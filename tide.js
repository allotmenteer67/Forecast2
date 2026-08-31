// Tide prediction engine — the pure-maths half of the tide feature.
// Kept separate from tide-ui.js (DOM/fetch/rendering) so the harmonic
// analysis itself can be tested and reasoned about on its own, the same
// separation solar.js/solar-ui.js already use.
//
// APPROACH: this is the same technique every official tide-table
// authority uses (UKHO included) — fit a handful of known astronomical
// cycles (the "constituents" below) to a station's own historical
// water-level record via least squares, then the fitted curve predicts
// forward indefinitely. The difference from an official prediction is
// purely how much history and how many constituents go into the fit —
// see the accuracy discussion from when this was scoped: expect decent
// timing, softer height/shape accuracy, and correspondingly it should
// keep improving as TFV (below) absorbs whatever systematic error is
// left over from a necessarily shorter, smaller-constituent-set fit
// than an official one.
//
// VALIDATION NOTE: this file's maths is verified against synthetic
// data shaped like a real, large-range, shallow-water estuary tide
// (Bristol Channel scale) — see the accompanying test script mentioned
// in the build notes. It has NOT been run against genuine EA readings
// in this session (the readings endpoint couldn't be fetched live from
// here — only the station list and current-reading snapshot could).
// The first real run against actual Hinkley Point history is the real
// test; if predictions look implausible, check here first.

// Period in hours for each constituent. The four semidiurnal + four
// diurnal are the standard "major eight" behind most tide tables; M4
// and MS4 are shallow-water overtides of M2 — these matter more here
// than on an open coastline, since the Bristol Channel's huge range and
// shallow mudflats distort the tide away from a clean sine wave (faster
// rise than fall, or vice versa) more than most places in the world.
const TIDE_CONSTITUENTS = [
  { name: "M2", periodHours: 12.4206012 },
  { name: "S2", periodHours: 12.0 },
  { name: "N2", periodHours: 12.6583482 },
  { name: "K2", periodHours: 11.9672348 },
  { name: "K1", periodHours: 23.9344696 },
  { name: "O1", periodHours: 25.8193387 },
  { name: "P1", periodHours: 24.0658902 },
  { name: "Q1", periodHours: 26.8683567 },
  { name: "M4", periodHours: 6.2103006 },
  { name: "MS4", periodHours: 6.1033393 }
];

// ---- Small linear algebra: Gaussian elimination with partial pivoting
// ---- for a square system A x = b. Kept local rather than pulling in a
// matrix library — the system here is at most ~21x21 (10 constituents *
// 2 + 1 mean), well within what a plain elimination handles cleanly.
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivotRow][col])) pivotRow = row;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) continue; // singular direction — leave as 0, see below

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }

  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

// Fits mean level + amplitude/phase (as cos/sin coefficient pairs) for
// every constituent in TIDE_CONSTITUENTS against a set of real
// readings. Returns null if there isn't enough data to fit meaningfully
// — see MIN_FIT_READINGS below.
const MIN_FIT_READINGS = 200; // a little over 2 days of 15-min readings;
                               // far short of what a good fit actually
                               // wants (see file header), but enough to
                               // not blow up the linear algebra

function fitTideHarmonics(readings) {
  if (!readings || readings.length < MIN_FIT_READINGS) return null;

  const paramCount = 1 + TIDE_CONSTITUENTS.length * 2;
  const omegas = TIDE_CONSTITUENTS.map(c => (2 * Math.PI) / c.periodHours);

  // Design matrix columns: [1, cos(w1 t), sin(w1 t), cos(w2 t), sin(w2 t), ...]
  const rows = readings.map(r => {
    const row = [1];
    omegas.forEach(w => {
      row.push(Math.cos(w * r.hours), Math.sin(w * r.hours));
    });
    return row;
  });

  // Normal equations: (X^T X) a = X^T y
  const XtX = Array.from({ length: paramCount }, () => new Array(paramCount).fill(0));
  const Xty = new Array(paramCount).fill(0);
  rows.forEach((row, i) => {
    const y = readings[i].level;
    for (let a = 0; a < paramCount; a++) {
      Xty[a] += row[a] * y;
      for (let b = 0; b < paramCount; b++) {
        XtX[a][b] += row[a] * row[b];
      }
    }
  });

  const coeffs = solveLinearSystem(XtX, Xty);
  return { meanLevel: coeffs[0], omegas, pairs: TIDE_CONSTITUENTS.map((c, i) => ({
    name: c.name,
    cos: coeffs[1 + i * 2],
    sin: coeffs[2 + i * 2]
  })) };
}

// Predicts water level at a given time (hours, same epoch/units the fit
// was built from) from a fitted model.
function predictTideLevel(fit, hours) {
  let level = fit.meanLevel;
  fit.pairs.forEach((p, i) => {
    const w = fit.omegas[i];
    level += p.cos * Math.cos(w * hours) + p.sin * Math.sin(w * hours);
  });
  return level;
}

// Finds high/low water events between startHours and endHours by
// evaluating the fitted curve at a fine step and locating local
// extrema — simpler and more robust than solving for the curve's
// derivative roots analytically, and plenty precise at a 3-minute step
// (tide curves are slow-moving; a genuine extremum is never missed
// between two samples 3 minutes apart).
const TIDE_EXTREMA_STEP_HOURS = 3 / 60;

function findTideExtremes(fit, startHours, endHours) {
  const events = [];
  let prev = predictTideLevel(fit, startHours);
  let prevPrev = null;
  for (let h = startHours + TIDE_EXTREMA_STEP_HOURS; h <= endHours; h += TIDE_EXTREMA_STEP_HOURS) {
    const level = predictTideLevel(fit, h);
    if (prevPrev !== null) {
      const risingBefore = prev > prevPrev;
      const risingAfter = level > prev;
      if (risingBefore && !risingAfter) {
        events.push({ hours: h - TIDE_EXTREMA_STEP_HOURS, level: prev, type: "high" });
      } else if (!risingBefore && risingAfter) {
        events.push({ hours: h - TIDE_EXTREMA_STEP_HOURS, level: prev, type: "low" });
      }
    }
    prevPrev = prev;
    prev = level;
  }
  return events;
}

// ---- TFV (Tidal Fudge Factor) ----
// Same idea as the weather side's FFV: a recency-weighted running
// correction, learned from comparing this station's own self-derived
// prediction against its own EA-observed reading — not a different
// station's prediction, which is what makes this a genuine model-error
// correction rather than papering over a station mismatch.
//
// The alpha is NOT the same constant FFV uses elsewhere in the app —
// FFV updates once per day, so 2/31 gives it a ~30-day memory measured
// in samples. Tide readings arrive every 15 minutes (96/day), so the
// same alpha value would give a real memory of only ~8 hours, not 30
// days — confirmed as a genuine bug during testing (a fake 36-hour
// surge pushed the fudge to within a few cm of the surge's full size,
// when a real 30-day memory should barely register it). This alpha is
// calculated for a 30-day memory at 96 samples/day instead.
const TIDE_READINGS_PER_DAY = 96; // 15-minute readings
const TIDE_TFV_MEMORY_DAYS = 30;
const TIDE_TFV_EMA_ALPHA = 2 / (TIDE_TFV_MEMORY_DAYS * TIDE_READINGS_PER_DAY + 1);

function updateTideFudge(previousFudge, predictedLevel, actualLevel) {
  const residual = actualLevel - predictedLevel;
  if (previousFudge === null || previousFudge === undefined) return residual;
  return previousFudge + TIDE_TFV_EMA_ALPHA * (residual - previousFudge);
}

function applyTideFudge(predictedLevel, fudge) {
  return predictedLevel + (fudge || 0);
}

// ---- EA Tide Gauge stations ----
// Bundled rather than fetched on every use — there are only a few dozen
// of them, they change rarely, and this list was pulled live from
// https://environment.data.gov.uk/flood-monitoring/id/stations?type=TideGauge
// during this feature's build, using each station's mAOD (Ordnance
// Datum) measure where one exists, since that's directly comparable
// across stations rather than each one's own arbitrary local datum.
// EA's own documentation describes the network as "44 locations"; only
// 43 distinct stations came back in the actual response fetched here —
// worth a re-check against a fresh station list occasionally in case
// one was missed or the network has changed since.
const EA_TIDE_STATIONS = [
  { id: "E70039", measureId: "E70039-level-tidal_level-Mean-15_min-mAOD", label: "Lowestoft", lat: 52.473075, lon: 1.750085 },
  { id: "E72639", measureId: "E72639-level-tidal_level-Mean-15_min-mAOD", label: "Avonmouth Portbury", lat: 51.49999, lon: -2.728468 },
  { id: "E71539", measureId: "E71539-level-tidal_level-Mean-15_min-mAOD", label: "Sheerness", lat: 51.445627, lon: 0.743415 },
  { id: "E71939", measureId: "E71939-level-tidal_level-Mean-15_min-mAOD", label: "Bournemouth", lat: 50.714331, lon: -1.874873 },
  { id: "E71239", measureId: "E71239-level-tidal_level-Mean-15_min-mAOD", label: "Cromer", lat: 52.934316, lon: 1.301623 },
  { id: "E72039", measureId: "E72039-level-tidal_level-Mean-15_min-mAOD", label: "Weymouth", lat: 50.608501, lon: -2.447945 },
  { id: "E71639", measureId: "E71639-level-tidal_level-Mean-15_min-mAOD", label: "Dover", lat: 51.114372, lon: 1.322641 },
  { id: "E73439-anglian", measureId: "E73439-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Heysham", lat: 54.031798, lon: -2.920253 },
  { id: "E72439", measureId: "E72439-level-tidal_level-Mean-15_min-mAOD", label: "Ilfracombe", lat: 51.211131, lon: -4.112362 },
  { id: "E70939", measureId: "E70939-level-tidal_level-Mean-15_min-mAOD", label: "North Shields", lat: 55.007415, lon: -1.439769 },
  { id: "E73639-anglian", measureId: "E73639-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Workington", lat: 54.650691, lon: -3.56717 },
  { id: "E72139", measureId: "E72139-level-tidal_level-Mean-15_min-mAOD", label: "Plymouth", lat: 50.368401, lon: -4.185217 },
  { id: "E71739", measureId: "E71739-level-tidal_level-Mean-15_min-mAOD", label: "Newhaven", lat: 50.781775, lon: 0.057004 },
  { id: "E71039", measureId: "E71039-level-tidal_level-Mean-15_min-mAOD", label: "Whitby", lat: 54.489967, lon: -0.614597 },
  { id: "E70139-anglian", measureId: "E70139-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Liverpool", lat: 53.44967, lon: -3.01815 },
  { id: "E72539", measureId: "E72539-level-tidal_level-Mean-15_min-mAOD", label: "Hinkley Point", lat: 51.210605, lon: -3.131326 },
  { id: "E71439", measureId: "E71439-level-tidal_level-Mean-15_min-mAOD", label: "Harwich", lat: 51.947978, lon: 1.292108 },
  { id: "E72239", measureId: "E72239-level-tidal_level-Mean-15_min-mAOD", label: "Newlyn", lat: 50.103007, lon: -5.542779 },
  { id: "E71839", measureId: "E71839-level-tidal_level-Mean-15_min-mAOD", label: "Portsmouth", lat: 50.80229, lon: -1.11119 },
  { id: "E71139", measureId: "E71139-level-tidal_level-Mean-15_min-mAOD", label: "Immingham", lat: 53.63018, lon: -0.18742 },
  { id: "E71339", measureId: "E71339-level-tidal_level-Mean-15_min-mAOD", label: "Washpile", lat: 52.875861, lon: 0.218395 },
  { id: "E72339", measureId: "E72339-level-tidal_level-Mean-15_min-m", label: "St Marys", lat: 49.91786, lon: -6.31722 },
  { id: "E73939", measureId: "E73939-level-tidal_level-Mean-15_min-mAOD", label: "Portrush", lat: 55.20108, lon: -6.65123 },
  { id: "E70539", measureId: "E70539-level-tidal_level-Mean-15_min-mAOD", label: "Holyhead", lat: 53.31394, lon: -4.62043 },
  { id: "E73139", measureId: "E73139-level-tidal_level-Mean-15_min-mAOD", label: "Fishguard", lat: 52.01321, lon: -4.98371 },
  { id: "E70439", measureId: "E70439-level-tidal_level-Mean-15_min-mAOD", label: "Ullapool", lat: 57.89527, lon: -5.15789 },
  { id: "E70839", measureId: "E70839-level-tidal_level-Mean-15_min-mAOD", label: "Leith", lat: 55.98983, lon: -3.18168 },
  { id: "E72939", measureId: "E72939-level-tidal_level-Mean-15_min-mAOD", label: "Mumbles", lat: 51.57, lon: -3.97544 },
  { id: "E72839", measureId: "E72839-level-tidal_level-Mean-15_min-mAOD", label: "Newport", lat: 51.55001, lon: -2.98743 },
  { id: "E70739", measureId: "E70739-level-tidal_level-Mean-15_min-mAOD", label: "Aberdeen", lat: 57.14406, lon: -2.08013 },
  { id: "E73039", measureId: "E73039-level-tidal_level-Mean-15_min-mAOD", label: "Milford Haven", lat: 51.70738, lon: -5.05184 },
  { id: "E74039", measureId: "E74039-level-tidal_level-Mean-15_min-mAOD", label: "Millport", lat: 55.7498, lon: -4.90634 },
  { id: "E73839", measureId: "E73839-level-tidal_level-Mean-15_min-mAOD", label: "Bangor", lat: 54.66518, lon: -5.67045 },
  { id: "E70639", measureId: "E70639-level-tidal_level-Mean-15_min-mAOD", label: "Wick", lat: 58.44098, lon: -3.08631 },
  { id: "E73539", measureId: "E73539-level-tidal_level-Mean-15_min-mAOD", label: "Port Erin", lat: 54.08538, lon: -4.76807 },
  { id: "E70339", measureId: "E70339-level-tidal_level-Mean-15_min-mAOD", label: "Kinlochbervie", lat: 58.45673, lon: -5.05018 },
  { id: "E74239", measureId: "E74239-level-tidal_level-Mean-15_min-mAOD", label: "Tobermory", lat: 56.62314, lon: -6.06424 },
  { id: "E73739", measureId: "E73739-level-tidal_level-Mean-15_min-mAOD", label: "Portpatrick", lat: 54.84254, lon: -5.12004 },
  { id: "E74339", measureId: "E74339-level-tidal_level-Mean-15_min-mAOD", label: "Stornoway", lat: 58.20781, lon: -6.38897 },
  { id: "E70239", measureId: "E70239-level-tidal_level-Mean-15_min-mAOD", label: "Jersey", lat: 49.18333, lon: -2.11667 },
  { id: "E73239", measureId: "E73239-level-tidal_level-Mean-15_min-mAOD", label: "Barmouth", lat: 52.71931, lon: -4.04503 },
  { id: "E74439", measureId: "E74439-level-tidal_level-Mean-15_min-mAOD", label: "Lerwick", lat: 60.15402, lon: -1.1403 },
  { id: "E73339", measureId: "E73339-level-tidal_level-Mean-15_min-mAOD", label: "Llandudno", lat: 53.33164, lon: -3.82521 }
];

const EA_STATIONS_URL = "https://environment.data.gov.uk/flood-monitoring/id/stations?type=TideGauge";
const EA_READINGS_BASE = "https://environment.data.gov.uk/flood-monitoring/id/measures";
const EA_READINGS_MAX_LIMIT = 10000; // EA's own hard cap per request — at
                                      // 15-min readings that's just over
                                      // 104 days, plenty for a first fit

// Haversine distance in km — plenty precise for "which of 44 UK coastal
// stations is nearest", no need for anything more exact than that.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestTideStation(lat, lon) {
  let best = null, bestDist = Infinity;
  EA_TIDE_STATIONS.forEach(station => {
    const dist = haversineKm(lat, lon, station.lat, station.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  });
  return best ? { ...best, distanceKm: bestDist } : null;
}

// Fetches this station's own recent history live and fits it on the
// spot — the "backfill" equivalent for a genuinely new tide location.
// EA needs no key, so (unlike UKHO) this can run directly from the
// browser rather than needing to wait for the next scheduled
// collection. Returns null if the fetch fails or comes back too thin
// to fit (see MIN_FIT_READINGS in the fit function itself).
async function backfillTideStation(station) {
  const url = `${EA_READINGS_BASE}/${station.measureId}/readings?_sorted&_limit=${EA_READINGS_MAX_LIMIT}`;
  const res = await fetchWithTimeout(url, {}, 30000);
  if (!res.ok) throw new Error(`Tide gauge fetch failed: ${res.status}`);
  const data = await res.json();
  const parsed = data.items
    .map(item => ({ time: Date.parse(item.dateTime), level: item.value }))
    .filter(r => typeof r.level === "number" && !Number.isNaN(r.time))
    .sort((a, b) => a.time - b.time);
  if (!parsed.length) return { readings: [], epochIso: new Date().toISOString() };

  // Epoch is deliberately the earliest reading in the batch, not "just
  // whatever came back first" — readable and conventional, though the
  // fit itself works the same regardless of which fixed point every
  // reading's hours-offset is measured relative to.
  const epoch = parsed[0].time;
  const readings = parsed.map(r => ({ hours: (r.time - epoch) / 3600000, level: r.level }));
  return { readings, epochIso: new Date(epoch).toISOString() };
}

// ---- Saved tide locations ----
// A separate list from weather's saved places (PLACES_KEY) — a tide
// spot and a weather postcode are conceptually different things (see
// the discussion when this was scoped), so they get their own storage
// rather than being forced to share one list.
const TIDE_LOCATIONS_KEY = "cloude-tide:locations";
const CURRENT_TIDE_LOCATION_KEY = "cloude-tide:current";

function loadTideLocations() {
  try {
    const raw = localStorage.getItem(TIDE_LOCATIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to default
  }
  return [];
}

function saveTideLocations(locations) {
  try {
    localStorage.setItem(TIDE_LOCATIONS_KEY, JSON.stringify(locations));
  } catch {
    // Storage unavailable — saved tide locations just won't persist.
  }
}

function loadCurrentTideLocationId() {
  try {
    return localStorage.getItem(CURRENT_TIDE_LOCATION_KEY) || null;
  } catch {
    return null;
  }
}

function saveCurrentTideLocationId(id) {
  try {
    localStorage.setItem(CURRENT_TIDE_LOCATION_KEY, id);
  } catch {
    // Storage unavailable — current tide location just won't persist.
  }
}

// ---- Per-station TFV storage ----
// Keyed by the EA station id, NOT by the saved location's own id —
// two saved locations that happen to share a nearest station (e.g. two
// nearby villages both closest to the same gauge) should share that
// station's learned correction rather than tracking it twice, since
// it's genuinely the same station's own model error either way.
function tideFudgeKey(stationId) {
  return `cloude-tide:tfv:${stationId}`;
}

function loadTideFudge(stationId) {
  try {
    const raw = localStorage.getItem(tideFudgeKey(stationId));
    return raw === null ? null : parseFloat(raw);
  } catch {
    return null;
  }
}

function saveTideFudge(stationId, fudge) {
  try {
    localStorage.setItem(tideFudgeKey(stationId), String(fudge));
  } catch {
    // Storage unavailable — correction just won't persist between visits.
  }
}

// Cached fit per station, kept in memory only (not persisted) — refit
// happens once per page load per station rather than on every render,
// the same "don't redo expensive work every render" principle behind
// this session's in-memory FFV cache fix for the main app.
const tideFitCache = new Map();

async function getOrBuildTideFit(station) {
  if (tideFitCache.has(station.id)) return tideFitCache.get(station.id);
  const backfill = await backfillTideStation(station);
  if (!backfill || backfill.readings.length < MIN_FIT_READINGS) return null;
  const fit = fitTideHarmonics(backfill.readings);
  if (!fit) return null;
  const result = { fit, epochIso: backfill.epochIso, latestReadings: backfill.readings.slice(-400) };
  tideFitCache.set(station.id, result);
  return result;
}
