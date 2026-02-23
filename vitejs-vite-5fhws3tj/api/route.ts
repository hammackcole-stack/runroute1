// api/route.ts

type LatLng = [number, number]; // [lat, lng]
type LonLat = [number, number]; // [lon, lat]

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}
function metersToLat(m: number) {
  return m / 110540;
}

function validateLatLng(p: any, label = "point"): asserts p is LatLng {
  if (!Array.isArray(p) || p.length !== 2) {
    throw new Error(`Invalid ${label}: expected [lat,lng]`);
  }
  const lat = Number(p[0]);
  const lng = Number(p[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid ${label}: lat/lng must be numbers`);
  }
  if (lat < -90 || lat > 90) throw new Error(`Invalid ${label}: lat out of bounds (${lat})`);
  if (lng < -180 || lng > 180) throw new Error(`Invalid ${label}: lng out of bounds (${lng})`);
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

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(id);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(id);
        reject(e);
      });
  });
}

export default async function handler(req: any, res: any) {
  try {
    // IMPORTANT: always respond to GET fast (for debugging)
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "API is alive. Use POST to generate routes." });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Vercel usually parses JSON body for you, but handle string just in case
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    validateLatLng(startLatLng, "startLatLng");

    if (typeof targetMeters !== "number" || !Number.isFinite(targetMeters) || targetMeters <= 0) {
      return res.status(400).json({ error: "Missing/invalid targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    const [lat, lng] = startLatLng as LatLng;
    const startLonLat: LonLat = [lng, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];

    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[((seedNum % candidates.length) + candidates.length) % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // ---- GraphHopper attempt (fast-fail) ----
    if (GH_KEY) {
      try {
        const points: LatLng[] = [];

        if (type === "out-and-back") {
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;

          const dLat = metersToLat(oneWay * Math.sin(b));
          const dLon = metersToLon(oneWay * Math.cos(b), lat);

          const mid: LatLng = [lat + dLat, lng + dLon];
          validateLatLng(mid, "mid");

          points.push([lat, lng], mid, [lat, lng]);
        } else {
          const r = targetMeters / (2 * Math.PI);
          const p1: LatLng = [lat + metersToLat(r), lng];
          const p2: LatLng = [lat, lng + metersToLon(r, lat)];
          const p3: LatLng = [lat - metersToLat(r), lng];

          validateLatLng(p1, "p1");
          validateLatLng(p2, "p2");
          validateLatLng(p3, "p3");

          points.push([lat, lng], p1, p2, p3, [lat, lng]);
        }

        const ghUrl = new URL("https://graphhopper.com/api/1/route");
        ghUrl.searchParams.set("key", GH_KEY);
        ghUrl.searchParams.set("points_encoded", "false");
        ghUrl.searchParams.set("profile", "foot");
        ghUrl.searchParams.set("instructions", "false");
        ghUrl.searchParams.set("calc_points", "true");
        ghUrl.searchParams.set("elevation", "true");

        const ghResp = await withTimeout(
          fetch(ghUrl.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ points }),
          }),
          8000
        );

        const ghJson: any = await ghResp.json();

        if (!ghResp.ok) {
          throw new Error(ghJson?.message || ghJson?.error || `GraphHopper error (${ghResp.status})`);
        }

        const path = ghJson?.paths?.[0];
        const coordsLonLat: any[] = path?.points?.coordinates || [];
        if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

        const altitudes = coordsLonLat.map((c) => c?.[2]).filter((n) => typeof n === "number");

        const totalMeters = typeof path?.distance === "number" ? path.distance : targetMeters;

        const elevProfile =
          altitudes.length > 2
            ? altitudes.map((e: number, i: number) => ({
                distanceMeters: (i * totalMeters) / (altitudes.length - 1),
                elevation: Math.round(e),
              }))
            : fakeElevationProfile(targetMeters, pref, 1.0);

        const ascent = computeAscent(elevProfile);
        const score = scoreRoute(ascent, pref);

        const distanceMiles = totalMeters / 1609.34;
        const timeMinutes =
          typeof path?.time === "number" ? Math.round(path.time / 1000 / 60) : Math.round(distanceMiles * 10);

        const feature1 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coordsLonLat.map((c) => [c[0], c[1]]) },
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

        // Alternates: mock w/ different elevation intensities
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

        const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
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

        return res.status(200).json({ type: "FeatureCollection", features: [feature1, feature2, feature3] });
      } catch (e: any) {
        console.warn("GraphHopper route failed, falling back to mock:", e?.message || e);
      }
    }

    // ---- Mock fallback (always fast) ----
    const meters1 = targetMeters;
    const meters2 = targetMeters * 0.98;
    const meters3 = targetMeters * 1.02;

    const coords1 =
      type === "out-and-back" ? makeOutAndBack(startLonLat, meters1, bearing) : makeLoop(startLonLat, meters1, pref);
    const coords2 =
      type === "out-and-back" ? makeOutAndBack(startLonLat, meters2, bearing + 35) : makeLoop(startLonLat, meters2, pref);
    const coords3 =
      type === "out-and-back" ? makeOutAndBack(startLonLat, meters3, bearing + 70) : makeLoop(startLonLat, meters3, pref);

    const elev1 = fakeElevationProfile(meters1, pref, 1.0);
    const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
    const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);

    const asc1 = computeAscent(elev1);
    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

    const warn = GH_KEY ? "GraphHopper failed; using mock." : "Mock mode: no GH_KEY env var found on server yet.";

    return res.status(200).json({
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
            warnings: [warn],
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
            warnings: [warn],
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
            warnings: [warn],
            elevationProfile: elev3,
            source: "mock",
          },
        },
      ],
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
