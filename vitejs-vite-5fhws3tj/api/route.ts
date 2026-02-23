// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon]  — GraphHopper format
type LonLat = [number, number]; // [lon, lat]  — GeoJSON format

const GH_TIMEOUT_MS = 8_000;

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
  if (!Array.isArray(p) || p.length < 2)
    throw new Error(`Invalid ${label}: expected [lat, lon]`);
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new Error(`Invalid ${label}: lat/lon must be numbers`);
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];
  return [a, b];
}

// ── waypoint builder ──────────────────────────────────────────────────────────

/**
 * Builds the GH waypoint array for a single route.
 *
 * Loop: places 3 intermediate waypoints at 120° intervals starting at bearingDeg,
 * forming a triangle that GH will route around — each bearing offset produces a
 * genuinely different loop shape.
 *
 * Out-and-back: single midpoint in the bearing direction.
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

  // Loop: 3 waypoints at 120° increments starting at bearingDeg
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

async function graphHopperRoute(points: LatLon[], key: string, profile: string) {
  // GH POST body expects [lon, lat] — swap after normalizing
  const safePoints = points.map((p, i) => {
    const [lat, lon] = normalizeLatLon(p, `point ${i}`);
    return [lon, lat];
  });

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);

  const requestBody = {
    points: safePoints,
    profile,
    points_encoded: false,
    instructions: false,
    calc_points: true,
    elevation: true,
  };

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

/**
 * Attempts a real GH route. If GH fails for any reason, silently falls back
 * to the provided mock geometry. Each of the 3 routes calls this independently
 * so one failure doesn't take down the others.
 */
async function buildRouteFeature({
  waypoints,
  mockCoords,
  targetMeters,
  pref,
  ghKey,
  ghProfile,
  elevIntensity,
}: {
  waypoints: LatLon[];
  mockCoords: LonLat[];
  targetMeters: number;
  pref: "flat" | "hills";
  ghKey: string | undefined;
  ghProfile: string;
  elevIntensity: number;
}): Promise<object> {
  if (ghKey) {
    try {
      const { path, coords } = await graphHopperRoute(waypoints, ghKey, ghProfile);
      // (rate-limit errors throw before reaching here)
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
          warnings: [],
          elevationProfile: elevProfile,
          source: "graphhopper",
        },
      };
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      const isRateLimit = msg.toLowerCase().includes("limit");
      console.warn("GH route failed, using mock fallback:", msg);
      // Bubble rate-limit errors up with a clear flag so the caller can
      // surface a useful warning instead of silently showing a mock.
      if (isRateLimit) {
        return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
          "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again.",
        ]);
      }
    }
  }

  return buildMockFeature(
    mockCoords,
    targetMeters,
    pref,
    elevIntensity,
    [ghKey ? "Route used mock (GraphHopper failed)." : "Using mock (no GH key)."]
  );
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

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "API is alive. Use POST to generate routes." });
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
    } = body;

    if (!startLatLng)
      return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number")
      return res.status(400).json({ error: "Missing targetMeters (number)" });

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" =
      routeType === "out-and-back" ? "out-and-back" : "loop";

    // Map surfacePref → GH profile
    // "trail" → hike (prefers unpaved paths), "road"/"mixed" → foot
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

    // Run GH requests sequentially with a short pause between each.
    // Parallel calls (Promise.all) blow through the free-tier per-minute limit
    // almost instantly — sequential keeps burst rate at 1 req at a time.
    const GH_STAGGER_MS = 300;

    const feature1 = await buildRouteFeature({
      waypoints: buildWaypoints(lat, lon, meters1, type, bearing1),
      mockCoords:
        type === "out-and-back"
          ? makeOutAndBack(startLonLat, meters1, bearing1)
          : makeLoop(startLonLat, meters1, pref),
      targetMeters: meters1,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: 1.0,
    });

    await sleep(GH_STAGGER_MS);

    const feature2 = await buildRouteFeature({
      waypoints: buildWaypoints(lat, lon, meters2, type, bearing2),
      mockCoords:
        type === "out-and-back"
          ? makeOutAndBack(startLonLat, meters2, bearing2)
          : makeLoop(startLonLat, meters2, pref),
      targetMeters: meters2,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 0.85 : 0.8,
    });

    await sleep(GH_STAGGER_MS);

    const feature3 = await buildRouteFeature({
      waypoints: buildWaypoints(lat, lon, meters3, type, bearing3),
      mockCoords:
        type === "out-and-back"
          ? makeOutAndBack(startLonLat, meters3, bearing3)
          : makeLoop(startLonLat, meters3, pref),
      targetMeters: meters3,
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 1.55 : 1.25,
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
