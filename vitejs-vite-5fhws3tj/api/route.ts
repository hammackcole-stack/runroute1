// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon] — GraphHopper input (we normalize then swap to [lon,lat] in body)
type LonLat = [number, number]; // [lon, lat] — GeoJSON format

const GH_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 8_000;
const GH_STAGGER_MS = 300;

// How many “anchor” points around the park boundary we’ll use to force a loop.
// More points = more “hug the park,” but more risk GH does weird detours.
const PARK_WAYPOINTS = 6;

// Filter out tiny “parks” (pocket greens / traffic triangles).
const PARK_MIN_AREA_M2 = 25_000; // ~6 acres
const PARK_MIN_PERIMETER_M = 600; // avoid weird tiny shapes

// If the user asks for a big run, we’ll repeat the park loop this many times max.
const PARK_MAX_LAPS = 4;

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
  if (!Array.isArray(p) || p.length < 2) throw new Error(`Invalid ${label}: expected [lat, lon]`);
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Invalid ${label}: lat/lon must be numbers`);
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];
  return [a, b];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A small, stable local projection (meters) around an origin latitude.
// Good enough for “nearest boundary point” / area / perimeter at city scale.
function projectMeters(lon: number, lat: number, originLat: number) {
  const x = (lon * 111320) * Math.cos((originLat * Math.PI) / 180);
  const y = lat * 110540;
  return { x, y };
}

function distMeters(aLon: number, aLat: number, bLon: number, bLat: number, originLat: number) {
  const a = projectMeters(aLon, aLat, originLat);
  const b = projectMeters(bLon, bLat, originLat);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Closest point on a segment AB to point P in projected meters space.
function closestPointOnSegmentMeters(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number
) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-12) return { x: ax, y: ay, t: 0 };
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * abx, y: ay + t * aby, t };
}

function polygonPerimeterMeters(poly: LonLat[], originLat: number) {
  if (poly.length < 2) return 0;
  let p = 0;
  for (let i = 1; i < poly.length; i++) {
    p += distMeters(poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1], originLat);
  }
  // close the ring if not already closed
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    p += distMeters(last[0], last[1], first[0], first[1], originLat);
  }
  return p;
}

// Approx area via shoelace in local projection. Requires ring-ish polygon.
function polygonAreaMeters2(poly: LonLat[], originLat: number) {
  if (poly.length < 3) return 0;
  const pts = poly.map(([lon, lat]) => projectMeters(lon, lat, originLat));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Find the nearest point on the polygon boundary (polyline) to a given lon/lat.
 * Returns a boundary point (lon/lat) and also the index of the segment start.
 */
function nearestBoundaryPoint(poly: LonLat[], pLon: number, pLat: number, originLat: number) {
  if (poly.length < 2) return { point: [pLon, pLat] as LonLat, segIndex: 0, dist: Infinity };

  const P = projectMeters(pLon, pLat, originLat);
  let best = { x: 0, y: 0, segIndex: 0, dist: Infinity };

  for (let i = 1; i < poly.length; i++) {
    const [aLon, aLat] = poly[i - 1];
    const [bLon, bLat] = poly[i];
    const A = projectMeters(aLon, aLat, originLat);
    const B = projectMeters(bLon, bLat, originLat);
    const C = closestPointOnSegmentMeters(A.x, A.y, B.x, B.y, P.x, P.y);
    const dx = C.x - P.x;
    const dy = C.y - P.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best.dist) best = { x: C.x, y: C.y, segIndex: i - 1, dist: d };
  }

  // Inverse projection back to lon/lat (approx).
  const lon = best.x / (111320 * Math.cos((originLat * Math.PI) / 180));
  const lat = best.y / 110540;
  return { point: [lon, lat] as LonLat, segIndex: best.segIndex, dist: best.dist };
}

/**
 * Sample N roughly-evenly-spaced points around the polygon boundary, starting from the nearest boundary point.
 * We use these as waypoints to force a “loop around the park”.
 */
function boundaryWaypoints(poly: LonLat[], startAtSegIndex: number, count: number, originLat: number) {
  if (poly.length < 2) return [];
  const ring: LonLat[] = [...poly];

  // ensure closed ring
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);

  // rotate ring so it starts near segIndex
  const startIdx = Math.max(0, Math.min(startAtSegIndex, ring.length - 2));
  const rotated = [...ring.slice(startIdx), ...ring.slice(1, startIdx + 1)]; // avoid duplicating closure weirdness
  // Build cumulative distances
  const cum: number[] = [0];
  for (let i = 1; i < rotated.length; i++) {
    const d = distMeters(rotated[i - 1][0], rotated[i - 1][1], rotated[i][0], rotated[i][1], originLat);
    cum.push(cum[cum.length - 1] + d);
  }
  const total = cum[cum.length - 1] || 0;
  if (total <= 1) return [];

  const pts: LonLat[] = [];
  for (let k = 1; k <= count; k++) {
    const target = (k / (count + 1)) * total;
    // find segment containing target
    let i = 1;
    while (i < cum.length && cum[i] < target) i++;
    if (i >= cum.length) i = cum.length - 1;
    const prev = cum[i - 1];
    const next = cum[i];
    const t = next > prev ? (target - prev) / (next - prev) : 0;
    const [aLon, aLat] = rotated[i - 1];
    const [bLon, bLat] = rotated[i];
    pts.push([aLon + (bLon - aLon) * t, aLat + (bLat - aLat) * t]);
  }
  return pts;
}

// ── waypoint builders ─────────────────────────────────────────────────────────

function buildOutAndBackWaypoints(lat: number, lon: number, targetMeters: number, bearingDeg: number): LatLon[] {
  const b = (bearingDeg * Math.PI) / 180;
  const oneWay = targetMeters / 2;
  const mid: LatLon = [
    lat + metersToLat(oneWay * Math.sin(b)),
    lon + metersToLon(oneWay * Math.cos(b), lat),
  ];
  return [[lat, lon], mid, [lat, lon]];
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
  return Math.max(0, Math.min(100, Math.round(100 - (Math.abs(ascentMeters - target) / tolerance) * 100)));
}

// ── GH API ───────────────────────────────────────────────────────────────────

const AVOID_MAJOR_ROADS_MODEL = {
  "ch.disable": true,
  custom_model: {
    priority: [
      { if: "road_class == MOTORWAY || road_class == TRUNK", multiply_by: 0.01 },
      { if: "road_class == PRIMARY", multiply_by: 0.1 },
      { if: "road_class == SECONDARY", multiply_by: 0.3 },
    ],
  },
};

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
  if (!resp.ok) throw new Error(json?.message || json?.error || `GraphHopper error (status ${resp.status})`);
  return json;
}

async function graphHopperRoute(points: LatLon[], key: string, profile: string, avoidMajorRoads = false) {
  const safePoints = points.map((p, i) => {
    const [lat, lon] = normalizeLatLon(p, `point ${i}`);
    return [lon, lat];
  });

  const baseBody = {
    points: safePoints,
    profile,
    points_encoded: false,
    instructions: true,
    calc_points: true,
    elevation: true,
  };

  const attempts = avoidMajorRoads ? [{ ...baseBody, ...AVOID_MAJOR_ROADS_MODEL }, baseBody] : [baseBody];

  let lastErr: Error | null = null;
  for (const body of attempts) {
    try {
      const json = await ghPost(key, body);
      const path = json?.paths?.[0];
      const coords: any[] = path?.points?.coordinates ?? [];
      if (!coords.length) {
        console.error("GH point-to-point: no coords:", JSON.stringify(json).slice(0, 300));
        throw new Error("GraphHopper returned no coordinates");
      }
      return { path, coords };
    } catch (e: any) {
      lastErr = e;
      if (attempts.length > 1) console.warn("GH custom_model rejected, retrying without:", e?.message);
    }
  }
  throw lastErr ?? new Error("GraphHopper point-to-point failed");
}

async function ghRoundTrip(
  lat: number,
  lon: number,
  distanceMeters: number,
  seed: number,
  key: string,
  profile: string,
  avoidMajorRoads = false
) {
  const baseBody = {
    points: [[lon, lat]],
    algorithm: "round_trip",
    "round_trip.distance": Math.round(distanceMeters),
    "round_trip.seed": seed,
    profile,
    points_encoded: false,
    instructions: true,
    calc_points: true,
    elevation: true,
  };

  const attempts = avoidMajorRoads ? [{ ...baseBody, ...AVOID_MAJOR_ROADS_MODEL }, baseBody] : [baseBody];

  let lastErr: Error | null = null;
  for (const body of attempts) {
    try {
      const json = await ghPost(key, body);
      const path = json?.paths?.[0];
      const coords: any[] = path?.points?.coordinates ?? [];
      if (!coords.length) {
        console.error("GH round_trip: no coords:", JSON.stringify(json).slice(0, 300));
        throw new Error("GraphHopper round_trip returned no coordinates");
      }
      return { path, coords };
    } catch (e: any) {
      lastErr = e;
      if (attempts.length > 1) console.warn("GH custom_model rejected, retrying without:", e?.message);
    }
  }
  throw lastErr ?? new Error("GraphHopper round_trip failed");
}

// ── Overpass: park geometry + boundary entry ─────────────────────────────────

type ParkPick = {
  name?: string;
  // Park boundary approximation (LonLat ring-ish). Might be a way or a stitched relation.
  boundary: LonLat[];
  // Best “entry” point on boundary nearest the user.
  entry: LonLat;
  // Distance from start to boundary (meters, approx)
  distToBoundary: number;
  // Simple geom stats
  areaM2: number;
  perimeterM: number;
};

async function overpassRequest(query: string): Promise<any | null> {
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
  return await resp.json().catch(() => null);
}

// Extract one “best effort” boundary polyline from an Overpass element.
// For ways: el.geometry is an array of {lat,lon}.
// For relations: el.members contains ways with their own geometry arrays.
function extractBoundaryLonLat(el: any): LonLat[] {
  // Way
  if (el?.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 3) {
    return el.geometry.map((g: any) => [Number(g.lon), Number(g.lat)] as LonLat);
  }

  // Relation: stitch member way geometries (best-effort; not perfect)
  if (el?.type === "relation" && Array.isArray(el.members)) {
    const chunks: LonLat[][] = [];
    for (const m of el.members) {
      if (m?.type !== "way") continue;
      if (!Array.isArray(m.geometry) || m.geometry.length < 3) continue;
      chunks.push(m.geometry.map((g: any) => [Number(g.lon), Number(g.lat)] as LonLat));
    }
    // If only one chunk, return it.
    if (chunks.length === 1) return chunks[0];

    // Otherwise, naive stitching: connect chunks by nearest endpoints.
    // This is a heuristic, but usually “good enough” to get a perimeter-ish polyline.
    const used = new Array(chunks.length).fill(false);
    const out: LonLat[] = [];

    let cur = 0;
    used[cur] = true;
    out.push(...chunks[cur]);

    while (true) {
      const last = out[out.length - 1];
      let bestIdx = -1;
      let bestFlip = false;
      let bestD = Infinity;

      for (let i = 0; i < chunks.length; i++) {
        if (used[i]) continue;
        const c = chunks[i];
        const head = c[0];
        const tail = c[c.length - 1];

        const dHead = Math.hypot(head[0] - last[0], head[1] - last[1]);
        const dTail = Math.hypot(tail[0] - last[0], tail[1] - last[1]);

        if (dHead < bestD) {
          bestD = dHead;
          bestIdx = i;
          bestFlip = false;
        }
        if (dTail < bestD) {
          bestD = dTail;
          bestIdx = i;
          bestFlip = true;
        }
      }

      if (bestIdx === -1) break;
      used[bestIdx] = true;
      const next = bestFlip ? [...chunks[bestIdx]].reverse() : chunks[bestIdx];
      // avoid duplicating the join point
      out.push(...next.slice(1));
    }

    return out;
  }

  return [];
}

function pickBestParkFromElements(
  elements: any[],
  startLat: number,
  startLon: number
): ParkPick | null {
  const originLat = startLat;

  const candidates: ParkPick[] = [];
  for (const el of elements) {
    const boundary = extractBoundaryLonLat(el);
    if (!boundary || boundary.length < 3) continue;

    const { point: entry, segIndex, dist } = nearestBoundaryPoint(boundary, startLon, startLat, originLat);
    const areaM2 = polygonAreaMeters2(boundary, originLat);
    const perM = polygonPerimeterMeters(boundary, originLat);

    // filter out tiny / malformed ones
    if (areaM2 > 0 && areaM2 < PARK_MIN_AREA_M2) continue;
    if (perM > 0 && perM < PARK_MIN_PERIMETER_M) continue;

    candidates.push({
      name: el?.tags?.name,
      boundary,
      entry,
      distToBoundary: dist,
      areaM2,
      perimeterM: perM,
    });
  }

  if (!candidates.length) return null;

  // Scoring: prioritize closeness, then size. (Distance dominates; size breaks ties.)
  // Lower score is better.
  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = c.distToBoundary - Math.min(300, Math.sqrt(Math.max(0, c.areaM2)) / 10); // small size bonus
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

/**
 * Overpass API — find the nearest “park-like” place and return boundary + nearest entry point.
 */
async function findNearestParkWithBoundary(
  lat: number,
  lon: number,
  radiusMeters = 3000
): Promise<ParkPick | null> {
  // Broaden beyond leisure=park because OSM varies a lot.
  const query =
    `[out:json][timeout:8];` +
    `(` +
    `way["leisure"~"^(park|common)$"](around:${radiusMeters},${lat},${lon});` +
    `relation["leisure"~"^(park|common)$"](around:${radiusMeters},${lat},${lon});` +
    `way["landuse"="recreation_ground"](around:${radiusMeters},${lat},${lon});` +
    `relation["landuse"="recreation_ground"](around:${radiusMeters},${lat},${lon});` +
    `);` +
    // include relation members (ways) so we can read geometry
    `(._;>;);` +
    `out body geom;`;

  const json = await overpassRequest(query);
  const els: any[] = json?.elements ?? [];
  if (!els.length) return null;

  // Only consider top-level park objects (ways/relations with tags), not nodes.
  const top = els.filter(
    (e) =>
      (e.type === "way" || e.type === "relation") &&
      e.tags &&
      ((e.tags.leisure && /^(park|common)$/.test(String(e.tags.leisure))) ||
        (e.tags.landuse && String(e.tags.landuse) === "recreation_ground"))
  );

  return pickBestParkFromElements(top, lat, lon);
}

/**
 * Overpass API — find a named park and return boundary + nearest entry point.
 * Uses regex substring match (case-insensitive). If multiple matches exist, returns best-scored one.
 */
async function findParkByNameWithBoundary(
  name: string,
  lat: number,
  lon: number,
  radiusMeters = 15000
): Promise<ParkPick | null> {
  const escaped = name.replace(/[[\](){}*+?.\\^$|]/g, "\\$&");

  const query =
    `[out:json][timeout:10];` +
    `(` +
    `way["leisure"~"^(park|common)$"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon});` +
    `relation["leisure"~"^(park|common)$"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon});` +
    `way["landuse"="recreation_ground"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon});` +
    `relation["landuse"="recreation_ground"]["name"~"${escaped}",i](around:${radiusMeters},${lat},${lon});` +
    `);` +
    `(._;>;);` +
    `out body geom;`;

  const json = await overpassRequest(query);
  const els: any[] = json?.elements ?? [];
  if (!els.length) return null;

  const top = els.filter(
    (e) =>
      (e.type === "way" || e.type === "relation") &&
      e.tags &&
      (typeof e.tags.name === "string") &&
      // ensure it actually matches (Overpass should do it, but belt + suspenders)
      new RegExp(escaped, "i").test(e.tags.name) &&
      ((e.tags.leisure && /^(park|common)$/.test(String(e.tags.leisure))) ||
        (e.tags.landuse && String(e.tags.landuse) === "recreation_ground"))
  );

  return pickBestParkFromElements(top, lat, lon);
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

function parseGHFeature(path: any, coords: any[], targetMeters: number, pref: "flat" | "hills", elevIntensity: number): object {
  const coordsLonLat: LonLat[] = coords.map((c: any) => [c[0], c[1]]);
  const altitudes = coords.map((c: any) => c?.[2]).filter((n: any) => typeof n === "number");

  let elevProfile: { distanceMeters: number; elevation: number }[];
  if (altitudes.length > 2) {
    const total = typeof path?.distance === "number" ? path.distance : targetMeters;
    const step = total / (altitudes.length - 1);
    elevProfile = altitudes.map((e: number, i: number) => ({ distanceMeters: i * step, elevation: Math.round(e) }));
  } else {
    elevProfile = fakeElevationProfile(targetMeters, pref, elevIntensity);
  }

  const ascent = computeAscent(elevProfile);
  const distanceMeters = typeof path?.distance === "number" ? path.distance : targetMeters;
  const distanceMiles = distanceMeters / 1609.34;
  const timeMinutes =
    typeof path?.time === "number" ? Math.round(path.time / 1000 / 60) : Math.round(distanceMiles * 10);

  const rawInstr: any[] = path?.instructions ?? [];
  const instructions = rawInstr.map((inst: any) => {
    const txt = String(inst.text ?? "");
    const mi = Number(((inst.distance ?? 0) / 1609.34).toFixed(2));
    const sign = typeof inst.sign === "number" ? inst.sign : 0;
    return { text: txt, distanceMiles: mi, sign };
  });

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
      instructions,
      source: "graphhopper",
    },
  };
}

function rateWarning(msg: string): boolean {
  return msg.toLowerCase().includes("limit");
}

function buildCombinedFeature(
  allCoords: LonLat[],
  totalDistanceMeters: number,
  totalTimeMs: number,
  allAltitudes: number[],
  targetMeters: number,
  pref: "flat" | "hills",
  elevIntensity: number,
  instructions?: any[]
): object {
  let elevProfile: { distanceMeters: number; elevation: number }[];
  if (allAltitudes.length > 2) {
    const step = totalDistanceMeters / (allAltitudes.length - 1);
    elevProfile = allAltitudes.map((e, i) => ({ distanceMeters: i * step, elevation: Math.round(e) }));
  } else {
    elevProfile = fakeElevationProfile(targetMeters, pref, elevIntensity);
  }

  const ascent = computeAscent(elevProfile);
  const distanceMiles = totalDistanceMeters / 1609.34;
  const timeMinutes =
    totalTimeMs > 0 ? Math.round(totalTimeMs / 1000 / 60) : Math.round(distanceMiles * 10);

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
      instructions: instructions ?? [],
      source: "graphhopper",
    },
  };
}

/**
 * NEW Park Loop approach:
 *
 *  1) Overpass gives us a boundary polyline.
 *  2) We compute the *nearest boundary entry point* to the runner.
 *  3) We create N boundary waypoints around the perimeter.
 *  4) We route: home -> entry, then entry -> (boundary waypoints...) -> entry, then reverse(home->entry) back home.
 *
 * This makes “Park Loop” actually wrap around the park instead of letting round_trip wander out.
 */
async function buildParkBoundaryLoopFeature({
  lat,
  lon,
  park,
  targetMeters,
  seed,
  pref,
  ghKey,
  mockCoords,
  elevIntensity,
  extraWarning,
  avoidMajorRoads,
}: {
  lat: number;
  lon: number;
  park: ParkPick;
  targetMeters: number;
  seed: number; // currently unused but kept for compatibility / future randomness
  pref: "flat" | "hills";
  ghKey: string;
  mockCoords: LonLat[];
  elevIntensity: number;
  extraWarning?: string | null;
  avoidMajorRoads?: boolean;
}): Promise<object> {
  try {
    const entryLonLat = park.entry; // [lon, lat]
    const entryLatLon: LatLon = [entryLonLat[1], entryLonLat[0]];

    // Leg 1: home -> park entry
    const { path: toPath, coords: toCoords } = await graphHopperRoute(
      [[lat, lon], entryLatLon],
      ghKey,
      "foot",
      avoidMajorRoads
    );
    const toDistance = typeof toPath?.distance === "number" ? toPath.distance : 0;
    const toTime = typeof toPath?.time === "number" ? toPath.time : 0;

    // Remaining budget for the park loop
    const loopBudget = Math.max(600, targetMeters - toDistance * 2);

    // Create boundary waypoints around perimeter starting near the closest segment.
    const originLat = lat;
    const nearest = nearestBoundaryPoint(park.boundary, lon, lat, originLat);
    const wpsLonLat = boundaryWaypoints(park.boundary, nearest.segIndex, PARK_WAYPOINTS, originLat);

    // If boundary is weird / too small, fall back to old behavior (mock)
    if (!wpsLonLat.length) {
      return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [
        "Park boundary was too small/unclear — showing estimated route.",
      ]);
    }

    // Route 2: entry -> waypoints -> entry (one lap)
    await sleep(GH_STAGGER_MS);

    const lapWaypoints: LatLon[] = [
      entryLatLon,
      ...wpsLonLat.map(([wLon, wLat]) => [wLat, wLon] as LatLon),
      entryLatLon,
    ];

    const { path: lapPath, coords: lapCoords } = await graphHopperRoute(
      lapWaypoints,
      ghKey,
      "foot",
      avoidMajorRoads
    );
    const lapDistance = typeof lapPath?.distance === "number" ? lapPath.distance : 0;
    const lapTime = typeof lapPath?.time === "number" ? lapPath.time : 0;

    // Decide laps based on loop budget vs actual lap distance
    const safeLap = Math.max(1, Math.min(PARK_MAX_LAPS, lapDistance > 0 ? Math.round(loopBudget / lapDistance) : 1));

    // Build loop coords by repeating lap geometry (avoid duplicating the first point each repeat)
    const lapLonLat: LonLat[] = lapCoords.map((c: any) => [c[0], c[1]]);
    const loopLonLat: LonLat[] = [];
    for (let i = 0; i < safeLap; i++) loopLonLat.push(...(i === 0 ? lapLonLat : lapLonLat.slice(1)));

    const loopActualDistance = lapDistance * safeLap;
    const loopActualTime = lapTime * safeLap;

    // Stitch coordinates: toPark + parkLoop + reverse(toPark)
    const toLonLat: LonLat[] = toCoords.map((c: any) => [c[0], c[1]]);
    const fromLonLat: LonLat[] = [...toLonLat].reverse();
    const allCoords: LonLat[] = [...toLonLat, ...loopLonLat, ...fromLonLat];

    // Altitudes stitching
    const toAlts = toCoords.map((c: any) => c?.[2]).filter((n: any) => typeof n === "number") as number[];
    const lapAlts = lapCoords.map((c: any) => c?.[2]).filter((n: any) => typeof n === "number") as number[];
    const loopAlts: number[] = [];
    for (let i = 0; i < safeLap; i++) loopAlts.push(...lapAlts);
    const allAlts = [...toAlts, ...loopAlts, ...[...toAlts].reverse()];

    const totalDistance = toDistance * 2 + loopActualDistance;
    const totalTime = toTime * 2 + loopActualTime;

    // Instructions: keep it simple (you can refine later)
    const parkLabel =
      (park.name ? park.name : "Park") + " — " + String(safeLap) + (safeLap === 1 ? " loop" : " loops");
    const instructions = [
      { text: `Run to ${park.name ?? "the park"}`, distanceMiles: Number((toDistance / 1609.34).toFixed(2)), sign: 0 },
      { text: parkLabel, distanceMiles: Number((loopActualDistance / 1609.34).toFixed(2)), sign: 0 },
      { text: "Retrace your route back to start", distanceMiles: Number((toDistance / 1609.34).toFixed(2)), sign: 4 },
    ];

    const feature = buildCombinedFeature(
      allCoords,
      totalDistance,
      totalTime,
      allAlts,
      targetMeters,
      pref,
      elevIntensity,
      instructions
    ) as any;

    feature.properties.parkName = park.name ?? null;
    feature.properties.parkEntryLonLat = entryLonLat;
    feature.properties.parkBoundaryAreaM2 = Math.round(park.areaM2);
    feature.properties.parkBoundaryPerimeterM = Math.round(park.perimeterM);
    feature.properties.parkLaps = safeLap;
    feature.properties.transitDistanceMiles = Number(((toDistance * 2) / 1609.34).toFixed(2));

    if (extraWarning) feature.properties.warnings = [extraWarning, ...(feature.properties.warnings ?? [])];

    return feature;
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    console.warn("Park boundary loop GH failed:", msg);
    const warning = rateWarning(msg)
      ? "GraphHopper rate limit reached — showing estimated route. Wait a minute and try again."
      : "Park loop route failed, showing estimated route.";
    return buildMockFeature(mockCoords, targetMeters, pref, elevIntensity, [warning]);
  }
}

async function buildPointToPointFeature({
  waypoints,
  mockCoords,
  targetMeters,
  pref,
  ghKey,
  ghProfile,
  elevIntensity,
  avoidMajorRoads,
}: {
  waypoints: LatLon[];
  mockCoords: LonLat[];
  targetMeters: number;
  pref: "flat" | "hills";
  ghKey: string | undefined;
  ghProfile: string;
  elevIntensity: number;
  avoidMajorRoads?: boolean;
}): Promise<object> {
  if (ghKey) {
    try {
      const { path, coords } = await graphHopperRoute(waypoints, ghKey, ghProfile, avoidMajorRoads);
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

async function buildRoundTripFeature({
  lat,
  lon,
  targetMeters,
  seed,
  mockCoords,
  pref,
  ghKey,
  ghProfile,
  elevIntensity,
  avoidMajorRoads,
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
  avoidMajorRoads?: boolean;
}): Promise<object> {
  if (ghKey) {
    try {
      const { path, coords } = await ghRoundTrip(lat, lon, targetMeters, seed, ghKey, ghProfile, avoidMajorRoads);
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
      surfacePref, // unused currently (GH free tier)
      loopAtPark,
      parkSearch,
      avoidMajorRoads,
    } = body;

    const avoidMajor: boolean = avoidMajorRoads === true;

    if (!startLatLng) return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number") {
      return res.status(400).json({ error: "Missing targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    // Free-tier GH supports foot; we keep it simple.
    const ghProfile = "foot";

    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills" ? [25, 70, 115, 160, 205, 250, 295, 340] : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    // ── Out-and-back ──────────────────────────────────────────────────────────
    if (type === "out-and-back") {
      const bearing2 = bearing + 35;
      const bearing3 = bearing + 70;

      const f1 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters1, bearing),
        mockCoords: makeOutAndBack(startLonLat, meters1, bearing),
        targetMeters: meters1,
        pref,
        ghKey: GH_KEY,
        ghProfile,
        elevIntensity: 1.0,
        avoidMajorRoads: avoidMajor,
      });
      await sleep(GH_STAGGER_MS);

      const f2 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters2, bearing2),
        mockCoords: makeOutAndBack(startLonLat, meters2, bearing2),
        targetMeters: meters2,
        pref,
        ghKey: GH_KEY,
        ghProfile,
        elevIntensity: pref === "hills" ? 0.85 : 0.8,
        avoidMajorRoads: avoidMajor,
      });
      await sleep(GH_STAGGER_MS);

      const f3 = await buildPointToPointFeature({
        waypoints: buildOutAndBackWaypoints(lat, lon, meters3, bearing3),
        mockCoords: makeOutAndBack(startLonLat, meters3, bearing3),
        targetMeters: meters3,
        pref,
        ghKey: GH_KEY,
        ghProfile,
        elevIntensity: pref === "hills" ? 1.55 : 1.25,
        avoidMajorRoads: avoidMajor,
      });

      return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });
    }

    // ── Park Loop (NEW: boundary entry + perimeter waypoints) ─────────────────
    if (loopAtPark) {
      const searchName: string | null =
        typeof parkSearch === "string" && parkSearch.trim().length > 0 ? parkSearch.trim() : null;

      let park: ParkPick | null = null;
      let parkWarning: string | null = null;

      if (GH_KEY) {
        if (searchName) {
          park = await findParkByNameWithBoundary(searchName, lat, lon).catch((e) => {
            console.warn("Overpass named park lookup failed:", e?.message);
            return null;
          });
          if (!park) {
            parkWarning = `Couldn't find "${searchName}" nearby — routing to the nearest park instead.`;
            park = await findNearestParkWithBoundary(lat, lon).catch(() => null);
          }
        } else {
          park = await findNearestParkWithBoundary(lat, lon).catch((e) => {
            console.warn("Overpass nearest park lookup failed:", e?.message);
            return null;
          });
        }
      }

      if (park && GH_KEY) {
        const f1 = await buildParkBoundaryLoopFeature({
          lat,
          lon,
          park,
          targetMeters: meters1,
          seed: seedNum * 3,
          pref,
          ghKey: GH_KEY!,
          mockCoords: makeLoop(startLonLat, meters1, pref),
          elevIntensity: 1.0,
          extraWarning: parkWarning,
          avoidMajorRoads: avoidMajor,
        });
        await sleep(GH_STAGGER_MS);

        const f2 = await buildParkBoundaryLoopFeature({
          lat,
          lon,
          park,
          targetMeters: meters2,
          seed: seedNum * 3 + 1,
          pref,
          ghKey: GH_KEY!,
          mockCoords: makeLoop(startLonLat, meters2, pref),
          elevIntensity: pref === "hills" ? 0.85 : 0.8,
          extraWarning: parkWarning,
          avoidMajorRoads: avoidMajor,
        });
        await sleep(GH_STAGGER_MS);

        const f3 = await buildParkBoundaryLoopFeature({
          lat,
          lon,
          park,
          targetMeters: meters3,
          seed: seedNum * 3 + 2,
          pref,
          ghKey: GH_KEY!,
          mockCoords: makeLoop(startLonLat, meters3, pref),
          elevIntensity: pref === "hills" ? 1.55 : 1.25,
          extraWarning: parkWarning,
          avoidMajorRoads: avoidMajor,
        });

        return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });
      }

      console.warn("Park Loop: no suitable park boundary found, falling back to standard loop");
    }

    // ── Standard Loop ─────────────────────────────────────────────────────────
    const f1 = await buildRoundTripFeature({
      lat,
      lon,
      targetMeters: meters1,
      seed: seedNum * 3,
      mockCoords: makeLoop(startLonLat, meters1, pref),
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: 1.0,
      avoidMajorRoads: avoidMajor,
    });
    await sleep(GH_STAGGER_MS);

    const f2 = await buildRoundTripFeature({
      lat,
      lon,
      targetMeters: meters2,
      seed: seedNum * 3 + 1,
      mockCoords: makeLoop(startLonLat, meters2, pref),
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 0.85 : 0.8,
      avoidMajorRoads: avoidMajor,
    });
    await sleep(GH_STAGGER_MS);

    const f3 = await buildRoundTripFeature({
      lat,
      lon,
      targetMeters: meters3,
      seed: seedNum * 3 + 2,
      mockCoords: makeLoop(startLonLat, meters3, pref),
      pref,
      ghKey: GH_KEY,
      ghProfile,
      elevIntensity: pref === "hills" ? 1.55 : 1.25,
      avoidMajorRoads: avoidMajor,
    });

    return res.status(200).json({ type: "FeatureCollection", features: [f1, f2, f3] });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
