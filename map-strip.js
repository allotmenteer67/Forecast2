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
// Was 10km. Halved to roughly quadruple the number of sampled points
// across the same physical area — confirmed on-device that the coarse
// original spacing was the actual cause of the strip's blocky look
// (the same "Tetris" problem terrain had, and for the same underlying
// reason: a screen area sampled at 6px cells but backed by far fewer
// real data points than that). This is the "fetch a denser grid"
// option rather than interpolating the coarser one — genuinely more
// detail rather than a smoother-looking guess at detail that isn't
// there, at the cost of a heavier request: roughly 3x the locations,
// which Open-Meteo's own rate limit weights by. Still a small fraction
// of what the front page's main weather fetch already costs, but not
// free, and this runs automatically on every visit.
const MAP_STRIP_GRID_SPACING_KM = 5;
const MAP_STRIP_FORECAST_DAYS = 3;
const KM_PER_DEG_LAT = 111.32;
function kmPerDegLon(lat) { return 111.32 * Math.cos(lat * Math.PI / 180); }

// Synced to the front page's own hour slider (#hourSlider — see
// app.js), so the strip shows the same "now" or "+N hours" moment as
// the headline grid above it, rather than always being fixed to right
// now. Not synced to the Date slider (±7 days): a day beyond what's
// already fetched needs a wider forecast window, and a past day needs
// real historical data from a different API entirely (the archive
// endpoint, not the forecast one) — a genuinely bigger job than reading
// a different index out of data already in hand, and one that doesn't
// obviously earn its cost for an always-on preview strip whose whole
// point is "right now, nearby".
let mapStripHourOffset = 0;

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

// Same three palettes as map.js's own MAP_PALETTES, and now genuinely
// the SAME values, not a bolder stand-in — see the note this replaces
// below for what changed and why.
//
// This used to deliberately diverge from map.js: land was bolder here
// (#9fcbae vs the real #e4efe6) on the reasoning that the full map's
// soft green sat too close to the sea colour to read as two different
// things at this strip's smaller size. That trade favoured legibility
// over consistency. Explicitly reversed now that the ask is for the
// strip to look like the same map, not its own variant — if the softer
// land colour turns out to be a genuine problem at a glance (rather
// than just a different look), that's the thing to revisit, not a
// silent partial match.
const MAP_STRIP_PALETTES = {
  // river added to match map.js's own MAP_PALETTES exactly (same hex
  // values, same reasoning — a mid-tone pulled from that palette's own
  // rain ramp, since a river is the same "water" concept as the sea and
  // rain rather than a new colour of its own).
  paper: { land: "#e4efe6", sea: "#EEF5FA", coast: "#9c9a92", ink: "#4a4844", river: "#8FB9E2", ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"] },
  slate: { land: "#234f39", sea: "#33454f", coast: "#7a7a72", ink: "#d8d6cf", river: "#85B7EB", ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"] },
  mono: { land: "#FFFFFF", sea: "#ECECEC", coast: "#555555", ink: "#111111", river: "#7C7C7C", ramp: ["#C9C9C9", "#A2A2A2", "#7C7C7C", "#585858", "#363636", "#141414"] }
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
let mapStripLakes = null;
let mapStripWaterways = null;
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

function drawMapStripCoastline(ctx, view, geojson, fill, stroke) {
  if (!geojson) return;
  ctx.fillStyle = fill;
  // Was fill-only. The full map strokes the coastline outline too (see
  // map.js's own coastline layer: `stroke: p.coast`), which reads as a
  // defined edge to the land rather than just a colour boundary — this
  // was the strip's most visible remaining difference from the full
  // map once the palette itself matched.
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
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
      ctx.stroke();
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

// Same ring-walking shape as map.js's own eachRing — rivers/canals are
// LineString/MultiLineString, but this covers Polygon/MultiPolygon too
// in case a future data build ever mixes geometry types in.
function eachMapStripRing(geometry, visit) {
  if (!geometry) return;
  const t = geometry.type, c = geometry.coordinates;
  if (t === "LineString") visit(c);
  else if (t === "MultiLineString" || t === "Polygon") c.forEach(visit);
  else if (t === "MultiPolygon") c.forEach(poly => poly.forEach(visit));
}

// Per-feature styling (canal dashed, river solid — the traditional
// "this was built, not carved by the land" OS-map convention), same as
// map.js's own drawMapWaterways, which is why this isn't built on
// drawMapStripCoastline's shared fill/stroke above. Deliberately WITHOUT
// that function's bounding-box culling: a 25km strip view only ever has
// a handful of waterway features in range at all, so the skip-what's-
// off-screen optimisation that matters on the full map's much larger
// file (see map.js) isn't earning its cost at this scale.
function drawMapStripWaterways(ctx, view, geo, colour) {
  if (!geo) return;
  const features = geo.type === "FeatureCollection" ? geo.features : [geo];
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  features.forEach(feature => {
    const geometry = feature.geometry || feature;
    ctx.setLineDash(feature.properties?.kind === "canal" ? [4, 3] : []);
    eachMapStripRing(geometry, ring => {
      ctx.beginPath();
      ring.forEach(([lon, lat], i) => {
        const x = view.x(lon), y = view.y(lat);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  });
  ctx.setLineDash([]); // reset — later layers (place labels, centre marker) must not inherit this
}

// Bilinear elevation + shading, ported from map.js's terrainElevationAt/
// terrainShadeAt/terrainShadeBilinear (see that file for the full
// reasoning). The strip's first terrain attempt used plain
// nearest-neighbour differencing instead, on the theory that a strip
// this small couldn't show more detail than that anyway — backwards, as
// it turned out: a small view over an 8.3km grid means only a handful
// of real grid points fall inside it at all, so nearest-neighbour
// produced a few large flat rectangles rather than a few small ones —
// confirmed on-device as a blocky, "Tetris" look. Interpolating between
// the few points there ARE is exactly what turns them into a smooth
// gradient instead of hard-edged blocks, which matters more on a small
// view with few points than on the full map with many.
function mapStripElevationAt(grid, fr, fc) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  if (r0 < 0 || c0 < 0 || r0 > grid.rows - 1 || c0 > grid.cols - 1) return null;
  const tr = fr - r0, tc = fc - c0;
  const z00 = grid.values[r0][c0], z01 = grid.values[r0][c1];
  const z10 = grid.values[r1][c0], z11 = grid.values[r1][c1];
  if ([z00, z01, z10, z11].some(v => v === null || v === undefined)) return null;
  const top = z00 + (z01 - z00) * tc;
  const bottom = z10 + (z11 - z10) * tc;
  return top + (bottom - top) * tr;
}

function mapStripShadeAt(grid, fr, fc) {
  const zC = mapStripElevationAt(grid, fr, fc);
  if (zC === null) return 0;
  // Sea substitution, same reasoning as map.js: without this, the real
  // 0-metre sea value reads as a cliff at every coastline, which on a
  // 25km view is a big share of what's on screen at all.
  const landOr = v => (v === null || v <= 0 ? zC : v);
  const zN = landOr(mapStripElevationAt(grid, fr - 1, fc));
  const zS = landOr(mapStripElevationAt(grid, fr + 1, fc));
  const zW = landOr(mapStripElevationAt(grid, fr, fc - 1));
  const zE = landOr(mapStripElevationAt(grid, fr, fc + 1));
  const dzdx = (zE - zW) / 2;
  const dzdy = (zS - zN) / 2;
  const stepMetres = grid.dLat * KM_PER_DEG_LAT * 1000;
  const slopeX = dzdx / stepMetres;
  const slopeY = dzdy / stepMetres;
  const EXAGGERATION = 8;
  return Math.max(-1, Math.min(1, (slopeX - slopeY) * EXAGGERATION));
}

function mapStripShadeBilinear(grid, fr, fc) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const s00 = mapStripShadeAt(grid, r0, c0), s01 = mapStripShadeAt(grid, r0, c1);
  const s10 = mapStripShadeAt(grid, r1, c0), s11 = mapStripShadeAt(grid, r1, c1);
  const top = s00 + (s01 - s00) * tc;
  const bottom = s10 + (s11 - s10) * tc;
  return top + (bottom - top) * tr;
}

function drawMapStripTerrain(ctx, view, grid) {
  if (!grid) return;
  const cell = 3;
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lat = view.lat(py + cell / 2), lon = view.lon(px + cell / 2);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
      // Sea check uses the nearest node, not the interpolated value —
      // same reasoning as map.js: blending across the coast would
      // produce fractional "heights" just offshore and shade open water.
      const z = grid.values[Math.round(fr)][Math.round(fc)];
      if (z === null || z === undefined || z <= 0) continue;
      const shade = mapStripShadeBilinear(grid, fr, fc);
      if (Math.abs(shade) < 0.02) continue;
      ctx.fillStyle = shade > 0 ? "#ffffff" : "#000000";
      ctx.globalAlpha = Math.min(0.50, Math.abs(shade) * 0.7);
      ctx.fillRect(px, py, cell, cell);
    }
  }
  ctx.globalAlpha = 1;
}

// Bilinear blend of the 4 nearest grid points, same technique that
// took terrain from hard-edged blocks to smooth shading a few sessions
// back. No new data needed for this one — it's the same 256-point grid
// already being fetched, just blended between rather than snapped to
// whichever single point is nearest. That "snap to nearest" is what
// actually caused the blockiness: it isn't fixed by a denser grid on
// its own (that only shrinks the blocks), only by not having hard
// edges between points at all.
function mapStripRainAt(grid, fr, fc, hourIndex) {
  const r0 = Math.floor(fr), c0 = Math.floor(fc);
  const r1 = Math.min(grid.rows - 1, r0 + 1), c1 = Math.min(grid.cols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const v00 = grid.rainByHour[r0][c0][hourIndex];
  const v01 = grid.rainByHour[r0][c1][hourIndex];
  const v10 = grid.rainByHour[r1][c0][hourIndex];
  const v11 = grid.rainByHour[r1][c1][hourIndex];
  const top = v00 + (v01 - v00) * tc;
  const bottom = v10 + (v11 - v10) * tc;
  return top + (bottom - top) * tr;
}

// Direct copy of map.js's own mapHourClock and its full reasoning
// (kept as its own small copy rather than shared, same reasoning as
// everything else in this file — see the file-level note at the top).
// "+Nh" makes you do the arithmetic before you can act on it; the
// question being asked is "will it be raining when I get there", which
// is a clock time, and days are named once they stop being today
// because "09:00" alone is ambiguous over a 48-hour range.
function mapStripHourClock(grid, hoursAhead) {
  const idx = grid && grid.times ? Math.min(grid.startIdx + hoursAhead, grid.times.length - 1) : null;
  const iso = idx !== null ? grid.times[idx] : null;
  const when = iso ? new Date(iso) : new Date(Date.now() + hoursAhead * 3600000);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = when.toDateString() === new Date().toDateString();
  if (hoursAhead === 0) return `Now, ${time}`;
  if (isToday) return time;
  return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

// Reuses the full map's own .map-scale class outright — same pill, same
// corner, same look, rather than a strip-specific class that could drift
// out of sync with it over time (style.css only needs .map-strip itself
// given `position: relative` for this to have something to sit inside).
// Created lazily and appended once rather than requiring index.html to
// carry a dedicated element for it — keeps this file self-contained
// against .map-strip's existing markup, same as everything else here.
let mapStripScaleEl = null;
function ensureMapStripScale() {
  if (mapStripScaleEl || !mapStripCanvas) return mapStripScaleEl;
  const host = mapStripCanvas.closest(".map-strip");
  if (!host) return null;
  mapStripScaleEl = document.createElement("div");
  mapStripScaleEl.className = "map-strip-scale";
  host.appendChild(mapStripScaleEl);
  return mapStripScaleEl;
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
  drawMapStripCoastline(ctx, view, mapStripCoastline, p.land, p.coast);

  if (mapStripTerrain) {
    ctx.save();
    if (clipMapStripToLand(ctx, view, mapStripCoastline)) {
      drawMapStripTerrain(ctx, view, mapStripTerrain);
    }
    ctx.restore();
  }

  // Lakes then waterways, same order as map.js's own layer registration
  // (terrain -> lakes -> waterways -> weather). Lakes reuse the generic
  // coastline-drawing function above — a lake is just another sea-
  // coloured polygon with a coastline-style outline, nothing waterway-
  // specific about it.
  if (mapStripLakes) {
    drawMapStripCoastline(ctx, view, mapStripLakes, p.sea, p.coast);
  }
  if (mapStripWaterways) {
    drawMapStripWaterways(ctx, view, mapStripWaterways, p.river);
  }

  if (grid) {
    // Clamped rather than trusted outright: the front page's hour
    // slider can go up to +48h, comfortably inside the 72 hours
    // fetched, but clamping here means a future change to either
    // range can't quietly read past the end of a real point's array.
    const hourIndex = Math.min(
      grid.startIdx + mapStripHourOffset,
      grid.rainByHour[0][0].length - 1
    );
    // Was 6px, matched to the old nearest-neighbour lookup. Smaller
    // now there's genuine sub-grid-point detail to resolve between —
    // same reasoning as terrain's own 4px-to-3px change when it first
    // gained interpolation.
    const cell = 3;
    for (let px = 0; px < view.w; px += cell) {
      for (let py = 0; py < view.h; py += cell) {
        const lon = centre.lon + (px - view.w / 2) / (view.pxPerKm * kmPerDegLon(centre.lat));
        const lat = centre.lat - (py - view.h / 2) / (view.pxPerKm * KM_PER_DEG_LAT);
        const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
        if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
        const value = mapStripRainAt(grid, fr, fc, hourIndex);
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

    // Regular weight now, matching the full map's own place labels
    // exactly (was 600/bold here, a leftover from when the strip's
    // palette and styling generally diverged from the full map on
    // purpose — see MAP_STRIP_PALETTES' own note).
    ctx.font = "11px -apple-system, system-ui, sans-serif";
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

  // Bottom-right time pill, matching the full map's own version in spirit
  // but its own small class (see style.css) rather than a full-width bar
  // across a card this size. Hidden at "Now" — that's the strip's own
  // default state already, so a clock permanently repeating the current
  // time added nothing; it only earns a place once the shared Hour
  // slider (Play button included — this is exactly the state Play
  // drives) has moved somewhere else worth naming.
  const scaleEl = ensureMapStripScale();
  if (scaleEl) {
    scaleEl.classList.toggle("is-visible", mapStripHourOffset !== 0);
    if (mapStripHourOffset !== 0) scaleEl.textContent = mapStripHourClock(grid, mapStripHourOffset);
  }
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
  const startIdx = points[0].hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);

  // Keeps each point's FULL hourly series rather than collapsing to a
  // single "now" value the way this used to — that's what lets the
  // render step below pick out whichever hour the front page's own
  // slider is currently on, without a separate fetch per hour moved.
  // 3 days (72 hours) comfortably covers the front page's slider range
  // (up to +48h), so nothing here needed to grow to support this.
  const rainByHour = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < rows; c++) {
      const series = points[r * rows + c].hourly.precipitation;
      row.push(series.map(v => (v === null || v === undefined ? 0 : v)));
    }
    rainByHour.push(row);
  }
  // Same series for every point (Open-Meteo's hourly buckets are aligned
  // across all requested locations), so the first point's own timestamps
  // stand in for all of them — matches map.js's own mapGrid.times, which
  // the new clock readout below is a direct copy of the reasoning for.
  const times = points[0].hourly.time;

  return { lat0, lon0, dLat, dLon, rows, cols: rows, rainByHour, times, startIdx: Math.max(0, startIdx) };
}

async function initMapStrip(centre) {
  if (!mapStripCanvas) return;
  sizeMapStripCanvas();

  // A cold PWA launch on iOS: reported as the map strip staying at a
  // wrong (too-short) height on first open, pushing everything below it
  // down far enough to need a scroll — but self-correcting the moment
  // anything else forces a fresh layout pass (opening the full map and
  // coming back). .map-strip's height comes from a plain CSS flex-grow
  // against .app-home's `min-height: 100svh` (see style.css) — no JS
  // computes it — but `svh` itself is measured against iOS's own
  // dynamic toolbar, which isn't necessarily settled at the very first
  // paint right after launch. The existing ResizeObserver below already
  // catches a LATER size change correctly; this only covers the case
  // where the very first measurement, taken here before that observer
  // is even attached, was against a viewport iOS hadn't finished
  // settling yet. Two rAFs (not a guessed timeout) waits for the
  // browser's own next two paint opportunities, by which point iOS's
  // real viewport has consistently settled in testing.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (sizeMapStripCanvas() && mapStripLastCentre) {
        renderMapStrip(mapStripLastCentre, mapStripLastGrid);
      }
    });
  });

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
    if (!mapStripLakes) {
      // Own try/catch, same reasoning as terrain above: a missing or
      // slow lakes file shouldn't hold up coastline/places, and the
      // strip is still doing everything it promises without it.
      try {
        const res = await fetchWithTimeout("data/lakes-50m.json", {}, 15000);
        if (res.ok) mapStripLakes = await res.json();
      } catch {
        // No lakes this time — same degrade-not-break reasoning as terrain.
      }
    }
    if (!mapStripWaterways) {
      try {
        const res = await fetchWithTimeout("data/waterways.json", {}, 15000);
        if (res.ok) mapStripWaterways = await res.json();
      } catch {
        // No rivers/canals this time — same degrade-not-break reasoning.
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

// Reads the SAME #hourSlider element app.js already owns and drives the
// headline grid with — a second listener on it, not a shared state
// object, since that's all this needs and app.js's own "input" handler
// is left completely untouched. Only re-renders (never re-fetches): the
// full hourly series for every point is already sitting in
// mapStripLastGrid from the one fetch on load, so moving the slider is
// just picking a different index out of data already in hand.
const mapStripHourSlider = document.getElementById("hourSlider");
if (mapStripHourSlider) {
  mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
  mapStripHourSlider.addEventListener("input", () => {
    mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
    if (mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}

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
