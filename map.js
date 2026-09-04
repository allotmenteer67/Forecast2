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

// Temperature and pressure get their own FIXED colour scales rather
// than one per palette (unlike rain's ramp above) — real-world
// temperature maps are blue-cold/red-hot almost universally regardless
// of app theme, and inventing a "Slate" or "Paper" variant of that
// would just be decoration with no convention behind it. One
// consequence worth stating plainly: the "High contrast" mono palette
// was built so rain reads by shade alone for anyone who can't reliably
// separate blues — temperature and pressure don't get that treatment,
// and showing them at the same time as rain (or each other) in mono
// mode will be harder to tell apart than rain alone is.
const MAP_TEMP_THRESHOLDS = [-Infinity, 0, 6, 12, 18, 24]; // °C, lower bound per band
const MAP_TEMP_RAMP = ["#2b6cb0", "#4299e1", "#63b3ed", "#f6ad55", "#ed8936", "#c53030"];

const MAP_PRESSURE_THRESHOLDS = [-Infinity, 995, 1005, 1013, 1020, 1028]; // hPa, lower bound per band
const MAP_PRESSURE_RAMP = ["#553c9a", "#805ad5", "#b794f4", "#9ae6b4", "#68d391", "#dd6b20"];

// Highest index whose threshold the value clears — used by temperature
// and pressure, which (unlike rain) always have a value worth showing;
// there's no "dry" band to hide below.
function bandIndexFor(value, thresholds) {
  let idx = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (value >= thresholds[i]) idx = i;
  }
  return idx;
}

// ---------------------------------------------------------------------
// Layer visibility — independent toggles, not a single-layer switcher.
// Rain defaults on (the map's original purpose); the three added later
// default off so nobody's map suddenly looks different after an update.
// Deliberately no mutual exclusion: showing rain and temperature at
// once will look muddier than either alone (two colour washes occupying
// the same pixels), but that trade was the explicit ask — a forced
// single-layer switcher would be easier to keep legible but wouldn't be
// what this is for.
// ---------------------------------------------------------------------
const MAP_LAYER_TOGGLES_KEY = "forecast-compare:map:layers";
const MAP_LAYER_IDS = ["rain", "wind", "pressure", "temperature"];
const MAP_LAYER_DEFAULTS = { rain: true, wind: false, pressure: false, temperature: false };

function loadMapLayerToggles() {
  try {
    const raw = localStorage.getItem(MAP_LAYER_TOGGLES_KEY);
    if (raw) return { ...MAP_LAYER_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...MAP_LAYER_DEFAULTS };
}

function saveMapLayerToggle(id, visible) {
  const toggles = loadMapLayerToggles();
  toggles[id] = visible;
  try { localStorage.setItem(MAP_LAYER_TOGGLES_KEY, JSON.stringify(toggles)); } catch {}
}

function mapLayerVisible(id) {
  return !!loadMapLayerToggles()[id];
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

// Rough plausible-looking stand-ins for the three added fields, built
// from the same u/v/front terms as rain above so all four stay loosely
// consistent with each other (temperature drops and pressure falls
// near the "front", wind backs veered ahead of it) — good enough for
// exercising the toggle UI and the wind animation offline, not a real
// physical model.
function stubTempAt(lat, lon, t) {
  const v = (lat - 51.0) * 1.4;
  const front = -1.2 + t * 0.085;
  const seasonalBase = 14 - v * 3;
  return seasonalBase - Math.exp(-((front + 0.6) ** 2) / 0.5) * 4;
}

function stubPressureAt(lat, lon, t) {
  const u = (lon + 4.0) * 1.4;
  const v = (lat - 51.0) * 1.4;
  const front = -1.2 + t * 0.085;
  const d = (u * 0.8 + v * 0.3) - front;
  return 1013 - Math.exp(-(d * d) / 0.2) * 22;
}

function stubWindAt(lat, lon, t) {
  const u = (lon + 4.0) * 1.4;
  const front = -1.2 + t * 0.085;
  const speed = 8 + Math.exp(-((u - front) ** 2) / 0.3) * 22;
  const dir = (220 + t * 1.5 + u * 20) % 360;
  return { speed, dir };
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
  const rain = [], temp = [], pressure = [], windSpeed = [], windDir = [];
  for (let t = 0; t < hours; t++) {
    const rainFrame = [], tempFrame = [], pressureFrame = [], speedFrame = [], dirFrame = [];
    for (let r = 0; r < rows; r++) {
      const rainRow = [], tempRow = [], pressureRow = [], speedRow = [], dirRow = [];
      for (let c = 0; c < cols; c++) {
        const lat = lat0 + r * dLat, lon = lon0 + c * dLon;
        rainRow.push(stubValueAt(lat, lon, t));
        tempRow.push(stubTempAt(lat, lon, t));
        pressureRow.push(stubPressureAt(lat, lon, t));
        const wind = stubWindAt(lat, lon, t);
        speedRow.push(wind.speed);
        dirRow.push(wind.dir);
      }
      rainFrame.push(rainRow); tempFrame.push(tempRow); pressureFrame.push(pressureRow);
      speedFrame.push(speedRow); dirFrame.push(dirRow);
    }
    rain.push(rainFrame); temp.push(tempFrame); pressure.push(pressureFrame);
    windSpeed.push(speedFrame); windDir.push(dirFrame);
  }
  return { lat0, lon0, dLat, dLon, rows, cols, hours, rain, temp, pressure, windSpeed, windDir, stub: true };
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
// note at the top of this file for why. pressure_msl (sea-level,
// height-corrected), not surface_pressure — the same choice
// collect-weather.js already makes for the Compare page's Pressure
// condition, since the map's area can span real elevation differences
// that surface pressure alone would show as a fake gradient.
// wind_speed_unit: mph to match every other real fetch in this app —
// see the README note on the km/h-labelled-as-mph bug that convention
// was introduced to fix.
//
// Cost: four hourly variables instead of one, on the same one-request-
// per-point shape as before — assume roughly 4x the "API call" cost per
// point against the 10,000/day free-tier limit now that wind, pressure
// and temperature ride along with rain. At 10 km spacing a 100 km-
// radius view can reach several hundred points, so this is worth
// watching if "Couldn't load map data" starts showing up on a well
// zoomed-out view — more so than before this change.
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
    hourly: "precipitation,temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "mph",
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

  const rain = [], temp = [], pressure = [], windSpeed = [], windDir = [];
  for (let h = 0; h < MAP_FORECAST_HOURS; h++) {
    const rainFrame = [], tempFrame = [], pressureFrame = [], speedFrame = [], dirFrame = [];
    for (let r = 0; r < rows; r++) {
      const rainRow = [], tempRow = [], pressureRow = [], speedRow = [], dirRow = [];
      for (let c = 0; c < cols; c++) {
        const point = points[r * cols + c];
        const i = startIdx + h;
        const v = point.hourly.precipitation[i];
        rainRow.push(v === null || v === undefined ? 0 : v);
        tempRow.push(point.hourly.temperature_2m[i] ?? null);
        pressureRow.push(point.hourly.pressure_msl[i] ?? null);
        speedRow.push(point.hourly.wind_speed_10m[i] ?? null);
        dirRow.push(point.hourly.wind_direction_10m[i] ?? null);
      }
      rainFrame.push(rainRow); tempFrame.push(tempRow); pressureFrame.push(pressureRow);
      speedFrame.push(speedRow); dirFrame.push(dirRow);
    }
    rain.push(rainFrame); temp.push(tempFrame); pressure.push(pressureFrame);
    windSpeed.push(speedFrame); windDir.push(dirFrame);
  }

  return {
    lat0, lon0, dLat, dLon, rows, cols, hours: MAP_FORECAST_HOURS,
    rain, temp, pressure, windSpeed, windDir, stub: false
  };
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

// field: "rain" | "temp" | "pressure" | "windSpeed" | "windDir" — each a
// same-shaped [hour][row][col] array off the grid object.
function sampleGrid(grid, field, hour, lat, lon) {
  if (!grid) return null;
  const fr = (lat - grid.lat0) / grid.dLat;
  const fc = (lon - grid.lon0) / grid.dLon;
  if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) return null;
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(r0 + 1, grid.rows - 1), c1 = Math.min(c0 + 1, grid.cols - 1);
  const tr = fr - r0, tc = fc - c0;
  const f = grid[field][Math.min(hour, grid.hours - 1)];
  if (f[r0][c0] === null || f[r0][c1] === null || f[r1][c0] === null || f[r1][c1] === null) {
    // Wind direction is angular — averaging raw degrees across a wrap
    // (e.g. 350° and 10°) would bilinear-blend to 180°, exactly
    // backwards. Nearest-point lookup sidesteps that entirely rather
    // than doing circular interpolation for one field only.
    return f[Math.round(fr)]?.[Math.round(fc)] ?? null;
  }
  // Bilinear. Legitimate here in a way that sampling postcodes was not:
  // the model holds a continuous field that its grid samples, so
  // interpolating between cell centres recovers the field rather than
  // magnifying an interpolation that already happened.
  return (
    f[r0][c0] * (1 - tr) * (1 - tc) + f[r0][c1] * (1 - tr) * tc +
    f[r1][c0] * tr * (1 - tc) + f[r1][c1] * tr * tc
  );
}

// windDir specifically: bilinear-interpolating raw compass degrees is
// wrong across the 0°/360° wrap, so this always samples the nearest
// grid point rather than blending — a small loss of smoothness that a
// sparse arrow layout would hide anyway.
function sampleWindDir(grid, hour, lat, lon) {
  if (!grid) return null;
  const fr = (lat - grid.lat0) / grid.dLat;
  const fc = (lon - grid.lon0) / grid.dLon;
  if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) return null;
  const r = Math.round(Math.min(Math.max(fr, 0), grid.rows - 1));
  const c = Math.round(Math.min(Math.max(fc, 0), grid.cols - 1));
  const v = grid.windDir[Math.min(hour, grid.hours - 1)][r][c];
  return v === null || v === undefined ? null : v;
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

// Real hourly precipitation, in mm/hr — one threshold per ramp colour.
// Below the first threshold is drawn as nothing at all (dry), not the
// palest band, so "no colour" always means "no rain" rather than "a
// trace too faint to bother with" being indistinguishable from actual
// dry weather. Chosen to roughly track the intensity bands the Met
// Office and BBC already use in words (very light/light/moderate/
// heavy/torrential) rather than an abstract 0–1 scale — this replaced
// a sqrt(value) curve that was tuned for the stub's synthetic 0–1.6
// range and never revisited once real Open-Meteo data went live, which
// meant the palest band could never actually be reached by a real mm/hr
// figure. renderRainLegend() reads this same array, so the on-screen key
// and the fill colours can never drift out of sync with each other.
const RAIN_BAND_THRESHOLDS = [0.1, 0.5, 1, 2, 4, 8];

// Highest band whose threshold the value clears, or -1 for "don't draw
// this cell at all" (dry, or no data).
function rainBandIndex(value) {
  if (value === null || value === undefined || value < RAIN_BAND_THRESHOLDS[0]) return -1;
  let idx = 0;
  for (let i = 1; i < RAIN_BAND_THRESHOLDS.length; i++) {
    if (value >= RAIN_BAND_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

registerMapLayer({
  id: "temperature",
  draw(ctx, view) {
    if (!mapGrid || !mapLayerVisible("temperature")) return;
    const hour = mapHourValue();
    const cell = 6;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const value = sampleGrid(mapGrid, "temp", hour, view.lat(py + cell / 2), view.lon(px + cell / 2));
        if (value === null || value === undefined) continue;
        ctx.fillStyle = MAP_TEMP_RAMP[bandIndexFor(value, MAP_TEMP_THRESHOLDS)];
        ctx.globalAlpha = 0.55;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }
});

registerMapLayer({
  id: "pressure",
  draw(ctx, view) {
    if (!mapGrid || !mapLayerVisible("pressure")) return;
    const hour = mapHourValue();
    const cell = 6;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const value = sampleGrid(mapGrid, "pressure", hour, view.lat(py + cell / 2), view.lon(px + cell / 2));
        if (value === null || value === undefined) continue;
        ctx.fillStyle = MAP_PRESSURE_RAMP[bandIndexFor(value, MAP_PRESSURE_THRESHOLDS)];
        ctx.globalAlpha = 0.5;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }
});

registerMapLayer({
  id: "rain",
  draw(ctx, view) {
    if (!mapGrid || !mapLayerVisible("rain")) return;
    const p = mapPalette();
    const hour = mapHourValue();
    // 6px cells. Small enough that the model's own grid doesn't show as
    // blocks, large enough to stay smooth while dragging on a phone.
    const cell = 6;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const value = sampleGrid(mapGrid, "rain", hour, view.lat(py + cell / 2), view.lon(px + cell / 2));
        const band = rainBandIndex(value);
        if (band < 0) continue;
        ctx.fillStyle = p.ramp[band];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }
});

// Sparse arrows rather than one per grid cell — a 6px-spaced field of
// arrows would be solid ink at this zoom. Spacing is in screen pixels,
// not world distance, so the arrow density looks the same at every
// zoom level rather than thinning out or clumping as radiusKm changes.
const MAP_WIND_ARROW_SPACING_PX = 46;

// Downwind, not meteorological "from" — matches the headline wind
// arrow's own convention elsewhere in the app (anyRealWindDirection() /
// the rotating arrow in app.js), on the same reasoning: "which way will
// this push me" is more directly useful here than the raw met reading.
function windArrowAngleRad(metFromDegrees) {
  return ((metFromDegrees + 180) % 360) * Math.PI / 180;
}

registerMapLayer({
  id: "wind",
  draw(ctx, view) {
    if (!mapGrid || !mapLayerVisible("wind")) return;
    const p = mapPalette();
    const hour = mapHourValue();
    const dashOffset = mapWindAnimOffset;
    ctx.strokeStyle = p.ink;
    ctx.fillStyle = p.ink;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    for (let px = MAP_WIND_ARROW_SPACING_PX / 2; px < view.w; px += MAP_WIND_ARROW_SPACING_PX) {
      for (let py = MAP_WIND_ARROW_SPACING_PX / 2; py < view.h; py += MAP_WIND_ARROW_SPACING_PX) {
        const lat = view.lat(py), lon = view.lon(px);
        const speed = sampleGrid(mapGrid, "windSpeed", hour, lat, lon);
        const dir = sampleWindDir(mapGrid, hour, lat, lon);
        if (speed === null || dir === null) continue;
        const angle = windArrowAngleRad(dir);
        // Length scales with speed but is clamped at both ends — a calm
        // shouldn't disappear to a dot, and a gale shouldn't overrun the
        // next arrow's own cell.
        const len = 8 + Math.min(1, speed / 40) * 14;
        const dx = Math.sin(angle), dy = -Math.cos(angle);
        const x0 = px - dx * len * 0.5, y0 = py - dy * len * 0.5;
        const x1 = px + dx * len * 0.5, y1 = py + dy * len * 0.5;

        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        // The animated dash: a short "travelling" segment along the
        // shaft rather than a static line, so the arrow reads as a flow
        // direction rather than a fixed vector — a lightweight stand-in
        // for a full particle animation, cheap enough to redraw every
        // frame on a phone.
        ctx.setLineDash([4, 5]);
        ctx.lineDashOffset = -dashOffset;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrowhead, fixed (not dashed) so the direction stays readable
        // even mid-animation-cycle.
        const headLen = 4.5;
        const headAngle = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(
          x1 - Math.sin(angle - headAngle) * headLen,
          y1 + Math.cos(angle - headAngle) * headLen
        );
        ctx.lineTo(
          x1 - Math.sin(angle + headAngle) * headLen,
          y1 + Math.cos(angle + headAngle) * headLen
        );
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
});

// The legend is DOM, not canvas — same reasoning as the crosshair: it
// never needs redrawing mid-pan, and real text is sharper and far
// cheaper to keep accessible than canvas-drawn labels would be. Called
// from renderMap() so a palette change (paper/night/mono) or a layer
// toggle is reflected immediately rather than only on next page load.
//
// One row per VISIBLE colour-wash layer — rain, temperature, pressure —
// each labelled so a legend showing up under the map always says which
// quantity it's for; wind gets a plain caption instead, since an arrow
// field's "value" is a direction and rough length, not a colour scale.
function renderMapLegends() {
  const container = document.getElementById("mapLegends");
  if (!container) return;
  container.innerHTML = "";

  function addRow(labelText, thresholds, ramp, unit) {
    const row = document.createElement("div");
    row.className = "map-legend-row";
    const caption = document.createElement("span");
    caption.className = "map-legend-caption";
    caption.textContent = labelText;
    row.appendChild(caption);
    const strip = document.createElement("div");
    strip.className = "map-legend";
    thresholds.forEach((threshold, i) => {
      const swatch = document.createElement("span");
      swatch.className = "map-legend-swatch";
      swatch.style.background = ramp[i];
      const label = document.createElement("span");
      label.className = "map-legend-label";
      if (threshold === -Infinity) {
        label.textContent = `<${thresholds[1]}${unit}`;
      } else if (i === thresholds.length - 1) {
        label.textContent = `${threshold}+${unit}`;
      } else {
        label.textContent = `${threshold}${unit}`;
      }
      const item = document.createElement("span");
      item.className = "map-legend-item";
      item.append(swatch, label);
      strip.appendChild(item);
    });
    row.appendChild(strip);
    container.appendChild(row);
  }

  if (mapLayerVisible("rain")) {
    const p = mapPalette();
    addRow("Rain, mm/hr", RAIN_BAND_THRESHOLDS, p.ramp, "");
  }
  if (mapLayerVisible("temperature")) {
    addRow("Temperature, °C", MAP_TEMP_THRESHOLDS, MAP_TEMP_RAMP, "");
  }
  if (mapLayerVisible("pressure")) {
    addRow("Pressure, hPa", MAP_PRESSURE_THRESHOLDS, MAP_PRESSURE_RAMP, "");
  }
  if (mapLayerVisible("wind")) {
    const note = document.createElement("div");
    note.className = "map-legend-row map-legend-note";
    note.textContent = "Wind — arrow points downwind, longer = stronger";
    container.appendChild(note);
  }
}

// ---------------------------------------------------------------------
// Wind animation
//
// A single shared offset, advanced on a plain interval and read by
// every arrow the wind layer draws — not a per-arrow animation, so
// hundreds of arrows cost one running timer rather than hundreds.
// Runs only while the wind layer is actually visible and the tab is in
// the foreground; there is no point spending battery animating
// something nobody can see.
// ---------------------------------------------------------------------
let mapWindAnimOffset = 0;
let mapWindAnimTimer = null;

function mapWindAnimShouldRun() {
  return mapLayerVisible("wind") && document.visibilityState !== "hidden";
}

function startOrStopMapWindAnim() {
  const shouldRun = mapWindAnimShouldRun();
  if (shouldRun && !mapWindAnimTimer) {
    mapWindAnimTimer = setInterval(() => {
      mapWindAnimOffset = (mapWindAnimOffset + 1) % 9;
      renderMap();
    }, 90);
  } else if (!shouldRun && mapWindAnimTimer) {
    clearInterval(mapWindAnimTimer);
    mapWindAnimTimer = null;
  }
}

document.addEventListener("visibilitychange", startOrStopMapWindAnim);

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
  renderMapLegends();
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

// Layer toggle checkboxes — built once from MAP_LAYER_IDS rather than
// four near-identical listeners, so adding a fifth layer later is one
// entry in that array plus a matching checkbox in map.html, not another
// hand-written block here.
const mapLayerToggleEls = {};
MAP_LAYER_IDS.forEach(id => {
  const el = document.getElementById(`mapLayer_${id}`);
  if (!el) return;
  mapLayerToggleEls[id] = el;
  const toggles = loadMapLayerToggles();
  el.checked = !!toggles[id];
  el.addEventListener("change", () => {
    saveMapLayerToggle(id, el.checked);
    if (id === "wind") startOrStopMapWindAnim();
    renderMap();
  });
});

(async function initMap() {
  sizeMapCanvas();
  renderMap();
  startOrStopMapWindAnim();

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
