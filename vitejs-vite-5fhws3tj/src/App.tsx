import React, { useState, useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  useMap,
  CircleMarker,
  Popup,
} from "react-leaflet";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  MapPin,
  Navigation,
  TrendingUp,
  AlertTriangle,
  Loader2,
  Play,
} from "lucide-react";
import L from "leaflet";

// Helper component to adjust map view when route changes
function MapUpdater({ geoJsonData }: { geoJsonData: any }) {
  const map = useMap();
  useEffect(() => {
    if (geoJsonData) {
      const bounds = L.geoJSON(geoJsonData).getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          padding: [50, 50],
          animate: true,
          duration: 0.6,
        });
      }
    }
  }, [geoJsonData, map]);
  return null;
}

function StartUpdater({
  startLatLng,
}: {
  startLatLng: [number, number] | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (startLatLng) map.setView(startLatLng, 15);
  }, [startLatLng, map]);
  return null;
}

export default function App() {
  // Core inputs
  const [start, setStart] = useState("1563 Lucretia Ave Los Angeles, CA 90026");
  const [waypoint, setWaypoint] = useState("");
  const [routeType, setRouteType] = useState<"loop" | "out-and-back">("loop");
  const [startLatLng, setStartLatLng] = useState<[number, number] | null>(null);
  const [directionSeed, setDirectionSeed] = useState(0);

  // Modifiers
  const [mode, setMode] = useState<"distance" | "time">("distance");
  const [targetValue, setTargetValue] = useState<number>(5); // Miles or Minutes
  const [pace, setPace] = useState<number>(9.5); // Min/Mile
  const [loopAtPark, setLoopAtPark] = useState(false);
  const [elevationPref, setElevationPref] = useState<"flat" | "hills">("flat");

  // Request state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeData, setRouteData] = useState<any>(null);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(0);
  const [routeFadeKey, setRouteFadeKey] = useState(0);

  // Style helper for “show all routes”
  const routeStyle = (idx: number) => {
    const isSel = idx === selectedRouteIndex;
    return {
      color: isSel ? "#ccff00" : "#3f3f46", // neon vs zinc gray
      weight: isSel ? 6 : 3,
      opacity: isSel ? 0.95 : 0.55,
      lineCap: "square" as const,
      lineJoin: "miter" as const,
    };
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();

    // IMPORTANT: compute next seed locally so we can send it to /api/route
    const nextSeed = directionSeed + 1;
    setDirectionSeed(nextSeed);

    setLoading(true);
    setError(null);
    setRouteData(null);
    setSelectedRouteIndex(0);

    try {
      // 1) Pick a start coordinate (geocode with Nominatim; fallback to LA)
      let startCoords: [number, number] = [-118.2923, 34.0224]; // [lon, lat]

      try {
        const nomUrl =
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0` +
          `&q=${encodeURIComponent(start)}` +
          `&email=demo@example.com`;
        const res = await fetch(nomUrl);
        const json: any[] = await res.json();
        if (json?.length) {
          startCoords = [parseFloat(json[0].lon), parseFloat(json[0].lat)];
          setStartLatLng([parseFloat(json[0].lat), parseFloat(json[0].lon)]); // [lat, lon]
        }
      } catch {
        // ignore; use fallback
      }

      // 2) Determine target distance in meters
      const targetMiles =
        mode === "distance"
          ? targetValue
          : Math.max(0.5, targetValue / Math.max(1, pace));
      const targetMeters = targetMiles * 1609.34;

      // 3) CALL YOUR VERCEL FUNCTION (server calls GraphHopper)
      // NOTE:
      // - startCoords is [lon, lat]
      // - API expects startLatLng as [lat, lng]
      const resp = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLatLng: [startCoords[1], startCoords[0]], // [lat, lng]
          routeType,
          targetMeters,
          elevationPref,
          directionSeed: nextSeed,
          // keeping these in case you want to use them on the server later:
          loopAtPark,
        }),
      });

      const json = await resp.json();
      if (!resp.ok) {
        throw new Error(json?.error || "Route request failed");
      }

      // json should be { type: "FeatureCollection", features: [...] }
      setRouteData(json);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  // Safe accessor for the currently selected feature
const selectedFeature = routeData?.features?.[selectedRouteIndex];
const properties = selectedFeature?.properties;
const warnings = properties?.warnings || [];
const elevationProfile = properties?.elevationProfile;

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
                      required={false}
                      value={waypoint}
                      onChange={(e) => setWaypoint(e.target.value)}
                      placeholder="Enter turnaround point"
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

            {/* METRICS */}
            <div className="pt-2">
              <div className="flex gap-4 mb-4">
                <button
                  type="button"
                  onClick={() => setMode("distance")}
                  className={`text-[10px] font-bold uppercase tracking-[0.2em] transition-colors ${
                    mode === "distance"
                      ? "text-neon"
                      : "text-zinc-600 hover:text-white"
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

          {routeData?.features && (
            <div className="mt-10 flex flex-col gap-4 pb-8">
              <h2 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em]">
                Available Routes
              </h2>

              {routeData.features.map((feature: any, idx: number) => {
                const isSelected = selectedRouteIndex === idx;
                const featMetrics = feature.properties.metrics;
                const featScoring = feature.properties.scoring;

                return (
                  <button
                    key={idx}
                    onClick={() => {
                      setSelectedRouteIndex(idx);
                      setRouteFadeKey((k) => k + 1);
                    }}
                    className={`text-left p-5 border transition-all ${
                      isSelected
                        ? "border-neon bg-neon/5 scale-[1.02]"
                        : "border-zinc-800 bg-black hover:border-zinc-500 opacity-70 hover:opacity-100"
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
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">
                          Dist
                        </p>
                        <p className="text-xl font-black">
                          {featMetrics.distanceMiles}
                          <span className="text-xs text-zinc-500 font-normal ml-1">
                            mi
                          </span>
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">
                          Est
                        </p>
                        <p className="text-xl font-black">
                          {featMetrics.timeMinutes}
                          <span className="text-xs text-zinc-500 font-normal ml-1">
                            m
                          </span>
                        </p>
                      </div>

                      <div>
                        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1">
                          Climb
                        </p>
                        <p className="text-xl font-black">
                          {Math.round(featMetrics.totalAscent)}
                          <span className="text-xs text-zinc-500 font-normal ml-1">
                            m
                          </span>
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
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
            center={startLatLng ?? [40.7829, -73.9654]}
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

            {/* SHOW ALL ROUTES */}
            {routeData?.features?.map((feature: any, idx: number) => (
              <GeoJSON
                key={`route-${idx}-${routeFadeKey}`}
                data={feature}
                style={routeStyle(idx)}
              />
            ))}

            {/* Turnaround marker for selected route (out-and-back only) */}
            {selectedFeature &&
              routeType === "out-and-back" &&
              (() => {
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
                  data={elevationProfile}
                  margin={{ top: 5, right: 0, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="colorElevation"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#ccff00" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#ccff00" stopOpacity={0} />
                    </linearGradient>
                  </defs>

                  <XAxis
                    dataKey="distanceMeters"
                    tickFormatter={(val) => `${(val / 1609.34).toFixed(1)}`}
                    stroke="#27272a"
                    tick={{
                      fontSize: 10,
                      fill: "#52525b",
                      fontFamily: "monospace",
                    }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    stroke="#27272a"
                    tick={{
                      fontSize: 10,
                      fill: "#52525b",
                      fontFamily: "monospace",
                    }}
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
                    labelFormatter={(val: number) =>
                      `DIST ${(val / 1609.34).toFixed(2)} MI`
                    }
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
