// api/route.ts

type LatLon = [number, number]; // [lat, lon]
type LonLat = [number, number]; // [lon, lat]

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}
function metersToLat(m: number) {
  return m / 110540;
}

/**
 * GraphHopper expects points in [lat, lon].
 * This function makes that true 100% of the time.
 *
 * If it looks swapped (e.g. [-118, 34]), we swap it to [34, -118].
 * If it's still invalid, we throw early (so we fall back to mock fast).
 */
function normalizeLatLon(p: any, label = "point"): LatLon {
  const a = Number(p?.[0]);
  const b = Number(p?.[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`${label} is not numeric`);
  }

  // If the first value can't be latitude but the second can, it's swapped.
  // Example: [-118, 34] -> swap -> [34, -118]
  let lat = a;
  let lon = b;
  const looksSwapped = Math.abs(a) > 85 && Math.abs(b) <= 85;
  if (looksSwapped) {
    lat = b;
    lon = a;
  }

  // Validate after swap (GH uses WebMercator-ish lat bounds ~85)
  if (lat < -85.0511284 || lat > 85.0511284 || lon < -180 || lon > 180) {
    throw new Error(
      `${label} is out of bounds even after normalization: ${lat},${lon}`
    );
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

// supports intensity so each route can have different “hilliness”
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

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export const config = { runtime: "nodejs" };

// ----- GraphHopper call wrapper (with hard timeout + normalization) -----
async function graphHopperRoute(opts: {
  GH_KEY: string;
  points: any[]; // we normalize inside
  profile?: string;
}) {
  const { GH_KEY } = opts;
  const profile = opts.profile ?? "foot";

  const safePoints: LatLon[] = opts.points.map((p, i) =>
    normalizeLatLon(p, `Point ${i}`)
  );

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", GH_KEY);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", profile);
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const ghResp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: safePoints }),
      signal: controller.signal,
    });

    const ghJson: any = await ghResp.json();

    if (!ghResp.ok) {
      const msg =
        ghJson?.message ||
        ghJson?.error ||
        `GraphHopper error (status ${ghResp.status})`;
      throw new Error(msg);
    }

    return ghJson;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") {
      return Response.json({
        ok: true,
        message: "API is alive. Use POST to generate routes.",
      });
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Use POST" }, { status: 405 });
    }

    const body = await readJson(req);
    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    if (!startLatLng || !Array.isArray(startLatLng) || startLatLng.length !== 2) {
      return Response.json({ error: "Missing startLatLng: [lat,lng]" }, { status: 400 });
    }
    if (!targetMeters || typeof targetMeters !== "number") {
      return Response.json({ error: "Missing targetMeters (number)" }, { status: 400 });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" =
      routeType === "out-and-back" ? "out-and-back" : "loop";

    // Normalize the incoming start point *once*.
    const start: LatLon = normalizeLatLon(startLatLng, "startLatLng");
    const [lat, lon] = start;
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // ----------------------------
    // Try GraphHopper (real roads)
    // ----------------------------
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

          // loop: 3 anchors + start
          const r = targetMeters / (2 * Math.PI);
          const p1: LatLon = [lat + metersToLat(r), lon];
          const p2: LatLon = [lat, lon + metersToLon(r, lat)];
          const p3: LatLon = [lat - metersToLat(r), lon];
          return [start, p1, p2, p3, start];
        };

        // 3 *real* GH alternates (different bearings)
        const b1 = bearing;
        const b2 = bearing + 35;
        const b3 = bearing + 70;

        const [gh1, gh2, gh3] = await Promise.all([
          graphHopperRoute({ GH_KEY, points: buildPoints(b1) }),
          graphHopperRoute({ GH_KEY, points: buildPoints(b2) }),
          graphHopperRoute({ GH_KEY, points: buildPoints(b3) }),
        ]);

        const toFeature = (ghJson: any) => {
          const path = ghJson?.paths?.[0];
          const coordsLonLat: any[] = path?.points?.coordinates || [];
          if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

          // Elevation profile
          let elevProfile: { distanceMeters: number; elevation: number }[] = [];
          const altitudes = coordsLonLat
            .map((c) => c?.[2])
            .filter((n) => typeof n === "number");

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

          const distanceMeters =
            typeof path?.distance === "number" ? path.distance : targetMeters;

          const distanceMiles = distanceMeters / 1609.34;
          const timeMinutes =
            typeof path?.time === "number"
              ? Math.round(path.time / 1000 / 60)
              : Math.round(distanceMiles * 10);

          return {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: coordsLonLat.map((c) => [c[0], c[1]]), // GeoJSON wants [lon,lat]
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
        };

        const f1 = toFeature(gh1);
        const f2 = toFeature(gh2);
        const f3 = toFeature(gh3);

        return Response.json({
          type: "FeatureCollection",
          features: [f1, f2, f3],
        });
      } catch (e: any) {
        console.warn("GraphHopper failed, falling back to mock:", e?.message || e);
      }
    }

    // ----------------------------
    // Fallback: geometry-only mock
    // ----------------------------
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

    const feature1 = {
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
    };

    const feature2 = {
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
    };

    const feature3 = {
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
    };

    return Response.json({
      type: "FeatureCollection",
      features: [feature1, feature2, feature3],
    });
  } catch (e: any) {
    console.error(e);
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
