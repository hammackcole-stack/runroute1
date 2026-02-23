// api/route.ts — Vercel Serverless Function (Node.js runtime)
import type { VercelRequest, VercelResponse } from "@vercel/node";

type LatLon = [number, number]; // [lat, lon]  — GraphHopper format
type LonLat = [number, number]; // [lon, lat]  — GeoJSON format

const GH_TIMEOUT_MS = 8_000;

// ── helpers ───────────────────────────────────────────────────────────────────

function metersToLon(m: number, lat: number) {
  return m / (111320 * Math.cos((lat * Math.PI) / 180));
}

function metersToLat(m: number) {
  return m / 110540;
}

/**
 * Normalize to [lat, lon].
 * Flips [-118, 34] → [34, -118] when the first value can't be a latitude.
 * Limitation: cannot auto-detect swaps where both values fall in [-90, 90]
 * (e.g. passing [-87, 41] for Chicago would be silently misread).
 */
function normalizeLatLon(p: unknown, label = "point"): LatLon {
  if (!Array.isArray(p) || p.length < 2)
    throw new Error(`Invalid ${label}: expected [lat, lon]`);
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new Error(`Invalid ${label}: lat/lon must be numbers`);
  // First value can't be a latitude but second can → swap
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a];
  return [a, b];
}

// ── geometry helpers (mock fallback) ─────────────────────────────────────────

/**
 * Generates a closed loop that starts AND ends at startLonLat.
 * The circle is centered north of start so its southernmost point = startLonLat.
 * Previous version offset the circle east and never touched the start pin.
 */
function makeLoop(
  startLonLat: LonLat,
  targetMeters: number,
  hilliness: "flat" | "hills"
): LonLat[] {
  const numPts = 70;
  const radius = targetMeters / (2 * Math.PI);
  // Place center north so the bottom of the circle lands on startLonLat
  const centerLat = startLonLat[1] + metersToLat(radius);
  const centerLon = startLonLat[0];
  const coords: LonLat[] = [];
  for (let i = 0; i <= numPts; i++) {
    // Offset by -π/2 so i=0 and i=numPts both resolve to startLonLat
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

function makeOutAndBack(
  startLonLat: LonLat,
  targetMeters: number,
  bearingDeg: number
): LonLat[] {
  const oneWay = targetMeters / 2;
  const b = (bearingDeg * Math.PI) / 180;
  const out: LonLat = [
    startLonLat[0] + metersToLon(oneWay * Math.cos(b), startLonLat[1]),
    startLonLat[1] + metersToLat(oneWay * Math.sin(b)),
  ];
  return [startLonLat, out, startLonLat];
}

function fakeElevationProfile(
  lenMeters: number,
  pref: "flat" | "hills",
  intensity = 1
): { distanceMeters: number; elevation: number }[] {
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
  return Math.max(
    0,
    Math.min(100, Math.round(100 - (Math.abs(ascentMeters - target) / tolerance) * 100))
  );
}

// ── GraphHopper ───────────────────────────────────────────────────────────────

async function graphHopperRoute(points: LatLon[], key: string) {
  // GH POST API expects [lon, lat] (GeoJSON order) — normalize to [lat, lon] first,
  // then swap. The original code sent [lat, lon] which caused GH to treat the
  // longitude as a latitude, blowing the -85/82 lat bounds.
  const safePoints = points.map((p, i) => {
    const [lat, lon] = normalizeLatLon(p, `point ${i}`);
    return [lon, lat];
  });

  const ghUrl = new URL("https://graphhopper.com/api/1/route");
  ghUrl.searchParams.set("key", key);
  ghUrl.searchParams.set("points_encoded", "false");
  ghUrl.searchParams.set("profile", "foot");
  ghUrl.searchParams.set("instructions", "false");
  ghUrl.searchParams.set("calc_points", "true");
  ghUrl.searchParams.set("elevation", "true");

  // Hard timeout — prevents the POST from hanging if GH is slow/unreachable
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);

  let ghResp: Response;
  try {
    ghResp = await fetch(ghUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: safePoints }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const ghJson: any = await ghResp.json().catch(() => ({}));
  if (!ghResp.ok) {
    throw new Error(
      ghJson?.message || ghJson?.error || `GraphHopper error (status ${ghResp.status})`
    );
  }

  const path = ghJson?.paths?.[0];
  const coords: any[] = path?.points?.coordinates ?? [];
  if (!coords.length) throw new Error("GraphHopper returned no coordinates");

  return { path, coords };
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  // GET: healthcheck — never touches body parsing or GH
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "API is alive. Use POST to generate routes." });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    // Vercel automatically parses JSON bodies; no manual req.json() needed
    const body = req.body ?? {};
    const { startLatLng, routeType, targetMeters, elevationPref, directionSeed } = body;

    if (!startLatLng)
      return res.status(400).json({ error: "Missing startLatLng: [lat,lng]" });
    if (!targetMeters || typeof targetMeters !== "number")
      return res.status(400).json({ error: "Missing targetMeters (number)" });

    const pref: "flat" | "hills" = elevationPref === "hills" ? "hills" : "flat";
    const type: "loop" | "out-and-back" =
      routeType === "out-and-back" ? "out-and-back" : "loop";

    const [lat, lon] = normalizeLatLon(startLatLng, "startLatLng");
    const startLonLat: LonLat = [lon, lat];

    const candidates =
      pref === "hills"
        ? [25, 70, 115, 160, 205, 250, 295, 340]
        : [0, 90, 180, 270, 45, 135, 225, 315];
    const seedNum = typeof directionSeed === "number" ? directionSeed : 0;
    const bearing = candidates[seedNum % candidates.length];

    const GH_KEY = process.env.GH_KEY || process.env.VITE_GH_KEY;

    // ── GraphHopper path ────────────────────────────────────────────────────
    if (GH_KEY) {
      try {
        const points1: LatLon[] = [];
        if (type === "out-and-back") {
          const oneWay = targetMeters / 2;
          const b = (bearing * Math.PI) / 180;
          const mid: LatLon = [
            lat + metersToLat(oneWay * Math.sin(b)),
            lon + metersToLon(oneWay * Math.cos(b), lat),
          ];
          points1.push([lat, lon], mid, [lat, lon]);
        } else {
          const r = targetMeters / (2 * Math.PI);
          points1.push(
            [lat, lon],
            [lat + metersToLat(r), lon],
            [lat, lon + metersToLon(r, lat)],
            [lat - metersToLat(r), lon],
            [lat, lon]
          );
        }

        const { path, coords } = await graphHopperRoute(points1, GH_KEY);
        // GH returns [lon, lat, ele?] — strip elevation for GeoJSON coordinates
        const coordsLonLat: LonLat[] = coords.map((c: any) => [c[0], c[1]]);

        const altitudes = coords
          .map((c: any) => c?.[2])
          .filter((n: any) => typeof n === "number");

        let elevProfile: { distanceMeters: number; elevation: number }[];
        if (altitudes.length > 2) {
          const total =
            typeof path?.distance === "number" ? path.distance : targetMeters;
          const step = total / (altitudes.length - 1);
          elevProfile = altitudes.map((e: number, i: number) => ({
            distanceMeters: i * step,
            elevation: Math.round(e),
          }));
        } else {
          elevProfile = fakeElevationProfile(targetMeters, pref, 1);
        }

        const ascent = computeAscent(elevProfile);
        const distanceMeters =
          typeof path?.distance === "number" ? path.distance : targetMeters;
        const distanceMiles = distanceMeters / 1609.34;
        const timeMinutes =
          typeof path?.time === "number"
            ? Math.round(path.time / 1000 / 60)
            : Math.round(distanceMiles * 10);

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

        return res.status(200).json({
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
                scoring: { overallScore: scoreRoute(ascent, pref) },
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
        console.warn("GraphHopper failed, falling back to mock:", e?.message ?? e);
      }
    }

    // ── mock fallback ────────────────────────────────────────────────────────
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

    const elev1 = fakeElevationProfile(meters1, pref, 1.0);
    const elev2 = fakeElevationProfile(meters2, pref, pref === "hills" ? 0.85 : 0.8);
    const elev3 = fakeElevationProfile(meters3, pref, pref === "hills" ? 1.55 : 1.25);
    const asc1 = computeAscent(elev1);
    const asc2 = computeAscent(elev2);
    const asc3 = computeAscent(elev3);

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
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
