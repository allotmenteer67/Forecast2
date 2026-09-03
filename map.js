// map.js — the expanded map page.
//
// Loaded after app.js and tide.js, so it reuses loadConditionUnits()
// (units follow the choice already made in Settings — the map never gets
// its own km/miles setting) and haversineKm() rather than redefining
// either.
//
// WHAT THIS MAP IS, AND ISN'T
//
// It is drawn from the same merged global models the headline figures
// use, at roughly 10 km spacing. It is deliberately NOT built on UKMO's
// 2 km UKV model, despite that being far higher resolution, for three
// reasons worth recording because the temptation to "upgrade" it later
// will be strong:
//
//   1. UKMO open data carries an additional 4-hour delay on top of the
//      normal run cycle (Open-Meteo say so themselves, and add that it
//      makes the forecast less accurate as a result). Four hours is
//      useless for "should I hang the washing out".
//   2. UKV is not one of the app's six sources, so a UKV map could not
//      be FFV-corrected at all. It would be raw, uncorrected model
//      output drawn immediately above bias-corrected headline numbers,
//      and the two would visibly disagree.
//   3. Sampling finer than the model's own grid adds no information.
//      At 9-25 km native resolution, a 10 km grid is already at the
//      limit of what the data actually contains.
//
// So this map answers "where is the rain and which way is it moving",
// not "will it rain here in twenty minutes". The hourly slider on the
// front page remains the better answer to the second question.

const MAP_CENTRE_KEY = "forecast-compare:map:centre";
const MAP_ZOOM_KEY = "forecast-compare:map:zoom";
const MAP_PALETTE_KEY = "forecast-compare:map:palette";
const MAP_PREVIOUS_KEY = "forecast-compare:map:previousAdopted";
const MAP_BACK_ENABLED_KEY = "forecast-compare:map:backButton";

// Fixed levels rather than pinch-to-zoom. A fixed level means a fixed
// grid that can be cached and reused; continuous zoom would imply
// refetching at arbitrary extents. It also avoids fighting the sheet's
// own dismiss gesture, and one-handed tapping beats a two-finger
// gesture when you are stood at the allotment holding a spade.
const MAP_ZOOM_RADII_KM = [25, 50, 100];

// Ring radii per zoom level. Fixed rings would be either invisible at
// the widest level or off-canvas at the closest.
const MAP_RING_RADII_KM = { 25: [10, 20], 50: [15, 30], 100: [30, 60] };

// The grid is fetched wider than it is displayed, so ordinary panning
// reveals data already in hand rather than triggering a refetch. Only
// dragging past this margin costs a new request.
const MAP_FETCH_MARGIN = 1.5;

// ~10 km, matching the coarsest of the merged models. Finer would be
// resampling interpolation that has already happened upstream.
const MAP_GRID_SPACING_KM = 10;

const MAP_STALE_MS = 30 * 60 * 1000;

const KM_PER_DEG_LAT = 111.32;

// ---------------------------------------------------------------------
// Palettes
//
// Base and ramp are chosen TOGETHER as matched presets rather than as
// two independent settings. They are not separable in practice: on a
// light base the palest blues vanish, so a light preset's ramp has to
// start at mid-blue, while a dark base can use the full range. Offering
// them as separate dropdowns would let someone build a combination in
// which light rain is invisible.
//
// The map deliberately does NOT follow the app's colour theme. It is a
// data surface, not chrome — the same reasoning that keeps the tide
// graph's Raw and Corrected lines fixed. With seven themes, a
// theme-derived ramp would fight the rain layer for the same part of
// the colour space in at least three of them.
// ---------------------------------------------------------------------
const MAP_PALETTES = [
  {
    id: "paper",
    name: "Paper",
    land: "#EFEDE6", sea: "#DCE7EF", coast: "#9c9a92", ink: "#4a4844", ring: "#8a887f",
    // Starts at mid-blue, not near-white: on a light base the palest
    // stops of a conventional radar ramp read as "no rain".
    ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"]
  },
  {
    id: "slate",
    name: "Slate",
    land: "#3a3a37", sea: "#262b30", coast: "#7a7a72", ink: "#d8d6cf", ring: "#8f8f86",
    // Dark base, so the full range including the pale end is usable.
    ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"]
  },
  {
    id: "mono",
    name: "High contrast",
    land: "#FFFFFF", sea: "#ECECEC", coast: "#555555", ink: "#111111", ring: "#777777",
    // No hue at all. For bright daylight, and for anyone who can't
    // reliably separate the blues.
    ramp: ["#C9C9C9", "#A2A2A2", "#7C7C7C", "#585858", "#363636", "#141414"]
  }
];

function mapPalette() {
  let id = "paper";
  try { id = localStorage.getItem(MAP_PALETTE_KEY) || "paper"; } catch {}
  return MAP_PALETTES.find(p => p.id === id) || MAP_PALETTES[0];
}

// ---------------------------------------------------------------------
// Layer registry
//
// Every drawable thing on the map is a layer with a draw(ctx, view)
// method, rendered in array order — so array order IS z-order, and
// anything inserted before "coastline" sits underneath it.
//
// This exists specifically so terrain can be added later without
// touching the render loop. The map ships flat, but a flat map feels
// wrong once you know the rain is sitting on the Mendips rather than
// the Levels, so the slot is left ready:
//
//   1. Generate an elevation grid ONCE, offline, from Open-Meteo's free
//      elevation API (up to 100 coordinates per request, no key). Not at
//      runtime — terrain doesn't change.
//   2. Save it as terrain.json in the same shape as the coastline files.
//   3. Register a layer here, BEFORE "coastline", with a draw() that
//      renders contour bands or shading from it.
//
// Nothing else needs to change. Deliberately not attempted now: choosing
// band intervals and deciding whether shading or contours reads better
// at 100 km across is easy to underestimate, and much easier to judge
// against a working flat map than in the abstract.
// ---------------------------------------------------------------------
const mapLayers = [];

function registerMapLayer(layer) {
  mapLayers.push(layer);
}

// Bundled vector data, fetched once and cached in memory for the life of
// the page. These files ship with the app and cache with the app shell
// via sw.js, so panning never touches the network however far you drag —
// only the weather does.
//
// Sourced from Natural Earth, which is public domain: no permission
// needed, no attribution required. That matters here, because the whole
// reason for not using a tile service was to avoid both a live
// dependency and crediting somebody else's weather app.
const mapVectorData = { coastline: null, lakes: null, places: null };

// A missing file must degrade, not break. If the coastline hasn't been
// added to the repo yet the map still pans, still draws rain, and still
// adopts locations — it just has no land. That keeps this page useful
// while the GeoJSON is still being prepared.
async function loadMapVectors() {
  const files = [
    ["coastline", "data/coastline-50m.json"],
    ["lakes", "data/lakes-50m.json"],
    ["places", "data/places.json"]
  ];
  await Promise.all(files.map(async ([key, path]) => {
    try {
      const response = await fetch(path, { cache: "force-cache" });
      if (!response.ok) return;
      mapVectorData[key] = await response.json();
    } catch {
      // Left null. Its layer draws nothing.
    }
  }));
}

// ---------------------------------------------------------------------
// Projection
//
// A local equirectangular projection centred on the view, not full Web
// Mercator. Over a 200 km span the difference is well under a pixel, and
// this keeps the maths readable: everything is just kilometres from the
// centre, scaled to pixels.
// ---------------------------------------------------------------------
function kmPerDegLon(lat) {
  return KM_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}

function makeView(canvas, centre, radiusKm) {
  // CSS pixels, not the canvas's backing-store pixels. renderMap()
  // scales the context by the device pixel ratio, so everything below —
  // font sizes, line widths, cell sizes — is expressed at the size it
  // will actually appear.
  //
  // This was the bug behind the unreadable ring labels. The canvas is
  // sized at rect.width * dpr for sharpness, but the context was never
  // scaled to match, so drawing happened in device pixels: a "10px"
  // label rendered at 10 device pixels, which is barely 3 CSS pixels on
  // a modern phone. Not small — microscopic. The same fault made every
  // line hairline-thin and the rain cells a third of their intended
  // size.
  const dpr = canvas.width / (canvas.getBoundingClientRect().width || canvas.width);
  const w = canvas.width / dpr, h = canvas.height / dpr;
  // Scale from the WIDTH, so the stated radius is always what you get
  // left-to-right regardless of how tall the canvas happens to be.
  const pxPerKm = w / (radiusKm * 2);
  return {
    w, h, pxPerKm, centre, radiusKm,
    // Home sits below centre: weather arrives from the south-west, so
    // more of the map should show where it is coming FROM than where it
    // is going. A centred origin wastes half the view on the past.
    cx: w / 2,
    cy: h * 0.58,
    x(lon) { return this.cx + (lon - centre.lon) * kmPerDegLon(centre.lat) * this.pxPerKm; },
    y(lat) { return this.cy - (lat - centre.lat) * KM_PER_DEG_LAT * this.pxPerKm; },
    lon(px) { return centre.lon + (px - this.cx) / (kmPerDegLon(centre.lat) * this.pxPerKm); },
    lat(py) { return centre.lat - (py - this.cy) / (KM_PER_DEG_LAT * this.pxPerKm); }
  };
}

// ---------------------------------------------------------------------
// GeoJSON rendering
// ---------------------------------------------------------------------
function eachRing(geometry, visit) {
  if (!geometry) return;
  const t = geometry.type, c = geometry.coordinates;
  if (t === "LineString") visit(c);
  else if (t === "MultiLineString" || t === "Polygon") c.forEach(visit);
  else if (t === "MultiPolygon") c.forEach(poly => poly.forEach(visit));
}

function drawGeoJson(ctx, geo, view, { fill, stroke, lineWidth = 1 }) {
  if (!geo) return;
  const features = geo.type === "FeatureCollection" ? geo.features : [geo];
  ctx.lineWidth = lineWidth;
  features.forEach(feature => {
    const geometry = feature.geometry || feature;
    eachRing(geometry, ring => {
      ctx.beginPath();
      // Skips points far outside the view rather than clipping properly.
      // Canvas clips for us; this only avoids pathological coordinate
      // values when zoomed right in on a global file.
      ring.forEach(([lon, lat], i) => {
        const px = view.x(lon), py = view.y(lat);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    });
  });
}

// ---------------------------------------------------------------------
// Weather grid
//
// grid = { lat0, lon0, dLat, dLon, rows, cols, hours, values[hour][row][col] }
//
// fetchWeatherGrid() is live — real Open-Meteo precipitation, one
// request per pan/zoom/refresh. buildStubGrid() is kept alongside it,
// unused by the running app, purely as an offline fallback for testing
// pan/zoom/adopt/palettes/the hour slider without burning API calls or
// needing a connection; swap the call in ensureGrid() to reach for it.
// ---------------------------------------------------------------------
let mapGrid = null;
let mapGridFetchedAt = 0;
let mapGridCentre = null;

// Anchored to real latitude and longitude, NOT to the grid's own row and
// column indices.
//
// The first version keyed off indices, which meant the pattern was
// identical relative to whatever the centre happened to be. Panning
// moved the shower correctly while the finger was down, then the grid
// regenerated around the new centre on release and the shower snapped
// straight back to where it started. It looked exactly like the pan
// being undone, but the centre was moving fine all along — it was the
// fake weather that followed it. Real data will not do this; anchoring
// the stub to the world means the stub does not either.
function stubValueAt(lat, lon, t) {
  const u = (lon + 4.0) * 1.4;
  const v = (lat - 51.0) * 1.4;
  const front = -1.2 + t * 0.085;
  const d = (u * 0.8 + v * 0.3) - front;
  const band = Math.exp(-(d * d) / 0.09) * 1.6;
  const blob = Math.exp(-(((u - 0.9) ** 2) + ((v + 0.4) ** 2)) / 0.10) * 0.9;
  return Math.max(0, band + blob - 0.05);
}

// Shared by the stub and the live fetch below, so the two can never
// silently drift into different grid shapes — sampleGrid() has to agree
// with whichever one actually filled `values`.
function buildGridShape(centre, radiusKm) {
  const spanKm = radiusKm * MAP_FETCH_MARGIN;
  const dLat = MAP_GRID_SPACING_KM / KM_PER_DEG_LAT;
  const dLon = MAP_GRID_SPACING_KM / kmPerDegLon(centre.lat);
  const rows = Math.ceil((spanKm * 2) / MAP_GRID_SPACING_KM) + 1;
  const cols = rows;
  const lat0 = centre.lat - (rows - 1) / 2 * dLat;
  const lon0 = centre.lon - (cols - 1) / 2 * dLon;
  return { lat0, lon0, dLat, dLon, rows, cols };
}

function buildStubGrid(centre, radiusKm) {
  const { lat0, lon0, dLat, dLon, rows, cols } = buildGridShape(centre, radiusKm);
  const hours = 48;
  const values = [];
  for (let t = 0; t < hours; t++) {
    const frame = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push(stubValueAt(lat0 + r * dLat, lon0 + c * dLon, t));
      }
      frame.push(row);
    }
    values.push(frame);
  }
  return { lat0, lon0, dLat, dLon, rows, cols, hours, values, stub: true };
}

const MAP_FORECAST_HOURS = 48;

// forecast_days: 3, not 2 — the Hour slider always shows the next 48
// hours from THIS MOMENT, not from local midnight, so on a late evening
// two days of data could run out before the slider does. Three always
// leaves a full 48-hour margin regardless of what time "now" happens
// to be. Same convention as fetchHourlyForecast()'s real-source fetch.
const MAP_FORECAST_DAYS = 3;

// One request, comma-separated coordinate lists (Open-Meteo supports
// multiple locations natively — up to 1000 per call — and returns an
// array of one object per location, in the order requested, each
// shaped exactly like a single-location response). Deliberately the
// merged global models rather than ukmo_uk_deterministic_2km — see the
// note at the top of this file for why.
//
// Cost: assume roughly one API call PER POINT against the 10,000/day
// free-tier limit. At 10 km spacing a 100 km-radius view can reach
// several hundred points (radiusKm * MAP_FETCH_MARGIN, squared, over
// the 10 km cell size) — comfortable for occasional use, but zooming
// out and panning around repeatedly could burn through the daily
// allowance faster than the other real sources do. Worth keeping an
// eye on if "Couldn't load map data" starts showing up on a well
// zoomed-out view.
async function fetchWeatherGrid(centre, radiusKm) {
  const { lat0, lon0, dLat, dLon, rows, cols } = buildGridShape(centre, radiusKm);
  const lats = [];
  const lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push((lat0 + r * dLat).toFixed(4));
      lons.push((lon0 + c * dLon).toFixed(4));
    }
  }

  const params = new URLSearchParams({
    latitude: lats.join(","),
    longitude: lons.join(","),
    hourly: "precipitation",
    forecast_days: String(MAP_FORECAST_DAYS),
    timezone: "auto"
  });

  const res = await fetchWithTimeout(`${WEATHER_URL}?${params.toString()}`, {}, 30000);
  if (!res.ok) throw new Error(`Map weather fetch failed: ${res.status}`);
  const data = await res.json();

  // A single point comes back as one object rather than an array — the
  // grid always has more than one point in practice, but this keeps the
  // indexing below from ever having to special-case it.
  const points = Array.isArray(data) ? data : [data];
  if (points.length !== rows * cols) {
    throw new Error("Map weather fetch returned an unexpected number of points");
  }

  // Every point sits inside the same small area and shares one
  // timezone, so "now" only needs working out once rather than per
  // point. Same tolerant lookup as fetchHourlyForecast() uses for the
  // real-source hourly view, for the same reason: matching by parsed
  // time rather than string equality survives whatever exact minute
  // Open-Meteo's hourly buckets land on.
  const now = new Date();
  const nowIndex = points[0].hourly.time.findIndex(
    t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000
  );
  const startIdx = nowIndex >= 0 ? nowIndex : 0;

  const values = [];
  for (let h = 0; h < MAP_FORECAST_HOURS; h++) {
    const frame = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const point = points[r * cols + c];
        const v = point.hourly.precipitation[startIdx + h];
        row.push(v === null || v === undefined ? 0 : v);
      }
      frame.push(row);
    }
    values.push(frame);
  }

  return { lat0, lon0, dLat, dLon, rows, cols, hours: MAP_FORECAST_HOURS, values, stub: false };
}

async function ensureGrid(centre, radiusKm, force) {
  const stale = Date.now() - mapGridFetchedAt > MAP_STALE_MS;
  const moved = !mapGridCentre || haversineKm(
    mapGridCentre.lat, mapGridCentre.lon, centre.lat, centre.lon
  ) > radiusKm * (MAP_FETCH_MARGIN - 1);
  if (!force && mapGrid && !stale && !moved) return;
  try {
    mapGrid = await fetchWeatherGrid(centre, radiusKm);
    mapGridCentre = { ...centre };
    mapGridFetchedAt = Date.now();
    setMapStatus("");
  } catch {
    // Keep whatever was last drawn rather than blanking. If the daily
    // limit is ever hit, a slightly stale map beats a broken one — and
    // the rest of Cloude is unaffected either way, because this fetch
    // is entirely separate from loadLocationData().
    setMapStatus(mapGrid
      ? "Couldn't refresh the map just now — showing the last one."
      : "Couldn't load map data just now.");
  }
}

function sampleGrid(grid, hour, lat, lon) {
  if (!grid) return null;
  const fr = (lat - grid.lat0) / grid.dLat;
  const fc = (lon - grid.lon0) / grid.dLon;
  if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) return null;
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(r0 + 1, grid.rows - 1), c1 = Math.min(c0 + 1, grid.cols - 1);
  const tr = fr - r0, tc = fc - c0;
  const f = grid.values[Math.min(hour, grid.hours - 1)];
  // Bilinear. Legitimate here in a way that sampling postcodes was not:
  // the model holds a continuous field that its grid samples, so
  // interpolating between cell centres recovers the field rather than
  // magnifying an interpolation that already happened.
  return (
    f[r0][c0] * (1 - tr) * (1 - tc) + f[r0][c1] * (1 - tr) * tc +
    f[r1][c0] * tr * (1 - tc) + f[r1][c1] * tr * tc
  );
}

// ---------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------
registerMapLayer({
  id: "base",
  draw(ctx, view) {
    const p = mapPalette();
    ctx.fillStyle = p.sea;
    ctx.fillRect(0, 0, view.w, view.h);
  }
});

// --- terrain slot goes here (see the registry comment above) ---

registerMapLayer({
  id: "coastline",
  draw(ctx, view) {
    const p = mapPalette();
    drawGeoJson(ctx, mapVectorData.coastline, view, { fill: p.land, stroke: p.coast });
  }
});

registerMapLayer({
  id: "lakes",
  draw(ctx, view) {
    const p = mapPalette();
    drawGeoJson(ctx, mapVectorData.lakes, view, { fill: p.sea, stroke: p.coast });
  }
});

registerMapLayer({
  id: "rain",
  draw(ctx, view) {
    if (!mapGrid) return;
    const p = mapPalette();
    const hour = mapHourValue();
    // 6px cells. Small enough that the model's own grid doesn't show as
    // blocks, large enough to stay smooth while dragging on a phone.
    const cell = 6;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const value = sampleGrid(mapGrid, hour, view.lat(py + cell / 2), view.lon(px + cell / 2));
        if (value === null || value < 0.05) continue;
        const step = Math.min(p.ramp.length - 1, Math.floor(Math.sqrt(value) * p.ramp.length));
        ctx.fillStyle = p.ramp[step];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }
});

registerMapLayer({
  id: "rings",
  draw(ctx, view) {
    const p = mapPalette();
    const home = homeCoords();
    if (!home) return;
    const hx = view.x(home.lon), hy = view.y(home.lat);
    const imperial = usingMiles();
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = p.ring;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    (MAP_RING_RADII_KM[view.radiusKm] || [30, 60]).forEach(km => {
      ctx.beginPath();
      ctx.arc(hx, hy, km * view.pxPerKm, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Units follow the choice already made in Settings rather than
      // introducing a map-specific one.
      const shown = imperial ? Math.round(km * 0.621371) : km;
      const text = `${shown} ${imperial ? "mi" : "km"}`;
      ctx.font = "600 13px -apple-system, system-ui, sans-serif";
      // Outlined in the base colour first: these labels sit on top of
      // whatever the rain layer drew, which at the heavy end is dark
      // enough to swallow them entirely.
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.land;
      ctx.strokeText(text, hx + 5, hy - km * view.pxPerKm - 4);
      ctx.fillStyle = p.ink;
      ctx.fillText(text, hx + 5, hy - km * view.pxPerKm - 4);
      ctx.setLineDash([3, 4]);
      ctx.globalAlpha = 0.7;
    });
    ctx.restore();
    ctx.fillStyle = p.ink;
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fill();
  }
});

registerMapLayer({
  id: "places",
  draw(ctx, view) {
    const places = mapVectorData.places;
    if (!places || !places.length) return;
    const p = mapPalette();
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = p.ink;
    // Label thinning does more work than the rings at the wider levels.
    // Two rules together: rank (a place's own importance, from the
    // source data) and collision (whatever is left must not overlap).
    // Rank alone leaves a mess in dense areas; collision alone drops
    // cities in favour of whichever village happened to draw first.
    const maxRank = view.radiusKm <= 25 ? 6 : view.radiusKm <= 50 ? 4 : 2;
    const drawn = [];
    places
      .filter(place => (place.rank || 0) <= maxRank)
      .sort((a, b) => (a.rank || 0) - (b.rank || 0))
      .forEach(place => {
        const px = view.x(place.lon), py = view.y(place.lat);
        if (px < 6 || px > view.w - 6 || py < 12 || py > view.h - 4) return;
        const width = ctx.measureText(place.name).width;
        const box = { x: px, y: py, w: width + 14, h: 14 };
        if (drawn.some(d => Math.abs(d.x - box.x) < (d.w + box.w) / 2 && Math.abs(d.y - box.y) < 14)) return;
        drawn.push(box);
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(place.name, px + 5, py + 4);
      });
  }
});

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
// Resolved once on load, and cached here for the life of the page.
let mapHome = null;

function homeCoords() {
  if (typeof state === "object" && state && state.lat != null && state.lon != null) {
    return { lat: state.lat, lon: state.lon };
  }
  return mapHome;
}

// app.js only starts loadLocationData() when the page has a headline
// grid or a comparison table, and this page has neither — deliberately,
// so the map can never block or be blocked by the main forecast load.
// The side effect is that state.lat and state.lon stay null here
// forever, which silently took out both the distance rings and the Home
// button: each needs to know where home actually is.
//
// So the map resolves it once itself. One extra lookup on a page that
// already fetches weather, and it fails quietly — the map still pans and
// still draws rain without it, it just has nothing to measure from.
async function resolveMapHome() {
  if (homeCoords()) return;
  try {
    const postcode = typeof state === "object" && state ? state.postcode : null;
    if (!postcode) return;
    const resolved = await resolveLocation(postcode);
    mapHome = { lat: resolved.lat, lon: resolved.lon };
  } catch {
    // Ambiguous or unreachable — rings and Home stay unavailable rather
    // than guessing at a location.
  }
}

function usingMiles() {
  try {
    const units = loadConditionUnits();
    // Rain's unit is the closest thing to a distance preference the app
    // already stores; no new setting is introduced for the map.
    return units.rain === "imperial";
  } catch {
    return false;
  }
}

function loadMapCentre() {
  try {
    const raw = localStorage.getItem(MAP_CENTRE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.lat === "number" && typeof parsed.lon === "number") return parsed;
    }
  } catch {}
  return homeCoords() || { lat: 51.13, lon: -2.99 };
}

function saveMapCentre(centre) {
  try { localStorage.setItem(MAP_CENTRE_KEY, JSON.stringify(centre)); } catch {}
}

function loadMapZoom() {
  try {
    const v = parseInt(localStorage.getItem(MAP_ZOOM_KEY), 10);
    if (v >= 0 && v < MAP_ZOOM_RADII_KM.length) return v;
  } catch {}
  return 1;
}

function saveMapZoom(index) {
  try { localStorage.setItem(MAP_ZOOM_KEY, String(index)); } catch {}
}

// "Previous" means the previous ADOPTED location — the last place a
// forecast was actually fetched for — not the previous view. A view is
// wherever the map happened to be mid-drag, which changes constantly and
// is useless as a destination; an adopted location is somewhere you
// deliberately went.
function loadPreviousAdopted() {
  try {
    const raw = localStorage.getItem(MAP_PREVIOUS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function savePreviousAdopted(entry) {
  try { localStorage.setItem(MAP_PREVIOUS_KEY, JSON.stringify(entry)); } catch {}
}

// Built and wired, then put behind a setting that defaults on, rather
// than built and hidden. Hidden-but-live code doesn't get exercised, so
// it rots quietly and fails against state that changed shape underneath
// it. Behind a default-on toggle it is used, and if it is still switched
// off in three months it can be deleted knowing exactly what it does.
function backButtonEnabled() {
  try { return localStorage.getItem(MAP_BACK_ENABLED_KEY) !== "off"; } catch { return true; }
}

let mapCentre = loadMapCentre();
let mapZoomIndex = loadMapZoom();

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
const mapCanvas = document.getElementById("mapCanvas");
const mapStatusEl = document.getElementById("mapStatus");
const mapHourInput = document.getElementById("mapHour");

function mapHourValue() {
  return mapHourInput ? parseInt(mapHourInput.value, 10) || 0 : 0;
}

// "+7h" makes you do the arithmetic before you can act on it. The
// question being asked is "will it be raining when I get there", and
// that is a clock time. Days are named once they stop being today,
// because "09:00" alone is ambiguous over a 48-hour slider.
function mapHourClock(hoursAhead) {
  const when = new Date(Date.now() + hoursAhead * 3600000);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = when.toDateString() === new Date().toDateString();
  if (hoursAhead === 0) return `Now, ${time}`;
  if (isToday) return time;
  return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function setMapStatus(message) {
  if (!mapStatusEl) return;
  mapStatusEl.textContent = message || "";
  mapStatusEl.classList.toggle("is-error", !!message);
}

function sizeMapCanvas() {
  if (!mapCanvas) return;
  const rect = mapCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  mapCanvas.width = Math.round(rect.width * dpr);
  mapCanvas.height = Math.round(rect.height * dpr);
}

function renderMap() {
  if (!mapCanvas) return;
  const ctx = mapCanvas.getContext("2d");
  const dpr = mapCanvas.width / (mapCanvas.getBoundingClientRect().width || mapCanvas.width);
  // Everything after this draws in CSS pixels and comes out sharp.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const view = makeView(mapCanvas, mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
  mapLayers.forEach(layer => {
    ctx.save();
    try { layer.draw(ctx, view); } catch { /* one bad layer must not blank the map */ }
    ctx.restore();
  });
  updateMapChrome();
}

function updateMapChrome() {
  const radius = MAP_ZOOM_RADII_KM[mapZoomIndex];
  const imperial = usingMiles();
  const across = imperial ? Math.round(radius * 2 * 0.621371) : radius * 2;
  const zoomLabel = document.getElementById("mapZoomLabel");
  if (zoomLabel) zoomLabel.textContent = `${across} ${imperial ? "miles" : "km"} across`;

  const scale = document.getElementById("mapScale");
  if (scale) {
    const stale = mapGrid && Date.now() - mapGridFetchedAt > MAP_STALE_MS;
    scale.textContent = mapHourClock(mapHourValue()) + (stale ? " · older data" : "");
  }

  const hourLabel = document.getElementById("mapHourLabel");
  if (hourLabel) hourLabel.textContent = mapHourClock(mapHourValue());

  const adopt = document.getElementById("mapAdopt");
  if (adopt) {
    const home = homeCoords();
    const away = home ? haversineKm(home.lat, home.lon, mapCentre.lat, mapCentre.lon) : null;
    // The button says where "here" actually is, so pressing it is never
    // a surprise.
    adopt.textContent = away != null && away < 2
      ? "Forecast for here"
      : `Forecast for here${away != null ? ` (${Math.round(away)} km out)` : ""}`;
  }

  const home = document.getElementById("mapHome");
  if (home) home.disabled = !homeCoords();

  const back = document.getElementById("mapBack");
  if (back) {
    // Absent rather than disabled until there is somewhere to go back
    // to. On first use Home and Back would point at the same place,
    // which looks broken.
    back.hidden = !(backButtonEnabled() && loadPreviousAdopted());
  }
}

// ---------------------------------------------------------------------
// Panning
//
// Single-finger drag, which means touch-action: none on the canvas —
// the canvas stops the page scrolling over itself. That is why drag
// exists ONLY on this page and the front-page strip is tap-only: a
// scroll-blocking canvas inside a scrolling column feels broken.
// ---------------------------------------------------------------------
let panPointerId = null;
let panLast = null;

if (mapCanvas) {
  mapCanvas.addEventListener("pointerdown", e => {
    panPointerId = e.pointerId;
    panLast = { x: e.clientX, y: e.clientY };
    mapCanvas.setPointerCapture(e.pointerId);
  });

  mapCanvas.addEventListener("pointermove", e => {
    if (e.pointerId !== panPointerId || !panLast) return;
    // No dpr correction here any more: pointer coordinates and the
    // view are both in CSS pixels now.
    const view = makeView(mapCanvas, mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
    const dxKm = (e.clientX - panLast.x) / view.pxPerKm;
    const dyKm = (e.clientY - panLast.y) / view.pxPerKm;
    mapCentre = {
      lat: mapCentre.lat + dyKm / KM_PER_DEG_LAT,
      lon: mapCentre.lon - dxKm / kmPerDegLon(mapCentre.lat)
    };
    panLast = { x: e.clientX, y: e.clientY };
    renderMap();
  });

  function endPan(e) {
    if (e.pointerId !== panPointerId) return;
    panPointerId = null;
    panLast = null;
    saveMapCentre(mapCentre);
    // Only refetches if the drag left the margin — panning back and
    // forth over the same ground costs nothing.
    ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
  }
  mapCanvas.addEventListener("pointerup", endPan);
  mapCanvas.addEventListener("pointercancel", endPan);
}

// ---------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------
function goTo(centre, { remember } = {}) {
  if (remember) savePreviousAdopted({ lat: mapCentre.lat, lon: mapCentre.lon });
  mapCentre = { lat: centre.lat, lon: centre.lon };
  saveMapCentre(mapCentre);
  ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
  renderMap();
}

document.getElementById("mapHome")?.addEventListener("click", () => {
  const home = homeCoords();
  if (home) goTo(home, { remember: true });
});

document.getElementById("mapBack")?.addEventListener("click", () => {
  const previous = loadPreviousAdopted();
  if (previous) goTo(previous, { remember: true });
});

document.getElementById("mapAdopt")?.addEventListener("click", () => {
  savePreviousAdopted({ lat: mapCentre.lat, lon: mapCentre.lon });
  // Adoption is deliberate and never accidental, because every adopted
  // centre becomes a new coordinate-based areaCode with no FFV, no
  // eligibility, and a year-long backfill behind it. Free-panning that
  // adopted automatically would quietly spawn dozens of half-learned
  // areas.
  try {
    localStorage.setItem(CURRENT_POSTCODE_KEY, `${mapCentre.lat.toFixed(3)},${mapCentre.lon.toFixed(3)}`);
  } catch {}
  location.href = "index.html";
});

document.getElementById("mapZoomIn")?.addEventListener("click", () => {
  if (mapZoomIndex > 0) mapZoomIndex--;
  saveMapZoom(mapZoomIndex);
  ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
  renderMap();
});

document.getElementById("mapZoomOut")?.addEventListener("click", () => {
  if (mapZoomIndex < MAP_ZOOM_RADII_KM.length - 1) mapZoomIndex++;
  saveMapZoom(mapZoomIndex);
  ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
  renderMap();
});

mapHourInput?.addEventListener("input", renderMap);

window.addEventListener("resize", () => { sizeMapCanvas(); renderMap(); });

(async function initMap() {
  sizeMapCanvas();
  renderMap();

  await resolveMapHome();
  // Only recentre if nothing was stored — a remembered position must
  // survive, that being the whole point of remembering it.
  let stored = null;
  try { stored = localStorage.getItem(MAP_CENTRE_KEY); } catch {}
  if (!stored && homeCoords()) mapCentre = { ...homeCoords() };
  renderMap();

  await loadMapVectors();
  renderMap();
  await ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex], true);
  renderMap();
})();
