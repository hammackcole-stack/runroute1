// api/route.ts

type LatLon = [number, number]; // [lat, lon]  <-- GraphHopper wants this
type LonLat = [number, number]; // [lon, lat]  <-- GeoJSON wants this

export const config = {
  runtime: "nodejs",
};

// ---------- helpers ----------
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
 * If it's swapped (e.g. [-118, 34]) we flip it to [34, -118].
 */
function normalizeLatLon(p: any, label = "point"): LatLon {
  if (!Array.isArray(p) || p.length < 2) {
    throw new Error(`Invalid ${label}: expected [lat, lon]`);
  }
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`Invalid ${label}: lat/lon must be numbers`);
  }

  // Swap if first can't be lat but second can
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];

  // Otherwise assume it's already [lat, lon]
  return [a, b];
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

    const dx = metersToLon(r * Math.cos(a), startLonLat[1]); // startLonLat[1] = lat
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

async function readBodyJson(req: any): Promise<any> {
  // Vercel often provides req.body already
  if (req.body && typeof req.body === "object") return req.body;

  // Otherwise read raw stream
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve());
    req.on("error", (e: any) => reject(e));
  });

  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function graphHopperRoute(points: LatLon[], key: string) {
  const safePoints = points.map((p, i) => normalizeLatLon(p, `point ${i}`));

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", "foot");
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  // Hard timeout so POST can’t hang forever
  const timeoutMs = 8000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: safePoints }),
      signal: ac.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`GraphHopper timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }

  const ghJson: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg =
      ghJson?.message ||
      ghJson?.error ||
      `GraphHopper error (status ${resp.status})`;
    throw new Error(msg);
  }

  const path = ghJson?.paths?.[0];
  const coords: any[] = path?.points?.coordinates || [];
  if (!coords.length) throw new Error("GraphHopper returned no coordinates");

  return { path, coords };
}

// ---------- handler ----------
export default async function handler(req: any, res: any) {
  // ✅ GET must always reply instantly and never hang
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, message: "API is alive. Use POST to generate routes." });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST" });
  }

  try {
    const body = await readBodyJson(req);
    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    if (!startLatLng) return sendJson(res, 400, { error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number") {
      return sendJson(res, 400, { error: "Missing targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    // ✅ Normalize incoming startLatLng to [lat, lon] (swap-protection)
    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // Try GH first (fast fail → mock)
    if (GH_KEY) {
      try {
        const points1: LatLon[] = [];

        if (type === "out-and-back") {
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;
          const dLon = metersToLon(oneWay * Math.cos(b), lat);
          const dLat = metersToLat(oneWay * Math.sin(b));
          const mid: LatLon = [lat + dLat, lon + dLon];
          points1.push([lat, lon], mid, [lat, lon]);
        } else {
          const r = targetMeters / (2 * Math.PI);
          const p1: LatLon = [lat + metersToLat(r), lon];
          const p2: LatLon = [lat, lon + metersToLon(r, lat)];
          const p3: LatLon = [lat - metersToLat(r), lon];
          points1.push([lat, lon], p1, p2, p3, [lat, lon]);
        }

        const { path, coords } = await graphHopperRoute(points1, GH_KEY);

        // GH coords = [lon, lat, ele?]
        const coordsLonLat: LonLat[] = coords.map((c: any) => [c[0], c[1]]);

        const altitudes = coords.map((c: any) => c?.[2]).filter((n: any) => typeof n === "number");
        let elevProfile: { distanceMeters: number; elevation: number }[] = [];
        if (altitudes.length > 2) {
          const total = typeof path?.distance === "number" ? path.distance : targetMeters;
          const step = total / (altitudes.length - 1);
          elevProfile = altitudes.map((e: number, i: number) => ({
            distanceMeters: i * step,
            elevation: Math.round(e),
          }));
        } else {
          elevProfile = fakeElevationProfile(targetMeters, pref, 1);
        }

        const ascent = computeAscent(elevProfile);
        const score = scoreRoute(ascent, pref);

        const distanceMeters = typeof path?.distance === "number" ? path.distance : targetMeters;
        const distanceMiles = distanceMeters / 1609.34;
        const timeMinutes =
          typeof path?.time === "number"
            ? Math.round(path.time / 1000 / 60)
            : Math.round(distanceMiles * 10);

        // Keep 2/3 mock until GH is rock solid
        const meters2 = targetMeters * 0.98;
        const meters3 = targetMeters * 1.02;

        const mock2 =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, meters2, bearing + 35)
            : makeLoop(startLonLat, meters2, pref);

        const mock3 =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, meters3, bearing + 70)
            : makeLoop(startLonLat, meters3, pref);

        const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
        const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);
        const asc2 = computeAscent(elev2);
        const asc3 = computeAscent(elev3);

        return sendJson(res, 200, {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "LineString", coordinates: coordsLonLat },
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
            },
            {
              type: "Feature",
              geometry: { type: "LineString", coordinates: mock2 },
              properties: {
                metrics: {
                  distanceMiles: Number((meters2 / 1609.34).toFixed(2)),
                  timeMinutes: Math.round((meters2 / 1609.34) * 10),
                  totalAscent: asc2,
                  totalDescent: asc2,
                },
                scoring: { overallScore: scoreRoute(asc2, pref) },
                warnings: ["Alt route is mock (for now)."],
                elevationProfile: elev2,
                source: "mock",
              },
            },
            {
              type: "Feature",
              geometry: { type: "LineString", coordinates: mock3 },
              properties: {
                metrics: {
                  distanceMiles: Number((meters3 / 1609.34).toFixed(2)),
                  timeMinutes: Math.round((meters3 / 1609.34) * 10),
                  totalAscent: asc3,
                  totalDescent: asc3,
                },
                scoring: { overallScore: scoreRoute(asc3, pref) },
                warnings: ["Alt route is mock (for now)."],
                elevationProfile: elev3,
                source: "mock",
              },
            },
          ],
        });
      } catch (e: any) {
        // GH failure should never break GET; POST falls back fast
        console.warn("GraphHopper failed; using mock:", e?.message || e);
      }
    }

    // Mock fallback
    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    const coords1 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters1, bearing)
        : makeLoop(startLonLat, meters1, pref);

    const coords2 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters2, bearing + 35)
        : makeLoop(startLonLat, meters2, pref);

    const coords3 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, meters3, bearing + 70)
        : makeLoop(startLonLat, meters3, pref);

    const elev1 = fakeElevationProfile(meters1, pref, pref === "hills" ? 1.0 : 1.0);
    const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
    const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);

    const asc1 = computeAscent(elev1);
    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

    return sendJson(res, 200, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords1 },
          properties: {
            metrics: {
              distanceMiles: Number((meters1 / 1609.34).toFixed(2)),
              timeMinutes: Math.round((meters1 / 1609.34) * 10),
              totalAscent: asc1,
              totalDescent: asc1,
            },
            scoring: { overallScore: scoreRoute(asc1, pref) },
            warnings: ["Using mock (GraphHopper unavailable or failed)."],
            elevationProfile: elev1,
            source: "mock",
          },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords2 },
          properties: {
            metrics: {
              distanceMiles: Number((meters2 / 1609.34).toFixed(2)),
              timeMinutes: Math.round((meters2 / 1609.34) * 10),
              totalAscent: asc2,
              totalDescent: asc2,
            },
            scoring: { overallScore: scoreRoute(asc2, pref) },
            warnings: ["Using mock (GraphHopper unavailable or failed)."],
            elevationProfile: elev2,
            source: "mock",
          },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords3 },
          properties: {
            metrics: {
              distanceMiles: Number((meters3 / 1609.34).toFixed(2)),
              timeMinutes: Math.round((meters3 / 1609.34) * 10),
              totalAscent: asc3,
              totalDescent: asc3,
            },
            scoring: { overallScore: scoreRoute(asc3, pref) },
            warnings: ["Using mock (GraphHopper unavailable or failed)."],
            elevationProfile: elev3,
            source: "mock",
          },
        },
      ],
    });
  } catch (e: any) {
    console.error(e);
    return sendJson(res, 500, { error: e?.message || "Server error" });
  }
}
