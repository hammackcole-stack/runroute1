// api/route.ts

type LatLon = [number, number]; // [lat, lon]
type LonLat = [number, number]; // [lon, lat]

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}
function metersToLat(m: number) {
  return m / 110540;
}

// --------------------
// Tiny in-memory cache
// --------------------
type CacheEntry = { expiresAt: number; value: any };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheGet(key: string) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key: string, value: any) {
  CACHE.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  if (CACHE.size > 200) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
}

// --------------------
// GH helpers
// --------------------
function buildCustomModel(opts: {
  surfacePref: "trail" | "road" | "mixed";
  avoidMajorRoads: boolean;
}) {
  const { surfacePref, avoidMajorRoads } = opts;
  const priority: any[] = [];

  if (avoidMajorRoads) {
    priority.push(
      { if: "road_class == MOTORWAY", multiply_by: "0.05" },
      { if: "road_class == TRUNK", multiply_by: "0.15" },
      { if: "road_class == PRIMARY", multiply_by: "0.25" },
      { if: "road_class == SECONDARY", multiply_by: "0.45" }
    );
  }

  if (surfacePref === "trail") {
    priority.push(
      { if: "road_class == PATH", multiply_by: "1.5" },
      { if: "road_class == TRACK", multiply_by: "1.25" },
      { if: "road_class == FOOTWAY", multiply_by: "1.4" },
      { if: "road_class == CYCLEWAY", multiply_by: "1.1" },
      { if: "road_class == RESIDENTIAL", multiply_by: "0.7" },
      { if: "road_class == TERTIARY", multiply_by: "0.55" }
    );
  } else if (surfacePref === "road") {
    priority.push(
      { if: "road_class == RESIDENTIAL", multiply_by: "1.25" },
      { if: "road_class == UNCLASSIFIED", multiply_by: "1.15" },
      { if: "road_class == SERVICE", multiply_by: "1.1" },
      { if: "road_class == PATH", multiply_by: "0.55" },
      { if: "road_class == TRACK", multiply_by: "0.65" },
      { if: "road_class == FOOTWAY", multiply_by: "0.75" }
    );
  }

  return { priority };
}

function buildPointsForRoute(args: {
  routeType: "loop" | "out-and-back";
  start: LatLon; // [lat,lon]
  targetMeters: number;
  bearingDeg: number;
}) {
  const { routeType, start, targetMeters, bearingDeg } = args;
  const [lat, lon] = start;

  if (routeType === "out-and-back") {
    const oneWay = targetMeters / 2;
    const b = (bearingDeg * Math.PI) / 180;
    const dLon = metersToLon(oneWay * Math.cos(b), lat);
    const dLat = metersToLat(oneWay * Math.sin(b));
    const mid: LatLon = [lat + dLat, lon + dLon];
    return [start, mid, start];
  }

  const r = targetMeters / (2 * Math.PI);
  const a = (bearingDeg * Math.PI) / 180;

  const p1: LatLon = [
    lat + metersToLat(r * Math.sin(a)),
    lon + metersToLon(r * Math.cos(a), lat),
  ];
  const p2: LatLon = [
    lat + metersToLat(r * Math.sin(a + (2 * Math.PI) / 3)),
    lon + metersToLon(r * Math.cos(a + (2 * Math.PI) / 3), lat),
  ];
  const p3: LatLon = [
    lat + metersToLat(r * Math.sin(a + (4 * Math.PI) / 3)),
    lon + metersToLon(r * Math.cos(a + (4 * Math.PI) / 3), lat),
  ];

  return [start, p1, p2, p3, start];
}

function computeAscent(profile: { elevation: number }[]) {
  let ascent = 0;
  for (let i = 1; i < profile.length; i++) {
    const diff = profile[i].elevation - profile[i - 1].elevation;
    if (diff > 0) ascent += diff;
  }
  return ascent;
}

function scoreRoute(ascentMeters: number, pref: "flat" | "hills") {
  const target = pref === "flat" ? 60 : 220;
  const tolerance = pref === "flat" ? 90 : 160;
  const delta = Math.abs(ascentMeters - target);
  const raw = 100 - (delta / tolerance) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function buildElevationProfileFromCoords(
  coords: number[][],
  fallbackMeters: number,
  pref: "flat" | "hills"
) {
  const altitudes = coords.map((c) => c?.[2]).filter((n) => typeof n === "number") as number[];
  if (altitudes.length > 2) {
    const step = fallbackMeters / (altitudes.length - 1);
    return altitudes.map((e, i) => ({
      distanceMeters: i * step,
      elevation: Math.round(e),
    }));
  }

  // synth fallback (should be rare once GH elevation works)
  const pts = 50;
  const out: { distanceMeters: number; elevation: number }[] = [];
  const base = 120;
  const amp = pref === "hills" ? 35 : 8;
  for (let i = 0; i <= pts; i++) {
    const d = (i / pts) * fallbackMeters;
    const elev =
      base +
      amp * Math.sin((i / pts) * 2 * Math.PI) +
      (pref === "hills" ? amp * 0.4 * Math.sin((i / pts) * 6 * Math.PI) : 0);
    out.push({ distanceMeters: d, elevation: Math.round(elev) });
  }
  return out;
}

async function graphHopperRoute(args: {
  key: string;
  points: LatLon[]; // [lat,lon]
  customModel: any;
  timeoutMs: number;
}) {
  const { key, points, customModel, timeoutMs } = args;

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", "foot");
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const ghResp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        points, // MUST be [lat,lon]
        custom_model: customModel,
      }),
    });

    const ghJson: any = await ghResp.json().catch(() => ({}));
    if (!ghResp.ok) {
      const msg = ghJson?.message || ghJson?.error || `GraphHopper error (${ghResp.status})`;
      throw new Error(msg);
    }

    const path = ghJson?.paths?.[0];
    const coords = path?.points?.coordinates as number[][]; // [lon,lat,(ele?)]
    if (!coords?.length) throw new Error("GraphHopper returned no coordinates");

    return {
      distanceMeters: typeof path?.distance === "number" ? path.distance : null,
      timeMs: typeof path?.time === "number" ? path.time : null,
      coordsLonLat: coords.map((c) => [c[0], c[1]]), // GeoJSON wants [lon,lat]
      coordsRaw: coords,
    };
  } finally {
    clearTimeout(t);
  }
}

export const config = { runtime: "nodejs" };

// Classic Vercel Node handler signature (no @vercel/node import needed)
export default async function handler(req: any, res: any) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "API is alive. Use POST to generate routes." });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Vercel usually parses JSON into req.body automatically
    const body =
      typeof req.body === "string"
        ? (() => {
            try { return JSON.parse(req.body); } catch { return null; }
          })()
        : req.body;

    const {
      startLatLng,
      routeType,
      targetMeters,
      elevationPref,
      directionSeed,
      surfacePref,
      avoidMajorRoads,
    } = body || {};

    if (!startLatLng || !Array.isArray(startLatLng) || startLatLng.length !== 2) {
      return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    }
    if (!targetMeters || typeof targetMeters !== "number") {
      return res.status(400).json({ error: "Missing targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" =
      routeType === "out-and-back" ? "out-and-back" : "loop";
    const surface: "trail" | "road" | "mixed" =
      surfacePref === "trail" || surfacePref === "road" ? surfacePref : "mixed";
    const avoidMaj = !!avoidMajorRoads;

    const [lat, lon] = startLatLng as LatLon; // [lat,lon]
    const start: LatLon = [lat, lon];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const baseBearing = candidates[seedNum % candidates.length];
    const bearings = [baseBearing, baseBearing + 35, baseBearing + 70];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;
    if (!GH_KEY) {
      return res.status(200).json({
        type: "FeatureCollection",
        features: [],
        error: "No GH_KEY set on server.",
      });
    }

    const cacheKey = JSON.stringify({
      start,
      type,
      targetMeters: Math.round(targetMeters),
      pref,
      surface,
      avoidMaj,
      seed: seedNum,
    });

    const cached = cacheGet(cacheKey);
    if (cached) return res.status(200).json(cached);

    const customModel = buildCustomModel({ surfacePref: surface, avoidMajorRoads: avoidMaj });

    const results = await Promise.all(
      bearings.map((b) => {
        const points = buildPointsForRoute({
          routeType: type,
          start,
          targetMeters,
          bearingDeg: b,
        });
        return graphHopperRoute({
          key: GH_KEY,
          points,
          customModel,
          timeoutMs: 12000,
        });
      })
    );

    const features = results.map((r, idx) => {
      const distM = r.distanceMeters ?? targetMeters;
      const distMiles = distM / 1609.34;
      const timeMinutes =
        typeof r.timeMs === "number"
          ? Math.round(r.timeMs / 1000 / 60)
          : Math.round(distMiles * 10);

      const elevProfile = buildElevationProfileFromCoords(r.coordsRaw, distM, pref);
      const ascent = computeAscent(elevProfile);
      const score = scoreRoute(ascent, pref);

      return {
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.coordsLonLat },
        properties: {
          metrics: {
            distanceMiles: Number(distMiles.toFixed(2)),
            timeMinutes,
            totalAscent: ascent,
            totalDescent: ascent,
          },
          scoring: { overallScore: score },
          warnings:
            idx === 0
              ? []
              : ["Real GraphHopper alternate (different anchor points / bearing)."],
          elevationProfile: elevProfile,
          source: "graphhopper",
        },
      };
    });

    const payload = { type: "FeatureCollection", features };
    cacheSet(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
