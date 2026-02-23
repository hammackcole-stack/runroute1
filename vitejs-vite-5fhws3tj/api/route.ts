// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon] — GraphHopper format
type LonLat = [number, number]; // [lon, lat] — GeoJSON format

const GH_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 8_000;
const GH_STAGGER_MS = 300;

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── waypoint builders ─────────────────────────────────────────────────────────

/**
 * Waypoints for out-and-back: one midpoint in the bearing direction.
 * (Standard loop no longer uses this — it uses GH round_trip instead.)
 */
function buildOutAndBackWaypoints(
  lat: number,
  lon: number,
  targetMeters: number,
  bearingDeg: number
): LatLon[] {
  const b = (bearingDeg * Math.PI) / 180;
  const oneWay = targetMeters / 2;
  const mid: LatLon = [
    lat + metersToLat(oneWay * Math.sin(b)),
    lon + metersToLon(oneWay * Math.cos(b), lat),
  ];
  return [[lat, lon], mid, [lat, lon]];
}

/**
 * Waypoints for park loop:
 *   start → 3 points inside the park (120° apart) → start
 *
 * The 3 inner points form a triangle around the park center so GH creates a
 * real loop inside the park rather than an out-and-back through it.
 * rotationDeg rotates the triangle to produce distinct loop shapes across the
 * 3 route variants and across multiple Generate clicks.
 */
function buildParkWaypoints(
  startLat: number,
  startLon: number,
  parkLat: number,
  parkLon: number,
  rotationDeg: number
): LatLon[] {
  const innerR = 150; // meters from park center — tune if parks feel too tight/loose
  const pts: LatLon[] = [[startLat, startLon]];
  for (let i = 0; i < 3; i++) {
    const angle = ((rotationDeg + i * 120) * Math.PI) / 180;
    pts.push([
      parkLat + metersToLat(innerR * Math.sin(angle)),
      parkLon + metersToLon(innerR * Math.cos(angle), parkLat),
    ]);
  }
  pts.push([startLat, startLon]);
  return pts;
}

// ── mock geometry (fallback) ──────────────────────────────────────────────────

function makeLoop(startLonLat: LonLat, targetMeters: number, hilliness: "flat" | "hills"): LonLat[] {
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

function makeOutAndBack(startLonLat: LonLat, targetMeters: number, bearingDeg: number): LonLat[] {
  const oneWay = targetMeters / 2;
  const b = (bearingDeg * Math.PI) / 180;
  const out: LonLat = [
    startLonLat[0] + metersToLon(oneWay * Math.cos(b), startLonLat[1]),
    startLonLat[1] + metersToLat(oneWay * Math.sin(b)),
  ];
  return [startLonLat, out, startLonLat];
}

// ── elevation / scoring ───────────────────────────────────────────────────────

function fakeElevationProfile(lenMeters: number, pref: "flat" | "hills", intensity = 1) {
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

// ── GH API ───────────────────────────────────────────────────────────────────

async function ghPost(key: string, body: object): Promise<any> {
  const url = new URL("https://graphhopper.com/api/1/route");
  url.searchParams.set("key", key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json?.message || json?.error || `GraphHopper error (status ${resp.status})`);
  }
  return json;
}

/**
 * Point-to-point routing — GH finds the best path through all waypoints in order.
 * Used for out-and-back and park loop.
 */
async function graphHopperRoute(points: LatLon[], key: string, profile: string) {
  // GH POST body expects [lon, lat] — normalize then swap
  const safePoints = points.map((p, i) => {
    const [lat, lon] = normalizeLatLon(p, `point ${i}`);
    return [lon, lat];
  });
  const json = await ghPost(key, {
    points: safePoints,
    profile,
    points_encoded: false,
    instructions: false,
    calc_points: true,
    elevation: true,
  });
  const path = json?.paths?.[0];
  const coords: any[] = path?.points?.coordinates ?? [];
  if (!coords.length) {
    console.error("GH point-to-point: no coords:", JSON.stringify(json).slice(0, 300));
    throw new Error("GraphHopper returned no coordinates");
  }
  return { path, coords };
}

/**
 * Round-trip routing — GH generates a loop from a single point, actively
 * avoiding reuse of the same roads. This is the correct algorithm for
 * Standard Loop ("take me out and bring me back a different way").
 *
 * seed controls which of many possible loops is returned — incrementing it
 * on each Generate click produces a fresh route each time.
 */
async function ghRoundTrip(
  lat: number,
  lon: number,
  distanceMeters: number,
  seed: number,
  key: string,
  profile: string
) {
  const json = await ghPost(key, {
    points: [[lon, lat]], // single point for round trip
    algorithm: "round_trip",
    "round_trip.distance": Math.round(distanceMeters),
    "round_trip.seed": seed,
    profile,
    points_encoded: false,
    instructions: false,
    calc_points: true,
    elevation: true,
  });
  const path = json?.paths?.[0];
  const coords: any[] = path?.points?.coordinates ?? [];
  if (!coords.length) {
    console.error("GH round_trip: no coords:", JSON.stringify(json).slice(0, 300));
    throw new Error("GraphHopper round_trip returned no coordinates");
  }
  return { path, coords };
}

/**
 * Overpass API — find the nearest park/open space within radiusMeters.
 * Returns { lat, lon, name } of the closest one, or null.
 */
async function findNearestPark(
  lat: number,
  lon: number,
  radiusMeters = 3000
): Promise<{ lat: number; lon: number; name?: string } | null> {
  const query =
    `[out:json][timeout:8];` +
    `(way["leisure"="park"](around:${radiusMeters},${lat},${lon});` +
    `relation["leisure"="park"](around:${radiusMeters},${lat},${lon}););` +
    `out center 10;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) return null;
  const json: any = await resp.json().catch(() => null);
  if (!json?.elements?.length) return null;

  // Pick whichever element is closest to start
  let closest: { lat: number; lon: number; name?: string } | null = null;
  let minDist = Infinity;
  for (const el of json.elements) {
    const elLat: number = el.center?.lat ?? el.lat;
    const elLon: number = el.center?.lon ?? el.lon;
    if (elLat == null || elLon == null) continue;
    const dist = Math.sqrt(
      Math.pow((elLat - lat) * 110540, 2) +
      Math.pow((elLon - lon) * 111320 * Math.cos((lat * Math.PI) / 180), 2)
    );
    if (dist < minDist) {
      minDist = dist;
      closest = { lat: elLat, lon: elLon, name: el.tags?.name };
    }
  }
  return closest;
}

// ── feature builders ──────────────────────────────────────────────────────────

function buildMockFeature(
  coords: LonLat[],
  targetMeters: number,
  pref: "flat" | "hills",
  elevIntensity: number,
  warnings: string[]
): object {
  const elev = fakeElevationProfile(targetMeters, pref, elevIntensity);
  const asc = computeAscent(elev);
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
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

/** Convert a raw GH path+coords response into a GeoJSON Feature with metrics. */
function parseGHFeature(
  path: any,
  coords: any[],
  targetMeters: number,
  pref: "flat" | "hills",
  elevIntensity: number
): object {
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
  const distanceMeters = typeof path?.distance === "number" ? path.distance : targetMeters;
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
}

function rateWarning(msg: string): boolean {
  return msg.toLowerCase().includes("limit");
}

/**
 * Point-to-point feature: routes through a list of waypoints.
 * Used for out-and-back and park loop.
 */
async function buildPointToPointFeature({
  waypoints, mockCoords, targetMeters, pref, ghKey, ghProfile, elevIntensity,
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
      return parseGHFeature(path, coords, targetMeters, pref, elevIntensity);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      console.warn("GH point-to-point failed:", msg);
      if (rateWarning(msg)) {
        return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
          "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again.",
        ]);
      }
    }
  }
  return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
    ghKey ? "Route used mock (GraphHopper failed)." : "Using mock (no GH key).",
  ]);
}

/**
 * Round-trip feature: uses GH's round_trip algorithm.
 * Used for Standard Loop — GH actively avoids reusing roads.
 * Each unique seed produces a genuinely different loop.
 */
async function buildRoundTripFeature({
  lat, lon, targetMeters, seed, mockCoords, pref, ghKey, ghProfile, elevIntensity,
}: {
  lat: number;
  lon: number;
  targetMeters: number;
  seed: number;
  mockCoords: LonLat[];
  pref: "flat" | "hills";
  ghKey: string | undefined;
  ghProfile: string;
  elevIntensity: number;
}): Promise<object> {
  if (ghKey) {
    try {
      const { path, coords } = await ghRoundTrip(lat, lon, targetMeters, seed, ghKey, ghProfile);
      return parseGHFeature(path, coords, targetMeters, pref, elevIntensity);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      console.warn("GH round_trip failed:", msg);
      if (rateWarning(msg)) {
        return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
          "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again.",
        ]);
      }
    }
  }
  return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
    ghKey ? "Route used mock (GraphHopper failed)." : "Using mock (no GH key).",
  ]);
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
      loopAtPark,
    } = body;

    if (!startLatLng) return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number")
      return res.status(400).json({ error: "Missing targetMeters (number)" });

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    // "trail" → GH hike profile (prefers unpaved), everything else → foot
    const ghProfile = surfacePref === "trail" ? "hike" : "foot";

    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // Slight distance variation so routes 2/3 aren't identical length to route 1
    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    // ── Out-and-back ──────────────────────────────────────────────────────────
    // Distinct bearing per route so the 3 options go in meaningfully different
    // directions, not just slightly different lengths on the same path.
    if (type === "out-and-back") {
      const bearing2 = bearing + 35;
      const bearing3 = bearing + 70;

      const f1 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters1, bearing),
        mockCoords: makeOutAndBack(startLonLat, meters1, bearing),
        targetMeters: meters1, pref, ghKey: GH_KEY, ghProfile, elevIntensity: 1.0,
      });
      await sleep(GH_STAGGER_MS);

      const f2 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters2, bearing2),
        mockCoords: makeOutAndBack(startLonLat, meters2, bearing2),
        targetMeters: meters2, pref, ghKey: GH_KEY, ghProfile,
        elevIntensity: pref === "hills" ? 0.85 : 0.8,
      });
      await sleep(GH_STAGGER_MS);

      const f3 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters3, bearing3),
        mockCoords: makeOutAndBack(startLonLat, meters3, bearing3),
        targetMeters: meters3, pref, ghKey: GH_KEY, ghProfile,
        elevIntensity: pref === "hills" ? 1.55 : 1.25,
      });

      return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });
    }

    // ── Park Loop ─────────────────────────────────────────────────────────────
    // Finds the nearest park via Overpass, then routes:
    //   start → [3 points inside the park] → start
    // The 3 inner points form a triangle so GH creates a real loop, not an
    // out-and-back. Each of the 3 route variants rotates the triangle to
    // produce a different loop shape. seedNum shifts the rotation per click.
    if (loopAtPark) {
      const park = GH_KEY
        ? await findNearestPark(lat, lon).catch((e) => {
            console.warn("Overpass park lookup failed:", e?.message);
            return null;
          })
        : null;

      if (park) {
        console.log(`Park Loop: nearest park at ${park.lat},${park.lon} (${park.name ?? "unnamed"})`);

        // Rotate the inner triangle per seedNum so each Generate gives fresh loops
        const baseRotation = seedNum * 45;

        const f1 = await buildPointToPointFeature({
          waypoints: buildParkWaypoints(lat, lon, park.lat, park.lon, baseRotation),
          mockCoords: makeLoop(startLonLat, meters1, pref),
          targetMeters: meters1, pref, ghKey: GH_KEY, ghProfile, elevIntensity: 1.0,
        });
        await sleep(GH_STAGGER_MS);

        const f2 = await buildPointToPointFeature({
          waypoints: buildParkWaypoints(lat, lon, park.lat, park.lon, baseRotation + 60),
          mockCoords: makeLoop(startLonLat, meters2, pref),
          targetMeters: meters2, pref, ghKey: GH_KEY, ghProfile,
          elevIntensity: pref === "hills" ? 0.85 : 0.8,
        });
        await sleep(GH_STAGGER_MS);

        const f3 = await buildPointToPointFeature({
          waypoints: buildParkWaypoints(lat, lon, park.lat, park.lon, baseRotation + 120),
          mockCoords: makeLoop(startLonLat, meters3, pref),
          targetMeters: meters3, pref, ghKey: GH_KEY, ghProfile,
          elevIntensity: pref === "hills" ? 1.55 : 1.25,
        });

        return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });
      }

      // No park found nearby — fall through to Standard Loop
      console.warn("Park Loop: no park found within 3 km, falling back to standard loop");
    }

    // ── Standard Loop ─────────────────────────────────────────────────────────
    // Uses GH's round_trip algorithm, which routes a loop from a single point
    // while actively minimising road reuse. Seeds are multiplied by 3 so that
    // clicking Generate produces 3 seeds that don't overlap with the previous
    // click's set (seedNum=1 uses 3/4/5, seedNum=2 uses 6/7/8, etc.).
    const f1 = await buildRoundTripFeature({
      lat, lon, targetMeters: meters1, seed: seedNum * 3,
      mockCoords: makeLoop(startLonLat, meters1, pref),
      pref, ghKey: GH_KEY, ghProfile, elevIntensity: 1.0,
    });
    await sleep(GH_STAGGER_MS);

    const f2 = await buildRoundTripFeature({
      lat, lon, targetMeters: meters2, seed: seedNum * 3 + 1,
      mockCoords: makeLoop(startLonLat, meters2, pref),
      pref, ghKey: GH_KEY, ghProfile,
      elevIntensity: pref === "hills" ? 0.85 : 0.8,
    });
    await sleep(GH_STAGGER_MS);

    const f3 = await buildRoundTripFeature({
      lat, lon, targetMeters: meters3, seed: seedNum * 3 + 2,
      mockCoords: makeLoop(startLonLat, meters3, pref),
      pref, ghKey: GH_KEY, ghProfile,
      elevIntensity: pref === "hills" ? 1.55 : 1.25,
    });

    return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });

  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
