// api/route.ts

type LatLon = [number, number]; // [lat, lon]  <-- GraphHopper wants this
type LonLat = [number, number]; // [lon, lat]  <-- GeoJSON wants this

export const config = {
  runtime: "nodejs",
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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

  // If first value cannot be latitude, but second can, swap.
  // Example: [-118, 34] => swap => [34, -118]
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];

  // If both look plausible, assume it's already [lat, lon]
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

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function graphHopperRoute(points: LatLon[], key: string) {
  // normalize *every* point to [lat, lon]
  const safePoints = points.map((p, i) => normalizeLatLon(p, `point ${i}`));

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", "foot");
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  const ghResp = await fetch(ghUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: safePoints }),
  });

  const ghJson: any = await ghResp.json().catch(() => ({}));

  if (!ghResp.ok) {
    const msg =
      ghJson?.message ||
      ghJson?.error ||
      `GraphHopper error (status ${ghResp.status})`;
    throw new Error(msg);
  }

  const path = ghJson?.paths?.[0];
  const coords: any[] = path?.points?.coordinates || [];
  if (!coords.length) throw new Error("GraphHopper returned no coordinates");

  return { path, coords };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    // Healthcheck should NEVER hang
    if (req.method === "GET") {
      return json({ ok: true, message: "API is alive. Use POST to generate routes." });
    }
    if (req.method !== "POST") {
      return json({ error: "Use POST" }, 405);
    }

    const body = await readJson(req);
    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body || {};

    if (!startLatLng) return json({ error: "Missing startLatLng: [lat,lng]" }, 400);
    if (!targetMeters || typeof targetMeters !== "number")
      return json({ error: "Missing targetMeters (number)" }, 400);

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    // Normalize incoming startLatLng to [lat, lon]
    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat]; // for GeoJSON + our geometry helpers

    // Bearings that cycle as you click Generate
    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // ----------------------------
    // Try GraphHopper (Route 1)
    // ----------------------------
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

        // coords come back as [lon, lat, ele?] -> GeoJSON wants [lon, lat]
        const coordsLonLat: LonLat[] = coords.map((c: any) => [c[0], c[1]]);

        // Elevation profile from GH if present
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

        // Route 2/3 still mock for now (we’ll make them GH alternates after this is stable)
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

        return json({
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
        // If GH fails, drop to mock (but GH failure should not break GET)
        console.warn("GraphHopper route failed, falling back to mock:", e?.message || e);
      }
    }

    // ----------------------------
    // Mock fallback (distinct elev + score per route)
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

    return json({
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
    return json({ error: e?.message || "Server error" }, 500);
  }
}
