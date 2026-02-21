// api/route.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

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

function fakeElevationProfile(lenMeters: number, pref: "flat" | "hills") {
  const pts = 50;
  const out: { distanceMeters: number; elevation: number }[] = [];
  const base = 120;
  const amp = pref === "hills" ? 35 : 8;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const {
      startLatLng,
      routeType,
      targetMeters,
      elevationPref,
      directionSeed,
    } = req.body || {};

    if (!startLatLng || !Array.isArray(startLatLng) || startLatLng.length !== 2) {
      return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    }
    if (!targetMeters || typeof targetMeters !== "number") {
      return res.status(400).json({ error: "Missing targetMeters (number)" });
    }

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" = routeType === "out-and-back" ? "out-and-back" : "loop";

    const [lat, lng] = startLatLng as LatLng;
    const startLonLat: LonLat = [lng, lat];

    // Cycle bearings so "Generate" changes direction
    const candidates = pref === "hills"
      ? [25, 70, 115, 160, 205, 250, 295, 340]
      : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    // ----------------------------
    // Try GraphHopper (real roads)
    // ----------------------------
    const GH_KEY = process.env.VITE_GH_KEY || process.env.GH_KEY;
    if (GH_KEY) {
      try {
        // We’ll do out-and-back by routing start -> point in direction -> start
        // For loop we’ll approximate with start -> 3 points -> start.
        const points: LatLng[] = [];

        if (type === "out-and-back") {
          // create a target point based on bearing and half-distance
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;
          const dLon = metersToLon(oneWay * Math.cos(b), lat);
          const dLat = metersToLat(oneWay * Math.sin(b));
          const mid: LatLng = [lat + dLat, lng + dLon];
          points.push([lat, lng], mid, [lat, lng]);
        } else {
          // loop: 3 anchor points around the circle + start
          const r = targetMeters / (2 * Math.PI);
          const p1: LatLng = [lat + metersToLat(r), lng];
          const p2: LatLng = [lat, lng + metersToLon(r, lat)];
          const p3: LatLng = [lat - metersToLat(r), lng];
          points.push([lat, lng], p1, p2, p3, [lat, lng]);
        }

        // GraphHopper Route API
        const ghUrl = new URL("https://graphhopper.com/api/1/route");
        ghUrl.searchParams.set("key", GH_KEY);
        ghUrl.searchParams.set("points_encoded", "false");
        ghUrl.searchParams.set("profile", "foot"); // "foot" tends to choose paths/trails better than "car"
        ghUrl.searchParams.set("instructions", "false");
        ghUrl.searchParams.set("calc_points", "true");
        ghUrl.searchParams.set("elevation", "true");

        const ghResp = await fetch(ghUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points }),
        });

        const ghJson: any = await ghResp.json();
        if (!ghResp.ok) {
          throw new Error(ghJson?.message || "GraphHopper failed");
        }

        const path = ghJson?.paths?.[0];
        const coordsLonLat: LonLat[] = path?.points?.coordinates || [];
        if (!coordsLonLat.length) throw new Error("GraphHopper returned no coordinates");

        // Build elevation profile (if GH elevation is present)
        let elevProfile: { distanceMeters: number; elevation: number }[] = [];
        const ghElev = path?.points?.coordinates?.map((c: any) => c[2]).filter((n: any) => typeof n === "number");
        if (ghElev?.length) {
          // Simple distance axis: spread over total distance
          const total = typeof path?.distance === "number" ? path.distance : targetMeters;
          const step = total / (ghElev.length - 1);
          elevProfile = ghElev.map((e: number, i: number) => ({
            distanceMeters: i * step,
            elevation: Math.round(e),
          }));
        } else {
          elevProfile = fakeElevationProfile(targetMeters, pref);
        }

        const ascent = computeAscent(elevProfile);
        const score = scoreRoute(ascent, pref);

        const distanceMiles = (path.distance / 1609.34) || (targetMeters / 1609.34);
        const timeMinutes = path.time ? Math.round(path.time / 1000 / 60) : Math.round(distanceMiles * 10);

        // Return 3 “options” by varying the seed/bearing slightly:
        // For now we’ll just return the SAME GH path as Route 1,
        // and two slightly rotated FALLBACK paths as Routes 2/3.
        const feature1 = {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coordsLonLat.map((c: any) => [c[0], c[1]]) },
          properties: {
            metrics: { distanceMiles: Number(distanceMiles.toFixed(2)), timeMinutes, totalAscent: ascent, totalDescent: ascent },
            scoring: { overallScore: score },
            warnings: [],
            elevationProfile: elevProfile,
            source: "graphhopper",
          },
        };

        // Option 2/3 as geometric alternates (for now)
        const feature2Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, targetMeters * 0.98, bearing + 35)
            : makeLoop(startLonLat, targetMeters * 0.92, pref);

        const feature3Coords =
          type === "out-and-back"
            ? makeOutAndBack(startLonLat, targetMeters * 1.02, bearing + 70)
            : makeLoop(startLonLat, targetMeters * 1.08, pref);

        const elev2 = fakeElevationProfile(targetMeters, pref);
        const elev3 = fakeElevationProfile(targetMeters, pref);
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

        return res.status(200).json({
          type: "FeatureCollection",
          features: [feature1, feature2, feature3],
        });
      } catch (e: any) {
        // Fall through to mock
        console.warn("GraphHopper route failed, falling back to mock:", e?.message || e);
      }
    }

    // ----------------------------
    // Fallback: geometry-only mock
    // ----------------------------
    const coords1 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters, bearing)
        : makeLoop(startLonLat, targetMeters, pref);

    const elev1 = fakeElevationProfile(targetMeters, pref);
    const asc1 = computeAscent(elev1);
    const score1 = scoreRoute(asc1, pref);

    const coords2 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters * 0.98, bearing + 35)
        : makeLoop(startLonLat, targetMeters * 0.92, pref);

    const coords3 =
      type === "out-and-back"
        ? makeOutAndBack(startLonLat, targetMeters * 1.02, bearing + 70)
        : makeLoop(startLonLat, targetMeters * 1.08, pref);

    const elev2 = fakeElevationProfile(targetMeters, pref);
    const elev3 = fakeElevationProfile(targetMeters, pref);

    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

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
          scoring: { overallScore: score1 },
          warnings: ["Mock mode: no GH_KEY env var found on server yet."],
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
          warnings: ["Mock mode: no GH_KEY env var found on server yet."],
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
          warnings: ["Mock mode: no GH_KEY env var found on server yet."],
          elevationProfile: elev3,
          source: "mock",
        },
      },
    ];

    return res.status(200).json({ type: "FeatureCollection", features });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}