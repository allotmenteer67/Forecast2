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
const MAP_ZOOM_RADII_KM = [25, 50, 100, 150];

// Ring radii per zoom level. Fixed rings would be either invisible at
// the widest level or off-canvas at the closest.
const MAP_RING_RADII_KM = { 25: [10, 20], 50: [15, 30], 100: [30, 60], 150: [50, 100] };
// A separate table of genuinely round MILE values, not the km ones
// converted — 30km becomes "19mi" when converted, which reads as an
// oddly specific measurement nobody actually thinks in. 20mi is what
// someone using miles would actually expect to see there.
const MAP_RING_RADII_MI = { 25: [5, 10], 50: [10, 20], 100: [20, 40], 150: [30, 60] };

// The grid is fetched wider than it is displayed, so ordinary panning
// reveals data already in hand rather than triggering a refetch. Only
// dragging past this margin costs a new request.
const MAP_FETCH_MARGIN = 1.5;

// ~10 km at the closest zoom, matching the coarsest of the merged
// models (finer would just be resampling interpolation that already
// happened upstream) — but widened at the two wider zoom levels
// specifically to keep the POINT COUNT, and so the payload size, from
// growing unboundedly with the viewing area. Flat 10km spacing at
// 100km radius meant ~960 points and a multi-megabyte response once
// wind/temperature/pressure joined rain in the same request (5
// variables instead of 1) — squarely why "couldn't load map data"
// started showing up more often on a wide, zoomed-out view: that
// response was routinely taking longer to arrive than the fetch
// timeout allowed, especially on a slower connection. Detail that
// dense was never visible at that zoom anyway.
const MAP_GRID_SPACING_KM = { 25: 10, 50: 14, 100: 20, 150: 25 };

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
    // Land now uses the app's own --accent-light green (#e4efe6) rather
    // than a neutral beige — safe to do now that no data layer uses
    // green anywhere (rain is blue, temperature runs purple→red,
    // pressure is unfilled contour lines), and it ties the map visually
    // back to the rest of the app. Sea is paler than before for the
    // same underlying reason as the land change: the palest rain band
    // needs to actually stand out against it, and the old sea tone sat
    // too close to that band's own colour.
    land: "#e4efe6", sea: "#EEF5FA", coast: "#9c9a92", ink: "#4a4844", ring: "#8a887f",
    // Starts at mid-blue, not near-white: on a light base the palest
    // stops of a conventional radar ramp read as "no rain".
    ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"]
  },
  {
    id: "slate",
    name: "Slate",
    // Land uses the app's own --accent-dark green (#234f39), same
    // reasoning as Paper above. Sea lightened from the original
    // near-black so the palest rain band doesn't get lost against it —
    // "paler" means lighter here, the opposite direction from Paper's
    // sea change, since a dark theme needs MORE separation from black
    // to show a pale colour, not less.
    land: "#234f39", sea: "#33454f", coast: "#7a7a72", ink: "#d8d6cf", ring: "#8f8f86",
    // Dark base, so the full range including the pale end is usable.
    ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"]
  },
  {
    id: "mono",
    name: "High contrast",
    // Deliberately NOT given the green land treatment the other two
    // palettes got — this one's whole purpose is no hue at all, for
    // anyone who can't reliably separate colours by shade. Introducing
    // green here would undermine the one thing this palette is for.
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
//
// Temperature is a smooth gradient between these stops, not discrete
// bands — the original 6-step banding (6°C per colour change) read as
// coarse, and widening the range to actually cover a UK heatwave/cold
// snap (-10 to 34°C, both seen in recent years) at a similarly coarse
// step would have meant a dozen-plus swatches, unworkable as a legend
// on a phone. A continuous scale changes colour at every degree and
// only needs a handful of tick labels to explain itself.
const MAP_TEMP_MIN_C = -10;
const MAP_TEMP_MAX_C = 34;
const MAP_TEMP_COLOR_STOPS = [
  { t: -10, rgb: [90, 40, 140] },  // deep purple — proper winter cold
  { t: 0, rgb: [43, 108, 176] },   // blue — freezing
  { t: 12, rgb: [99, 179, 237] },  // light blue — cool
  { t: 20, rgb: [246, 173, 85] },  // amber — warm
  { t: 27, rgb: [237, 137, 54] },  // orange — hot
  { t: 34, rgb: [197, 48, 48] }    // red — heatwave
];

function tempColor(value) {
  const v = Math.max(MAP_TEMP_MIN_C, Math.min(MAP_TEMP_MAX_C, value));
  const stops = MAP_TEMP_COLOR_STOPS;
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i].t && v <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi.t - lo.t || 1;
  const f = (v - lo.t) / span;
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}


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
  const spacingKm = MAP_GRID_SPACING_KM[radiusKm] || 10;
  const spanKm = radiusKm * MAP_FETCH_MARGIN;
  const dLat = spacingKm / KM_PER_DEG_LAT;
  const dLon = spacingKm / kmPerDegLon(centre.lat);
  const rows = Math.ceil((spanKm * 2) / spacingKm) + 1;
  const cols = rows;
  const lat0 = centre.lat - (rows - 1) / 2 * dLat;
  const lon0 = centre.lon - (cols - 1) / 2 * dLon;
  return { lat0, lon0, dLat, dLon, rows, cols };
}

function buildStubGrid(centre, radiusKm) {
  const { lat0, lon0, dLat, dLon, rows, cols } = buildGridShape(centre, radiusKm);
  const hours = 48;
  // Rounded down to the top of the current hour — real Open-Meteo data
  // is always bucketed on the hour, and the stub should behave the same
  // way rather than showing minute-precise labels the live data never
  // would.
  const startOfHour = new Date();
  startOfHour.setMinutes(0, 0, 0);
  const times = [];
  const rain = [], temp = [], pressure = [], windSpeed = [], windDir = [];
  for (let t = 0; t < hours; t++) {
    times.push(new Date(startOfHour.getTime() + t * 3600000).toISOString());
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
  return { lat0, lon0, dLat, dLon, rows, cols, hours, times, rain, temp, pressure, windSpeed, windDir, stub: true };
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
    times: points[0].hourly.time.slice(startIdx, startIdx + MAP_FORECAST_HOURS),
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
  } catch (err) {
    // One silent retry before giving up — a lot of what shows up as
    // "couldn't load" on mobile is a momentary signal drop rather than
    // anything actually wrong, and a short pause is often all it takes.
    // Only tried once: a genuinely dead connection or a real server
    // error shouldn't sit here retrying indefinitely.
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      mapGrid = await fetchWeatherGrid(centre, radiusKm);
      mapGridCentre = { ...centre };
      mapGridFetchedAt = Date.now();
      setMapStatus("");
      return;
    } catch (retryErr) {
      // Keep whatever was last drawn rather than blanking. If the daily
      // limit is ever hit, a slightly stale map beats a broken one —
      // and the rest of Cloude is unaffected either way, because this
      // fetch is entirely separate from loadLocationData().
      //
      // The reason is named rather than one blanket sentence for every
      // failure — a timeout, a rate limit, and a genuine network drop
      // want different responses (wait it out, wait longer, or check
      // the connection), and lumping them together made this
      // impossible to tell apart from the outside.
      const reason = describeMapFetchError(retryErr);
      setMapStatus(mapGrid
        ? `Couldn't refresh the map just now (${reason}) — showing the last one.`
        : `Couldn't load map data just now (${reason}).`);
    }
  }
}

// fetchWithTimeout (app.js) already converts its own AbortError into a
// plain Error with this exact message before it ever reaches here, so
// that's what's actually checked for a timeout — not err.name, which
// would never match by this point. Everything else genuinely is
// offline/DNS/TLS territory that a message can't usefully subdivide
// further from here.
function describeMapFetchError(err) {
  if (err instanceof Error && /^Timed out/.test(err.message)) return "timed out";
  if (err instanceof Error && /^Map weather fetch failed: 429/.test(err.message)) return "rate limited";
  if (err instanceof Error && /^Map weather fetch failed: \d+/.test(err.message)) return err.message.replace("Map weather fetch failed: ", "server error ");
  if (err instanceof Error && /unexpected number of points/.test(err.message)) return "unexpected response";
  return "connection problem";
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

// --- terrain slot (see the registry comment above) ---
//
// Registered AFTER coastline rather than in the slot marked above it:
// the coastline layer FILLS the land with a solid colour, so anything
// drawn before it gets painted straight over. Hillshading has to sit
// on top of that fill to be visible at all — but still below rain/
// wind/isobars, which is what the slot was really about.
//
// Shaded relief rather than colour bands, deliberately: this is
// texture, not a data layer. Green land stays green and just gains
// shadow, so it adds detail without introducing a fourth colour field
// competing with rain, temperature and pressure for the same pixels.
// ---------------------------------------------------------------------

const TERRAIN_DB_NAME = "cloude-terrain";
const TERRAIN_STORE = "tiles";
const TERRAIN_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
// Open-Meteo's elevation endpoint caps each request at 100 coordinates,
// so a usable grid needs batching (see fetchTerrainGrid). Kept modest
// per zoom: finer than this multiplies request count fast for detail
// that isn't visible anyway at the wider radii.
const TERRAIN_MAX_COORDS_PER_REQUEST = 100;
const TERRAIN_SPACING_KM = { 25: 3, 50: 5, 100: 8, 150: 12 };

// IndexedDB, NOT localStorage (which everything else in Cloude uses):
// terrain is bulk data measured in megabytes across a few areas, and
// localStorage's ~5MB ceiling is shared with FFV history, tide data and
// settings — filling it with terrain could break those. IndexedDB is
// built for exactly this and gives far more headroom.
function terrainDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TERRAIN_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TERRAIN_STORE)) db.createObjectStore(TERRAIN_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function terrainCacheGet(key) {
  try {
    const db = await terrainDb();
    return await new Promise(resolve => {
      const tx = db.transaction(TERRAIN_STORE, "readonly");
      const req = tx.objectStore(TERRAIN_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // private browsing, quota refusal, or no IndexedDB at all — terrain just won't be cached
  }
}

async function terrainCacheSet(key, value) {
  try {
    const db = await terrainDb();
    const tx = db.transaction(TERRAIN_STORE, "readwrite");
    tx.objectStore(TERRAIN_STORE).put(value, key);
  } catch {
    // Same as above — a failed cache write only costs a refetch later.
  }
}

// Elevation never changes, so a tile is keyed purely by where it is and
// how coarse it is — no timestamp, no staleness check. Once fetched, an
// area is permanently done.
function terrainKey(centre, radiusKm) {
  const spacing = TERRAIN_SPACING_KM[radiusKm] || 8;
  // Snapped to the grid spacing so small pans reuse the same tile
  // instead of each one counting as a brand-new area to fetch.
  const snapLat = (Math.round(centre.lat / 0.25) * 0.25).toFixed(2);
  const snapLon = (Math.round(centre.lon / 0.25) * 0.25).toFixed(2);
  return `${snapLat},${snapLon},${radiusKm},${spacing}`;
}

let mapTerrain = null;
let terrainFetchInFlight = null;

async function fetchTerrainGrid(centre, radiusKm) {
  const spacingKm = TERRAIN_SPACING_KM[radiusKm] || 8;
  const spanKm = radiusKm * MAP_FETCH_MARGIN;
  const dLat = spacingKm / KM_PER_DEG_LAT;
  const dLon = spacingKm / kmPerDegLon(centre.lat);
  const rows = Math.ceil((spanKm * 2) / spacingKm) + 1;
  const cols = rows;
  const lat0 = centre.lat - (rows - 1) / 2 * dLat;
  const lon0 = centre.lon - (cols - 1) / 2 * dLon;

  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(lat0 + r * dLat);
      lons.push(lon0 + c * dLon);
    }
  }

  // Batched to the API's 100-coordinate limit, sequentially rather than
  // all at once — a dozen simultaneous requests to a free public service
  // is exactly the kind of burst that gets rate-limited.
  const elevations = [];
  for (let i = 0; i < lats.length; i += TERRAIN_MAX_COORDS_PER_REQUEST) {
    const batchLats = lats.slice(i, i + TERRAIN_MAX_COORDS_PER_REQUEST);
    const batchLons = lons.slice(i, i + TERRAIN_MAX_COORDS_PER_REQUEST);
    const params = new URLSearchParams({
      latitude: batchLats.map(v => v.toFixed(4)).join(","),
      longitude: batchLons.map(v => v.toFixed(4)).join(",")
    });
    const res = await fetchWithTimeout(`${TERRAIN_ELEVATION_URL}?${params.toString()}`, {}, 20000);
    if (!res.ok) throw new Error(`Elevation fetch failed: ${res.status}`);
    const data = await res.json();
    elevations.push(...data.elevation);
  }

  const values = [];
  for (let r = 0; r < rows; r++) {
    values.push(elevations.slice(r * cols, (r + 1) * cols));
  }
  return { lat0, lon0, dLat, dLon, rows, cols, values };
}

async function ensureTerrain(centre, radiusKm) {
  const key = terrainKey(centre, radiusKm);
  if (mapTerrain && mapTerrain.key === key) return;
  if (terrainFetchInFlight === key) return; // already being fetched — don't stack duplicate batch runs

  const cached = await terrainCacheGet(key);
  if (cached) {
    mapTerrain = { key, ...cached };
    renderMap();
    return;
  }

  terrainFetchInFlight = key;
  try {
    const grid = await fetchTerrainGrid(centre, radiusKm);
    await terrainCacheSet(key, grid);
    mapTerrain = { key, ...grid };
    renderMap();
  } catch (err) {
    console.error("Terrain fetch failed:", err);
    // Silent on screen: terrain is decoration. The map is entirely
    // usable without it, and a visible error for missing texture would
    // be noise on top of the weather-fetch messages that actually matter.
  } finally {
    terrainFetchInFlight = null;
  }
}

// Standard hillshade: light from the north-west (the cartographic
// convention — it reads as raised rather than sunken, which a
// south-east light famously inverts for most people), shading each
// cell by the slope it faces.
function terrainShadeAt(grid, r, c) {
  const rN = Math.max(0, r - 1), rS = Math.min(grid.rows - 1, r + 1);
  const cW = Math.max(0, c - 1), cE = Math.min(grid.cols - 1, c + 1);
  const zN = grid.values[rN][c], zS = grid.values[rS][c];
  const zW = grid.values[r][cW], zE = grid.values[r][cE];
  if ([zN, zS, zW, zE].some(v => v === null || v === undefined)) return 0;
  // Rate of change north-south and east-west, in metres per grid step.
  const dzdx = (zE - zW) / 2;
  const dzdy = (zS - zN) / 2;
  // Dot product against a north-west light vector, normalised roughly
  // into -1..1. The divisor is a vertical exaggeration constant — UK
  // terrain is gentle enough that true-scale shading is nearly
  // invisible at these grid spacings.
  const shade = (dzdx - dzdy) / 60;
  return Math.max(-1, Math.min(1, shade));
}

registerMapLayer({
  id: "terrain",
  draw(ctx, view) {
    const grid = mapTerrain;
    if (!grid) return;
    const cell = 4;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const lat = view.lat(py + cell / 2), lon = view.lon(px + cell / 2);
        const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
        if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
        const r = Math.round(fr), c = Math.round(fc);
        const z = grid.values[r][c];
        // At or below sea level is water, not flat land — skip it so
        // the sea stays clean rather than picking up noise from the
        // DEM's own coastal edges.
        if (z === null || z === undefined || z <= 0) continue;
        const shade = terrainShadeAt(grid, r, c);
        if (Math.abs(shade) < 0.02) continue; // flat ground: leave the land colour alone entirely
        ctx.fillStyle = shade > 0 ? "#ffffff" : "#000000";
        ctx.globalAlpha = Math.min(0.32, Math.abs(shade) * 0.4);
        ctx.fillRect(px, py, cell, cell);
      }
    }
    ctx.globalAlpha = 1;
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
        ctx.fillStyle = tempColor(value);
        ctx.globalAlpha = 0.55;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }
});

// ---------------------------------------------------------------------
// Isobars — marching squares over the pressure grid, at the standard
// synoptic-chart spacing of 4 hPa. Chosen over a colour wash (the
// original approach) for two reasons at once: it's the familiar
// convention from every other pressure chart, and it stacks cleanly
// with rain/temperature underneath rather than adding a third
// competing colour field to a display that was already getting muddy
// with two.
// ---------------------------------------------------------------------
const MAP_ISOBAR_INTERVAL_HPA = 4;

// Null if the level doesn't cross this edge at all; otherwise the
// interpolated screen point where it does.
function edgeCrossing(vA, vB, ax, ay, bx, by, level) {
  if (vA === null || vB === null || (vA >= level) === (vB >= level)) return null;
  const t = (level - vA) / (vB - vA);
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
}

// One contour level at a time, over the grid's own lattice (not a
// finer screen-space resampling like the colour-wash layers use) —
// isobars are about the shape of the pressure field itself, not pixel
// smoothness, and the model's real ~10km spacing is the honest
// resolution to draw them at.
function marchingSquaresSegments(grid, hourIdx, view, level) {
  const segments = [];
  const field = grid.pressure[hourIdx];
  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < grid.cols - 1; c++) {
      const vTL = field[r][c], vTR = field[r][c + 1];
      const vBL = field[r + 1][c], vBR = field[r + 1][c + 1];
      if ([vTL, vTR, vBL, vBR].some(v => v === null || v === undefined)) continue;

      const latT = grid.lat0 + r * grid.dLat, latB = grid.lat0 + (r + 1) * grid.dLat;
      const lonL = grid.lon0 + c * grid.dLon, lonR = grid.lon0 + (c + 1) * grid.dLon;
      const xL = view.x(lonL), xR = view.x(lonR);
      const yT = view.y(latT), yB = view.y(latB);

      const top = edgeCrossing(vTL, vTR, xL, yT, xR, yT, level);
      const right = edgeCrossing(vTR, vBR, xR, yT, xR, yB, level);
      const bottom = edgeCrossing(vBL, vBR, xL, yB, xR, yB, level);
      const left = edgeCrossing(vTL, vBL, xL, yT, xL, yB, level);

      const points = [top, right, bottom, left].filter(Boolean);
      if (points.length === 2) {
        segments.push([points[0], points[1]]);
      } else if (points.length === 4) {
        // The ambiguous "saddle" case — the level crosses all four
        // edges, and there are two equally-valid ways to connect them
        // into two lines. Pairing top-with-bottom and left-with-right
        // is a fixed, arbitrary choice rather than resolving the true
        // topology (which needs checking the cell's centre value too) —
        // fine for a readable isobar, not claiming survey precision.
        segments.push([top, bottom]);
        segments.push([left, right]);
      }
    }
  }
  return segments;
}

registerMapLayer({
  id: "pressure",
  draw(ctx, view) {
    if (!mapGrid || !mapLayerVisible("pressure")) return;
    const p = mapPalette();
    const hour = Math.min(mapHourValue(), mapGrid.hours - 1);
    const field = mapGrid.pressure[hour];
    const flat = field.flat().filter(v => v !== null && v !== undefined);
    if (!flat.length) return;
    const minP = Math.min(...flat), maxP = Math.max(...flat);
    const lo = Math.floor(minP / MAP_ISOBAR_INTERVAL_HPA) * MAP_ISOBAR_INTERVAL_HPA;
    const hi = Math.ceil(maxP / MAP_ISOBAR_INTERVAL_HPA) * MAP_ISOBAR_INTERVAL_HPA;

    ctx.save();
    ctx.strokeStyle = p.ink;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.75;
    ctx.font = "600 11px -apple-system, system-ui, sans-serif";

    for (let level = lo; level <= hi; level += MAP_ISOBAR_INTERVAL_HPA) {
      const segments = marchingSquaresSegments(mapGrid, hour, view, level);
      if (!segments.length) continue;

      ctx.beginPath();
      segments.forEach(([a, b]) => {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      });
      ctx.stroke();

      // One label per level, near a representative segment — a label
      // on every segment would be as cluttered as the colour wash this
      // replaced.
      const mid = segments[Math.floor(segments.length / 2)];
      const mx = (mid[0].x + mid[1].x) / 2, my = (mid[0].y + mid[1].y) / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.land;
      ctx.strokeText(String(level), mx + 3, my - 3);
      ctx.fillStyle = p.ink;
      ctx.fillText(String(level), mx + 3, my - 3);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = p.ink;
    }
    ctx.globalAlpha = 1;
    ctx.restore();
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

// Fixed length per speed band, not a continuous scale — same reasoning
// as rain's discrete bands: a handful of clearly different sizes reads
// at a glance, where a continuous gradient just looks like "some
// arrows are randomly bigger" without a key to compare against. Bands
// follow the everyday language for wind (calm/breezy/windy/gale)
// rather than an arbitrary split.
// 10mph divisions, as many as comfortably fit across an iPhone-width
// legend without crowding — six bands reads cleanly at a glance (the
// whole point of banding rather than a continuous scale) and covers
// everything from calm to a genuine severe gale.
const MAP_WIND_SPEED_THRESHOLDS = [0, 10, 20, 30, 40, 50]; // mph, lower bound per band
const MAP_WIND_ARROW_LENGTHS = [8, 12, 16, 20, 24, 28]; // px, one per band above

function windArrowLength(speedMph) {
  return MAP_WIND_ARROW_LENGTHS[bandIndexFor(speedMph, MAP_WIND_SPEED_THRESHOLDS)];
}

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
    ctx.strokeStyle = p.ink;
    ctx.fillStyle = p.ink;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    for (let px = MAP_WIND_ARROW_SPACING_PX / 2; px < view.w; px += MAP_WIND_ARROW_SPACING_PX) {
      for (let py = MAP_WIND_ARROW_SPACING_PX / 2; py < view.h; py += MAP_WIND_ARROW_SPACING_PX) {
        const lat = view.lat(py), lon = view.lon(px);
        const speed = sampleGrid(mapGrid, "windSpeed", hour, lat, lon);
        const dir = sampleWindDir(mapGrid, hour, lat, lon);
        if (speed === null || dir === null) continue;
        const angle = windArrowAngleRad(dir);
        const len = windArrowLength(speed);
        const dx = Math.sin(angle), dy = -Math.cos(angle);
        const x0 = px - dx * len * 0.5, y0 = py - dy * len * 0.5;
        const x1 = px + dx * len * 0.5, y1 = py + dy * len * 0.5;

        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();

        // Bigger head than a typical arrowhead so the direction reads
        // clearly at map size, even for the shortest (calm) arrows.
        const headLen = 8;
        const headAngle = Math.PI / 6;
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

  // A gradient bar, not swatches — temperature is a continuous scale
  // now (see MAP_TEMP_COLOR_STOPS), so discrete boxes would misrepresent
  // it as banded again. Built from the exact same colour stops the
  // layer paints with, the same "one source of truth" rule every other
  // legend on this map already follows.
  if (mapLayerVisible("temperature")) {
    const row = document.createElement("div");
    row.className = "map-legend-row";
    const caption = document.createElement("span");
    caption.className = "map-legend-caption";
    caption.textContent = "Temperature, °C";
    row.appendChild(caption);

    const span = MAP_TEMP_MAX_C - MAP_TEMP_MIN_C;
    const stops = MAP_TEMP_COLOR_STOPS
      .map(s => `${tempColor(s.t)} ${((s.t - MAP_TEMP_MIN_C) / span) * 100}%`)
      .join(", ");
    const bar = document.createElement("div");
    bar.className = "map-legend-gradient";
    bar.style.background = `linear-gradient(to right, ${stops})`;
    row.appendChild(bar);

    const ticks = document.createElement("div");
    ticks.className = "map-legend-ticks";
    [MAP_TEMP_MIN_C, 0, 10, 20, 30, MAP_TEMP_MAX_C].forEach(t => {
      const tick = document.createElement("span");
      tick.textContent = `${t}°`;
      ticks.appendChild(tick);
    });
    row.appendChild(ticks);
    container.appendChild(row);
  }

  // A caption, not a legend — isobars are a familiar convention (every
  // synoptic chart labels its own lines directly, same as this layer
  // does), so the useful thing to state here is just the spacing
  // between them, not a colour key that no longer exists.
  if (mapLayerVisible("pressure")) {
    const row = document.createElement("div");
    row.className = "map-legend-row map-legend-note";
    row.textContent = `Isobars, every ${MAP_ISOBAR_INTERVAL_HPA} hPa — labelled in hPa`;
    container.appendChild(row);
  }

  // Arrow length is the thing that actually needs a key — colour swatch
  // legends don't apply to a direction-and-length field, so this draws
  // small reference arrows at each band's real length instead, in the
  // current palette's own ink colour so it always matches what's on the
  // map.
  if (mapLayerVisible("wind")) {
    const p = mapPalette();
    const row = document.createElement("div");
    row.className = "map-legend-row";
    const caption = document.createElement("span");
    caption.className = "map-legend-caption";
    caption.textContent = "Wind, mph";
    row.appendChild(caption);

    const strip = document.createElement("div");
    strip.className = "map-legend";
    const svgNS = "http://www.w3.org/2000/svg";
    // Horizontal, not the map's own vertical arrows — a vertical arrow
    // tall enough to show the longest band's real length was taller
    // than the icon box, clipping its own point off. Horizontal gives
    // it the width to grow into instead, which a legend row has plenty
    // of, and doesn't need to match the compass-direction arrows on the
    // map itself (this key is about relative LENGTH = speed, not
    // direction).
    const svgW = 44, svgH = 20, cy = 10, startX = 4;
    MAP_WIND_SPEED_THRESHOLDS.forEach((threshold, i) => {
      const len = MAP_WIND_ARROW_LENGTHS[i];
      const tipX = startX + len;
      const item = document.createElement("span");
      item.className = "map-legend-item";

      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", String(svgW));
      svg.setAttribute("height", String(svgH));
      svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(startX)); line.setAttribute("y1", String(cy));
      line.setAttribute("x2", String(tipX)); line.setAttribute("y2", String(cy));
      line.setAttribute("stroke", p.ink);
      line.setAttribute("stroke-width", "1.8");
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
      const head = document.createElementNS(svgNS, "polygon");
      head.setAttribute("points", `${tipX + 6},${cy} ${tipX - 1},${cy - 4} ${tipX - 1},${cy + 4}`);
      head.setAttribute("fill", p.ink);
      svg.appendChild(head);
      item.appendChild(svg);

      const label = document.createElement("span");
      label.className = "map-legend-label";
      label.textContent = i === MAP_WIND_SPEED_THRESHOLDS.length - 1 ? `${threshold}+` : `${threshold}`;
      item.appendChild(label);
      strip.appendChild(item);
    });
    row.appendChild(strip);
    container.appendChild(row);
  }
}

registerMapLayer({
  id: "rings",
  draw(ctx, view) {
    const p = mapPalette();
    const home = homeCoords();
    if (!home) return;
    const hx = view.x(home.lon), hy = view.y(home.lat);
    const imperial = usingMiles();
    // Pick the table already in the right unit rather than picking a km
    // radius and converting it for the label — see MAP_RING_RADII_MI's
    // own comment for why that produced odd numbers like "19mi".
    const radii = imperial ? (MAP_RING_RADII_MI[view.radiusKm] || [20, 40]) : (MAP_RING_RADII_KM[view.radiusKm] || [30, 60]);
    const kmPerUnit = imperial ? 1.60934 : 1;
    ctx.save();
    radii.forEach(value => {
      const km = value * kmPerUnit;
      const r = km * view.pxPerKm;

      // A solid halo pass first, in the base land colour — the inner
      // and outer rings were already the exact same colour, but the
      // outer one covers more ground and so is more likely to cross a
      // patch of rain/temperature colouring close to its own tone,
      // where it effectively vanishes. This halo is what actually
      // guarantees both rings stay visible against whatever happens to
      // be underneath them, the same trick the labels below already
      // use against a dark rain wash.
      ctx.setLineDash([]);
      ctx.strokeStyle = p.land;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.stroke();

      // The actual dashed ring, identical style for inner and outer.
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = p.ring;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const text = `${value} ${imperial ? "mi" : "km"}`;
      ctx.font = "600 13px -apple-system, system-ui, sans-serif";
      // Outlined in the base colour first: these labels sit on top of
      // whatever the rain layer drew, which at the heavy end is dark
      // enough to swallow them entirely.
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.land;
      ctx.strokeText(text, hx + 5, hy - r - 4);
      ctx.fillStyle = p.ink;
      ctx.fillText(text, hx + 5, hy - r - 4);
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
    // Wind, not Rain — a UK user very commonly has mm for rain and mph
    // for wind at the same time (the app's own README notes exactly
    // this as a real user's actual settings), so Rain's unit was often
    // giving the wrong answer for anyone in that entirely normal
    // combination. Wind's unit is the one actually about distance/speed
    // rather than a depth measurement, making it the closer proxy for
    // "does this person think in miles or km" — still no new map-
    // specific setting introduced, just reading the more relevant one
    // of the two that already exist.
    return units.wind === "imperial";
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
//
// Reads the grid's own hourly timestamps rather than adding
// hoursAhead*3600000 to the exact current instant — Open-Meteo's hourly
// buckets always land on the hour, but "now" usually doesn't, so that
// arithmetic used to show things like "03:36" for the +1h mark. That
// implies a precision (rain arriving at exactly 03:36, not 03:00 or
// 04:00) the forecast never claimed — same hour-only convention as the
// front page's own hourly slider and every other scrolling view in the
// app. Falls back to the old arithmetic only in the brief window before
// the first grid has loaded.
function mapHourClock(hoursAhead) {
  const iso = mapGrid?.times?.[hoursAhead];
  const when = iso ? new Date(iso) : new Date(Date.now() + hoursAhead * 3600000);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = when.toDateString() === new Date().toDateString();
  if (hoursAhead === 0) return `Now, ${time}`;
  if (isToday) return time;
  return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

// Shorthand conditions at the crosshair (mapCentre — wherever the map
// is currently centred on, the same point "Forecast for here" would
// adopt) for whichever hour the slider is on. Only for layers actually
// switched on, matching what's drawn: showing a rain figure while the
// rain layer itself is hidden would read as data appearing from
// nowhere. compassLabel() comes from app.js, already loaded before this
// file on every page that includes the map.
function buildMapReadout(hour) {
  if (!mapGrid) return "";
  const parts = [];

  if (mapLayerVisible("wind")) {
    const speed = sampleGrid(mapGrid, "windSpeed", hour, mapCentre.lat, mapCentre.lon);
    const dir = sampleWindDir(mapGrid, hour, mapCentre.lat, mapCentre.lon);
    if (speed !== null && dir !== null) parts.push(`${compassLabel(dir)} ${Math.round(speed)}mph`);
  }
  if (mapLayerVisible("rain")) {
    const rain = sampleGrid(mapGrid, "rain", hour, mapCentre.lat, mapCentre.lon);
    if (rain !== null && rain !== undefined) {
      parts.push(rain < RAIN_BAND_THRESHOLDS[0] ? "dry" : `${rain.toFixed(1)}mm/hr`);
    }
  }
  if (mapLayerVisible("temperature")) {
    const temp = sampleGrid(mapGrid, "temp", hour, mapCentre.lat, mapCentre.lon);
    if (temp !== null && temp !== undefined) parts.push(`${Math.round(temp)}°C`);
  }
  if (mapLayerVisible("pressure")) {
    const pressure = sampleGrid(mapGrid, "pressure", hour, mapCentre.lat, mapCentre.lon);
    if (pressure !== null && pressure !== undefined) parts.push(`${Math.round(pressure)}hPa`);
  }

  return parts.join(" · ");
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
    const hour = mapHourValue();
    const readout = buildMapReadout(hour);
    scale.textContent = mapHourClock(hour) + (readout ? ` · ${readout}` : "") + (stale ? " · older data" : "");
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
// Panning, tap, and double-tap-to-zoom
//
// Single-finger drag, which means touch-action: none on the canvas —
// the canvas stops the page scrolling over itself. That is why drag
// exists ONLY on this page and the front-page strip is tap-only: a
// scroll-blocking canvas inside a scrolling column feels broken.
//
// Zoom buttons were tried first and didn't work well in practice — a
// double-tap (in, recentring on wherever was tapped) plus wrapping back
// out to the widest view once already at the closest level covers both
// directions from one gesture, with no dedicated zoom-out needed and no
// extra button added to a page already growing a few "back to
// somewhere" controls (see the Home/Back buttons above).
// ---------------------------------------------------------------------
let panPointerId = null;
let panLast = null;
let panStart = null;
let panMoved = false;
let lastTapAt = 0;
let lastTapPos = null;

const MAP_TAP_MOVE_TOLERANCE_PX = 10; // beyond this it's a drag, not a tap
const MAP_TAP_MAX_DURATION_MS = 400;
const MAP_DOUBLE_TAP_WINDOW_MS = 350;
const MAP_DOUBLE_TAP_DISTANCE_PX = 40; // two taps in roughly the same spot, not two unrelated taps

if (mapCanvas) {
  mapCanvas.addEventListener("pointerdown", e => {
    panPointerId = e.pointerId;
    panLast = { x: e.clientX, y: e.clientY };
    panStart = { x: e.clientX, y: e.clientY, time: Date.now() };
    panMoved = false;
    mapCanvas.setPointerCapture(e.pointerId);
  });

  mapCanvas.addEventListener("pointermove", e => {
    if (e.pointerId !== panPointerId || !panLast) return;
    if (Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y) > MAP_TAP_MOVE_TOLERANCE_PX) {
      panMoved = true;
    }
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

  // Zooms in centred on wherever was tapped — repeated double-taps on
  // the same spot walk progressively closer to it, matching how this
  // gesture behaves everywhere else (Photos, Maps). Wrapping back out
  // to the widest level deliberately does NOT recentre: that one reads
  // as "show me everything again", not "look closer here".
  function handleDoubleTap(e) {
    const rect = mapCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const view = makeView(mapCanvas, mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
    const tappedLat = view.lat(py);
    const tappedLon = view.lon(px);

    if (mapZoomIndex > 0) {
      mapZoomIndex--;
      mapCentre = { lat: tappedLat, lon: tappedLon };
    } else {
      mapZoomIndex = MAP_ZOOM_RADII_KM.length - 1;
    }
    saveMapZoom(mapZoomIndex);
    saveMapCentre(mapCentre);
    renderMap();
    ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
    ensureTerrain(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
  }

  function endPan(e) {
    if (e.pointerId !== panPointerId) return;
    panPointerId = null;
    const wasTap = !panMoved && Date.now() - panStart.time < MAP_TAP_MAX_DURATION_MS;
    panLast = null;

    if (wasTap) {
      const now = Date.now();
      const dist = lastTapPos ? Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) : Infinity;
      if (now - lastTapAt < MAP_DOUBLE_TAP_WINDOW_MS && dist < MAP_DOUBLE_TAP_DISTANCE_PX) {
        lastTapAt = 0;
        lastTapPos = null;
        handleDoubleTap(e);
        return; // handleDoubleTap already saves/refetches/renders — the plain single-tap bookkeeping below is skipped
      }
      lastTapAt = now;
      lastTapPos = { x: e.clientX, y: e.clientY };
    }

    saveMapCentre(mapCentre);
    // Only refetches if the drag left the margin — panning back and
    // forth over the same ground costs nothing.
    ensureGrid(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]).then(renderMap);
    ensureTerrain(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
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
  ensureTerrain(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
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

// Manual dragging always wins — the "input" listener below stops
// playback the instant someone touches the slider themselves, the same
// "a deliberate action beats an automatic one" rule the front page's
// own hourly view already follows for its 5-second-hold-turned-
// persistent behaviour.
let mapHourPlayTimer = null;
const mapHourPlayButton = document.getElementById("mapHourPlay");

function stopMapHourPlay() {
  if (mapHourPlayTimer) {
    clearInterval(mapHourPlayTimer);
    mapHourPlayTimer = null;
  }
  if (mapHourPlayButton) mapHourPlayButton.textContent = "Play";
}

function startMapHourPlay() {
  if (mapHourPlayTimer || !mapHourInput) return;
  mapHourPlayTimer = setInterval(() => {
    const next = (parseInt(mapHourInput.value, 10) || 0) + 1;
    mapHourInput.value = next > 47 ? 0 : next;
    renderMap();
  }, 700);
  if (mapHourPlayButton) mapHourPlayButton.textContent = "Pause";
}

mapHourPlayButton?.addEventListener("click", () => {
  if (mapHourPlayTimer) stopMapHourPlay(); else startMapHourPlay();
});

// Stops playback rather than fighting it — a background tab advancing
// the slider with nobody watching serves no purpose and just wastes a
// timer.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stopMapHourPlay();
});

mapHourInput?.addEventListener("input", () => {
  stopMapHourPlay();
  renderMap();
});

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
    renderMap();
  });
});

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
  // Terrain is static and cached forever once fetched, so this is
  // fire-and-forget rather than awaited — it renders itself the
  // moment it lands, and must never hold up the weather map.
  ensureTerrain(mapCentre, MAP_ZOOM_RADII_KM[mapZoomIndex]);
  renderMap();
})();
