// Tide maths — harmonic fit, FFV-equivalent correction (TFV), and the
// EA Tide Gauge API backfill. Kept separate from tide-ui.js's DOM code,
// the same split solar.js/solar-ui.js already use.

const MIN_FIT_READINGS = 500; // roughly a week of 15-min data — below
                               // this a harmonic fit is too noisy to trust

// ---- Harmonic constituents ----
// Standard semidiurnal/diurnal constituents plus two shallow-water terms
// (M4/MS4), fit by least-squares against a station's own historical
// readings — see the session addendum for the full decision trail
// (dropped UKHO's paid tier in favour of this, self-derived approach).
const TIDE_CONSTITUENTS = [
  { name: "M2", speed: 28.9841042 },
  { name: "S2", speed: 30.0000000 },
  { name: "N2", speed: 28.4397295 },
  { name: "K2", speed: 30.0821373 },
  { name: "K1", speed: 15.0410686 },
  { name: "O1", speed: 13.9430356 },
  { name: "P1", speed: 14.9589314 },
  { name: "Q1", speed: 13.3986609 },
  { name: "M4", speed: 57.9682084 },
  { name: "MS4", speed: 58.9841042 }
];

function fitTideHarmonics(readings) {
  if (!readings || readings.length < MIN_FIT_READINGS) return null;
  const n = readings.length;
  const cols = 1 + TIDE_CONSTITUENTS.length * 2; // mean level + (cos,sin) per constituent
  // Build the normal equations (X^T X) and (X^T y) directly rather than
  // holding the full design matrix in memory — thousands of readings is
  // fine either way, but this is the standard approach and avoids a
  // large intermediate array.
  const XtX = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const Xty = new Array(cols).fill(0);

  const row = new Array(cols);
  for (let i = 0; i < n; i++) {
    const t = readings[i].hours;
    const y = readings[i].level;
    row[0] = 1;
    TIDE_CONSTITUENTS.forEach((c, k) => {
      const theta = ((c.speed * t) % 360) * (Math.PI / 180);
      row[1 + k * 2] = Math.cos(theta);
      row[2 + k * 2] = Math.sin(theta);
    });
    for (let a = 0; a < cols; a++) {
      Xty[a] += row[a] * y;
      for (let b = a; b < cols; b++) {
        XtX[a][b] += row[a] * row[b];
      }
    }
  }
  for (let a = 0; a < cols; a++) {
    for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  }

  const coeffs = solveLinearSystem(XtX, Xty);
  if (!coeffs) return null;
  return { coeffs };
}

// Plain Gaussian elimination with partial pivoting — the matrix here is
// at most 21x21 (1 + 10 constituents * 2), so nothing fancier is needed.
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map(row => row.slice());
  const v = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-9) return null; // singular — not enough data variety to fit
    [M[col], M[pivot]] = [M[pivot], M[col]];
    [v[col], v[pivot]] = [v[pivot], v[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      for (let c = col; c < n; c++) M[r][c] -= factor * M[col][c];
      v[r] -= factor * v[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = v[i];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}

// Spring/neap cycle labels — the M2/S2 constituents already fitted for
// each station ARE the spring/neap cycle (their ~14.77-day beat is
// exactly what produces it), so this reads that beat directly rather
// than scanning history separately. Deliberately in one place and
// easy to swap: change the wording here only, nothing else needs to
// know about it.
const TIDE_CYCLE_LABELS = [
  "Springs",       // peak
  "Taking off",    // easing from springs, early
  "Taking off",    // easing from springs, mid
  "Near neaps",
  "Neaps",         // trough
  "Making",        // building toward springs, early
  "Making",        // building toward springs, mid
  "Near springs"
];

// Returns one of TIDE_CYCLE_LABELS for a given moment, purely from the
// fitted M2 and S2 constituents' relative phase — no separate
// historical min/max scan needed. M2 and S2 beating in phase (their
// combined amplitude at its largest) IS a spring tide; beating in
// opposition (their combined amplitude smallest) IS a neap — this is
// the actual physical mechanism, not an approximation of it.
function tideCyclePhase(fit, hours) {
  if (!fit) return null;
  const m2 = TIDE_CONSTITUENTS.findIndex(c => c.name === "M2");
  const s2 = TIDE_CONSTITUENTS.findIndex(c => c.name === "S2");
  if (m2 < 0 || s2 < 0) return null;
  const { coeffs } = fit;
  const cosM2 = coeffs[1 + m2 * 2], sinM2 = coeffs[2 + m2 * 2];
  const cosS2 = coeffs[1 + s2 * 2], sinS2 = coeffs[2 + s2 * 2];
  const phaseM2 = Math.atan2(sinM2, cosM2) * (180 / Math.PI);
  const phaseS2 = Math.atan2(sinS2, cosS2) * (180 / Math.PI);
  const speedM2 = TIDE_CONSTITUENTS[m2].speed, speedS2 = TIDE_CONSTITUENTS[s2].speed;

  // psi = 0 at the moment M2 and S2 add constructively (spring), 180 at
  // their most destructive (neap). Moves at a constant rate forever
  // (speedM2 - speedS2 is fixed), so this always sweeps the same
  // direction around the cycle — the 8 bins below are ordered to match
  // that direction rather than needing a separate rising/falling check.
  let psi = ((speedM2 - speedS2) * hours - (phaseM2 - phaseS2)) % 360;
  if (psi < 0) psi += 360;

  const bin = Math.round(psi / 45) % 8;
  // Rotates the label list so index 0 (Springs) lines up with psi≈0,
  // and walks forward through Taking off → Neaps → Making → Near
  // springs as psi increases toward 360/0 — matching how psi actually
  // decreases over real time (see comment above), so what a person
  // sees scrubbing forward through the week moves through the labels
  // in the sailing-almanac order, not backwards.
  return TIDE_CYCLE_LABELS[(8 - bin) % 8];
}

function predictTideLevel(fit, hours) {
  if (!fit) return null;
  const { coeffs } = fit;
  let level = coeffs[0];
  TIDE_CONSTITUENTS.forEach((c, k) => {
    const theta = ((c.speed * hours) % 360) * (Math.PI / 180);
    level += coeffs[1 + k * 2] * Math.cos(theta) + coeffs[2 + k * 2] * Math.sin(theta);
  });
  return level;
}

// Finds local highs/lows by sampling densely and keeping sign changes in
// the slope — plenty precise for a semidiurnal signal at this sample
// rate, no need for anything more exact than that.
function findTideExtremes(fit, startHours, endHours) {
  const stepHours = 1 / 30; // 2-minute steps
  const events = [];
  let prevLevel = predictTideLevel(fit, startHours);
  let prevSlope = null;
  for (let h = startHours + stepHours; h <= endHours; h += stepHours) {
    const level = predictTideLevel(fit, h);
    const slope = level - prevLevel;
    if (prevSlope !== null && slope !== 0 && prevSlope !== 0 && (slope > 0) !== (prevSlope > 0)) {
      events.push({
        hours: h - stepHours / 2,
        level: predictTideLevel(fit, h - stepHours / 2),
        type: prevSlope > 0 ? "high" : "low"
      });
    }
    prevLevel = level;
    prevSlope = slope;
  }
  return events;
}

// ---- TFV (Tidal Fudge Value) — learned correction against this
// station's OWN observed reading, recency-weighted the same way FFV is
// (~30-day effective memory) — see the session addendum for the bug
// found and fixed in this session (reused FFV's daily-sample alpha
// unchanged, which gave TFV a real memory of ~8 hours instead of 30
// days at tide's 15-minute sampling rate).
const TIDE_FUDGE_ALPHA = 2 / (30 * 96 + 1); // 30 days at 15-min samples

function applyTideFudge(level, fudge) {
  if (fudge === null || fudge === undefined || Number.isNaN(fudge)) return level;
  return level + fudge;
}

// ---- EA Tide Gauge Network — real, no-key station list ----
// id/measureId let this reuse the exact same EA Tide Gauge API this
// project already depends on elsewhere; lat/lon are each station's own
// published position, used only to find the nearest one to a resolved
// location (see nearestTideStation below).
//
// cdOffsetOD: each station's Chart Datum height relative to Ordnance
// Datum Newlyn (metres), published by the National Tidal and Sea Level
// Facility (https://ntslf.org/tides/datum). CD height = OD height minus
// this value. Confident matches only — omitted (undefined) for stations
// NTSLF doesn't publish a value for, and for the handful that use a
// LOCAL Ordnance Datum rather than ODN (St Mary's, Port Erin, Stornoway,
// Lerwick, Jersey/St Helier — flagged individually below), since it's
// not yet confirmed whether this station's own EA mAOD readings share
// that same local reference or the national one. Any code using this
// value must treat its absence as "no CD conversion available" rather
// than assume 0.
const EA_TIDE_STATIONS = [
  { id: "E70039", measureId: "E70039-level-tidal_level-Mean-15_min-mAOD", label: "Lowestoft", lat: 52.473075, lon: 1.750085, cdOffsetOD: -1.50 },
  { id: "E72639", measureId: "E72639-level-tidal_level-Mean-15_min-mAOD", label: "Avonmouth Portbury", lat: 51.49999, lon: -2.728468, cdOffsetOD: -6.50 }, // NTSLF publishes "Avonmouth" — likely the same tidal regime as this Portbury gauge, not individually confirmed as the identical physical station
  { id: "E71539", measureId: "E71539-level-tidal_level-Mean-15_min-mAOD", label: "Sheerness", lat: 51.445627, lon: 0.743415, cdOffsetOD: -2.90 },
  { id: "E71939", measureId: "E71939-level-tidal_level-Mean-15_min-mAOD", label: "Bournemouth", lat: 50.714331, lon: -1.874873, cdOffsetOD: -1.40 },
  { id: "E71239", measureId: "E71239-level-tidal_level-Mean-15_min-mAOD", label: "Cromer", lat: 52.934316, lon: 1.301623, cdOffsetOD: -2.75 },
  { id: "E72039", measureId: "E72039-level-tidal_level-Mean-15_min-mAOD", label: "Weymouth", lat: 50.608501, lon: -2.447945, cdOffsetOD: -0.93 },
  { id: "E71639", measureId: "E71639-level-tidal_level-Mean-15_min-mAOD", label: "Dover", lat: 51.114372, lon: 1.322641, cdOffsetOD: -3.67 },
  { id: "E73439-anglian", measureId: "E73439-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Heysham", lat: 54.031798, lon: -2.920253, cdOffsetOD: -4.90 },
  { id: "E72439", measureId: "E72439-level-tidal_level-Mean-15_min-mAOD", label: "Ilfracombe", lat: 51.211131, lon: -4.112362, cdOffsetOD: -4.80 },
  { id: "E70939", measureId: "E70939-level-tidal_level-Mean-15_min-mAOD", label: "North Shields", lat: 55.007415, lon: -1.439769, cdOffsetOD: -2.60 },
  { id: "E73639-anglian", measureId: "E73639-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Workington", lat: 54.650691, lon: -3.56717, cdOffsetOD: -4.20 },
  { id: "E72139", measureId: "E72139-level-tidal_level-Mean-15_min-mAOD", label: "Plymouth", lat: 50.368401, lon: -4.185217, cdOffsetOD: -3.22 }, // NTSLF's own network listing names this station "Plymouth (Devonport)" — confirmed same station, not a guess
  { id: "E71739", measureId: "E71739-level-tidal_level-Mean-15_min-mAOD", label: "Newhaven", lat: 50.781775, lon: 0.057004, cdOffsetOD: -3.52 },
  { id: "E71039", measureId: "E71039-level-tidal_level-Mean-15_min-mAOD", label: "Whitby", lat: 54.489967, lon: -0.614597, cdOffsetOD: -3.00 },
  { id: "E70139-anglian", measureId: "E70139-anglian-level-tidal_level-Mean-15_min-mAOD", label: "Liverpool", lat: 53.44967, lon: -3.01815, cdOffsetOD: -4.93 },
  { id: "E72539", measureId: "E72539-level-tidal_level-Mean-15_min-mAOD", label: "Hinkley Point", lat: 51.210605, lon: -3.131326, cdOffsetOD: -5.90 },
  { id: "E71439", measureId: "E71439-level-tidal_level-Mean-15_min-mAOD", label: "Harwich", lat: 51.947978, lon: 1.292108 }, // no published NTSLF offset found
  { id: "E72239", measureId: "E72239-level-tidal_level-Mean-15_min-mAOD", label: "Newlyn", lat: 50.103007, lon: -5.542779, cdOffsetOD: -3.05 },
  { id: "E71839", measureId: "E71839-level-tidal_level-Mean-15_min-mAOD", label: "Portsmouth", lat: 50.80229, lon: -1.11119, cdOffsetOD: -2.73 },
  { id: "E71139", measureId: "E71139-level-tidal_level-Mean-15_min-mAOD", label: "Immingham", lat: 53.63018, lon: -0.18742, cdOffsetOD: -3.90 },
  { id: "E71339", measureId: "E71339-level-tidal_level-Mean-15_min-mAOD", label: "Washpile", lat: 52.875861, lon: 0.218395 }, // no published NTSLF offset found
  { id: "E72339", measureId: "E72339-level-tidal_level-Mean-15_min-m", label: "St Marys", lat: 49.91786, lon: -6.31722 }, // NTSLF value (-2.91m) is against a LOCAL OD, not confirmed to match this station's own mAOD reference — omitted rather than risk a wrong conversion
  { id: "E73939", measureId: "E73939-level-tidal_level-Mean-15_min-mAOD", label: "Portrush", lat: 55.20108, lon: -6.65123, cdOffsetOD: -1.24 },
  { id: "E70539", measureId: "E70539-level-tidal_level-Mean-15_min-mAOD", label: "Holyhead", lat: 53.31394, lon: -4.62043, cdOffsetOD: -3.05 },
  { id: "E73139", measureId: "E73139-level-tidal_level-Mean-15_min-mAOD", label: "Fishguard", lat: 52.01321, lon: -4.98371, cdOffsetOD: -2.44 },
  { id: "E70439", measureId: "E70439-level-tidal_level-Mean-15_min-mAOD", label: "Ullapool", lat: 57.89527, lon: -5.15789, cdOffsetOD: -2.75 },
  { id: "E70839", measureId: "E70839-level-tidal_level-Mean-15_min-mAOD", label: "Leith", lat: 55.98983, lon: -3.18168, cdOffsetOD: -2.90 },
  { id: "E72939", measureId: "E72939-level-tidal_level-Mean-15_min-mAOD", label: "Mumbles", lat: 51.57, lon: -3.97544, cdOffsetOD: -5.00 },
  { id: "E72839", measureId: "E72839-level-tidal_level-Mean-15_min-mAOD", label: "Newport", lat: 51.55001, lon: -2.98743, cdOffsetOD: -5.81 },
  { id: "E70739", measureId: "E70739-level-tidal_level-Mean-15_min-mAOD", label: "Aberdeen", lat: 57.14406, lon: -2.08013, cdOffsetOD: -2.25 },
  { id: "E73039", measureId: "E73039-level-tidal_level-Mean-15_min-mAOD", label: "Milford Haven", lat: 51.70738, lon: -5.05184, cdOffsetOD: -3.71 },
  { id: "E74039", measureId: "E74039-level-tidal_level-Mean-15_min-mAOD", label: "Millport", lat: 55.7498, lon: -4.90634, cdOffsetOD: -1.62 },
  { id: "E73839", measureId: "E73839-level-tidal_level-Mean-15_min-mAOD", label: "Bangor", lat: 54.66518, lon: -5.67045, cdOffsetOD: -2.01 },
  { id: "E70639", measureId: "E70639-level-tidal_level-Mean-15_min-mAOD", label: "Wick", lat: 58.44098, lon: -3.08631, cdOffsetOD: -1.71 },
  { id: "E73539", measureId: "E73539-level-tidal_level-Mean-15_min-mAOD", label: "Port Erin", lat: 54.08538, lon: -4.76807 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E70339", measureId: "E70339-level-tidal_level-Mean-15_min-mAOD", label: "Kinlochbervie", lat: 58.45673, lon: -5.05018, cdOffsetOD: -2.50 },
  { id: "E74239", measureId: "E74239-level-tidal_level-Mean-15_min-mAOD", label: "Tobermory", lat: 56.62314, lon: -6.06424, cdOffsetOD: -2.39 },
  { id: "E73739", measureId: "E73739-level-tidal_level-Mean-15_min-mAOD", label: "Portpatrick", lat: 54.84254, lon: -5.12004, cdOffsetOD: -1.80 },
  { id: "E74339", measureId: "E74339-level-tidal_level-Mean-15_min-mAOD", label: "Stornoway", lat: 58.20781, lon: -6.38897 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E70239", measureId: "E70239-level-tidal_level-Mean-15_min-mAOD", label: "Jersey", lat: 49.18333, lon: -2.11667 }, // NTSLF's St Helier value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E73239", measureId: "E73239-level-tidal_level-Mean-15_min-mAOD", label: "Barmouth", lat: 52.71931, lon: -4.04503, cdOffsetOD: -2.44 },
  { id: "E74439", measureId: "E74439-level-tidal_level-Mean-15_min-mAOD", label: "Lerwick", lat: 60.15402, lon: -1.1403 }, // NTSLF value is against a LOCAL OD — omitted, see St Marys note above
  { id: "E73339", measureId: "E73339-level-tidal_level-Mean-15_min-mAOD", label: "Llandudno", lat: 53.33164, lon: -3.82521, cdOffsetOD: -3.85 }
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

// Cached fit per station — an in-memory layer for the current page load
// (fastest, no I/O at all), backed by a persisted copy in localStorage
// so a location that's already been fitted once stays instant across
// page loads and app restarts too, not just within one session.
//
// Tides are astronomically stable — the constituents underlying a
// harmonic fit don't meaningfully drift over a week — so there's no
// need to hold up a location switch on a fresh multi-second rebuild
// just to keep the model current. TIDE_FIT_MAX_AGE_MS instead triggers
// a QUIET background refresh once a persisted fit is old enough, using
// whatever's already cached in the meantime rather than making the
// person wait for it — the same stale-while-revalidate approach the
// service worker (sw.js) already uses for the app shell.
const tideFitCache = new Map();
const tideFitRefreshing = new Set(); // stationIds with a background refresh already in flight — avoids piling up duplicate refreshes on repeat visits while one's still running
const TIDE_FIT_MAX_AGE_MS = 7 * 24 * 3600000; // a week

function tideFitStorageKey(stationId) {
  return `cloude-tide:fit:${stationId}`;
}

function loadPersistedTideFit(stationId) {
  try {
    const raw = localStorage.getItem(tideFitStorageKey(stationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePersistedTideFit(stationId, result) {
  try {
    localStorage.setItem(tideFitStorageKey(stationId), JSON.stringify({
      fit: result.fit,
      epochIso: result.epochIso,
      builtAt: Date.now()
    }));
  } catch {
    // Storage unavailable — just won't persist between visits; falls
    // back to a live rebuild each time, same as before this change.
  }
}

// Does the actual live fetch + fit — the one genuinely slow path,
// now only ever hit for a station that's never been fitted before, or
// during a quiet background refresh of a week-old one.
async function buildAndCacheTideFit(station) {
  const backfill = await backfillTideStation(station);
  if (!backfill || backfill.readings.length < MIN_FIT_READINGS) return null;
  const fit = fitTideHarmonics(backfill.readings);
  if (!fit) return null;
  const result = { fit, epochIso: backfill.epochIso };
  tideFitCache.set(station.id, result);
  savePersistedTideFit(station.id, result);
  return result;
}

function refreshTideFitInBackground(station) {
  if (tideFitRefreshing.has(station.id)) return;
  tideFitRefreshing.add(station.id);
  buildAndCacheTideFit(station)
    .catch(() => {
      // A failed background refresh just means the existing (still
      // perfectly usable) cached fit keeps being used until one succeeds.
    })
    .finally(() => tideFitRefreshing.delete(station.id));
}

async function getOrBuildTideFit(station) {
  if (tideFitCache.has(station.id)) return tideFitCache.get(station.id);

  const persisted = loadPersistedTideFit(station.id);
  if (persisted && persisted.fit && persisted.epochIso) {
    const result = { fit: persisted.fit, epochIso: persisted.epochIso };
    tideFitCache.set(station.id, result);
    if (!persisted.builtAt || Date.now() - persisted.builtAt > TIDE_FIT_MAX_AGE_MS) {
      refreshTideFitInBackground(station); // don't await — use what's cached now, improve it quietly for next time
    }
    return result;
  }

  return buildAndCacheTideFit(station); // never built before — this one genuinely has to wait
}

// ==== Admiralty Discovery API — secondary-port correction ====
//
// The 44 EA stations above are real gauges, but most saved locations
// are inevitably SOME distance from the nearest one — Teignmouth is
// ~52km from Plymouth, for example. That distance is a genuine source
// of error distinct from anything TFV can fix: TFV corrects Plymouth's
// own model against Plymouth's own gauge, so it can only ever make
// Plymouth's prediction more accurate FOR Plymouth. It has no way to
// know Teignmouth exists, let alone that its tide runs ~35-40 minutes
// and the better part of a metre different from Plymouth's.
//
// UKHO's free Discovery tier of the Admiralty Tidal API covers 607
// named UK tidal stations — standard AND secondary ports — so it very
// likely has a REAL station for wherever the nearest EA gauge is only
// an approximation for. This section: (1) finds the nearest of those
// 607 stations to a saved location, (2) pulls its real ~6-day
// high/low predictions, (3) compares them against what our own
// EA-station-based model would have predicted for the same moments,
// and (4) stores the learned time/height difference so it can be
// applied going forward — including for dates well outside that 6-day
// window, and without needing to keep calling the API.
//
// This is a genuinely different kind of correction to TFV: it's a
// fixed geographic offset between two real places, not a drifting model
// error, so it doesn't need TFV's 30-day rolling memory — a single
// ~6-day sample (roughly a dozen tidal events) should already land
// close to a stable value. It's user-triggered (see "Check against
// Admiralty" in Settings) rather than automatic, matching this app's
// existing convention for anything that spends an external API's rate
// limit (see the Compare page's "Backfill 1 year of real data" button).

const DISCOVERY_KEY_STORAGE = "cloude-tide:discoveryKey";
const DISCOVERY_PROXY_STORAGE = "cloude-tide:discoveryProxyUrl";
const DISCOVERY_STATIONS_CACHE_KEY = "cloude-tide:discoveryStations";
const DISCOVERY_STATIONS_CACHE_MAX_AGE_MS = 30 * 24 * 3600000; // 30 days — this list barely ever changes
const DISCOVERY_DIRECT_HOST = "https://admiraltyapi.azure-api.net"; // Admiralty's own docs confirm this can't be called directly from a browser — no CORS header on their side — so this is only ever used as a fallback label, not expected to actually succeed from here

function loadDiscoveryKey() {
  try {
    return localStorage.getItem(DISCOVERY_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function saveDiscoveryKey(key) {
  try {
    if (key) localStorage.setItem(DISCOVERY_KEY_STORAGE, key);
    else localStorage.removeItem(DISCOVERY_KEY_STORAGE);
  } catch {
    // Storage unavailable — key just won't persist between visits.
  }
}

function loadDiscoveryProxyUrl() {
  try {
    return (localStorage.getItem(DISCOVERY_PROXY_STORAGE) || "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function saveDiscoveryProxyUrl(url) {
  try {
    const trimmed = (url || "").replace(/\/+$/, "");
    if (trimmed) localStorage.setItem(DISCOVERY_PROXY_STORAGE, trimmed);
    else localStorage.removeItem(DISCOVERY_PROXY_STORAGE);
  } catch {
    // Storage unavailable — proxy URL just won't persist between visits.
  }
}

// The proxy forwards whatever path/query it receives straight on to
// Admiralty (see admiralty-proxy-worker.js), so the client-side path
// structure stays identical either way — only the host changes.
function discoveryApiBase() {
  const proxy = loadDiscoveryProxyUrl();
  return `${proxy || DISCOVERY_DIRECT_HOST}/uktidalapi/api/V1`;
}

// Wraps a Discovery fetch so a raw network-level failure (TypeError,
// "Load failed", "Failed to fetch" — exactly what a CORS block looks
// like from fetch()'s perspective) gets a clear, actionable message
// when there's no proxy configured yet, rather than a cryptic browser
// error with no indication of what to actually do about it.
async function fetchDiscovery(path, apiKey) {
  try {
    // cache: "no-store" — every Admiralty check genuinely needs fresh
    // data (tide predictions and the reliability of a learned
    // correction both depend on it), so this must never be served
    // from the browser's own HTTP cache even if a future response
    // ever carried cache-friendly headers.
    return await fetchWithTimeout(`${discoveryApiBase()}${path}`, {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
      cache: "no-store"
    }, 30000);
  } catch (err) {
    if (!loadDiscoveryProxyUrl()) {
      throw new Error("Couldn't reach Admiralty directly — browsers can't call their API without a small relay in between. Set a Discovery proxy URL in Settings (see admiralty-proxy-worker.js in the project files).");
    }
    throw err;
  }
}

// Fetches and caches the full 607-station list. GeoJSON: each feature's
// coordinates are [lon, lat] (GeoJSON's own convention, the opposite
// order to everywhere else in this codebase — deliberately converted
// back to {lat, lon} immediately here so nothing downstream has to
// remember which order this one source uses).
async function loadDiscoveryStations(apiKey) {
  try {
    const raw = localStorage.getItem(DISCOVERY_STATIONS_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.fetchedAt && Date.now() - cached.fetchedAt < DISCOVERY_STATIONS_CACHE_MAX_AGE_MS) {
        return cached.stations;
      }
    }
  } catch {
    // fall through to a fresh fetch
  }

  const res = await fetchDiscovery("/Stations/", apiKey);
  if (!res.ok) throw new Error(`Admiralty station list fetch failed: ${res.status}`);
  const geojson = await res.json();
  const stations = (geojson.features || [])
    .map(f => ({
      id: f.properties?.Id,
      name: f.properties?.Name,
      lat: f.geometry?.coordinates?.[1],
      lon: f.geometry?.coordinates?.[0]
    }))
    .filter(s => s.id && typeof s.lat === "number" && typeof s.lon === "number");

  try {
    localStorage.setItem(DISCOVERY_STATIONS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), stations }));
  } catch {
    // Cache write failing just means a slower re-fetch next time — not fatal.
  }
  return stations;
}

// Normalises a place name for comparison — lowercase, drop a trailing
// ", County" (resolveLocation's own labels always carry one) and any
// trailing "(qualifier)" like "(New Quay)" or "(Approaches)" — several
// real Discovery stations share one town name this way (e.g. Teignmouth
// has both "Teignmouth (New Quay)" and "Teignmouth (Approaches)") — then
// strips punctuation. Kept deliberately simple: this only needs to
// recognise "this is genuinely the same named place", not handle every
// possible spelling variant.
function normalizePlaceName(name) {
  return (name || "")
    .split(",")[0]
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Finds the real Admiralty station for a location — preferring an exact
// NAME match over raw distance. This matters because Admiralty's own
// secondary-port predictions are already correctly adjusted from
// whichever standard port each place is traditionally referenced
// against (e.g. Lyme Regis is referenced to Plymouth, not its nearer-
// by-air neighbour Weymouth, because Weymouth sits on an amphidromic
// point that makes it a poor tidal proxy despite being geographically
// closer) — so if a station literally named after the place exists in
// Discovery's 607-station list, that IS the right, already-correctly-
// adjusted answer, and picking the nearest-by-distance station instead
// would silently ignore Admiralty's own considered choice of reference.
// Nearest-by-distance is only a fallback for wherever no station bears
// the place's own name (e.g. a postcode resolving to an unnamed stretch
// of coast, or a genuinely ungauged location).
async function nearestDiscoveryStation(lat, lon, apiKey, label) {
  const stations = await loadDiscoveryStations(apiKey);

  if (label) {
    const target = normalizePlaceName(label);
    if (target.length >= 3) {
      // A town can have more than one qualified entry (Teignmouth has
      // both "(New Quay)" and "(Approaches)") — collect every match
      // rather than taking the first, and pick whichever is physically
      // closest to the location actually being added, since a plain
      // "Teignmouth" search has no way to know which qualifier the
      // person meant.
      const nameMatches = stations.filter(s => normalizePlaceName(s.name) === target);
      if (nameMatches.length) {
        let best = nameMatches[0], bestDist = haversineKm(lat, lon, best.lat, best.lon);
        nameMatches.forEach(s => {
          const d = haversineKm(lat, lon, s.lat, s.lon);
          if (d < bestDist) { bestDist = d; best = s; }
        });
        return { ...best, distanceKm: bestDist };
      }
    }
  }

  let best = null, bestDist = Infinity;
  stations.forEach(station => {
    const dist = haversineKm(lat, lon, station.lat, station.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  });
  return best ? { ...best, distanceKm: bestDist } : null;
}

// Admiralty's own FAQ is explicit: "Is British Summer Time applied to
// predictions? No. All predicted height times are shown at Greenwich
// Mean Time (GMT)" — never adjusted for BST, even in summer. Their own
// published schema never shows an explicit UTC marker on the DateTime
// string, though ("DateTime": "string" is the whole example). If their
// real response omits one too, plain Date.parse() would treat it as
// LOCAL time per the ES2015+ spec for a timezone-less ISO datetime —
// which during BST silently shifts every Admiralty event an hour
// early, systematically. This forces UTC whenever the string doesn't
// already specify its own timezone, rather than trusting that default.
function parseAdmiraltyDateTime(raw) {
  if (!raw) return NaN;
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  return Date.parse(hasTimezone ? raw : `${raw}Z`);
}

async function fetchDiscoveryEvents(stationId, apiKey, durationDays) {
  const duration = Math.max(1, Math.min(7, durationDays || 7));
  const res = await fetchDiscovery(`/Stations/${stationId}/TidalEvents?duration=${duration}`, apiKey);
  if (!res.ok) throw new Error(`Admiralty tidal events fetch failed: ${res.status}`);
  const data = await res.json();
  // Admiralty's own predictions are always Chart-Datum-referenced — no
  // conversion needed on this side.
  return data
    .filter(e => !e.Filtered && typeof e.Height === "number")
    .map(e => ({
      type: e.EventType === "HighWater" ? "high" : "low",
      time: parseAdmiraltyDateTime(e.DateTime),
      heightCD: e.Height
    }))
    .filter(e => !Number.isNaN(e.time))
    .sort((a, b) => a.time - b.time);
}

// ---- Learned secondary-port offset storage ----
// Keyed by the DISCOVERY station id (not the saved location's own id),
// mirroring how TFV is keyed by EA station id — two saved locations
// that share a nearest Discovery station share the same real-world
// geographic offset, since it's the same two physical places being
// compared either way.
function secondaryOffsetKey(discoveryStationId) {
  return `cloude-tide:secondary:${discoveryStationId}`;
}

function loadSecondaryOffset(discoveryStationId) {
  try {
    const raw = localStorage.getItem(secondaryOffsetKey(discoveryStationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSecondaryOffset(discoveryStationId, offset) {
  try {
    localStorage.setItem(secondaryOffsetKey(discoveryStationId), JSON.stringify(offset));
  } catch {
    // Storage unavailable — learned offset just won't persist between visits.
  }
}

// Runs the full learn: fetch Discovery's real events, compare each
// against our own EA-station model's nearest same-type prediction (in
// Chart Datum terms, via the EA station's own cdOffsetOD — comparing
// before that conversion would just measure the OD/CD gap between the
// two data sources, not the real geographic difference between the two
// places), and average the differences separately for highs and lows.
//
// Returns null (and stores nothing) if the EA station has no confident
// cdOffsetOD — proceeding without it would silently produce a "learned
// offset" that's actually just measuring the wrong thing.
async function learnSecondaryOffset({ eaStation, discoveryStationId, discoveryStationDistanceFromEaStationKm, apiKey, fit, epochIso }) {
  if (typeof eaStation.cdOffsetOD !== "number") {
    throw new Error("This location's nearest EA station has no confirmed Chart Datum offset yet, so a learned correction against it wouldn't be trustworthy.");
  }

  const discoveryEvents = await fetchDiscoveryEvents(discoveryStationId, apiKey, 7);
  if (discoveryEvents.length < 4) {
    throw new Error("Admiralty didn't return enough tidal events to learn from — try again later.");
  }

  const fudge = loadTideFudge(eaStation.id);
  const windowStartHours = (discoveryEvents[0].time - Date.parse(epochIso)) / 3600000 - 12;
  const windowEndHours = (discoveryEvents[discoveryEvents.length - 1].time - Date.parse(epochIso)) / 3600000 + 12;
  const modelEvents = findTideExtremes(fit, windowStartHours, windowEndHours).map(e => ({
    type: e.type,
    time: Date.parse(epochIso) + e.hours * 3600000,
    // OD (mAOD-consistent, since the model was fit to EA's own mAOD
    // readings) → Chart Datum, so this is comparable to Discovery's
    // own CD-referenced heights.
    heightCD: applyTideFudge(e.level, fudge) - eaStation.cdOffsetOD
  }));

  const diffsByType = { high: { time: [], discoveryHeight: [], modelHeight: [] }, low: { time: [], discoveryHeight: [], modelHeight: [] } };
  discoveryEvents.forEach(dEvent => {
    let nearest = null, nearestGap = Infinity;
    modelEvents.forEach(mEvent => {
      if (mEvent.type !== dEvent.type) return;
      const gap = Math.abs(mEvent.time - dEvent.time);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = mEvent;
      }
    });
    // A match more than 4 hours off is almost certainly the wrong cycle
    // (e.g. comparing against a neighbouring day's event rather than
    // the corresponding one) — skip rather than pollute the average.
    // Also requires nearest.heightCD to be a real, meaningfully positive
    // Chart Datum height (not near zero) before dividing by it — Chart
    // Datum heights are heights above LAT, so this should almost always
    // hold for a genuine tidal extreme; skip rather than risk an
    // unstable ratio if it doesn't.
    if (nearest && nearestGap <= 4 * 3600000 && nearest.heightCD > 0.15) {
      diffsByType[dEvent.type].time.push((dEvent.time - nearest.time) / 60000); // minutes
      diffsByType[dEvent.type].discoveryHeight.push(dEvent.heightCD);
      diffsByType[dEvent.type].modelHeight.push(nearest.heightCD);
    }
  });

  // Standard deviation of an array — used below to see how much the
  // individual per-event samples disagree with each other, not just
  // their average. With typically only 6-14 samples in a week this is
  // a noisy estimate, not a precise figure — treated as a rough flag
  // in the UI, never as a confident diagnosis.
  const stdDev = arr => {
    if (arr.length < 2) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  };

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  // Fits real = a + b*model (ordinary least squares) rather than a pure
  // ratio (real = b*model, forced through zero). A pure ratio was found
  // to badly misrepresent a genuine ADDITIVE height bias — the kind
  // that shows up as roughly the same real-world error in metres at
  // both high and low tide — because dividing that same fixed error by
  // a much smaller low-tide height inflates the ratio far more than it
  // does at high tide. That exact fingerprint (a much bigger "% correction"
  // on low tide than high tide, with individual samples agreeing closely
  // with each other) is what a same-place self-check against Weymouth
  // showed: not noise, not a real amplitude difference, but a fixed
  // metres-level offset being forced through the wrong kind of model.
  // The general linear fit resolves correctly either way without having
  // to know in advance which kind of mismatch a location has: a=0,b≈1
  // for a well-matched station; a large b with small a for a genuine
  // amplitude difference (Lyme Regis vs Weymouth); a small b-deviation
  // with a real nonzero a for a same-place additive bias (this case).
  const linearFit = (modelArr, realArr) => {
    const n = modelArr.length;
    if (n < 2) return null;
    const meanModel = mean(modelArr), meanReal = mean(realArr);
    let cov = 0, varModel = 0;
    for (let i = 0; i < n; i++) {
      const dm = modelArr[i] - meanModel;
      cov += dm * (realArr[i] - meanReal);
      varModel += dm * dm;
    }
    // No spread in the model's own heights to fit a slope against
    // (can happen with very few samples) — fall back to a pure
    // additive shift rather than an undefined/unstable slope.
    if (varModel === 0) return { intercept: meanReal - meanModel, slope: 1 };
    const slope = cov / varModel;
    const intercept = meanReal - slope * meanModel;
    return { intercept, slope };
  };

  const residualStdDev = (modelArr, realArr, fit) => {
    if (!fit) return null;
    const residuals = modelArr.map((m, i) => realArr[i] - (fit.intercept + fit.slope * m));
    return stdDev(residuals);
  };

  const highFit = linearFit(diffsByType.high.modelHeight, diffsByType.high.discoveryHeight);
  const lowFit = linearFit(diffsByType.low.modelHeight, diffsByType.low.discoveryHeight);

  const offset = {
    highTimeMin: mean(diffsByType.high.time),
    highHeightIntercept: highFit ? highFit.intercept : null,
    highHeightSlope: highFit ? highFit.slope : null,
    highHeightResidualSpread: residualStdDev(diffsByType.high.modelHeight, diffsByType.high.discoveryHeight, highFit),
    highTimeSpread: stdDev(diffsByType.high.time),
    lowTimeMin: mean(diffsByType.low.time),
    lowHeightIntercept: lowFit ? lowFit.intercept : null,
    lowHeightSlope: lowFit ? lowFit.slope : null,
    lowHeightResidualSpread: residualStdDev(diffsByType.low.modelHeight, diffsByType.low.discoveryHeight, lowFit),
    lowTimeSpread: stdDev(diffsByType.low.time),
    sampleCount: diffsByType.high.time.length + diffsByType.low.time.length,
    learnedAt: new Date().toISOString(),
    // How far the matched Admiralty station is from the EA gauge itself
    // (not from the saved location — a different distance). When this is
    // small, the two are essentially the same physical place, so a large
    // correction here would mean the model disagrees with real data about
    // the SAME location — a red flag in its own right, not a genuine
    // geographic correction (see the reliability check below).
    eaToDiscoveryDistanceKm: typeof discoveryStationDistanceFromEaStationKm === "number" ? discoveryStationDistanceFromEaStationKm : null
  };
  if (!highFit && !lowFit) {
    // linearFit needs at least 2 matched same-type events to produce a
    // real slope+intercept — this is a DIFFERENT condition from "zero
    // events matched at all" (which the old check here tested for).
    // With exactly one matched high event and one matched low event,
    // the old check passed silently, then saved an offset with null
    // height fields anyway — indistinguishable from a genuinely stale
    // pre-fix offset, which is exactly the confusing "stored correction
    // is outdated" message a location kept showing no matter how many
    // times it was rechecked. Catching it here, before anything is
    // saved, means a real cause (the two places' tide timings not
    // lining up well enough within the 4-hour matching window — quite
    // possible for an open coastal bay checked against an estuary
    // gauge) gets its own honest message instead.
    throw new Error("Admiralty's predictions and this location's own model only lined up closely enough to compare on 1 or fewer high and low events each this week — too few to learn a reliable height correction from. This can happen when the matched places have a genuinely different tidal timing (e.g. an open bay vs a sheltered estuary) — try again in a few days once more events are available, or check a more local named station if one exists nearby.");
  }

  saveSecondaryOffset(discoveryStationId, offset);
  return offset;
}

// Rough, best-effort read on whether a location's learned correction
// looks trustworthy — three checks, none of them a confident diagnosis
// on their own, but together a useful flag for "look more closely here":
//
// 1. Plain distance from the nearest EA gauge — the further away, the
//    more this location depends on the correction actually being good,
//    since the uncorrected model itself is weaker here than usual.
// 2. The SIZE of the learned ratio — a ratio far from 1.0 means a real
//    amplitude mismatch (Weymouth vs Lyme Regis is the known example).
//    This is exactly what the ratio correction is FOR, so a big ratio
//    isn't itself a problem — just worth knowing how much correcting
//    is happening.
// 3. The CONSISTENCY of the individual samples — this is the one that
//    can catch a genuine SHAPE mismatch (Southampton's double high
//    water is the known example), which no single ratio or time shift
//    can properly fix. If the real per-event samples disagree with each
//    other by a lot, no single number was ever going to describe this
//    location well, and that disagreement is the tell — no need to
//    already know it's a "Southampton-style" case in advance.
// Rough, best-effort read on whether a location's learned correction
// looks trustworthy — checks, none a confident diagnosis on their own,
// but together a useful flag for "look more closely here":
//
// 1. Plain distance from the nearest EA gauge — the further away, the
//    more this location depends on the correction actually being good,
//    since the uncorrected model itself is weaker here than usual.
// 2. Same-place sanity check — if the matched Admiralty station is
//    essentially the same physical place as the EA gauge, BOTH the
//    slope should sit close to 1 AND the intercept close to 0; either
//    one being off means the comparison itself is untrustworthy, not a
//    genuine correction.
// 3. The SIZE of the learned slope — a slope far from 1.0 means a real
//    amplitude mismatch (Weymouth vs Lyme Regis is the known example).
//    This is exactly what the correction is FOR, so a big slope isn't
//    itself a problem — just worth knowing how much correcting is
//    happening.
// 4. The CONSISTENCY of the individual samples around the fitted line
//    (the residual spread) — this is the one that can catch a genuine
//    SHAPE mismatch (Southampton's double high water is the known
//    example), which no single slope+intercept pair can properly fix.
//    If real samples scatter widely around the fitted line relative to
//    the tide's own typical size, no simple correction was ever going
//    to describe this location well, and that scatter is the tell — no
//    need to already know it's a "Southampton-style" case in advance.
function assessSecondaryOffsetReliability(eaStation, offset) {
  const notes = [];

  const SAME_PLACE_KM = 5;
  const SAME_PLACE_MAX_SLOPE_DEVIATION = 0.15;
  const SAME_PLACE_MAX_INTERCEPT_M = 0.3;
  const isSamePlace = typeof offset.eaToDiscoveryDistanceKm === "number" && offset.eaToDiscoveryDistanceKm <= SAME_PLACE_KM;

  if (isSamePlace) {
    [["high", offset.highHeightSlope, offset.highHeightIntercept], ["low", offset.lowHeightSlope, offset.lowHeightIntercept]].forEach(([type, slope, intercept]) => {
      const slopeOff = typeof slope === "number" && Math.abs(slope - 1) > SAME_PLACE_MAX_SLOPE_DEVIATION;
      const interceptOff = typeof intercept === "number" && Math.abs(intercept) > SAME_PLACE_MAX_INTERCEPT_M;
      if (slopeOff || interceptOff) {
        const parts = [];
        if (slopeOff) parts.push(`a scaling factor of ×${slope.toFixed(2)}`);
        if (interceptOff) parts.push(`a fixed shift of ${intercept >= 0 ? "+" : ""}${intercept.toFixed(2)}m`);
        notes.push(`⚠ This correction looks unreliable: the Admiralty station used is only ${offset.eaToDiscoveryDistanceKm.toFixed(1)}km from the gauge itself, essentially the same physical place, yet the learned ${type}-tide correction includes ${parts.join(" and ")} — a real same-place comparison should need almost neither. Treat this correction with real caution until it's been rechecked.`);
      }
    });
  }

  if (eaStation.distanceKm > 40) {
    notes.push(`This location's nearest gauge is ${eaStation.distanceKm.toFixed(0)}km away — further than usual, so this correction matters more here than most.`);
  }

  if (!isSamePlace) {
    [["high", offset.highHeightSlope], ["low", offset.lowHeightSlope]].forEach(([type, slope]) => {
      if (typeof slope === "number" && Math.abs(slope - 1) > 0.2) {
        const pct = Math.round((slope - 1) * 100);
        notes.push(`A substantial ${type} correction (scaling by ${pct >= 0 ? "+" : ""}${pct}%) has been applied — this location's tide differs considerably in size from its nearest gauge.`);
      }
    });
  }

  [["high", offset.highHeightResidualSpread], ["low", offset.lowHeightResidualSpread]].forEach(([type, spread]) => {
    // Residual spread relative to a typical tidal range (2m — a rough
    // but reasonable UK-wide yardstick) rather than relative to the
    // slope/ratio itself, since a residual is already in metres and
    // comparing it to a near-zero ratio would be meaningless.
    if (typeof spread === "number" && spread > 0.3) {
      notes.push(`The ${type}-tide samples used to learn this correction scattered more than usual around the fitted line (±${spread.toFixed(2)}m) — possibly a sign this location's tide has a genuinely different SHAPE from its nearest gauge (like a double high or low water), which a single correction can't fully fix. Worth treating ${type} predictions here with extra caution.`);
    }
  });

  return notes;
}

// Applies a learned secondary-port offset to a single hours/OD-level
// pair, returning a Chart-Datum-referenced result. Blends between the
// high-tide offset and the low-tide offset by how far through the
// current half-cycle the given hour sits, rather than snapping straight
// from one to the other at each event — real secondary-port tide tables
// interpolate between reference points the same way, so a smooth blend
// is the standard approach here, not a simplification of it.
//
// Returns null if there's no usable offset, or if eaStation has no
// confirmed cdOffsetOD (the learned offset is itself CD-referenced,
// since that's what Admiralty's own data uses — applying it to an
// unconverted OD level would silently mix two different height
// references, which is exactly the mismatch this function exists to
// avoid rather than reproduce).
function applySecondaryOffset(fit, hours, odLevel, eaStation, offset) {
  if (!offset || typeof eaStation.cdOffsetOD !== "number") return null;
  const nearbyEvents = findTideExtremes(fit, hours - 8, hours + 8);
  if (nearbyEvents.length < 2) return null;

  let before = null, after = null;
  for (const e of nearbyEvents) {
    if (e.hours <= hours) before = e;
    if (e.hours > hours && !after) after = e;
  }
  if (!before || !after) return null;

  const offsetFor = type => ({
    timeMin: type === "high" ? offset.highTimeMin : offset.lowTimeMin,
    slope: type === "high" ? offset.highHeightSlope : offset.lowHeightSlope,
    intercept: type === "high" ? offset.highHeightIntercept : offset.lowHeightIntercept
  });
  const beforeOffset = offsetFor(before.type);
  const afterOffset = offsetFor(after.type);
  if (beforeOffset.timeMin === null || afterOffset.timeMin === null) return null;
  if (typeof beforeOffset.slope !== "number" || typeof afterOffset.slope !== "number") return null;
  if (typeof beforeOffset.intercept !== "number" || typeof afterOffset.intercept !== "number") return null;

  const span = after.hours - before.hours;
  const frac = span > 0 ? (hours - before.hours) / span : 0;
  const timeMin = beforeOffset.timeMin + (afterOffset.timeMin - beforeOffset.timeMin) * frac;
  const slope = beforeOffset.slope + (afterOffset.slope - beforeOffset.slope) * frac;
  const intercept = beforeOffset.intercept + (afterOffset.intercept - beforeOffset.intercept) * frac;

  // A full linear correction (slope AND intercept), not a pure ratio —
  // the slope stretches a suppressed-range station's curve toward a
  // genuinely different-amplitude location (Lyme Regis vs Weymouth);
  // the intercept absorbs a fixed, same-size-at-every-tide-height
  // discrepancy that a pure ratio would otherwise distort — inflating
  // it far more at low tide than high tide, which is exactly the bug
  // a same-place self-check exposed (see learnSecondaryOffset).
  const levelCD = (odLevel - eaStation.cdOffsetOD) * slope + intercept;
  return { hours: hours + timeMin / 60, levelCD };
}
