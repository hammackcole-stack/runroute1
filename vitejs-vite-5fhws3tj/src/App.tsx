import React, { useEffect, useMemo, useState } from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Loader2,
  MapPin,
  Navigation,
  Play,
  TrendingUp,
} from "lucide-react";
import L from "leaflet";

type FeatureCollection = {
  type: "FeatureCollection";
  features: any[];
};

type SurfacePref = "mixed" | "trail" | "road";

const LS_KEY = "runroute:lastRoute:v1";

// Helper component to adjust map view when route changes
function MapUpdater({ geoJsonData }: { geoJsonData: any }) {
  const map = useMap();
  useEffect(() => {
    if (geoJsonData) {
      const bounds = L.geoJSON(geoJsonData).getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], animate: true, duration: 0.6 });
      }
    }
  }, [geoJsonData, map]);
  return null;
}

function StartUpdater({ startLatLng }: { startLatLng: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (startLatLng) map.setView(startLatLng, 15);
  }, [startLatLng, map]);
  return null;
}

// ── gradient + arrow helpers ──────────────────────────────────────────────────

const GRAD_COLOR_START = '#f0ff80'; // pale lime-yellow
const GRAD_COLOR_END   = '#ccff00'; // neon green
const N_GRAD_SEGMENTS  = 40;
const ARROW_FRACS      = [0.12, 0.28, 0.46, 0.64, 0.80, 0.93];

function lerpColor(colorA: string, colorB: string, t: number): string {
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(colorA);
  const [br, bg, bb] = parse(colorB);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b = Math.round(ab + (bb - ab) * t);
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function bearingDeg(fromLatLng: [number, number], toLatLng: [number, number]): number {
  const dLon = (toLatLng[1] - fromLatLng[1]) * (Math.PI / 180);
  const lat1 = fromLatLng[0] * (Math.PI / 180);
  const lat2 = toLatLng[0] * (Math.PI / 180);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function signLabel(sign: number): string {
  if (sign === -3) return 'Sharp L';
  if (sign === -2) return 'Left';
  if (sign === -1) return 'Bear L';
  if (sign === 0)  return 'Straight';
  if (sign === 1)  return 'Bear R';
  if (sign === 2)  return 'Right';
  if (sign === 3)  return 'Sharp R';
  if (sign === 4)  return 'Finish';
  if (sign === 5)  return 'Waypoint';
  if (sign === 6)  return 'Roundabout';
  if (sign === 7)  return 'Keep L';
  if (sign === 8)  return 'Keep R';
  return 'Continue';
}

/** Renders the selected route as a gradient polyline from pale lime to neon green. */
function GradientPolyline({ feature }: { feature: any }) {
  const segments = useMemo(() => {
    const raw: any[] = feature?.geometry?.coordinates ?? [];
    const latLngs: [number, number][] = raw.map((c: any) => [c[1], c[0]]);
    if (latLngs.length < 2) return [];
    const n = latLngs.length;
    const step = Math.max(1, Math.floor(n / N_GRAD_SEGMENTS));
    const result: { positions: [number, number][]; t: number }[] = [];
    for (let i = 0; i < n - 1; i += step) {
      const end = Math.min(i + step + 1, n);
      result.push({ positions: latLngs.slice(i, end), t: i / (n - 1) });
    }
    return result;
  }, [feature]);

  return (
    <>
      {segments.map((seg, i) => (
        <Polyline
          key={i}
          positions={seg.positions}
          pathOptions={{
            color: lerpColor(GRAD_COLOR_START, GRAD_COLOR_END, seg.t),
            weight: 6,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
    </>
  );
}

/** Places rotated triangle markers along the selected route to show direction. */
function RouteArrows({ feature }: { feature: any }) {
  const arrows = useMemo(() => {
    const raw: any[] = feature?.geometry?.coordinates ?? [];
    const latLngs: [number, number][] = raw.map((c: any) => [c[1], c[0]]);
    const n = latLngs.length;
    if (n < 3) return [];
    return ARROW_FRACS.map((frac) => {
      const idx = Math.min(Math.floor(frac * (n - 1)), n - 2);
      const from = latLngs[idx];
      const to   = latLngs[idx + 1];
      const deg  = bearingDeg(from, to);
      const col  = lerpColor(GRAD_COLOR_START, GRAD_COLOR_END, frac);
      return { latlng: latLngs[idx], deg, col };
    });
  }, [feature]);

  return (
    <>
      {arrows.map((arrow, i) => {
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="pointer-events:none;width:0;height:0;' +
            'border-left:5px solid transparent;' +
            'border-right:5px solid transparent;' +
            'border-bottom:13px solid ' + arrow.col + ';' +
            'transform:rotate(' + String(Math.round(arrow.deg)) + 'deg);' +
            'transform-origin:center 65%;"></div>',
          iconSize: [10, 13],
          iconAnchor: [5, 6],
        });
        return <Marker key={i} position={arrow.latlng} icon={icon} />;
      })}
    </>
  );
}

// ── home address ──────────────────────────────────────────────────────────────

const HOME_ADDRESS = "1563 Lucretia Ave Los Angeles, CA 90026";
const HOME_LATLNG: [number, number] = [34.0822, -118.2559]; // [lat, lon]

function resolveAddress(input: string): string {
  return input.trim().toUpperCase() === "HOME" ? HOME_ADDRESS : input.trim();
}

export default function App() {
  // Core inputs
  const [start, setStart] = useState("HOME");
  const [waypoint, setWaypoint] = useState("");
  const [routeType, setRouteType] = useState<"loop" | "out-and-back">("loop");
  const [startLatLng, setStartLatLng] = useState<[number, number] | null>(HOME_LATLNG);
  const [directionSeed, setDirectionSeed] = useState(0);

  // Park search (optional — used when Park Loop is selected)
  const [parkSearch, setParkSearch] = useState("");

  // Modifiers
  const [mode, setMode] = useState<"distance" | "time">("distance");
  const [targetValue, setTargetValue] = useState<number>(5); // Miles or Minutes
  const [pace, setPace] = useState<number>(9.5); // Min/Mile
  const [loopAtPark, setLoopAtPark] = useState(false);
  const [elevationPref, setElevationPref] = useState<"flat" | "hills">("flat");

  // NEW: surface + avoid majors
  const [surfacePref, setSurfacePref] = useState<SurfacePref>("mixed");
  const [avoidMajorRoads, setAvoidMajorRoads] = useState<boolean>(true);

  // Request state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeData, setRouteData] = useState<FeatureCollection | null>(null);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(0);
  const [hoveredRouteIndex, setHoveredRouteIndex] = useState<number | null>(null);
  const [routeFadeKey, setRouteFadeKey] = useState(0);
  const [showDirections, setShowDirections] = useState(false);

  // Load last route from localStorage (on first mount)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.routeData?.features?.length) {
        setRouteData(parsed.routeData);
        if (Array.isArray(parsed.startLatLng)) setStartLatLng(parsed.startLatLng);
        if (typeof parsed.start === "string") setStart(parsed.start);
        if (typeof parsed.selectedRouteIndex === "number") setSelectedRouteIndex(parsed.selectedRouteIndex);
      }
    } catch {
      // ignore
    }
  }, []);

  // Persist last route whenever it changes
  useEffect(() => {
    try {
      if (!routeData?.features?.length) return;
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          routeData,
          startLatLng,
          start,
          selectedRouteIndex,
        })
      );
    } catch {
      // ignore
    }
  }, [routeData, startLatLng, start, selectedRouteIndex]);

  // Style helper for "show all routes"
  // Selected = neon green, hovered (not selected) = dim white preview, others = dark
  const routeStyle = (idx: number) => {
    const isSel = idx === selectedRouteIndex;
    const isHov = idx === hoveredRouteIndex && !isSel;
    let color = '#3f3f46';
    let weight = 3;
    let opacity = 0.45;
    if (isSel) { color = '#ccff00'; weight = 6; opacity = 0.95; }
    else if (isHov) { color = '#ffffff'; weight = 4; opacity = 0.7; }
    return { color, weight, opacity, lineCap: 'square' as const, lineJoin: 'miter' as const };
  };

  const selectedFeature = useMemo(() => {
    return routeData?.features?.[selectedRouteIndex] ?? routeData?.features?.[0] ?? null;
  }, [routeData, selectedRouteIndex]);

  const properties = selectedFeature?.properties ?? null;
  const warnings: string[] = (properties?.warnings as string[]) ?? [];
  const elevationProfile =
    (properties?.elevationProfile as { distanceMeters: number; elevation: number }[]) ?? [];
  const directionSteps: any[] = (properties?.instructions as any[]) ?? [];

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();

    const nextSeed = directionSeed + 1;
    setDirectionSeed(nextSeed);

    setLoading(true);
    setError(null);
    setRouteData(null);
    setSelectedRouteIndex(0);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);

    try {
      // 1) Geocode. "HOME" resolves directly to the hardcoded home coords — no
      //    Nominatim request needed. Anything else goes through Nominatim with
      //    a fallback to home if the lookup fails.
      let startCoordsLonLat: [number, number] = [HOME_LATLNG[1], HOME_LATLNG[0]]; // [lon, lat]

      if (start.trim().toUpperCase() === "HOME") {
        setStartLatLng(HOME_LATLNG);
      } else {
        try {
          const nomUrl =
            `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0` +
            `&q=${encodeURIComponent(resolveAddress(start))}` +
            `&email=demo@example.com`;
          const res = await fetch(nomUrl);
          const json: any[] = await res.json();
          if (json?.length) {
            startCoordsLonLat = [parseFloat(json[0].lon), parseFloat(json[0].lat)];
            setStartLatLng([parseFloat(json[0].lat), parseFloat(json[0].lon)]);
          }
        } catch {
          setStartLatLng([startCoordsLonLat[1], startCoordsLonLat[0]]);
        }
      }

      // 2) Determine target distance in meters
      const targetMiles =
        mode === "distance"
          ? targetValue
          : Math.max(0.5, targetValue / Math.max(1, pace));
      const targetMeters = targetMiles * 1609.34;

      // 3) Call Vercel function
      const resp = await fetch("/api/route", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLatLng: [startCoordsLonLat[1], startCoordsLonLat[0]], // [lat,lon]
          routeType,
          targetMeters,
          elevationPref,
          directionSeed: nextSeed,
          surfacePref,
          avoidMajorRoads,
          loopAtPark,
          parkSearch: parkSearch.trim() || null,
          waypoint,
        }),
      });

      const json = await resp.json().catch(() => null);

      if (!resp.ok) {
        throw new Error(json?.error || `Route request failed (${resp.status})`);
      }

      if (!json?.features?.length) {
        throw new Error(
          json?.error ||
            "No routes returned. Check GH_KEY in Vercel, or GraphHopper limits."
        );
      }

      setRouteData(json);
    } catch (err: any) {
      const msg =
        err?.name === "AbortError"
          ? "Route request timed out (30s). Try again."
          : err?.message || "Something went wrong.";
      console.error(err);
      setError(msg);
    } finally {
      clearTimeout(t);
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-black text-white overflow-hidden font-sans">
      {/* LEFT PANEL */}
      <aside className="w-full md:w-[420px] h-auto md:h-full bg-black border-r border-zinc-900 flex flex-col z-10 shadow-2xl overflow-y-auto">
        <div className="p-8">
          <h1 className="text-5xl font-black italic tracking-tighter text-neon uppercase mb-8">
            RunRoute
          </h1>

          <form onSubmit={handleGenerate} className="space-y-6">
            {/* LOCATION INPUTS */}
            <div className="space-y-4">
              <div className="relative">
                <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-1">
                  Start
                </label>
                <div className="flex items-center border-b border-zinc-800 focus-within:border-neon transition-colors pb-2">
                  <MapPin className="w-4 h-4 text-neon mr-3 shrink-0" />
                  <input
                    type="text"
                    required
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    placeholder="Enter starting point"
                    className="w-full bg-transparent text-white placeholder-zinc-700 outline-none text-lg font-medium"
                  />
                </div>
              </div>

              {!loopAtPark && routeType !== "out-and-back" && (
                <div className="relative">
                  <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-1">
                    Waypoint
                  </label>
                  <div className="flex items-center border-b border-zinc-800 focus-within:border-neon transition-colors pb-2">
                    <Navigation className="w-4 h-4 text-neon mr-3 shrink-0" />
                    <input
                      type="text"
                      value={waypoint}
                      onChange={(e) => setWaypoint(e.target.value)}
                      placeholder="(Optional) Enter turnaround point"
                      className="w-full bg-transparent text-white placeholder-zinc-700 outline-none text-lg font-medium"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ROUTE TOGGLES */}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-2">
                  Structure
                </label>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRouteType("loop");
                      setLoopAtPark(false);
                    }}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      routeType === "loop" && !loopAtPark
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    Standard Loop
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setRouteType("loop");
                      setLoopAtPark(true);
                    }}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      loopAtPark
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    Park Loop
                  </button>

                  {loopAtPark && (
                    <div className="border border-zinc-800 focus-within:border-neon transition-colors">
                      <input
                        type="text"
                        value={parkSearch}
                        onChange={(e) => setParkSearch(e.target.value)}
                        placeholder="Park name (optional)"
                        className="w-full bg-transparent text-white placeholder-zinc-700 outline-none text-xs font-medium px-3 py-2"
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setRouteType("out-and-back");
                      setLoopAtPark(false);
                    }}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      routeType === "out-and-back"
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    Out &amp; Back
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-2">
                  Elevation
                </label>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setElevationPref("flat")}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      elevationPref === "flat"
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    Flat
                  </button>

                  <button
                    type="button"
                    onClick={() => setElevationPref("hills")}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      elevationPref === "hills"
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    Hills
                  </button>
                </div>
              </div>
            </div>

            {/* NEW: SURFACE + AVOID */}
            <div className="pt-2">
              <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-2">
                Surface
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(["mixed", "trail", "road"] as SurfacePref[]).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSurfacePref(opt)}
                    className={`p-3 text-xs font-bold uppercase tracking-widest border transition-all ${
                      surfacePref === opt
                        ? "border-neon text-neon bg-neon/10"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                    }`}
                  >
                    {opt === "mixed" ? "Mixed" : opt === "trail" ? "Trails" : "Roads"}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between border border-zinc-800 p-3">
                <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                  Avoid Major Roads
                </span>
                <button
                  type="button"
                  onClick={() => setAvoidMajorRoads((v) => !v)}
                  className={`px-3 py-2 text-xs font-black uppercase tracking-widest border transition-all ${
                    avoidMajorRoads
                      ? "border-neon text-neon bg-neon/10"
                      : "border-zinc-700 text-zinc-500"
                  }`}
                >
                  {avoidMajorRoads ? "On" : "Off"}
                </button>
              </div>
            </div>

            {/* METRICS */}
            <div className="pt-2">
              <div className="flex gap-4 mb-4">
                <button
                  type="button"
                  onClick={() => setMode("distance")}
                  className={`text-[10px] font-bold uppercase tracking-[0.2em] transition-colors ${
                    mode === "distance" ? "text-neon" : "text-zinc-600 hover:text-white"
                  }`}
                >
                  By Distance
                </button>
                <button
                  type="button"
                  onClick={() => setMode("time")}
                  className={`text-[10px] font-bold uppercase tracking-[0.2em] transition-colors ${
                    mode === "time" ? "text-neon" : "text-zinc-600 hover:text-white"
                  }`}
                >
                  By Time
                </button>
              </div>

              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-1">
                    {mode === "distance" ? "Target Miles" : "Target Minutes"}
                  </label>
                  <input
                    type="number"
                    step={mode === "distance" ? "0.1" : "1"}
                    min="1"
                    value={targetValue}
                    onChange={(e) => setTargetValue(parseFloat(e.target.value))}
                    className="w-full bg-transparent text-3xl font-black border-b border-zinc-800 focus:border-neon outline-none pb-1 transition-colors"
                  />
                </div>

                {mode === "time" && (
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-1">
                      Pace (Min/Mi)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      min="4"
                      value={pace}
                      onChange={(e) => setPace(parseFloat(e.target.value))}
                      className="w-full bg-transparent text-3xl font-black border-b border-zinc-800 focus:border-neon outline-none pb-1 transition-colors"
                    />
                  </div>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-transparent border border-neon text-neon font-black uppercase tracking-widest py-4 mt-4 hover:bg-neon hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 group"
            >
              {loading ? (
                <Loader2 className="animate-spin w-5 h-5" />
              ) : (
                <>
                  Generate Route
                  <Play className="w-4 h-4 fill-current group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          {error && (
            <div className="mt-6 p-4 border border-red-500 text-red-400 flex items-start gap-3 text-xs tracking-wide">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {/* DIRECTIONS PANEL */}
          {directionSteps.length > 0 && (
            <div className="mt-8 pb-2">
              <button
                type="button"
                onClick={() => setShowDirections((v) => !v)}
                className="w-full flex justify-between items-center text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em] mb-3 hover:text-zinc-400 transition-colors"
              >
                <span>Directions</span>
                <span className="text-base leading-none">{showDirections ? '\u2212' : '+'}</span>
              </button>
              {showDirections && (
                <div className="space-y-0 max-h-72 overflow-y-auto border border-zinc-900">
                  {directionSteps.map((step: any, i: number) => (
                    <div
                      key={i}
                      className="flex gap-3 px-3 py-2 border-b border-zinc-900 last:border-0 hover:bg-zinc-950 transition-colors"
                    >
                      <span className="text-[9px] font-black text-neon uppercase tracking-wider w-14 shrink-0 pt-0.5 leading-tight">
                        {signLabel(step.sign)}
                      </span>
                      <span className="text-[10px] text-zinc-400 flex-1 leading-relaxed">
                        {step.text}
                      </span>
                      {step.distanceMiles > 0 && (
                        <span className="text-[9px] text-zinc-600 shrink-0 font-mono pt-0.5">
                          {step.distanceMiles}mi
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {routeData?.features?.length ? (
            <div className="mt-10 flex flex-col gap-4 pb-8">
              <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em]">
                Available Routes
              </h2>

              {routeData.features.map((feature: any, idx: number) => {
                const isSelected = selectedRouteIndex === idx;
                const featMetrics = feature.properties.metrics;
                const featScoring = feature.properties.scoring;
                const parkName: string | null = feature.properties.parkName ?? null;
                const parkLaps: number | null = feature.properties.parkLaps ?? null;
                const parkLapMi: number | null = feature.properties.parkLapDistanceMiles ?? null;
                const transitMi: number | null = feature.properties.transitDistanceMiles ?? null;

                return (
                  <button
                    key={`${idx}-${routeFadeKey}`}
                    onClick={() => {
                      setSelectedRouteIndex(idx);
                      setRouteFadeKey((k) => k + 1);
                    }}
                    onMouseEnter={() => setHoveredRouteIndex(idx)}
                    onMouseLeave={() => setHoveredRouteIndex(null)}
                    className={`text-left p-5 border transition-all ${
                      isSelected
                        ? "border-neon bg-neon/5 scale-[1.02]"
                        : "border-zinc-800 bg-black hover:border-zinc-600 opacity-70 hover:opacity-100"
                    }`}
                  >
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-neon font-black italic tracking-wider text-sm uppercase">
                        Route 0{idx + 1}
                      </span>
                      <span className="text-[10px] font-bold text-white tracking-[0.2em] px-2 py-1 border border-zinc-700">
                        {featScoring.overallScore} MATCH
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">Dist</p>
                        <p className="text-xl font-black">
                          {featMetrics.distanceMiles}
                          <span className="text-xs text-zinc-500 font-normal ml-1">mi</span>
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">Est</p>
                        <p className="text-xl font-black">
                          {featMetrics.timeMinutes}
                          <span className="text-xs text-zinc-500 font-normal ml-1">m</span>
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">Climb</p>
                        <p className="text-xl font-black">
                          {Math.round(featMetrics.totalAscent)}
                          <span className="text-xs text-zinc-500 font-normal ml-1">m</span>
                        </p>
                      </div>
                    </div>

                    {parkName && parkLaps != null && parkLapMi != null && (
                      <div className="mt-3 pt-3 border-t border-zinc-800 space-y-1">
                        <p className="text-[10px] font-bold text-neon uppercase tracking-widest truncate">
                          {parkName}
                        </p>
                        <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
                          {parkLaps}× loop · {parkLapMi} mi/lap
                          {transitMi != null && (
                            <span className="text-zinc-700"> · {transitMi} mi transit</span>
                          )}
                        </p>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </aside>

      {/* RIGHT PANEL */}
      <main className="flex-1 relative flex flex-col bg-black h-[60vh] md:h-full">
        {/* WARNINGS */}
        {warnings.length > 0 && (
          <div className="absolute top-4 left-4 right-4 z-[400] pointer-events-none">
            {warnings.map((w: string, i: number) => (
              <div
                key={i}
                className="mb-2 bg-black border border-amber-500 text-amber-500 p-3 text-xs tracking-wide shadow-2xl inline-flex items-start gap-2 max-w-lg pointer-events-auto backdrop-blur-md bg-opacity-90"
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <p>{w}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 relative z-0 bg-black">
          <MapContainer
            center={startLatLng ?? HOME_LATLNG}
            zoom={13}
            style={{ width: "100%", height: "100%" }}
            className="w-full h-full bg-black"
            zoomControl={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />

            <StartUpdater startLatLng={startLatLng} />
            {startLatLng && (
              <CircleMarker
                center={startLatLng}
                radius={7}
                pathOptions={{
                  color: "#ccff00",
                  fillColor: "#ccff00",
                  fillOpacity: 1,
                  weight: 2,
                }}
              >
                <Popup>Start</Popup>
              </CircleMarker>
            )}

            {/* SHOW ALL ROUTES — unselected rendered as flat GeoJSON */}
            {routeData?.features?.map((feature: any, idx: number) =>
              idx !== selectedRouteIndex ? (
                <GeoJSON key={`route-${idx}-${routeFadeKey}-${hoveredRouteIndex}`} data={feature} style={routeStyle(idx)} />
              ) : null
            )}

            {/* SELECTED ROUTE — gradient polyline + direction arrows */}
            {selectedFeature && (
              <GradientPolyline
                key={`grad-${selectedRouteIndex}-${routeFadeKey}`}
                feature={selectedFeature}
              />
            )}
            {selectedFeature && (
              <RouteArrows
                key={`arrows-${selectedRouteIndex}-${routeFadeKey}`}
                feature={selectedFeature}
              />
            )}

            {/* Park center marker for park loop routes */}
            {selectedFeature?.properties?.parkLat != null && (
              <CircleMarker
                center={[selectedFeature.properties.parkLat, selectedFeature.properties.parkLon]}
                radius={9}
                pathOptions={{
                  color: "#ccff00",
                  fillColor: "#000000",
                  fillOpacity: 0.85,
                  weight: 2,
                }}
              >
                <Popup>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {selectedFeature.properties.parkName ?? "Park"}
                  </span>
                </Popup>
              </CircleMarker>
            )}

            {/* Turnaround marker for selected route (out-and-back only) */}
            {selectedFeature && routeType === "out-and-back" && (() => {
              const coords = selectedFeature.geometry.coordinates;
              const turn = coords[Math.floor(coords.length / 2)];
              const latlng: [number, number] = [turn[1], turn[0]];
              return (
                <CircleMarker
                  center={latlng}
                  radius={8}
                  pathOptions={{
                    color: "#39FF14",
                    fillColor: "#39FF14",
                    fillOpacity: 1,
                  }}
                >
                  <Popup>Turn around here</Popup>
                </CircleMarker>
              );
            })()}

            {selectedFeature && <MapUpdater geoJsonData={selectedFeature} />}
          </MapContainer>
        </div>

        {/* ELEVATION CHART */}
        {elevationProfile && elevationProfile.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-40 bg-black/90 backdrop-blur-lg border-t border-zinc-900 z-10 p-6 flex flex-col justify-end">
            <div className="absolute top-4 left-6 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-neon" />
              <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em]">
                Elevation
              </h4>
            </div>

            <div className="h-24 w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  key={`elev-${selectedRouteIndex}-${routeFadeKey}`}
                  data={elevationProfile}
                  margin={{ top: 5, right: 0, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="colorElevation" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ccff00" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#ccff00" stopOpacity={0} />
                    </linearGradient>
                  </defs>

                  <XAxis
                    dataKey="distanceMeters"
                    tickFormatter={(val) => `${(val / 1609.34).toFixed(1)}`}
                    stroke="#27272a"
                    tick={{ fontSize: 10, fill: "#52525b", fontFamily: "monospace" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    stroke="#27272a"
                    tick={{ fontSize: 10, fill: "#52525b", fontFamily: "monospace" }}
                    domain={["dataMin - 5", "dataMax + 5"]}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#000",
                      border: "1px solid #ccff00",
                      borderRadius: "0",
                      color: "#fff",
                    }}
                    itemStyle={{ color: "#ccff00", fontWeight: "bold" }}
                    labelStyle={{
                      color: "#a1a1aa",
                      fontSize: "10px",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                    }}
                    labelFormatter={(val: number) => `DIST ${(val / 1609.34).toFixed(2)} MI`}
                  />
                  <Area
                    type="step"
                    dataKey="elevation"
                    stroke="#ccff00"
                    strokeWidth={1}
                    fillOpacity={1}
                    fill="url(#colorElevation)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
