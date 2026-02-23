// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon]  — internal format
type LonLat = [number, number]; // [lon, lat]  — GeoJSON format

const GH_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 3_500;

// ── coordinate helpers ────────────────────────────────────────────────────────

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}

function metersToLat(m: number) {
  return m / 110540;
}

/**
 * Normalize to [lat, lon].
 * Flips [-118, 34] → [34, -118] when the first value can't be a latitude.
 * Limitation: cannot auto-detect swaps where both values fall in [-90, 90].
 */
function normalizeLatLon(p: unknown, label = "point"): LatLon {
  if (!Array.isArray(p) || p.length < 2) {
    throw new Error(`Invalid ${label}: expected [lat, lon]`);
  }
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`Invalid ${label}: lat/lon must be numbers`);
  }
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];
  return [a, b];
}

function haversineMeters(a: LatLon, b: LatLon) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ── Overpass: find nearest park center (for Park Loop) ────────────────────────

async function findNearestParkCenter(lat: number, lon: number): Promise<LatLon | null> {
  // Try a few radii quickly; keep it fast and never hang the API
  const radii = [1200, 2500, 5000];

  for (const r of radii) {
    const query = `
[out:json][timeout:3];
(
  way["leisure"="park"](around:${r},${lat},${lon});
  relation["leisure"="park"](around:${r},${lat},${lon});
);
out center 25;
`.trim();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const resp = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      const data: any = await resp.json().catch(() => null);
      const els: any[] = data?.elements ?? [];
      if (!els.length) continue;

      let best: { p: LatLon; d: number } | null = null;

      for (const el of els) {
        const cLat = el?.center?.lat;
        const cLon = el?.center?.lon;
        if (typeof cLat !== "number" || typeof cLon !== "number") continue;

        const p: LatLon = [cLat, cLon];
        const d = haversineMeters([lat, lon], p);
        if (!best || d < best.d) best = { p, d };
      }

      return best?.p ?? null;
    } catch {
      // ignore and try next radius
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

// ── waypoint builders ─────────────────────────────────────────────────────────

/**
 * Standard Loop / Out-and-back:
 * Loop = 3 intermediate waypoints at 120° intervals, starting at bearingDeg.
 * Out-and-back = single midpoint in bearing direction.
 */
function buildWaypoints(
  lat: number,
  lon: number,
  targetMeters: number,
  type: "loop" | "out-and-back",
  bearingDeg: number
): LatLon[] {
  const b = (bearingDeg * Math.PI) / 180;

  if (type === "out-and-back") {
    const oneWay = targetMeters / 2;
    const mid: LatLon = [
      lat + metersToLat(oneWay * Math.sin(b)),
      lon + metersToLon(oneWay * Math.cos(b), lat),
    ];
    return [[lat, lon], mid, [lat, lon]];
  }

  const r = targetMeters / (2 * Math.PI);
  const pts: LatLon[] = [[lat, lon]];
  for (let i = 0; i < 3; i++) {
    const a = ((bearingDeg + i * 120) * Math.PI) / 180;
    pts.push([
      lat + metersToLat(r * Math.sin(a)),
      lon + metersToLon(r * Math.cos(a), lat),
    ]);
  }
  pts.push([lat, lon]);
  return pts;
}

/**
 * Park Loop:
 * start -> park center -> 3 points around park -> park center -> start
 * This doesn't guarantee "inside park" (needs polygon constraints), but reliably
 * creates a park-focused route when paths exist.
 */
function buildParkWaypoints(
  start: LatLon,
  park: LatLon,
  totalMeters: number,
  bearingDeg: number
): LatLon[] {
  const [lat, lon] = start;

  const toPark = haversineMeters(start, park);
  const loopBudget = Math.max(800, totalMeters - (toPark + toPark)); // out + back

  // Keep the loop local so it actually stays around the park
  const loopR = Math.min(900, loopBudget / (2 * Math.PI));

  const pts: LatLon[] = [];
  for (let i = 0; i < 3; i++) {
    const a = ((bearingDeg + i * 120) * Math.PI) / 180;
    pts.push([
      park[0] + metersToLat(loopR * Math.sin(a)),
      park[1] + metersToLon(loopR * Math.cos(a), park[0]),
    ]);
  }

  return [[lat, lon], park, ...pts, park, [lat, lon]];
}

// ── mock geometry (fallback) ──────────────────────────────────────────────────

/**
 * Closed loop that starts and ends at startLonLat.
 * Circle centered north of start so its southernmost point = startLonLat.
 */
function makeLoop(
  startLonLat: LonLat,
  targetMeters: number,
  hilliness: "flat" | "hills"
): LonLat[] {
  const numPts = 70;
  const radius = targetMeters / (2 * Math.PI);
  const centerLat = startLonLat[1] + metersToLat(radius);
  const centerLon = startLonLat[0];
  const coords: LonLat[] = [];
  for (let i = 0; i <= numPts; i++) {
    const a = -Math.PI / 2 + (i / numPts) * 2 * Math.PI;
    const hillFactor = hilliness === "hills" ? 1 + 0.2 * Math.sin(2 * a) : 1;
    const r = radius * hillFactor;
    coords.push([
      centerLon + metersToLon(r * Math.cos(a), centerLat),
      centerLat + metersToLat(r * Math.sin(a)),
    ]);
  }
  return coords;
}

function makeOutAndBack(
  startLonLat: LonLat,
  targetMeters: number,
  bearingDeg: number
): LonLat[] {
  const oneWay = targetMeters / 2;
  const b = (bearingDeg * Math.PI) / 180;
  const out: LonLat = [
    startLonLat[0] + metersToLon(oneWay * Math.cos(b), startLonLat[1]),
    startLonLat[1] + metersToLat(oneWay * Math.sin(b)),
  ];
  return [startLonLat, out, startLonLat];
}

function fakeElevationProfile(
  lenMeters: number,
  pref: "flat" | "hills",
  intensity = 1
): { distanceMeters: number; elevation: number }[] {
  const pts = 50;
  const base = 120;
  const amp = (pref === "hills" ? 35 : 8) * intensity;
  return Array.from({ length: pts + 1 }, (_, i) => {
    const elev =
      base +
      amp * Math.sin((i / pts) * 2 * Math.PI) +
      (pref === "hills" ? amp * 0.4 * Math.sin((i / pts) * 6 * Math.PI) : 0);
    return { distanceMeters: (i / pts) * lenMeters, elevation: Math.round(elev) };
  });
}

function computeAscent(profile: { elevation: number }[]): number {
  let ascent = 0;
  for (let i = 1; i < profile.length; i++) {
    const diff = profile[i].elevation - profile[i - 1].elevation;
    if (diff > 0) ascent += diff;
  }
  return ascent;
}

function scoreRoute(ascentMeters: number, pref: "flat" | "hills"): number {
  const target = pref === "flat" ? 60 : 220;
  const tolerance = pref === "flat" ? 90 : 160;
  return Math.max(
    0,
    Math.min(100, Math.round(100 - (Math.abs(ascentMeters - target) / tolerance) * 100))
  );
}

// ── GraphHopper client ────────────────────────────────────────────────────────

/** Small pause between sequential GH calls to stay within free-tier rate limits. */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GraphHopper route call (POST).
 * IMPORTANT: GH expects points in [lon, lat] order in the POST body.
 * We normalize incoming points to [lat, lon] and then swap.
 *
 * Also supports avoidMajorRoads via custom_model.
 */
async function graphHopperRoute(
  points: LatLon[],
  key: string,
  profile: string,
  opts?: { avoidMajorRoads?: boolean }
) {
  const safePoints = points.map((p, i) => {
    const [lat, lon] = normalizeLatLon(p, `point ${i}`);
    return [lon, lat]; // GH expects [lon, lat]
  });

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);

  const requestBody: any = {
    points: safePoints,
    profile,
    points_encoded: false,
    instructions: false,
    calc_points: true,
    elevation: true,
  };

  // Discourage major roads (does not ban them).
  if (opts?.avoidMajorRoads) {
    requestBody.custom_model = {
      priority: [
        {
          if:
            "road_class == MOTORWAY || road_class == TRUNK || road_class == PRIMARY || road_class == SECONDARY",
          multiply_by: "0.15",
        },
        { if: "road_class == TERTIARY", multiply_by: "0.45" },
      ],
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);

  let ghResp: Response;
  try {
    ghResp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const ghJson: any = await ghResp.json().catch(() => ({}));
  if (!ghResp.ok) {
    throw new Error(
      ghJson?.message || ghJson?.error || `GraphHopper error (status ${ghResp.status})`
    );
  }

  const path = ghJson?.paths?.[0];
  const coords: any[] = path?.points?.coordinates ?? [];
  if (!coords.length) {
    console.error("GH response missing coordinates:", JSON.stringify(ghJson).slice(0, 500));
    throw new Error("GraphHopper returned no coordinates");
  }

  return { path, coords };
}

// ── per-route feature builder ─────────────────────────────────────────────────

async function buildRouteFeature({
  waypoints,
  mockCoords,
  targetMeters,
  pref,
  ghKey,
  ghProfile,
  elevIntensity,
  avoidMajorRoads,
  extraWarning,
}: {
  waypoints: LatLon[];
  mockCoords: LonLat[];
  targetMeters: number;
  pref: "flat" | "hills";
  ghKey: string | undefined;
  ghProfile: string;
  elevIntensity: number;
  avoidMajorRoads: boolean;
  extraWarning?: string | null;
}): Promise<any> {
  if (ghKey) {
    try {
      const { path, coords } = await graphHopperRoute(waypoints, ghKey, ghProfile, {
        avoidMajorRoads,
      });

      const coordsLonLat: LonLat[] = coords.map((c: any) => [c[0], c[1]]);

      const altitudes = coords
        .map((c: any) => c?.[2])
        .filter((n: any) => typeof n === "number");

      let elevProfile: { distanceMeters: number; elevation: number }[];
      if (altitudes.length > 2) {
        const total = typeof path?.distance === "number" ? path.distance : targetMeters;
        const step = total / (altitudes.length - 1);
        elevProfile = altitudes.map((e: number, i: number) => ({
          distanceMeters: i * step,
          elevation: Math.round(e),
        }));
      } else {
        elevProfile = fakeElevationProfile(targetMeters, pref, elevIntensity);
      }

      const ascent = computeAscent(elevProfile);
      const distanceMeters =
        typeof path?.distance === "number" ? path.distance : targetMeters;
      const distanceMiles = distanceMeters / 1609.34;
      const timeMinutes =
        typeof path?.time === "number"
          ? Math.round(path.time / 1000 / 60)
          : Math.round(distanceMiles * 10);

      const warnings: string[] = [];
      if (extraWarning) warnings.push(extraWarning);

      return {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coordsLonLat },
        properties: {
          metrics: {
            distanceMiles: Number(distanceMiles.toFixed(2)),
            timeMinutes,
            totalAscent: ascent,
            totalDescent: ascent,
          },
          scoring: { overallScore: scoreRoute(ascent, pref) },
          warnings,
          elevationProfile: elevProfile,
          source: "graphhopper",
        },
      };
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      const isRateLimit = msg.toLowerCase().includes("limit");
      console.warn("GH route failed, using mock fallback:", msg);

      if (isRateLimit) {
        return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
          ...(extraWarning ? [extraWarning] : []),
          "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again.",
        ]);
      }
    }
  }

  return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
    ...(extraWarning ? [extraWarning] : []),
    ghKey ? "Route used mock (GraphHopper failed)." : "Using mock (no GH key).",
  ]);
}

function buildMockFeature(
  mockCoords: LonLat[],
  targetMeters: number,
  pref: "flat" | "hills",
  elevIntensity: number,
  warnings: string[]
): object {
  const elev = fakeElevationProfile(targetMeters, pref, elevIntensity);
  const asc = computeAscent(elev);
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: mockCoords },
    properties: {
      metrics: {
        distanceMiles: Number((targetMeters / 1609.34).toFixed(2)),
        timeMinutes: Math.round((targetMeters / 1609.34) * 10),
        totalAscent: asc,
        totalDescent: asc,
      },
      scoring: { overallScore: scoreRoute(asc, pref) },
      warnings,
      elevationProfile: elev,
      source: "mock",
    },
  };
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  // GET: healthcheck — should always be instant and never touch GH/Overpass
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, message: "API is alive. Use POST to generate routes." });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const body = req.body ?? {};
    const {
      startLatLng,
      routeType,
      targetMeters,
      elevationPref,
      directionSeed,
      surfacePref,
      loopAtPark, // ✅ from UI
      avoidMajorRoads, // optional UI toggle; if absent we default true
    } = body;

    if (!startLatLng)
      return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number")
      return res.status(400).json({ error: "Missing targetMeters (number)" });

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" =
      routeType === "out-and-back" ? "out-and-back" : "loop";

    // Map surfacePref → GH profile
    const ghProfile = surfacePref === "trail" ? "hike" : "foot";

    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;

    // Three bearings, each offset by 35° to produce distinct route shapes
    const bearing1 = candidates[seedNum % candidates.length];
    const bearing2 = bearing1 + 35;
    const bearing3 = bearing1 + 70;

    // Slight distance variation keeps the three routes from overlapping exactly
    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // Default: true (better “standard loop” behavior)
    const avoidMajors = typeof avoidMajorRoads === "boolean" ? avoidMajorRoads : true;

    // Park-loop planning (only if requested AND we're doing a loop)
    const wantsPark = Boolean(loopAtPark) && type === "loop";
    let parkCenter: LatLon | null = null;
    let parkWarning: string | null = null;

    if (wantsPark) {
      parkCenter = await findNearestParkCenter(lat, lon);
      if (!parkCenter) {
        parkWarning =
          "Park Loop requested, but no nearby park found quickly — using Standard Loop.";
      }
    }

    const usePark = wantsPark && Boolean(parkCenter);

    const start: LatLon = [lat, lon];

    const mkWaypoints = (meters: number, bearing: number): LatLon[] => {
      if (usePark) {
        return buildParkWaypoints(start, parkCenter as LatLon, meters, bearing);
      }
      return buildWaypoints(lat, lon, meters, type, bearing);
    };

    const mkMockCoords = (meters: number, bearing: number): LonLat[] => {
      if (type === "out-and-back") return makeOutAndBack(startLonLat, meters, bearing);
      return makeLoop(startLonLat, meters, pref);
    };

    // Sequential GH calls to reduce free-tier rate-limit issues
    const GH_STAGGER_MS = 300;

    const feature1 = await buildRouteFeature({
      waypoints: mkWaypoints(meters1, bearing1),
      mockCoords: mkMockCoords(meters1, bearing1),
      targetMeters: meters1,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: 1.0,
      avoidMajorRoads: avoidMajors,
      extraWarning: parkWarning,
    });

    await sleep(GH_STAGGER_MS);

    const feature2 = await buildRouteFeature({
      waypoints: mkWaypoints(meters2, bearing2),
      mockCoords: mkMockCoords(meters2, bearing2),
      targetMeters: meters2,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 0.85 : 0.8,
      avoidMajorRoads: avoidMajors,
      extraWarning: parkWarning,
    });

    await sleep(GH_STAGGER_MS);

    const feature3 = await buildRouteFeature({
      waypoints: mkWaypoints(meters3, bearing3),
      mockCoords: mkMockCoords(meters3, bearing3),
      targetMeters: meters3,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 1.55 : 1.25,
      avoidMajorRoads: avoidMajors,
      extraWarning: parkWarning,
    });

    return res.status(200).json({
      type: "FeatureCollection",
      features: [feature1, feature2, feature3],
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
