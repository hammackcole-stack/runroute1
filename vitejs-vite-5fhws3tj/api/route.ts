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

// IMPORTANT: intensity makes each route’s elevation different
function fakeElevationProfile(lenMeters: number, pref: "flat" | "hills", intensity = 1) {
  const pts = 50;
  const out: { distanceMeters: number; elevation: number }[] = [];
  const base = 120;

  const baseAmp = pref === "hills" ? 35 : 8;
  const amp = baseAmp * intensity;

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

// Vercel/Next-style Request/Response works fine without @vercel/node types
export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const body = await req.json().catch(() => ({}));
    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    if (!startLatLng || !Array.isArray(startLatLng) || startLatLng.length !== 2) {
      return new Response(JSON.stringify({ error: "Missing startLatLng: [lat,lng]" }), { status: 400 });
    }
    if (!targetMeters || typeof targetMeters !== "number") {
      return new Response(JSON.stringify({ error: "Missing targetMeters (number)" }), { status: 400 });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    const [lat, lng] = startLatLng as LatLng;
    const startLonLat: LonLat = [lng, lat];

    // Cycle bearings so "Generate" changes direction
    const candidates =
      pref === "hills" ? [25, 70, 115, 160, 205, 250, 295, 340] : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY; // GH_KEY is what you set in Vercel
    const hasKey = Boolean(GH_KEY);

    // ----------------------------
    // Try GraphHopper (real roads)
    // ----------------------------
    if (hasKey) {
      try {
        const points: LatLng[] = [];

        if (type === "out-and-back") {
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;
          const dLon = metersToLon(oneWay * Math.cos(b), lat);
          const dLat = metersToLat(oneWay * Math.sin(b));
          const mid: LatLng = [lat + dLat, lng + dLon];
          points.push([lat, lng], mid, [lat, lng]);
        } else {
          const r = targetMeters / (2 * Math.PI);
          const p1: LatLng = [lat + metersToLat(r), lng];
          const p2: LatLng = [lat, lng + metersToLon(r, lat)];
          const p3: LatLng = [lat - metersToLat(r), lng];
          points.push([lat, lng], p1, p2, p3, [lat, lng]);
        }

        const ghUrl = new URL("https://graphhopper.com/api/1/route");
        ghUrl.searchParams.set("key", GH_KEY!);
        ghUrl.searchParams.set("points_encoded", "false");
        ghUrl.searchParams.set("profile", "foot");
        ghUrl.searchParams.set("instructions", "false");
        ghUrl.searchParams.set("calc_points", "true");
        ghUrl.searchParams.set("elevation", "true");

        const ghResp = await fetch(ghUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points }),
        });

        const ghJson: any = await ghResp.json();
        if (!ghResp.ok) throw new Error(ghJson?.message || "GraphHopper failed");

        const path = ghJson?.paths?.[0];
        const coordsLonLat: LonLat[] = path?.points?.coordinates || [];
        if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

        // Elevation profile from GH if present
        let elevProfile: { distanceMeters: number; elevation: number }[] = [];
        const ghElev = coordsLonLat.map((c: any) => c[2]).filter((n: any) => typeof n === "number");
        if (ghElev?.length) {
          const total = typeof path?.distance === "number" ? path.distance : targetMeters;
          const step = total / (ghElev.length - 1);
          elevProfile = ghElev.map((e: number, i: number) => ({
            distanceMeters: i * step,
            elevation: Math.round(e),
          }));
        } else {
          elevProfile = fakeElevationProfile(targetMeters, pref, 1.0);
        }

        const ascent = computeAscent(elevProfile);
        const score = scoreRoute(ascent, pref);

        const distanceMiles = (path.distance / 1609.34) || (targetMeters / 1609.34);
        const timeMinutes = path.time ? Math.round(path.time / 1000 / 60) : Math.round(distanceMiles * 10);

        const feature1 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coordsLonLat.map((c: any) => [c[0], c[1]]) },
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

        // Option 2/3 = mock alternates (still useful for variety)
        const feature2Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, targetMeters * 0.98, bearing + 35)
            : makeLoop(startLonLat, targetMeters * 0.92, pref);

        const feature3Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, targetMeters * 1.02, bearing + 70)
            : makeLoop(startLonLat, targetMeters * 1.08, pref);

        const elev2 = fakeElevationProfile(targetMeters, pref, pref === "flat" ? 0.85 : 1.0);
        const elev3 = fakeElevationProfile(targetMeters, pref, pref === "flat" ? 1.15 : 1.35);
        const asc2 = computeAscent(elev2);
        const asc3 = computeAscent(elev3);

        const feature2 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: feature2Coords },
          properties: {
            metrics: {
              distanceMiles: Number(((targetMeters * 0.98) / 1609.34).toFixed(2)),
              timeMinutes: Math.round(((targetMeters * 0.98) / 1609.34) * 10),
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
              distanceMiles: Number(((targetMeters * 1.02) / 1609.34).toFixed(2)),
              timeMinutes: Math.round(((targetMeters * 1.02) / 1609.34) * 10),
              totalAscent: asc3,
              totalDescent: asc3,
            },
            scoring: { overallScore: scoreRoute(asc3, pref) },
            warnings: ["Alt route is still mock geometry (for now)."],
            elevationProfile: elev3,
            source: "mock",
          },
        };

        return new Response(JSON.stringify({ type: "FeatureCollection", features: [feature1, feature2, feature3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e: any) {
        console.warn("GraphHopper failed; using mock fallback:", e?.message || e);
        // fall through to mock
      }
    }

    // ----------------------------
    // Fallback: geometry-only mock
    // ----------------------------
    const coords1 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters, bearing)
        : makeLoop(startLonLat, targetMeters, pref);

    const coords2 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters * 0.98, bearing + 35)
        : makeLoop(startLonLat, targetMeters * 0.92, pref);

    const coords3 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters * 1.02, bearing + 70)
        : makeLoop(startLonLat, targetMeters * 1.08, pref);

    // Different profiles per route => different climb + score + chart
    const elev1 = fakeElevationProfile(targetMeters, pref, pref === "flat" ? 0.75 : 0.9);
    const elev2 = fakeElevationProfile(targetMeters, pref, 1.0);
    const elev3 = fakeElevationProfile(targetMeters, pref, pref === "flat" ? 1.25 : 1.5);

    const asc1 = computeAscent(elev1);
    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

    const warning = hasKey
      ? "GraphHopper key found, but routing failed — using mock geometry."
      : "Mock mode: no GH_KEY env var found on server yet.";

    const features = [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords1 },
        properties: {
          metrics: {
            distanceMiles: Number((targetMeters / 1609.34).toFixed(2)),
            timeMinutes: Math.round((targetMeters / 1609.34) * 10),
            totalAscent: asc1,
            totalDescent: asc1,
          },
          scoring: { overallScore: scoreRoute(asc1, pref) },
          warnings: [warning],
          elevationProfile: elev1,
          source: "mock",
        },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords2 },
        properties: {
          metrics: {
            distanceMiles: Number(((targetMeters * 0.98) / 1609.34).toFixed(2)),
            timeMinutes: Math.round(((targetMeters * 0.98) / 1609.34) * 10),
            totalAscent: asc2,
            totalDescent: asc2,
          },
          scoring: { overallScore: scoreRoute(asc2, pref) },
          warnings: [warning],
          elevationProfile: elev2,
          source: "mock",
        },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords3 },
        properties: {
          metrics: {
            distanceMiles: Number(((targetMeters * 1.02) / 1609.34).toFixed(2)),
            timeMinutes: Math.round(((targetMeters * 1.02) / 1609.34) * 10),
            totalAscent: asc3,
            totalDescent: asc3,
          },
          scoring: { overallScore: scoreRoute(asc3, pref) },
          warnings: [warning],
          elevationProfile: elev3,
          source: "mock",
        },
      },
    ];

    return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e?.message || "Server error" }), { status: 500 });
  }
}
