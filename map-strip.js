// Front-page map preview strip — a small, static, tap-to-open-full-map
// preview, deliberately NOT a shrunk-down copy of map.js's pan/zoom
// machinery. A mini pannable map crammed into a strip this size fights
// your thumb rather than helping it; map.html already exists to be the
// place where real interaction happens. This just answers "is there
// rain nearby right now" at a glance, centred on wherever the front
// page is currently showing.
//
// Deliberately self-contained rather than loading map.js on this page
// too — map.js has a large stateful init sequence built entirely
// around map.html's own DOM (pan/zoom/toggles/legends), none of which
// exists here. Reusing it would mean either fighting that init
// sequence into tolerating a missing DOM, or duplicating it anyway to
// avoid that fight. A handful of constants below (rain thresholds, the
// current palette's colours) ARE duplicated from map.js as plain
// values — if those ever change there, they won't automatically follow
// here.
//
// Fires only after app.js's own weather fetch has already landed (see
// the "cloude:location-ready" event in app.js) — never competing with
// the data the person actually came to this page for.

const MAP_STRIP_RADIUS_KM = 25;
const MAP_STRIP_GRID_SPACING_KM = 10;
const MAP_STRIP_FORECAST_DAYS = 3;
const KM_PER_DEG_LAT = 111.32;
function kmPerDegLon(lat) { return 111.32 * Math.cos(lat * Math.PI / 180); }

// Same thresholds as map.js's RAIN_BAND_THRESHOLDS/rainBandIndex — kept
// duplicated rather than shared, see the file-level note above.
const MAP_STRIP_RAIN_THRESHOLDS = [0.1, 0.5, 1, 2, 4, 8];
function rainBandIndex(value) {
  if (value === null || value === undefined || value < MAP_STRIP_RAIN_THRESHOLDS[0]) return -1;
  let idx = 0;
  for (let i = 1; i < MAP_STRIP_RAIN_THRESHOLDS.length; i++) {
    if (value >= MAP_STRIP_RAIN_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

// Only the palette's own colours are duplicated (not the whole
// MAP_PALETTES structure) — reads the same MAP_PALETTE_KEY map.js
// saves to, so a palette chosen on the map page is honoured here too
// without needing map.js loaded to get at it. Land is deliberately
// BOLDER than the full map page's own land colour — at strip size,
// map.js's soft #e4efe6 sat too close to the sea colour to read as two
// different things at a glance, which matters more here than on the
// full map (where there's more screen and more time to look).
const MAP_STRIP_PALETTES = {
  paper: { land: "#9fcbae", sea: "#EEF5FA", coast: "#5c8a6d", ink: "#2b2a26", ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"] },
  slate: { land: "#2f6b4c", sea: "#33454f", coast: "#7a7a72", ink: "#f2f1ec", ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"] },
  mono: { land: "#FFFFFF", sea: "#ECECEC", coast: "#555555", ink: "#111111", ramp: ["#C9C9C9", "#A2A2A2", "#7C7C7C", "#585858", "#363636", "#141414"] }
};
function mapStripPalette() {
  let id = "paper";
  try { id = localStorage.getItem("forecast-compare:map:palette") || "paper"; } catch {}
  return MAP_STRIP_PALETTES[id] || MAP_STRIP_PALETTES.paper;
}

const mapStripCanvas = document.getElementById("mapStripCanvas");
let mapStripCoastline = null;
let mapStripPlaces = null;
let mapStripTerrain = null;
let mapStripLastCentre = null;
let mapStripLastGrid = null;

function sizeMapStripCanvas() {
  if (!mapStripCanvas) return;
  const rect = mapStripCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  // Skip the resize (and the caller's redraw) if nothing actually
  // changed — ResizeObserver below can fire on subpixel layout
  // settling that doesn't move the rounded pixel size at all, and
  // resizing a canvas clears it even when the new size is identical to
  // the old one, which would mean redrawing every single one of those
  // for no visible reason.
  if (mapStripCanvas.width === w && mapStripCanvas.height === h) return false;
  mapStripCanvas.width = w;
  mapStripCanvas.height = h;
  const ctx = mapStripCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

// A fixed-radius, no-pan-no-zoom view — the strip only ever shows one
// thing (25km around the current location), so this is a single
// projection built once per render rather than map.js's reusable
// makeView() with its pan offset and adjustable radius.
function mapStripView(centre) {
  const rect = mapStripCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const spanKm = MAP_STRIP_RADIUS_KM * 2;
  const pxPerKm = Math.min(w, h) / spanKm;
  const dLon = kmPerDegLon(centre.lat);
  return {
    w, h, pxPerKm,
    x: lon => w / 2 + (lon - centre.lon) * dLon * pxPerKm,
    y: lat => h / 2 - (lat - centre.lat) * KM_PER_DEG_LAT * pxPerKm,
    lat: py => centre.lat - (py - h / 2) / (pxPerKm * KM_PER_DEG_LAT),
    lon: px => centre.lon + (px - w / 2) / (pxPerKm * dLon)
  };
}

function drawMapStripCoastline(ctx, view, geojson, fill) {
  if (!geojson) return;
  ctx.fillStyle = fill;
  geojson.features.forEach(feature => {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    polygons.forEach(polygon => {
      ctx.beginPath();
      polygon.forEach(ring => {
        ring.forEach(([lon, lat], i) => {
          const x = view.x(lon), y = view.y(lat);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      });
      ctx.fill("evenodd");
    });
  });
}

// Clips to the same coastline outline the land fill uses, so shading
// stops exactly at the shore rather than bleeding over open water —
// same reasoning and same technique as clipToLand() in map.js, kept as
// its own small copy rather than shared (see the file-level note at
// the top of this file for why nothing here imports from map.js).
function clipMapStripToLand(ctx, view, geojson) {
  if (!geojson) return false;
  ctx.beginPath();
  geojson.features.forEach(feature => {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    polygons.forEach(polygon => {
      polygon.forEach(ring => {
        ring.forEach(([lon, lat], i) => {
          const x = view.x(lon), y = view.y(lat);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      });
    });
  });
  ctx.clip("evenodd");
  return true;
}

// A much coarser version of map.js's terrainShadeBilinear — this strip
// covers a fixed, small 25km radius at a small on-screen size, so the
// full elevation grid's ~8.3km spacing plus a plain nearest-neighbour
// slope (rather than map.js's bilinear interpolation) is already finer
// than what a strip this size can show. Kept deliberately simple:
// terrain here is a bit of texture to make the strip feel like the
// same map, not a serious relief rendering — that job stays on the
// full map page.
function drawMapStripTerrain(ctx, view, grid) {
  if (!grid) return;
  const cell = 4;
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lat = view.lat(py + cell / 2), lon = view.lon(px + cell / 2);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      const r = Math.round(fr), c = Math.round(fc);
      if (r < 1 || c < 1 || r > grid.rows - 2 || c > grid.cols - 2) continue;
      const z = grid.values[r][c];
      if (z === null || z === undefined || z <= 0) continue;
      // Plain east-west/north-south neighbour difference — a rough
      // stand-in for the real slope, which is all a handful of pixels
      // of texture needs.
      const zE = grid.values[r][c + 1], zW = grid.values[r][c - 1];
      const zN = grid.values[r + 1][c], zS = grid.values[r - 1][c];
      const dx = (zE ?? z) - (zW ?? z);
      const dy = (zN ?? z) - (zS ?? z);
      // NW-lit convention, same as map.js — negative dx/dy (rising
      // toward the light) reads as brighter.
      const shade = -(dx + dy) / 40;
      if (Math.abs(shade) < 0.03) continue;
      ctx.fillStyle = shade > 0 ? "#ffffff" : "#000000";
      ctx.globalAlpha = Math.min(0.35, Math.abs(shade) * 0.6);
      ctx.fillRect(px, py, cell, cell);
    }
  }
  ctx.globalAlpha = 1;
}

async function renderMapStrip(centre, grid) {
  if (!mapStripCanvas) return;
  mapStripLastCentre = centre;
  mapStripLastGrid = grid;
  const ctx = mapStripCanvas.getContext("2d");
  const view = mapStripView(centre);
  const p = mapStripPalette();

  ctx.fillStyle = p.sea;
  ctx.fillRect(0, 0, view.w, view.h);
  drawMapStripCoastline(ctx, view, mapStripCoastline, p.land);

  if (mapStripTerrain) {
    ctx.save();
    if (clipMapStripToLand(ctx, view, mapStripCoastline)) {
      drawMapStripTerrain(ctx, view, mapStripTerrain);
    }
    ctx.restore();
  }

  if (grid) {
    const cell = 6;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const lon = centre.lon + (px - view.w / 2) / (view.pxPerKm * kmPerDegLon(centre.lat));
        const lat = centre.lat - (py - view.h / 2) / (view.pxPerKm * KM_PER_DEG_LAT);
        const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
        if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
        const value = grid.rain[Math.round(fr)][Math.round(fc)];
        const band = rainBandIndex(value);
        if (band < 0) continue;
        ctx.fillStyle = p.ramp[band];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(px, py, cell, cell);
        ctx.globalAlpha = 1;
      }
    }
  }

  // A few names for scale — "is this 5 miles across or 50" is hard to
  // judge from an unlabelled outline. Nearest-and-biggest few only:
  // this is a strip, not the full map's places layer, so crowding it
  // with everything nearby would defeat the point.
  if (mapStripPlaces) {
    const withDistance = mapStripPlaces
      .map(place => ({ place, d: Math.hypot(place.lat - centre.lat, place.lon - centre.lon) }))
      .filter(({ d }) => d < 0.35) // roughly within the strip's own view, degrees not km, but fine at this latitude/scale
      .sort((a, b) => (a.place.rank - b.place.rank) || (a.d - b.d))
      .slice(0, 4);

    ctx.font = "600 11px -apple-system, system-ui, sans-serif";
    withDistance.forEach(({ place }) => {
      const x = view.x(place.lon), y = view.y(place.lat);
      if (x < 0 || x > view.w || y < 0 || y > view.h) return;
      ctx.fillStyle = p.ink;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      // Outlined in the land colour first — same trick map.js's own
      // ring labels use — so a name stays readable whether it lands on
      // sea, land, or a rain-coloured cell.
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.land;
      ctx.strokeText(place.name, x + 5, y + 4);
      ctx.fillText(place.name, x + 5, y + 4);
    });
  }

  // Centre marker, same small dot map.html itself uses for Home.
  ctx.fillStyle = p.ink;
  ctx.beginPath();
  ctx.arc(view.w / 2, view.h / 2, 4, 0, Math.PI * 2);
  ctx.fill();
}

async function fetchMapStripGrid(centre) {
  const spanKm = MAP_STRIP_RADIUS_KM * 1.5;
  const dLat = MAP_STRIP_GRID_SPACING_KM / KM_PER_DEG_LAT;
  const dLon = MAP_STRIP_GRID_SPACING_KM / kmPerDegLon(centre.lat);
  const rows = Math.ceil((spanKm * 2) / MAP_STRIP_GRID_SPACING_KM) + 1;
  const lat0 = centre.lat - (rows - 1) / 2 * dLat;
  const lon0 = centre.lon - (rows - 1) / 2 * dLon;

  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < rows; c++) {
      lats.push((lat0 + r * dLat).toFixed(4));
      lons.push((lon0 + c * dLon).toFixed(4));
    }
  }

  const params = new URLSearchParams({
    latitude: lats.join(","),
    longitude: lons.join(","),
    hourly: "precipitation",
    forecast_days: String(MAP_STRIP_FORECAST_DAYS),
    timezone: "auto"
  });
  // Routed through fetchOpenMeteo (app.js), which this page also loads —
  // same shared concurrency gate + 429 backoff as every other Open-Meteo
  // call in the app. This fetch fires right after the front page's own
  // 19-ish-request burst lands (see the file-level note above), so it's
  // exactly the kind of follow-up call that could land in the middle of
  // a rate-limit window the burst itself just caused.
  const res = await fetchOpenMeteo(`${WEATHER_URL}?${params.toString()}`, {}, 20000);
  if (!res.ok) throw new Error(`Map strip fetch failed: ${res.status}`);
  const data = await res.json();
  const points = Array.isArray(data) ? data : [data];
  if (points.length !== rows * rows) throw new Error("Map strip fetch returned an unexpected number of points");

  const now = new Date();
  const nowIndex = points[0].hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);
  const startIdx = nowIndex >= 0 ? nowIndex : 0;

  const rain = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < rows; c++) {
      const v = points[r * rows + c].hourly.precipitation[startIdx];
      row.push(v === null || v === undefined ? 0 : v);
    }
    rain.push(row);
  }
  return { lat0, lon0, dLat, dLon, rows, cols: rows, rain };
}

async function initMapStrip(centre) {
  if (!mapStripCanvas) return;
  sizeMapStripCanvas();
  try {
    if (!mapStripCoastline) {
      const res = await fetchWithTimeout("data/coastline-50m.json", {}, 15000);
      if (res.ok) mapStripCoastline = await res.json();
    }
    if (!mapStripPlaces) {
      const res = await fetchWithTimeout("data/places.json", {}, 15000);
      if (res.ok) mapStripPlaces = await res.json();
    }
    if (!mapStripTerrain) {
      // Static file, same one map.js uses — already cached by the
      // service worker/browser cache after the first full-map visit, so
      // this is typically a local read rather than a real fetch. Kept
      // to its own try/catch inside the outer one so a slow or failed
      // terrain load never holds up coastline/places, which matter more.
      try {
        const res = await fetchWithTimeout("data/elevation-uk.json", {}, 15000);
        if (res.ok) {
          const data = await res.json();
          const values = [];
          for (let r = 0; r < data.rows; r++) {
            values.push(data.values.slice(r * data.cols, (r + 1) * data.cols));
          }
          mapStripTerrain = { ...data, values };
        }
      } catch {
        // No terrain texture this time — the strip still renders sea,
        // coastline, places and rain, which is everything it actually
        // promises; terrain here is decoration on top of that.
      }
    }
  } catch {
    // No coastline/places this time — the strip still renders sea
    // colour plus rain (or just sea colour) and is still tappable
    // through to the full map, so this stays silent rather than
    // showing an error for what is, on the front page, a secondary
    // feature.
  }
  renderMapStrip(centre, null); // whatever arrived (coastline/places/terrain) shown immediately, rain follows once fetched

  try {
    const grid = await fetchMapStripGrid(centre);
    renderMapStrip(centre, grid);
  } catch (err) {
    console.error("Map strip weather fetch failed:", err);
    // Silent on screen, same reasoning as the coastline catch above.
  }
}

document.addEventListener("cloude:location-ready", e => {
  initMapStrip({ lat: e.detail.lat, lon: e.detail.lon });
});

// Was a window "resize" listener only, which never fires when the
// PAGE's own layout changes size without the window itself changing —
// exactly what happens when Tide/Fishing or a headline cell gets
// switched off in Settings: .map-strip's flex-grow (see style.css)
// gives the strip more height, but nothing tells this canvas that its
// own box just changed shape. Confirmed on-device: the card grew, but
// the drawing inside stayed the old, smaller size, leaving a plain
// blank gap in the newly-freed space instead of the map filling it.
// ResizeObserver watches the canvas's own box directly, so it fires for
// that case too, not just an actual window resize.
if (mapStripCanvas && "ResizeObserver" in window) {
  const mapStripResizeObserver = new ResizeObserver(() => {
    if (sizeMapStripCanvas() && mapStripLastCentre) {
      renderMapStrip(mapStripLastCentre, mapStripLastGrid);
    }
  });
  mapStripResizeObserver.observe(mapStripCanvas);
} else {
  // ResizeObserver has been in Safari since 2020 — this is only a
  // fallback for something unexpectedly old, not an expected path.
  window.addEventListener("resize", () => {
    if (sizeMapStripCanvas() && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}
