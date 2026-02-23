// api/route.ts

type LatLon = [number, number]; // [lat, lon]
type LonLat = [number, number]; // [lon, lat]

export const config = {
  runtime: "nodejs",
};

function sendJson(res: any, status: number, data: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}
function metersToLat(m: number) {
  return m / 110540;
}

/**
 * Ensure GraphHopper always receives [lat, lon].
 * If it's swapped (e.g. [-118, 34]) we flip it.
 */
function normalizeLatLon(p: any, label = "point"): LatLon {
  const a = Number(p?.[0]);
  const b = Number(p?.[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`${label} is not numeric`);
  }

  let lat = a;
  let lon = b;

  // swapped if first can't be lat but second can be
  if (Math.abs(a) > 85 && Math.abs(b) <= 85) {
    lat = b;
    lon = a;
  }

  if (lat < -85.0511284 || lat > 85.0511284 || lon < -180 || lon > 180) {
    throw new Error(`${label} is out of bounds after normalization: ${lat},${lon}`);
  }

  return [lat, lon];
}

// Simple geometry generators (fallback if GraphHopper fails)
function makeLoop(startLonLat: LonLat, targetMeters: number, hilliness: "flat" | "hills") {
  const points = 70;
  const radius = targetMeters / (2 * Math.PI);
  const coords: LonLat[] = [];
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * 2 * Math.PI;
    const hillFactor = hilliness === "hills" ? 1 + 0.2 * Math.sin(2 * a) : 1;
    const r = radius * hillFactor;

    const dx = metersToLon(r * Math.cos(a), startLonLat[1]);
    const dy = metersToLat(r * Math.sin(a));
    coords.push([startLonLat[0] + dx, startLonLat[1] + dy]);
  }
  return coords;
}

function makeOutAndBack(startLonLat: LonLat, targetMeters: number, bearingDeg: number) {
  const oneWay = targetMeters / 2;
  const b = (bearingDeg * Math.PI) / 180;
  const dx = metersToLon(oneWay * Math.cos(b), startLonLat[1]);
  const dy = metersToLat(oneWay * Math.sin(b));
  const out: LonLat = [startLonLat[0] + dx, startLonLat[1] + dy];
  return [startLonLat, out, startLonLat];
}

function fakeElevationProfile(lenMeters: number, pref: "flat" | "hills", intensity = 1) {
  const pts = 50;
  const out: { distanceMeters: number; elevation: number }[] = [];
  const base = 120;
  const amp = (pref === "hills" ? 35 : 8) * intensity;

  for (let i = 0; i <= pts; i++) {
    const d = (i / pts) * lenMeters;
    const elev =
      base +
      amp * Math.sin((i / pts) * 2 * Math.PI) +
      (pref === "hills" ? amp * 0.4 * Math.sin((i / pts) * 6 * Math.PI) : 0);

    out.push({ distanceMeters: d, elevation: Math.round(elev) });
  }
  return out;
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

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: any) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function graphHopperRoute(params: { GH_KEY: string; points: LatLon[]; profile?: string }) {
  const profile = params.profile ?? "foot";

  // Normalize ALL points right before GH call
  const safePoints = params.points.map((p, i) => normalizeLatLon(p, `Point ${i}`));

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", params.GH_KEY);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", profile);
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: safePoints }),
      signal: controller.signal,
    });

    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.message || data?.error || `GraphHopper error (status ${resp.status})`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function featureFromGh(ghJson: any, pref: "flat" | "hills", fallbackMeters: number) {
  const path = ghJson?.paths?.[0];
  const coordsLonLat: any[] = path?.points?.coordinates || [];
  if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

  const distanceMeters = typeof path?.distance === "number" ? path.distance : fallbackMeters;

  const altitudes = coordsLonLat.map((c) => c?.[2]).filter((n) => typeof n === "number");
  let elevProfile: { distanceMeters: number; elevation: number }[] = [];

  if (altitudes.length > 2) {
    const step = distanceMeters / (altitudes.length - 1);
    elevProfile = altitudes.map((e: number, i: number) => ({
      distanceMeters: i * step,
      elevation: Math.round(e),
    }));
  } else {
    elevProfile = fakeElevationProfile(distanceMeters, pref, 1);
  }

  const ascent = computeAscent(elevProfile);
  const score = scoreRoute(ascent, pref);

  const distanceMiles = distanceMeters / 1609.34;
  const timeMinutes =
    typeof path?.time === "number" ? Math.round(path.time / 1000 / 60) : Math.round(distanceMiles * 10);

  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coordsLonLat.map((c) => [c[0], c[1]]), // GeoJSON [lon,lat]
    },
    properties: {
      metrics: {
        distanceMiles: Number(distanceMiles.toFixed(2)),
        timeMinutes,
        totalAscent: ascent,
        totalDescent: ascent,
      },
      scoring: { overallScore: score },
      warnings: [],
      elevationProfile: elevProfile,
      source: "graphhopper",
    },
  };
}

export default async function handler(req: any, res: any) {
  try {
    // ✅ GET should ALWAYS respond instantly
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, message: "API is alive. Use POST to generate routes." });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Use POST" });
    }

    const body = await readBody(req);

    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    if (!startLatLng || !Array.isArray(startLatLng) || startLatLng.length !== 2) {
      return sendJson(res, 400, { error: "Missing startLatLng: [lat,lng]" });
    }
    if (typeof targetMeters !== "number" || !Number.isFinite(targetMeters) || targetMeters <= 0) {
      return sendJson(res, 400, { error: "Missing targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    const start: LatLon = normalizeLatLon(startLatLng, "startLatLng");
    const [lat, lon] = start;
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const baseBearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    if (GH_KEY) {
      try {
        const buildPoints = (bearingDeg: number): LatLon[] => {
          if (type === "out-and-back") {
            const oneWay = targetMeters / 2;
            const b = (bearingDeg * Math.PI) / 180;
            const dLon = metersToLon(oneWay * Math.cos(b), lat);
            const dLat = metersToLat(oneWay * Math.sin(b));
            const mid: LatLon = [lat + dLat, lon + dLon];
            return [start, mid, start];
          }

          const r = targetMeters / (2 * Math.PI);
          const p1: LatLon = [lat + metersToLat(r), lon];
          const p2: LatLon = [lat, lon + metersToLon(r, lat)];
          const p3: LatLon = [lat - metersToLat(r), lon];
          return [start, p1, p2, p3, start];
        };

        const [gh1, gh2, gh3] = await Promise.all([
          graphHopperRoute({ GH_KEY, points: buildPoints(baseBearing) }),
          graphHopperRoute({ GH_KEY, points: buildPoints(baseBearing + 35) }),
          graphHopperRoute({ GH_KEY, points: buildPoints(baseBearing + 70) }),
        ]);

        const f1 = featureFromGh(gh1, pref, targetMeters);
        const f2 = featureFromGh(gh2, pref, targetMeters);
        const f3 = featureFromGh(gh3, pref, targetMeters);

        return sendJson(res, 200, { type: "FeatureCollection", features: [f1, f2, f3] });
      } catch (e: any) {
        console.warn("GraphHopper failed; falling back to mock:", e?.message || e);
      }
    }

    // ---- Mock fallback ----
    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    const coords1 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters1, baseBearing)
        : makeLoop(startLonLat, meters1, pref);

    const coords2 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters2, baseBearing + 35)
        : makeLoop(startLonLat, meters2, pref);

    const coords3 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters3, baseBearing + 70)
        : makeLoop(startLonLat, meters3, pref);

    const elev1 = fakeElevationProfile(meters1, pref, 1.0);
    const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
    const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);

    const asc1 = computeAscent(elev1);
    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

    const feature = (coords: LonLat[], meters: number, elev: any, asc: number) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        metrics: {
          distanceMiles: Number((meters / 1609.34).toFixed(2)),
          timeMinutes: Math.round((meters / 1609.34) * 10),
          totalAscent: asc,
          totalDescent: asc,
        },
        scoring: { overallScore: scoreRoute(asc, pref) },
        warnings: ["Using mock (GraphHopper unavailable or failed)."],
        elevationProfile: elev,
        source: "mock",
      },
    });

    return sendJson(res, 200, {
      type: "FeatureCollection",
      features: [
        feature(coords1, meters1, elev1, asc1),
        feature(coords2, meters2, elev2, asc2),
        feature(coords3, meters3, elev3, asc3),
      ],
    });
  } catch (e: any) {
    console.error(e);
    return sendJson(res, 500, { error: e?.message || "Server error" });
  }
}
