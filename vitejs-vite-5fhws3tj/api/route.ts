// api/route.ts

type LatLng = [number, number]; // [lat, lng]
type LonLat = [number, number]; // [lon, lat]

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}
function metersToLat(m: number) {
  return m / 110540;
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

// Supports intensity so each route can have different “hilliness”
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

// Helper to safely read JSON body
async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") {
      return Response.json({ ok: true, message: "API is alive. Use POST to generate routes." });
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
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    const [lat, lng] = startLatLng as LatLng;
    const startLonLat: LonLat = [lng, lat];

    // Cycle bearings so "Generate" changes direction
    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    // ----------------------------
    // Try GraphHopper (real roads)
    // ----------------------------
    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    if (GH_KEY) {
      try {
        // IMPORTANT: GraphHopper expects points as [lon, lat]  [oai_citation:2‡docs.graphhopper.com](https://docs.graphhopper.com/openapi/routing/postroute.md)
        const ghPoints: LonLat[] = [];

        if (type === "out-and-back") {
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;

          const dLon = metersToLon(oneWay * Math.cos(b), lat);
          const dLat = metersToLat(oneWay * Math.sin(b));

          const midLonLat: LonLat = [lng + dLon, lat + dLat];

          ghPoints.push([lng, lat], midLonLat, [lng, lat]);
        } else {
          const r = targetMeters / (2 * Math.PI);
          const p1: LonLat = [lng, lat + metersToLat(r)];
          const p2: LonLat = [lng + metersToLon(r, lat), lat];
          const p3: LonLat = [lng, lat - metersToLat(r)];
          ghPoints.push([lng, lat], p1, p2, p3, [lng, lat]);
        }

        const ghUrl = new URL("https://graphhopper.com/api/1/route");
        ghUrl.searchParams.set("key", GH_KEY);

        // Timeout so we don't spin forever
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 12_000);

        const ghResp = await fetch(ghUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            profile: "foot",
            points: ghPoints, // [lon,lat]
            points_encoded: false,
            instructions: false,
            calc_points: true,
            elevation: true,
          }),
        }).finally(() => clearTimeout(t));

        const ghJson: any = await ghResp.json().catch(() => ({}));

        if (!ghResp.ok) {
          const msg =
            ghJson?.message ||
            ghJson?.error ||
            `GraphHopper error (status ${ghResp.status})`;
          throw new Error(msg);
        }

        const path = ghJson?.paths?.[0];
        const coordsLonLat: any[] = path?.points?.coordinates || [];
        if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

        // Elev profile from GH if it includes altitude in 3rd dimension
        let elevProfile: { distanceMeters: number; elevation: number }[] = [];
        const altitudes = coordsLonLat.map((c) => c?.[2]).filter((n) => typeof n === "number");

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

        // Route 1: GH
        const feature1 = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: coordsLonLat.map((c) => [c[0], c[1]]), // [lon,lat]
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

        // Route 2/3: mock alternates (distinct elevation + score)
        const meters2 = targetMeters * 0.98;
        const meters3 = targetMeters * 1.02;

        const feature2Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, meters2, bearing + 35)
            : makeLoop(startLonLat, meters2, pref);

        const feature3Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, meters3, bearing + 70)
            : makeLoop(startLonLat, meters3, pref);

        const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.9 : 0.8);
        const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);

        const asc2 = computeAscent(elev2);
        const asc3 = computeAscent(elev3);

        const feature2 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: feature2Coords },
          properties: {
            metrics: {
              distanceMiles: Number((meters2 / 1609.34).toFixed(2)),
              timeMinutes: Math.round((meters2 / 1609.34) * 10),
              totalAscent: asc2,
              totalDescent: asc2,
            },
            scoring: { overallScore: scoreRoute(asc2, pref) },
            warnings: ["Alt route is still mock geometry (for now)."],
            elevationProfile: elev2,
            source: "mock",
          },
        };

        const feature3 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: feature3Coords },
          properties: {
            metrics: {
              distanceMiles: Number((meters3 / 1609.34).toFixed(2)),
              timeMinutes: Math.round((meters3 / 1609.34) * 10),
              totalAscent: asc3,
              totalDescent: asc3,
            },
            scoring: { overallScore: scoreRoute(asc3, pref) },
            warnings: ["Alt route is still mock geometry (for now)."],
            elevationProfile: elev3,
            source: "mock",
          },
        };

        return Response.json({ type: "FeatureCollection", features: [feature1, feature2, feature3] });
      } catch (e: any) {
        console.warn("GraphHopper route failed, falling back to mock:", e?.message || e);
      }
    }

    // ----------------------------
    // Fallback: geometry-only mock (different elevation per route)
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
        warnings: ["GraphHopper failed; using mock."],
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
        warnings: ["GraphHopper failed; using mock."],
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
        warnings: ["GraphHopper failed; using mock."],
        elevationProfile: elev3,
        source: "mock",
      },
    };

    return Response.json({ type: "FeatureCollection", features: [feature1, feature2, feature3] });
  } catch (e: any) {
    console.error(e);
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
