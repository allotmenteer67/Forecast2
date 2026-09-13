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
//
// ---- SVG, not canvas — why, briefly ----
// This used to draw onto a <canvas>. After an extended, evidence-led
// debugging session, the actual cause of a real bug (the strip going
// permanently blank after returning from the full map or Settings, no
// error anywhere, not fixed by repainting, not fixed by replacing the
// canvas element outright) was narrowed down to something about how
// iOS composites a live <canvas> 2D context specifically not reliably
// surviving that particular page transition — confirmed by ruling out
// every other explanation first (layout/sizing, staleness, a detached
// element, several different trigger events). Rather than keep hunting
// for a way to force that specific compositing layer to refresh, the
// strip now draws with ordinary SVG elements instead. SVG has no
// separate bitmap to desync from what's declared — what you see IS the
// DOM, always, so this whole category of bug has nothing left to hide
// in. Every trigger, every data source, and the actual visual result
// are all unchanged; only how the picture gets onto the screen is
// different.

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
const MAP_STRIP_PALETTES = {
  paper: { land: "#e4efe6", sea: "#EEF5FA", coast: "#9c9a92", ink: "#4a4844", river: "#8FB9E2", tideMarker: "#CC3B2E", ramp: ["#BBD5EE", "#8FB9E2", "#6098D2", "#3B76BC", "#22539B", "#12376F"] },
  slate: { land: "#234f39", sea: "#33454f", coast: "#7a7a72", ink: "#d8d6cf", river: "#85B7EB", tideMarker: "#FF6B52", ramp: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#378ADD", "#185FA5", "#0C447C"] },
  mono: { land: "#FFFFFF", sea: "#ECECEC", coast: "#555555", ink: "#111111", river: "#7C7C7C", tideMarker: "#141414", ramp: ["#C9C9C9", "#A2A2A2", "#7C7C7C", "#585858", "#363636", "#141414"] }
};
function mapStripPalette() {
  let id = "paper";
  try { id = localStorage.getItem("forecast-compare:map:palette") || "paper"; } catch {}
  return MAP_STRIP_PALETTES[id] || MAP_STRIP_PALETTES.paper;
}

// Still called mapStripCanvas throughout — kept the name on purpose
// rather than renaming every reference, since this file's whole history
// (and every comment explaining a past fix) refers to it that way; it's
// now an <svg> element, not a <canvas>, but "the strip's own drawing
// surface" is still exactly what it is.
let mapStripCanvas = document.getElementById("mapStripCanvas");
let mapStripCoastline = null;
let mapStripPlaces = null;
let mapStripTerrain = null;
let mapStripLakes = null;
let mapStripWaterways = null;
let mapStripLastCentre = null;
let mapStripLastGrid = null;

// Simpler than the old canvas version by a wide margin — no devicePixelRatio
// backing-store math, no destructive resize-clears-content behaviour to
// work around (SVG doesn't lose its content just because its viewBox
// changed). Just measures the box and updates the viewBox to match.
function sizeMapStripSvg() {
  const freshSvg = document.getElementById("mapStripCanvas");
  if (freshSvg && freshSvg.isConnected) mapStripCanvas = freshSvg;
  if (!mapStripCanvas || !mapStripCanvas.isConnected) return false;
  const rect = mapStripCanvas.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w <= 0 || h <= 0) return false;
  const current = mapStripCanvas.getAttribute("viewBox");
  const wanted = `0 0 ${w} ${h}`;
  if (current === wanted) return false;
  mapStripCanvas.setAttribute("viewBox", wanted);
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
  const pxPerKm = Math.max(w, h) / spanKm;
  const dLon = kmPerDegLon(centre.lat);
  return {
    w, h, pxPerKm,
    x: lon => w / 2 + (lon - centre.lon) * dLon * pxPerKm,
    y: lat => h / 2 - (lat - centre.lat) * KM_PER_DEG_LAT * pxPerKm,
    lat: py => centre.lat - (py - h / 2) / (pxPerKm * KM_PER_DEG_LAT),
    lon: px => centre.lon + (px - w / 2) / (pxPerKm * dLon)
  };
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Replaces an SVG element's children from a markup string, WITHOUT
// using element.innerHTML — Safari's support for setting innerHTML on
// SVG elements specifically has a patchy history, and silently doing
// nothing (no error, no content) fits the actual on-device symptom
// exactly: weather updates fine, the strip stays empty, even a forced
// refresh changes nothing. DOMParser is a much older, more universally
// solid API for exactly this job — it genuinely parses the string as
// real XML and hands back real nodes, which are then imported into the
// live document and appended one by one. A parse failure (malformed
// markup) surfaces as a <parsererror> node in the result rather than a
// thrown exception, so that's checked explicitly too.
function setSvgContent(svgEl, innerMarkup) {
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg">${innerMarkup}</svg>`;
  const parsed = new DOMParser().parseFromString(wrapped, "image/svg+xml");
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  if (parsed.querySelector("parsererror")) {
    console.error("Map strip SVG markup failed to parse — check for an unescaped character.");
    return;
  }
  Array.from(parsed.documentElement.childNodes).forEach(node => {
    svgEl.appendChild(document.importNode(node, true));
  });
}

// Builds one <path> element's "d" data for a Polygon/MultiPolygon
// GeoJSON geometry, projected through view — the SVG equivalent of the
// old canvas version's per-ring moveTo/lineTo/closePath walk. fill-rule
// evenodd (set by the caller on the <path> itself) is what makes a
// polygon-with-holes (an island's lake, a lake's island) render
// correctly from a single path string, exactly as ctx.fill("evenodd")
// did before.
function svgPolygonPath(geojson, view) {
  if (!geojson) return "";
  const parts = [];
  geojson.features.forEach(feature => {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    polygons.forEach(polygon => {
      polygon.forEach(ring => {
        if (!ring.length) return;
        const points = ring.map(([lon, lat]) => `${view.x(lon).toFixed(1)},${view.y(lat).toFixed(1)}`);
        parts.push(`M${points.join("L")}Z`);
      });
    });
  });
  return parts.join(" ");
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
// map.js's own drawMapWaterways. Returns markup for one <path> per
// ring, since canal/river rings need different dash styling from each
// other and a single path element can only carry one stroke-dasharray.
function svgWaterwaysPaths(geo, view, colour) {
  if (!geo) return "";
  const features = geo.type === "FeatureCollection" ? geo.features : [geo];
  const parts = [];
  features.forEach(feature => {
    const geometry = feature.geometry || feature;
    const dash = feature.properties?.kind === "canal" ? ' stroke-dasharray="4,3"' : "";
    eachMapStripRing(geometry, ring => {
      if (!ring.length) return;
      const points = ring.map(([lon, lat]) => `${view.x(lon).toFixed(1)},${view.y(lat).toFixed(1)}`);
      parts.push(`<path d="M${points.join("L")}" fill="none" stroke="${colour}" stroke-width="1"${dash}/>`);
    });
  });
  return parts.join("");
}

// Bilinear elevation + shading, ported from map.js's terrainElevationAt/
// terrainShadeAt/terrainShadeBilinear (see that file for the full
// reasoning) — unchanged by the SVG rewrite, purely maths, no drawing.
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

// Builds the terrain shading layer as a grid of small <rect> elements —
// the SVG equivalent of the old per-cell ctx.fillRect loop. Cell size
// bumped from the canvas version's 3px to 6px: purely an SVG element-
// count concession (a 350x260 strip at 3px is ~10,000 individual
// elements just for terrain, which is more DOM than is sensible to
// rebuild on every redraw; 6px keeps the same shading technique and a
// still-detailed look at roughly a quarter the element count).
function svgTerrainRects(view, grid) {
  if (!grid) return "";
  const cell = 6;
  const parts = [];
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lat = view.lat(py + cell / 2), lon = view.lon(px + cell / 2);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
      const z = grid.values[Math.round(fr)][Math.round(fc)];
      if (z === null || z === undefined || z <= 0) continue;
      const shade = mapStripShadeBilinear(grid, fr, fc);
      if (Math.abs(shade) < 0.02) continue;
      const colour = shade > 0 ? "#ffffff" : "#000000";
      const opacity = Math.min(0.50, Math.abs(shade) * 0.7).toFixed(2);
      parts.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${colour}" fill-opacity="${opacity}"/>`);
    }
  }
  return parts.join("");
}

// Bilinear blend of the 4 nearest grid points — unchanged maths from
// the canvas version, purely a lookup, no drawing.
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

// Same cell-size concession as terrain above, same reasoning — 6px
// rather than the canvas version's 3px, to keep the rebuilt-every-
// redraw SVG element count reasonable.
function svgRainRects(view, centre, grid, palette) {
  if (!grid) return "";
  const hourIndex = Math.min(
    grid.startIdx + mapStripHourOffset,
    grid.rainByHour[0][0].length - 1
  );
  const cell = 6;
  const parts = [];
  for (let px = 0; px < view.w; px += cell) {
    for (let py = 0; py < view.h; py += cell) {
      const lon = centre.lon + (px - view.w / 2) / (view.pxPerKm * kmPerDegLon(centre.lat));
      const lat = centre.lat - (py - view.h / 2) / (view.pxPerKm * KM_PER_DEG_LAT);
      const fr = (lat - grid.lat0) / grid.dLat, fc = (lon - grid.lon0) / grid.dLon;
      if (fr < 0 || fc < 0 || fr > grid.rows - 1 || fc > grid.cols - 1) continue;
      const value = mapStripRainAt(grid, fr, fc, hourIndex);
      const band = rainBandIndex(value);
      if (band < 0) continue;
      parts.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${palette.ramp[band]}" fill-opacity="0.85"/>`);
    }
  }
  return parts.join("");
}

// Direct copy of map.js's own mapHourClock and its full reasoning
// (kept as its own small copy rather than shared, same reasoning as
// everything else in this file — see the file-level note at the top).
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
// corner, same look. Created lazily and appended once rather than
// requiring index.html to carry a dedicated element for it. Unaffected
// by the SVG rewrite — this was always a plain DOM element sitting
// next to the drawing surface, never inside it.
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
  // Re-fetched fresh on every single draw, not trusted from the
  // module-load-time reference above — cheap, harmless, and guards
  // against the rare case of the element having been replaced by
  // something else entirely outside this file's control.
  const freshSvg = document.getElementById("mapStripCanvas");
  if (freshSvg && freshSvg.isConnected) mapStripCanvas = freshSvg;
  if (!mapStripCanvas || !mapStripCanvas.isConnected) return;
  mapStripLastCentre = centre;
  mapStripLastGrid = grid;
  const view = mapStripView(centre);
  const p = mapStripPalette();

  const coastlinePath = svgPolygonPath(mapStripCoastline, view);
  const lakesPath = svgPolygonPath(mapStripLakes, view);

  // Land/sea/coastline first — sea as a plain background rect, land as
  // one combined <path> (fill-rule evenodd handles islands-in-lakes,
  // lakes-in-islands correctly from a single path, same as the old
  // ctx.fill("evenodd") did). A second, fill-less copy of the same path
  // is layered in again right at the end — see the comment down there
  // for why, same reasoning the canvas version already had.
  let svg = `<rect width="${view.w}" height="${view.h}" fill="${p.sea}"/>`;
  if (coastlinePath) {
    svg += `<path d="${coastlinePath}" fill="${p.land}" stroke="${p.coast}" stroke-width="1.5" fill-rule="evenodd"/>`;
  }

  // Terrain and waterways both clip to the land outline — an SVG
  // <clipPath>, defined once here and referenced by both groups below,
  // doing the same job ctx.clip() + ctx.save()/restore() did around each
  // one individually on the canvas version.
  const clipId = "mapStripLandClip";
  let defs = "";
  if (coastlinePath) {
    defs = `<defs><clipPath id="${clipId}"><path d="${coastlinePath}"/></clipPath></defs>`;
  }

  if (mapStripTerrain && coastlinePath) {
    svg += `<g clip-path="url(#${clipId})">${svgTerrainRects(view, mapStripTerrain)}</g>`;
  }

  // Lakes then waterways, same order as map.js's own layer registration
  // (terrain -> lakes -> waterways -> weather). Lakes reuse the generic
  // polygon path builder above — a lake is just another sea-coloured
  // polygon with a coastline-style outline, nothing waterway-specific
  // about it.
  if (lakesPath) {
    svg += `<path d="${lakesPath}" fill="${p.sea}" stroke="${p.coast}" stroke-width="1.5" fill-rule="evenodd"/>`;
  }
  if (mapStripWaterways && coastlinePath) {
    svg += `<g clip-path="url(#${clipId})">${svgWaterwaysPaths(mapStripWaterways, view, p.river)}</g>`;
  }

  if (grid) {
    svg += svgRainRects(view, centre, grid, p);
  }

  // Second, stroke-only copy of the coastline outline — the rain wash
  // just added above can bury the coastline stroke laid down before it
  // entirely, matching a bug already fixed on the full map (see its own
  // "coastline-outline" layer in map.js) but never applied here, since
  // the strip only ever drew its coastline once, up front, on the
  // canvas version. No fill this time, so it only redraws the outline
  // itself, sitting on top of everything painted since the first copy.
  if (coastlinePath) {
    svg += `<path d="${coastlinePath}" fill="none" stroke="${p.coast}" stroke-width="1.5"/>`;
  }

  // A few names for scale — "is this 5 miles across or 50" is hard to
  // judge from an unlabelled outline. Nearest-and-biggest few only.
  // Outline-then-fill on one <text> (paint-order handles this natively
  // in SVG — no separate strokeText/fillText calls needed) keeps a name
  // readable whether it lands on sea, land, or a rain cell.
  if (mapStripPlaces) {
    const withDistance = mapStripPlaces
      .map(place => ({ place, d: Math.hypot(place.lat - centre.lat, place.lon - centre.lon) }))
      .filter(({ d }) => d < 0.35)
      .sort((a, b) => (a.place.rank - b.place.rank) || (a.d - b.d))
      .slice(0, 4);

    withDistance.forEach(({ place }) => {
      const x = view.x(place.lon), y = view.y(place.lat);
      if (x < 0 || x > view.w || y < 0 || y > view.h) return;
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${p.ink}"/>`;
      svg += `<text x="${(x + 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" font-family="-apple-system, system-ui, sans-serif" fill="${p.ink}" stroke="${p.land}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(place.name)}</text>`;
    });
  }

  // Small icon only, no label — see map.js's own tide-locations layer
  // for the full version (name, tap-to-recentre).
  if (typeof loadTideLocations === "function") {
    const tideLocations = loadTideLocations();
    tideLocations.forEach(loc => {
      const x = view.x(loc.lon), y = view.y(loc.lat);
      if (x < 0 || x > view.w || y < 0 || y > view.h) return;
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${p.tideMarker}" stroke="#fff" stroke-width="1"/>`;
    });
  }

  // Centre marker, same small dot map.html itself uses for Home.
  svg += `<circle cx="${(view.w / 2).toFixed(1)}" cy="${(view.h / 2).toFixed(1)}" r="4" fill="${p.ink}"/>`;

  setSvgContent(mapStripCanvas, defs + svg);

  // Bottom-right time pill, matching the full map's own version in
  // spirit. Hidden at "Now" — that's the strip's own default state
  // already, so a clock permanently repeating the current time added
  // nothing; it only earns a place once the shared Hour slider has
  // moved somewhere else worth naming.
  const scaleEl = ensureMapStripScale();
  if (scaleEl) {
    scaleEl.classList.toggle("is-visible", mapStripHourOffset !== 0);
    if (mapStripHourOffset !== 0) scaleEl.textContent = mapStripHourClock(grid, mapStripHourOffset);
  }
}

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const MAP_STRIP_GRID_CACHE_KEY = "forecast-compare:mapstrip:grid";
const MAP_STRIP_GRID_CACHE_MS = 15 * 60 * 1000;

function mapStripGridCacheKey(centre) {
  return `${centre.lat.toFixed(2)},${centre.lon.toFixed(2)}`;
}

function loadMapStripGridCache(centre) {
  try {
    const raw = localStorage.getItem(MAP_STRIP_GRID_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.key !== mapStripGridCacheKey(centre)) return null;
    if (Date.now() - entry.cachedAt > MAP_STRIP_GRID_CACHE_MS) return null;
    const grid = entry.grid;
    const now = Date.now();
    const idx = grid.times.findIndex(t => new Date(t).getTime() >= now - 30 * 60 * 1000);
    if (idx === -1) return null;
    return { ...grid, startIdx: Math.max(0, idx) };
  } catch {
    return null;
  }
}

function saveMapStripGridCache(centre, grid) {
  try {
    localStorage.setItem(MAP_STRIP_GRID_CACHE_KEY, JSON.stringify({
      key: mapStripGridCacheKey(centre),
      cachedAt: Date.now(),
      grid
    }));
  } catch {
    // Storage full or unavailable — the strip just pays for a fresh
    // fetch next time, exactly as it did before this cache existed.
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
  const res = await fetchOpenMeteo(`${WEATHER_URL}?${params.toString()}`, {}, 20000);
  if (!res.ok) throw new Error(`Map strip fetch failed: ${res.status}`);
  const data = await res.json();
  const points = Array.isArray(data) ? data : [data];
  if (points.length !== rows * rows) throw new Error("Map strip fetch returned an unexpected number of points");

  const now = new Date();
  const startIdx = points[0].hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);

  const rainByHour = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < rows; c++) {
      const series = points[r * rows + c].hourly.precipitation;
      row.push(series.map(v => (v === null || v === undefined ? 0 : v)));
    }
    rainByHour.push(row);
  }
  const times = points[0].hourly.time;

  const grid = { lat0, lon0, dLat, dLon, rows, cols: rows, rainByHour, times, startIdx: Math.max(0, startIdx) };
  saveMapStripGridCache(centre, grid);
  return grid;
}

let mapStripGeneration = 0; // see the guard checks below — a fresh swipe supersedes any still-in-flight initMapStrip call from a previous one

async function initMapStrip(centre) {
  if (!mapStripCanvas) return;
  const myGeneration = ++mapStripGeneration;
  sizeMapStripSvg();

  // A cold PWA launch on iOS: reported as the map strip staying at a
  // wrong (too-short) height on first open, pushing everything below it
  // down far enough to need a scroll — but self-correcting the moment
  // anything else forces a fresh layout pass. .map-strip's height comes
  // from a plain CSS flex-grow against .app-home's `min-height: 100svh`
  // (see style.css) — no JS computes it — but `svh` itself is measured
  // against iOS's own dynamic toolbar, which isn't necessarily settled
  // at the very first paint right after launch. Two rAFs (not a guessed
  // timeout) waits for the browser's own next two paint opportunities.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (sizeMapStripSvg() && mapStripLastCentre) {
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
  if (myGeneration !== mapStripGeneration) return;
  renderMapStrip(centre, null); // whatever arrived (coastline/places/terrain) shown immediately, rain follows once fetched

  const cached = loadMapStripGridCache(centre);
  if (cached) {
    if (myGeneration !== mapStripGeneration) return;
    renderMapStrip(centre, cached);
    return;
  }

  try {
    const grid = await fetchMapStripGrid(centre);
    if (myGeneration !== mapStripGeneration) return;
    renderMapStrip(centre, grid);
  } catch (err) {
    console.error("Map strip weather fetch failed:", err);
  }
}

document.addEventListener("cloude:location-ready", e => {
  initMapStrip({ lat: e.detail.lat, lon: e.detail.lon });
});

const mapStripHourSlider = document.getElementById("hourSlider");
if (mapStripHourSlider) {
  mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
  mapStripHourSlider.addEventListener("input", () => {
    mapStripHourOffset = Number(mapStripHourSlider.value) || 0;
    if (mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}

// ResizeObserver watches the element's own box directly, catching a
// page-layout change (e.g. Tide/Fishing toggled off in Settings, which
// gives the strip more height via flex-grow) that a plain window
// "resize" listener would miss entirely. No cloneNode/replace dance
// needed here any more now the drawing surface is SVG — that machinery
// existed purely to work around canvas-specific compositing behaviour
// that doesn't apply here at all.
let mapStripResizeObserver = null;
if (mapStripCanvas && "ResizeObserver" in window) {
  mapStripResizeObserver = new ResizeObserver(() => {
    if (sizeMapStripSvg() && mapStripLastCentre) {
      renderMapStrip(mapStripLastCentre, mapStripLastGrid);
    }
  });
  mapStripResizeObserver.observe(mapStripCanvas);
} else {
  window.addEventListener("resize", () => {
    if (sizeMapStripSvg() && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  });
}

// Belt-and-braces repaint on the handful of signals that MIGHT fire on
// a "returned to this page" transition — kept from the canvas-debugging
// session even though the underlying bug they were chasing turned out
// to be canvas-specific and shouldn't exist any more with SVG. Left in
// because they're genuinely free (a plain re-render, cheap, no network
// unless the grid cache has actually expired) and there's no reason to
// remove a harmless safety net just because the thing it was guarding
// against has hopefully gone away.
setInterval(() => {
  if (document.visibilityState === "visible" && mapStripCanvas && mapStripLastCentre) {
    renderMapStrip(mapStripLastCentre, mapStripLastGrid);
  }
}, 1200);
window.addEventListener("pageshow", () => {
  if (mapStripCanvas && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && mapStripCanvas && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});
window.addEventListener("focus", () => {
  if (mapStripCanvas && mapStripLastCentre) renderMapStrip(mapStripLastCentre, mapStripLastGrid);
});
