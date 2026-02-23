// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon] — GraphHopper format
type LonLat = [number, number]; // [lon, lat] — GeoJSON format

const GH_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 8_000;
const GH_STAGGER_MS = 300;
// Target distance for one park lap — used to compute how many laps fit in budget
const PARK_LAP_TARGET_METERS = 1609; // ~1 mile

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

// buildParkWaypoints removed — park loop now uses real trail routing via
// buildParkLoopFeature (see feature builders section below).

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

/**
 * Overpass API — find a specific park by name near the user's location.
 * Uses case-insensitive regex matching so "griffith" matches "Griffith Park".
 * Searches within radiusMeters (default 15 km, wider than nearest-park since
 * the user might be running to a named park that isn't the closest one).
 * Falls back to null if nothing matches.
 */
async function findParkByName(
  name: string,
  lat: number,
  lon: number,
  radiusMeters = 15000
): Promise<{ lat: number; lon: number; name?: string } | null> {
  // Escape regex special chars so the name is treated as a literal substring
  const escaped = name.replace(/[[\](){}*+?.\\^$|]/g, "\\$&");
  const query =
    `[out:json][timeout:10];` +
    `(way["leisure"="park"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon});` +
    `relation["leisure"="park"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon}););` +
    `out center 5;`;

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

  // Pick the closest match to the start point
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
 * Build a feature from pre-stitched coordinate + altitude arrays.
 * Used for park loop where we combine two separate GH responses.
 */
function buildCombinedFeature(
  allCoords: LonLat[],
  totalDistanceMeters: number,
  totalTimeMs: number,
  allAltitudes: number[],
  targetMeters: number,
  pref: "flat" | "hills",
  elevIntensity: number
): object {
  let elevProfile: { distanceMeters: number; elevation: number }[];
  if (allAltitudes.length > 2) {
    const step = totalDistanceMeters / (allAltitudes.length - 1);
    elevProfile = allAltitudes.map((e, i) => ({
      distanceMeters: i * step,
      elevation: Math.round(e),
    }));
  } else {
    elevProfile = fakeElevationProfile(targetMeters, pref, elevIntensity);
  }

  const ascent = computeAscent(elevProfile);
  const distanceMiles = totalDistanceMeters / 1609.34;
  const timeMinutes =
    totalTimeMs > 0
      ? Math.round(totalTimeMs / 1000 / 60)
      : Math.round(distanceMiles * 10);

  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: allCoords },
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

/**
 * Park Loop feature builder — the correct approach for using real park trails:
 *
 *  1. Route home → park center using `foot` profile (streets/paths)
 *  2. `round_trip` from park center using `foot` profile — GH explores the
 *     actual path network at that location (footways, tracks, park paths),
 *     returning a loop that uses real mapped trails. Repeated N times to fill
 *     the remaining distance budget (lap count shown on route card).
 *  3. Stitch: toPark + parkLoop + reverse(toPark) → one continuous route
 *
 * The remaining loop distance is computed as targetMeters − 2×toParkDistance
 * so the total is close to what the user asked for. Minimum 500 m loop.
 *
 * Two GH calls per route (vs 1 for other modes) — stagger is applied between
 * them and between routes to stay within free-tier rate limits.
 */
async function buildParkLoopFeature({
  lat, lon,
  parkLat, parkLon,
  parkName,
  targetMeters,
  seed,
  pref,
  ghKey,
  mockCoords,
  elevIntensity,
  extraWarning,
}: {
  lat: number;
  lon: number;
  parkLat: number;
  parkLon: number;
  parkName?: string;
  targetMeters: number;
  seed: number;
  pref: "flat" | "hills";
  ghKey: string;
  mockCoords: LonLat[];
  elevIntensity: number;
  extraWarning?: string | null;
}): Promise<object> {
  try {
    // ── leg 1: home → park center ─────────────────────────────────────────────
    const { path: toPath, coords: toCoords } = await graphHopperRoute(
      [[lat, lon], [parkLat, parkLon]],
      ghKey,
      "foot"
    );
    const toDistance = typeof toPath?.distance === "number" ? toPath.distance : 0;
    const toTime = typeof toPath?.time === "number" ? toPath.time : 0;

    // ── leg 2: one lap of park round_trip, repeated N times ──────────────────
    // Free-tier GH supports foot (not hike). foot round_trip still uses park
    // paths/tracks. We compute a natural lap size (~1 mile) and repeat it to
    // fill the park distance budget — this lets the route card show "3× loop".
    await sleep(GH_STAGGER_MS);
    const loopBudget = Math.max(500, targetMeters - toDistance * 2);
    const laps = Math.max(1, Math.round(loopBudget / PARK_LAP_TARGET_METERS));
    const lapMeters = loopBudget / laps;

    const { path: loopPath, coords: lapCoords } = await ghRoundTrip(
      parkLat, parkLon, lapMeters, seed, ghKey, "foot"
    );
    const lapActualDistance =
      typeof loopPath?.distance === "number" ? loopPath.distance : lapMeters;
    const lapTime = typeof loopPath?.time === "number" ? loopPath.time : 0;

    // Repeat the single lap N times to build the multi-lap park segment
    const lapLonLat: LonLat[] = lapCoords.map((c: any) => [c[0], c[1]]);
    const loopLonLat: LonLat[] = [];
    for (let i = 0; i < laps; i++) loopLonLat.push(...lapLonLat);

    const loopActualDistance = lapActualDistance * laps;
    const loopTime = lapTime * laps;

    // ── stitch coordinates ────────────────────────────────────────────────────
    const toLonLat: LonLat[] = toCoords.map((c: any) => [c[0], c[1]]);
    const fromLonLat: LonLat[] = [...toLonLat].reverse();
    const allCoords: LonLat[] = [...toLonLat, ...loopLonLat, ...fromLonLat];

    // ── stitch altitudes (repeat for each lap) ────────────────────────────────
    const toAlts = toCoords
      .map((c: any) => c?.[2])
      .filter((n: any) => typeof n === "number") as number[];
    const lapAlts = lapCoords
      .map((c: any) => c?.[2])
      .filter((n: any) => typeof n === "number") as number[];
    const loopAlts: number[] = [];
    for (let i = 0; i < laps; i++) loopAlts.push(...lapAlts);
    const allAlts = [...toAlts, ...loopAlts, ...[...toAlts].reverse()];

    const totalDistance = toDistance * 2 + loopActualDistance;
    const totalTime = toTime * 2 + loopTime;

    // Build feature then annotate with park-specific metadata
    const feature = buildCombinedFeature(
      allCoords, totalDistance, totalTime, allAlts,
      targetMeters, pref, elevIntensity
    ) as any;

    feature.properties.parkName = parkName ?? null;
    feature.properties.parkLat = parkLat;
    feature.properties.parkLon = parkLon;
    feature.properties.parkLaps = laps;
    feature.properties.parkLapDistanceMiles = Number((lapActualDistance / 1609.34).toFixed(2));
    feature.properties.transitDistanceMiles = Number(((toDistance * 2) / 1609.34).toFixed(2));
    if (extraWarning) feature.properties.warnings = [extraWarning, ...(feature.properties.warnings ?? [])];

    return feature;
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    console.warn("Park loop GH failed:", msg);
    const warning = rateWarning(msg)
      ? "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again."
      : "Park loop route failed, showing estimated route.";
    return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [warning]);
  }
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
      parkSearch, // optional park name typed by the user
    } = body;

    if (!startLatLng) return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number")
      return res.status(400).json({ error: "Missing targetMeters (number)" });

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    // Free-tier GH only supports car, bike, foot — "hike" is paid-only.
    // foot already routes on park paths, footways, and tracks, so it's the
    // right choice for trail preference too. The distinction is in how GH
    // weights surfaces, not which paths it can access.
    const ghProfile = "foot";

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
    // Finds the target park via Overpass (by name if provided, else nearest),
    // then for each of the 3 route variants:
    //   1. foot routing home → park center
    //   2. round_trip from park center (N laps based on distance budget)
    //   3. reverse(leg 1) home
    // Different seeds give different trail paths per variant.
    if (loopAtPark) {
      const searchName: string | null =
        typeof parkSearch === "string" && parkSearch.trim().length > 0
          ? parkSearch.trim()
          : null;

      let park: { lat: number; lon: number; name?: string } | null = null;
      let parkWarning: string | null = null;

      if (GH_KEY) {
        if (searchName) {
          // User named a specific park — search by name first
          park = await findParkByName(searchName, lat, lon).catch((e) => {
            console.warn("Overpass named park lookup failed:", e?.message);
            return null;
          });
          if (!park) {
            // Named park not found — fall back to nearest and warn
            console.warn(`Park "${searchName}" not found, falling back to nearest`);
            parkWarning = `Couldn't find "${searchName}" nearby — routing to the nearest park instead.`;
            park = await findNearestPark(lat, lon).catch(() => null);
          }
        } else {
          park = await findNearestPark(lat, lon).catch((e) => {
            console.warn("Overpass park lookup failed:", e?.message);
            return null;
          });
        }
      }

      if (park) {
        console.log(`Park Loop: using "${park.name ?? "unnamed"}" at ${park.lat},${park.lon}`);

        // Each route uses a different seed so GH's round_trip explores a
        // different section of the park's trail network on each variant.
        // Multiplying by 3 + offset keeps seeds non-overlapping across Generate clicks.
        const f1 = await buildParkLoopFeature({
          lat, lon, parkLat: park.lat, parkLon: park.lon, parkName: park.name,
          targetMeters: meters1, seed: seedNum * 3,
          pref, ghKey: GH_KEY!, mockCoords: makeLoop(startLonLat, meters1, pref),
          elevIntensity: 1.0, extraWarning: parkWarning,
        });
        await sleep(GH_STAGGER_MS);

        const f2 = await buildParkLoopFeature({
          lat, lon, parkLat: park.lat, parkLon: park.lon, parkName: park.name,
          targetMeters: meters2, seed: seedNum * 3 + 1,
          pref, ghKey: GH_KEY!, mockCoords: makeLoop(startLonLat, meters2, pref),
          elevIntensity: pref === "hills" ? 0.85 : 0.8, extraWarning: parkWarning,
        });
        await sleep(GH_STAGGER_MS);

        const f3 = await buildParkLoopFeature({
          lat, lon, parkLat: park.lat, parkLon: park.lon, parkName: park.name,
          targetMeters: meters3, seed: seedNum * 3 + 2,
          pref, ghKey: GH_KEY!, mockCoords: makeLoop(startLonLat, meters3, pref),
          elevIntensity: pref === "hills" ? 1.55 : 1.25, extraWarning: parkWarning,
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
