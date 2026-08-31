const CONFIG = {
  forecasters: [
    { id: "metoffice", name: "Met Office", enabled: true, offset: 0 },
    { id: "ecmwf", name: "ECMWF", enabled: true, offset: 0.2 },
    { id: "gfs", name: "GFS (US)", enabled: true, offset: 0.3 },
    { id: "icon", name: "ICON (Germany)", enabled: true, offset: -0.2 },
    { id: "gem", name: "GEM (Canada)", enabled: true, offset: 0.5 },
    { id: "meteofrance", name: "Météo-France", enabled: true, offset: -0.4 },
    { id: "jma", name: "JMA (Japan)", enabled: true, offset: 0.15 },
    { id: "bom", name: "BOM (Australia)", enabled: true, offset: -0.3 },
    { id: "cma", name: "CMA (China)", enabled: true, offset: 0.45 },
    { id: "bbc", name: "BBC", enabled: true, offset: 0.6 },
    { id: "meteo", name: "Meteoblue", enabled: true, offset: -0.5 },
    { id: "yr", name: "YR", enabled: true, offset: 0.9 },
    { id: "accuweather", name: "AccuWeather", enabled: true, offset: -0.8 },
    { id: "netweather", name: "Netweather", enabled: false, offset: 0.4 },
    { id: "xcweather", name: "XCWeather", enabled: false, offset: -1.1 },
    { id: "wunderground", name: "Weather Underground", enabled: false, offset: 1.2 },
    { id: "weatherapi", name: "WeatherAPI", enabled: false, offset: -0.3 },
    { id: "windy", name: "Windy", enabled: false, offset: 0.7 },
    { id: "openweather", name: "OpenWeatherMap", enabled: false, offset: -0.6 },
    { id: "tomorrow", name: "Tomorrow.io", enabled: false, offset: 1.0 }
  ],
  conditions: {
    rain: { name: "Rain", unit: "mm" },
    cloud: { name: "Cloud", unit: "%" },
    wind: { name: "Wind", unit: "mph" },
    temperature: { name: "Temperature", unit: "°C" },
    pressure: { name: "Pressure", unit: "hPa" },
    sunshine: { name: "Sunshine", unit: "hrs" },
    uv: { name: "UV", unit: "index" },
    soilTemperature: { name: "Soil Temp", unit: "°C" },
    dewPoint: { name: "Dew Point", unit: "°C" },
    tide: { name: "Tide", unit: "m" }
  }
};

// ---- Colour themes ----
// Applies to every page via the same four CSS variables (--accent,
// --accent-dark, --accent-light, --headline-bg) each theme overrides in
// style.css — see the comment there for how the colours themselves were
// picked. This function is also called directly from Settings for an
// immediate live preview when a swatch is tapped, not just on page load.
// The actual anti-flash application happens via a small inline script in
// each HTML file's <head> (duplicated per page, since this is a plain
// multi-page site with no shared <head>) — this call here just keeps
// state consistent on every page load and is what Settings reuses.
const THEME_KEY = "forecast-compare:theme";
const THEMES = [
  { id: "mint", name: "Mint" },
  { id: "gold", name: "Gold" },
  { id: "sand", name: "Sand" },
  { id: "red", name: "Red" },
  { id: "blue", name: "Blue" },
  { id: "teal", name: "Teal" },
  { id: "olive", name: "Olive" }
];

function loadTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw && THEMES.some(t => t.id === raw)) return raw;
  } catch {
    // fall through to default
  }
  return "mint";
}

function saveTheme(themeId) {
  try {
    localStorage.setItem(THEME_KEY, themeId);
  } catch {
    // Storage unavailable — choice just won't persist between visits.
  }
}

function applyTheme(themeId) {
  // Mint is :root's own untouched default (see style.css) — removing the
  // attribute for it rather than setting data-theme="mint" means the
  // most common case matches the fewest selectors, and also cleanly
  // undoes a previous non-Mint choice.
  if (themeId === "mint") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = themeId;
  }
  // Keeps the browser's own chrome (address bar / status bar tint) in
  // step with whatever's on screen — manifest.json's theme_color only
  // ever applies at install time, so without this an installed icon's
  // splash colour could drift from whatever theme is actually active.
  const themeColorEl = document.querySelector('meta[name="theme-color"]');
  if (themeColorEl) {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    if (accent) themeColorEl.setAttribute("content", accent);
  }
}

applyTheme(loadTheme());

// ---- Backup: export / import ----
// Everything this app stores — FFV history, eligibility, saved places,
// the theme choice, all of it — lives only in this browser's localStorage
// on this one device. Clearing Safari's site data, or moving to a new
// phone, silently loses all of it with no warning. This is a plain
// key/value dump of every "forecast-compare:" prefixed key rather than a
// hand-maintained list of specific keys — new features that add their
// own storage key (like accuracy-trend above did) are included
// automatically without this needing to be updated to know about them.
const BACKUP_KEY_PREFIX = "forecast-compare:";

function exportAppData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(BACKUP_KEY_PREFIX)) {
      data[key] = localStorage.getItem(key);
    }
  }
  return JSON.stringify({ app: "Cloude", exportedAt: new Date().toISOString(), data }, null, 2);
}

// Returns { ok: true, keyCount } on success, or { ok: false, error } on
// failure — never throws, so the caller can show a plain message either
// way rather than needing its own try/catch around this.
function importAppData(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "That doesn't look like valid backup text — check it was copied in full." };
  }
  if (!parsed || typeof parsed.data !== "object" || parsed.data === null) {
    return { ok: false, error: "That text isn't a Cloude backup (missing expected data)." };
  }

  const entries = Object.entries(parsed.data).filter(([key]) => key.startsWith(BACKUP_KEY_PREFIX));
  if (!entries.length) {
    return { ok: false, error: "That backup doesn't contain any Cloude data to restore." };
  }

  try {
    entries.forEach(([key, value]) => localStorage.setItem(key, value));
  } catch {
    return { ok: false, error: "Storage is unavailable right now — nothing was restored." };
  }
  return { ok: true, keyCount: entries.length };
}

// Everything is stored and computed internally in these native units —
// rain in mm, wind in mph, temperature in °C, pressure in hPa — regardless
// of the display choice below. Only formatValue() and unit labels convert
// for display; FFV, accuracy, and all other math always operate on native
// values, so the display choice can never skew the numbers themselves,
// only how they're shown.
//
// Units are chosen PER CONDITION rather than one global Metric/Imperial
// toggle — someone can genuinely want mm for Rain, °C for Temperature, and
// mph for Wind all at once, which a single switch could never express.
// CONDITION_UNIT_TOGGLES lists which conditions actually have a choice
// (Cloud/Sunshine/UV are unitless/universal either way, so they're left
// out rather than offering a toggle that does nothing).
const CONDITION_UNITS_KEY = "forecast-compare:conditionUnits";
const CONDITION_UNIT_TOGGLES = ["rain", "temperature", "wind", "pressure"];
const DEFAULT_CONDITION_UNITS = {
  rain: "metric", // mm
  temperature: "metric", // °C
  wind: "imperial", // mph
  pressure: "metric" // hPa
  // soilTemperature and dewPoint deliberately not listed — see
  // conditionUnit(), which redirects them to Temperature's own setting.
};
const CONDITION_UNIT_LABELS = {
  rain: { metric: "mm", imperial: "in" },
  cloud: { metric: "%", imperial: "%" },
  wind: { metric: "km/h", imperial: "mph" },
  temperature: { metric: "°C", imperial: "°F" },
  pressure: { metric: "hPa", imperial: "inHg" },
  sunshine: { metric: "hrs", imperial: "hrs" },
  uv: { metric: "index", imperial: "index" },
  soilTemperature: { metric: "°C", imperial: "°F" },
  dewPoint: { metric: "°C", imperial: "°F" }
};

function loadConditionUnits() {
  let stored = {};
  try {
    const raw = localStorage.getItem(CONDITION_UNITS_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_CONDITION_UNITS, ...stored };
}

function saveConditionUnit(conditionName, system) {
  const units = loadConditionUnits();
  units[conditionName] = system;
  try {
    localStorage.setItem(CONDITION_UNITS_KEY, JSON.stringify(units));
  } catch {
    // Storage unavailable — choice just won't persist between visits.
  }
  state.conditionUnits = units;
}

// The unit system ("metric" | "imperial") in effect for one condition —
// conditions without a toggle (Cloud, Sunshine, UV) always read as metric,
// which is harmless since their labels are identical either way.
function conditionUnit(conditionName) {
  // Soil Temp and Dew Point are both °C-scale like Temperature and don't
  // get their own choice in Settings — asking twice for the same
  // metric/imperial decision would just be clutter, so they follow
  // whatever Temperature is already set to.
  const key = (conditionName === "soilTemperature" || conditionName === "dewPoint") ? "temperature" : conditionName;
  return state.conditionUnits[key] ?? "metric";
}

function unitLabel(conditionName) {
  return CONDITION_UNIT_LABELS[conditionName]?.[conditionUnit(conditionName)] ?? CONFIG.conditions[conditionName].unit;
}

// Converts a native-unit value (mm / mph / °C / hPa) to whichever system
// this condition's own toggle is set to. isDelta matters only for
// temperature: a DIFFERENCE (badge deltas, accuracy error magnitudes)
// scales by 9/5 with no +32 offset — converting a 2°C gap should give a
// 3.6°F gap, not 2×9/5+32.
function convertForDisplay(value, conditionName, isDelta = false) {
  if (value === null || value === undefined) return value;
  const system = conditionUnit(conditionName);
  if (system === "imperial") {
    if (conditionName === "rain") return value / 25.4; // mm -> in
    if (conditionName === "temperature" || conditionName === "soilTemperature" || conditionName === "dewPoint") {
      return isDelta ? value * 9 / 5 : value * 9 / 5 + 32; // °C -> °F
    }
    if (conditionName === "pressure") return value / 33.8639; // hPa -> inHg
    return value; // wind is already mph natively
  }
  // metric
  if (conditionName === "wind") return value * 1.60934; // mph -> km/h
  return value; // rain (mm), temperature/soilTemperature/dewPoint (°C) and pressure (hPa) are already metric natively
}

// ---- Actual weather (Open-Meteo, no API key) ----
// Geocoding: api.postcodes.io (UK postcodes -> lat/lon), or Open-Meteo's
// own free geocoding search for a plain place name — see resolveLocation.
// Weather: api.open-meteo.com/v1/forecast with past_days to pull recent
// recorded days alongside today. No key required for either.
const GEOCODE_URL = "https://api.postcodes.io/outcodes/";
const PLACE_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const MAX_ROLLBACK = 7; // days into the past the slider (and Actual) can reach
const MAX_FUTURE = 7; // days into the future the slider (and Met Office's live forecast) can reach

// Real data (Open-Meteo's Previous Runs API) only covers these four
// conditions for any source — Sunshine and UV aren't in that dataset, so
// real sources fall back to the demo formula for those two.
const REAL_DATA_CONDITIONS = new Set(["rain", "cloud", "wind", "temperature", "pressure", "soilTemperature", "dewPoint"]);

// Every source with genuine data behind it. Adding another real source
// later is just another entry here — everything downstream (fetching,
// FFV, accuracy, the headline) already loops over this rather than
// naming a specific source.
const REAL_SOURCES = [
  // The pure global 10km model (rather than the seamless UKV+global
  // blend) so every lead-time offset 1-7 is available on equal footing —
  // UKV 2km only forecasts 2 days out, which would make longer lead
  // times inconsistent.
  { id: "metoffice", model: "ukmo_global_deterministic_10km" },
  { id: "ecmwf", model: "ecmwf_ifs025" },
  // Seven more independent national models — genuinely different
  // physics/data-assimilation per source, which is what actually
  // improves an ensemble median (blending more demo/synthetic sources
  // can't do this, since they're not independent observations of
  // anything real).
  { id: "gfs", model: "gfs_seamless" },        // NOAA (US)
  { id: "icon", model: "icon_seamless" },      // DWD (Germany)
  { id: "gem", model: "gem_seamless" },        // Environment Canada
  { id: "meteofrance", model: "meteofrance_seamless" },
  // Three more, chosen for genuinely different geography/assimilation
  // rather than just adding numbers — East Asia, Southern Hemisphere,
  // and China had no representation at all before these. Confirmed
  // against Open-Meteo's own current model list rather than assumed,
  // since a wrong model string here would silently fall back to demo
  // data with no obvious error.
  { id: "jma", model: "jma_seamless" },        // Japan Meteorological Agency
  { id: "bom", model: "bom_access_global" },   // Australian Bureau of Meteorology
  { id: "cma", model: "cma_grapes_global" }    // China Meteorological Administration
];
function realSourceIds() {
  return REAL_SOURCES.map(s => s.id);
}

// Forecaster selection now lives on its own page (settings.html) so it
// isn't cluttering the day-to-day view. Both pages read/write this same
// localStorage key to stay in sync.
const SELECTED_FORECASTERS_KEY = "forecast-compare:selectedForecasters";
const ACCURACY_MODE_KEY = "forecast-compare:accuracyMode";

function loadAccuracyMode() {
  try {
    const raw = localStorage.getItem(ACCURACY_MODE_KEY);
    if (raw === "units" || raw === "percent" || raw === "both") return raw;
  } catch {
    // fall through to default
  }
  return "both";
}

// Current postcode and a short list of saved "places" (e.g. home,
// allotment) are shared across all three pages via localStorage, so
// switching between them doesn't need retyping and reuses whatever FFV
// history that area has already built up rather than looking like a
// brand new location every time.
const CURRENT_POSTCODE_KEY = "forecast-compare:currentPostcode";
const PLACES_KEY = "forecast-compare:places";

function loadCurrentPostcode() {
  try {
    const raw = localStorage.getItem(CURRENT_POSTCODE_KEY);
    if (raw) return raw;
  } catch {
    // fall through to default
  }
  return "TA6";
}

function saveCurrentPostcode(pc) {
  try {
    localStorage.setItem(CURRENT_POSTCODE_KEY, pc);
  } catch {
    // Storage unavailable — current postcode just won't persist.
  }
}

function loadPlaces() {
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate the old format (a saved place used to be just a plain
      // postcode string) transparently — now it's {postcode, label} so
      // it can be renamed to something memorable (Home, Work, the
      // allotment, etc). savePlaces always writes the new shape, so
      // this only ever needs to convert once, on the first read after
      // an update.
      return parsed.map(entry =>
        typeof entry === "string" ? { postcode: entry, label: entry } : entry
      );
    }
  } catch {
    // fall through to default
  }
  return [];
}

function savePlaces(places) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
  } catch {
    // Storage unavailable — saved places just won't persist.
  }
}

function loadSelectedForecasters() {
  try {
    const raw = localStorage.getItem(SELECTED_FORECASTERS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // fall through to default
  }
  return new Set(CONFIG.forecasters.filter(f => f.enabled).map(f => f.id));
}

function emptyLeadDayData() {
  const byLeadDay = {};
  for (let d = 1; d <= 7; d++) {
    byLeadDay[d] = { tempMax: [], tempMin: [], tempAvg: [], precip: [], wind: [], windGust: [], windDirection: [], cloud: [], pressure: [], soilTemp: [], dewPoint: [] };
  }
  return byLeadDay;
}

function emptyRealSourcesState() {
  const bySource = {};
  REAL_SOURCES.forEach(({ id }) => {
    bySource[id] = {
      status: "idle", // idle | loading | ready | error
      error: null,
      dates: [],
      byLeadDay: emptyLeadDayData()
    };
  });
  return bySource;
}

const state = {
  condition: "rain",
  rollback: 0,
  postcode: loadCurrentPostcode(),
  selected: loadSelectedForecasters(),
  conditionUnits: loadConditionUnits(),
  areaCode: "",
  lat: null,
  lon: null,
  actual: {
    status: "idle", // idle | loading | ready | error
    error: null,
    coordLabel: "",
    // Parallel arrays, oldest first, length 7: today-6 ... today
    dates: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_sum: [],
    windspeed_10m_max: [],
    windgusts_10m_max: [],
    sunshine_duration: [],
    uv_index_max: [],
    cloud_mean: [],
    pressure_mean: [],
    soilTemp_mean: [],
    dewPoint_mean: [],
    // Raw hourly pressure (not day-aggregated) covering the past window
    // through "now" — kept only to compute the pressure trend arrow
    // (see pressureTrend()), which needs a real few-hours-ago comparison
    // point that a daily mean can't give.
    pressure_hourly_times: [],
    pressure_hourly_values: []
  },
  realSources: emptyRealSourcesState(),
  backfill: {
    status: "idle", // idle | loading | done | error
    error: null,
    samplesAdded: 0
  },
  history: {
    status: "idle", // idle | loading | ready | error
    error: null,
    dayCount: 0,
    areaMismatch: false // true when the collected file exists but is for a different postcode area
  },
  hourly: {
    status: "idle", // idle | loading | ready | error
    error: null,
    times: [], // ISO datetime strings, aligned across all arrays below
    temperature: [],
    precipitation: [],
    windSpeed: [],
    windGust: [],
    windDirection: [],
    pressure: [],
    soilTemperature: [],
    dewPoint: [],
    uvIndex: [],
    cloudCover: [],
    sunriseByDate: {}, // "YYYY-MM-DD" -> ISO datetime
    sunsetByDate: {},
    uvMaxByDate: {} // "YYYY-MM-DD" -> that day's peak UV index
  },
  hourIndex: 0, // 0 = now; the hour slider's current position
  hourlyActive: false, // true while the hour slider is showing a specific hour rather than "Now"
  whatIf: null // Set of source ids for the Compare page's what-if merge; null until first initialised for the current condition
};

const postcode = document.getElementById("postcode");
const condition = document.getElementById("condition");
const rollback = document.getElementById("rollback");
const rollbackLabel = document.getElementById("rollbackLabel");
const table = document.getElementById("forecastTable");
const conditionTitle = document.getElementById("conditionTitle");
const locationLabel = document.getElementById("locationLabel");
const actualLine = document.getElementById("actualLine");
const actualStatus = document.getElementById("actualStatus");
const realSourceStatus = document.getElementById("metOfficeStatus");
const backfillButton = document.getElementById("backfillButton");
const backfillStatus = document.getElementById("backfillStatus");
const accuracyMode = document.getElementById("accuracyMode");
const accuracyBody = document.getElementById("accuracyBody");
const historyStatus = document.getElementById("historyStatus");
const headlineGrid = document.getElementById("headlineGrid");
const headlineDate = document.getElementById("headlineDate");
const headlineStatus = document.getElementById("headlineStatus");
const headlineStatusBlock = document.getElementById("headlineStatusBlock");
const headlineRetry = document.getElementById("headlineRetry");
const hourSlider = document.getElementById("hourSlider");
const hourLabel = document.getElementById("hourLabel");
const sheetBackdrop = document.getElementById("sheetBackdrop");
const sheet = document.getElementById("sheet");
const sheetClose = document.getElementById("sheetClose");
const sheetTitle = document.getElementById("sheetTitle");
const sheetRange = document.getElementById("sheetRange");
const sheetReadout = document.getElementById("sheetReadout");
const readoutTime = document.getElementById("readoutTime");
const readoutValue = document.getElementById("readoutValue");
const sheetBody = document.getElementById("sheetBody");
const sheetFootnote = document.getElementById("sheetFootnote");
const placeChip = document.getElementById("placeChip");
const placeChipLabel = document.getElementById("placeChipLabel");
const placeMenu = document.getElementById("placeMenu");
const placeMenuList = document.getElementById("placeMenuList");
const placesList = document.getElementById("placesList");
const addCurrentPlaceButton = document.getElementById("addCurrentPlace");
const useMyLocationButton = document.getElementById("useMyLocation");
const geoStatus = document.getElementById("geoStatus");
const whatIfChecks = document.getElementById("whatIfSources");
const whatIfResult = document.getElementById("whatIfResult");

if (postcode) postcode.value = state.postcode;

const HOUR_RANGE_KEY = "forecast-compare:hourRange";
function loadHourRange() {
  try {
    const raw = localStorage.getItem(HOUR_RANGE_KEY);
    if (raw === "24" || raw === "48") return Number(raw);
  } catch {
    // fall through to default
  }
  return 48;
}

function demoValue(day, source, conditionName) {
  const sourceOffset = source.offset ?? 0;
  // Lead-time trend: day 7 = furthest-out forecast for the target date,
  // day 1 = forecast issued the day before the target date.
  const leadTrend = (7 - day) * -0.12;

  let value;

  switch (conditionName) {
    case "rain":
      value = Math.max(0, 1.5 + day * 0.55 + sourceOffset + leadTrend);
      break;
    case "cloud":
      value = Math.min(100, Math.max(0, 48 + day * 3.2 + sourceOffset * 5));
      break;
    case "wind":
      value = Math.max(0, 7 + day * 0.75 + sourceOffset);
      break;
    case "temperature":
      value = 17.5 - day * 0.3 + sourceOffset * 0.4;
      break;
    case "pressure":
      value = 1013 - day * 0.3 + sourceOffset * 2;
      break;
    case "soilTemperature":
      // Soil lags and smooths air temperature — less day-to-day swing,
      // rarely near the same extremes.
      value = 12 - day * 0.15 + sourceOffset * 0.25;
      break;
    case "dewPoint":
      // Dew point is always at or below air temperature — this demo
      // formula mirrors Temperature's shape with a fixed gap under it.
      value = 17.5 - day * 0.3 + sourceOffset * 0.4 - 4;
      break;
    case "sunshine":
      value = Math.max(0, 5.2 - day * 0.3 - sourceOffset * 0.2);
      break;
    case "uv":
      value = Math.max(0, 4.0 - day * 0.18 + sourceOffset * 0.15);
      break;
    default:
      value = 0;
  }

  return value;
}

function formatValue(rawValue, conditionName, isDelta = false) {
  if (rawValue === null || rawValue === undefined || Number.isNaN(rawValue)) return "–";
  const value = convertForDisplay(rawValue, conditionName, isDelta);
  if (conditionName === "rain") {
    // Rain values are typically well under 1 unit — whole numbers would
    // read as "0" on most days, so this keeps decimal precision even
    // though everything else has been simplified to whole numbers.
    return conditionUnit("rain") === "imperial" ? value.toFixed(2) : value.toFixed(1);
  }
  if (conditionName === "pressure" && !isDelta) {
    // inHg values sit around 29.9 — rounding to a whole number would
    // erase basically all of the useful precision.
    return conditionUnit("pressure") === "imperial" ? value.toFixed(2) : Math.round(value).toString();
  }
  if (isDelta) {
    // Deltas and accuracy errors are often small numbers near zero —
    // rounding to whole units would hide the precision that makes an
    // accuracy score meaningful in the first place.
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  return Math.round(value).toString();
}

// ---- Target date helpers ----

function todayAtMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function targetDateForRollback(rollbackDays) {
  return addDays(todayAtMidnight(), -rollbackDays);
}

function formatDateShort(date) {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatDateLong(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// A stalled network request never resolves or rejects on its own, and
// plain fetch() has no built-in time limit — left unbounded, one genuinely
// stuck request (flaky wifi/cellular handoff, iOS pausing a backgrounded
// PWA's connections, etc.) can hang an entire load indefinitely, freezing
// the headline and leaving the guard in loadLocationData() with nothing
// to ever clear it. Every fetch in this file goes through this wrapper so
// a stall fails cleanly within a bounded time instead — that's what lets
// the existing per-source error handling, and the Retry button, actually
// do their job.
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Timed out — check your connection and try again");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Actual weather fetching ----

// Reverse of geocodePostcode: given the device's raw coordinates (from
// navigator.geolocation), finds the nearest real postcode via postcodes.io's
// reverse-lookup endpoint. Everything else in the app (FFV storage, saved
// places, the area-code label) is keyed on a postcode string, so this just
// feeds a postcode into the existing switchToPostcode() flow rather than
// needing a separate lat/lon-based code path.
async function reverseGeocodeCoords(lat, lon) {
  const url = `https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Could not look up a postcode for your location");
  const data = await res.json();
  const nearest = data.result?.[0]?.postcode;
  if (!nearest) throw new Error("No postcode found near your location");
  return nearest;
}

async function geocodePostcode(pc) {
  // Location is resolved from the first 3 characters of the postcode
  // (area-level, not the exact address) via postcodes.io's outcode lookup.
  // Note: some outward codes are 4 characters (e.g. "SW1A"); truncating to
  // 3 will miss those and the lookup below will fail for them.
  const areaCode = pc.replace(/\s+/g, "").slice(0, 3);
  const res = await fetchWithTimeout(GEOCODE_URL + encodeURIComponent(areaCode));
  if (!res.ok) throw new Error(`Area code "${areaCode}" not found`);
  const data = await res.json();
  if (!data.result) throw new Error(`Area code "${areaCode}" not found`);
  const district = Array.isArray(data.result.admin_district)
    ? data.result.admin_district[0]
    : data.result.admin_district;
  return {
    lat: data.result.latitude,
    lon: data.result.longitude,
    label: district || areaCode,
    areaCode
  };
}

// A UK postcode or outward code (e.g. "TA6" or "TA6 1AB") — deliberately
// permissive rather than a strict full-postcode pattern, since a bare
// outcode is valid input on its own. Anything that doesn't match this
// shape is treated as a place name instead.
function looksLikePostcode(input) {
  return /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i.test(input.trim());
}

// Thrown instead of a plain Error when a plain place name genuinely
// matches more than one distinct UK place (Gillingham in Kent vs
// Dorset; Newport in Wales vs the Isle of Wight; Richmond in London vs
// North Yorkshire — there are plenty). Carries the candidates so the
// caller can offer a picker rather than just failing or silently
// guessing — silently guessing is exactly what caused the Taunton/
// Massachusetts mix-up this replaces.
class AmbiguousLocationError extends Error {
  constructor(candidates) {
    super("More than one UK place matches that name");
    this.name = "AmbiguousLocationError";
    this.candidates = candidates;
  }
}

// Straight-line distance in km — good enough to tell "basically the same
// result reported twice" (a duplicate DB entry, a nearby hamlet with the
// same name as its parish) apart from two genuinely different towns,
// without needing a full geodesic library for what's just a threshold
// check.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Collapses candidates within 15km of one another (comfortably wider
// than the weather models' own ~10-25km grid, so two "duplicates" this
// close couldn't produce a meaningfully different forecast anyway) down
// to the first, so a genuine single place that happens to appear twice
// in the geocoder's own database doesn't trigger a pointless picker.
function distinctPlaces(candidates) {
  const kept = [];
  candidates.forEach(c => {
    if (!kept.some(k => distanceKm(k.latitude, k.longitude, c.latitude, c.longitude) < 15)) {
      kept.push(c);
    }
  });
  return kept;
}

// Resolves EITHER a UK postcode/outcode (via postcodes.io, as above) OR a
// plain place name (via Open-Meteo's own free geocoding search) to the
// same {lat, lon, label, areaCode} shape either way. Everything
// downstream — FFV storage, eligibility, saved places, the daily
// collector's history.json match — treats areaCode as an opaque
// per-location key, not specifically a postcode, so a place name slots
// into the exact same machinery without any of it needing to change.
//
// This doesn't cost any real accuracy: the app already only used a
// postcode's first 3 characters (a whole area, not a precise address),
// and the actual ceiling on precision is the weather models' own grid —
// 10-25km for Met Office/ECMWF — which swallows the difference between a
// postcode-area centre point and a place name's centre point regardless.
async function resolveLocation(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a postcode or place name");

  if (looksLikePostcode(trimmed)) {
    return geocodePostcode(trimmed);
  }

  // A comma-qualified input (from a disambiguation pick below, or
  // someone typing "Gillingham, Kent" themselves) is matched entirely on
  // this app's OWN side, against every admin field a candidate has —
  // deliberately NOT sent to Open-Meteo's own qualifier syntax, since
  // that only ever matches at the admin1 level, and Open-Meteo's own
  // documented example shows a UK admin1 is just "England" — far too
  // coarse to tell two same-named English towns apart. Always querying
  // by the base name and filtering locally means "Kent" or "Dorset"
  // actually works, regardless of which admin level GeoNames happens to
  // file a UK county under.
  const commaIndex = trimmed.indexOf(",");
  const baseName = commaIndex === -1 ? trimmed : trimmed.slice(0, commaIndex).trim();
  const qualifier = commaIndex === -1 ? null : trimmed.slice(commaIndex + 1).trim().toLowerCase();
  if (!baseName) throw new Error("Enter a postcode or place name");

  // countryCode=GB matters more than it looks: plenty of British place
  // names are shared with towns elsewhere in the world (Taunton,
  // Massachusetts; Richmond, Virginia; Cambridge, Ontario — the list is
  // long), and without this the geocoder has no way to prefer the UK
  // match over a bigger, more "relevant" same-named place abroad. This
  // app has no use for a non-UK result anywhere else in it (postcodes,
  // Met Office, mph-first units), so scoping the search here is a
  // straightforward, safe fix rather than a trade-off.
  //
  // count is higher than 1 specifically to catch ambiguity — a name
  // shared by more than one distinct UK town (see AmbiguousLocationError
  // above) needs to be told apart, not silently resolved to whichever
  // one the geocoder's own relevance ranking happens to prefer.
  const res = await fetchWithTimeout(`${PLACE_GEOCODE_URL}?name=${encodeURIComponent(baseName)}&count=8&language=en&format=json&countryCode=GB`);
  if (!res.ok) throw new Error(`"${baseName}" not found`);
  const data = await res.json();
  let results = data.results || [];
  if (!results.length) throw new Error(`"${baseName}" not found in the UK`);

  if (qualifier) {
    // Checked both ways (field contains qualifier, or qualifier contains
    // field) since admin field wording can be slightly more or less
    // specific than what got stored — "Kent" matching a field of exactly
    // "Kent", and a qualifier of "Kent, South East England" still
    // matching a field of just "Kent", both need to succeed.
    const filtered = results.filter(r =>
      [r.admin1, r.admin2, r.admin3, r.country].some(field => {
        if (!field) return false;
        const lower = field.toLowerCase();
        return lower.includes(qualifier) || qualifier.includes(lower);
      })
    );
    // If nothing matched (a renamed county, wording drift), fall through
    // to the full unfiltered list below rather than failing outright —
    // the ambiguity check further down will still catch it if more than
    // one distinct place remains genuinely unresolved.
    if (filtered.length) results = filtered;
  } else {
    const distinct = distinctPlaces(results);
    if (distinct.length > 1) throw new AmbiguousLocationError(distinct);
  }

  const match = results[0];

  const label = [...new Set([match.name, match.admin2, match.admin1, match.country].filter(Boolean))].join(", ");
  // A place name has no natural short "area code" the way a postcode
  // does — coordinates rounded to ~11km (matching the weather models'
  // own resolution, so anything finer would be false precision anyway)
  // make a stable, storage-safe key for the same place typed again later.
  const areaCode = `${match.latitude.toFixed(1)},${match.longitude.toFixed(1)}`;

  return { lat: match.latitude, lon: match.longitude, label, areaCode };
}

// Groups an hourly series into per-day aggregates (max/min/sum/mean), in
// the same oldest-first order as a matching daily array. Used both for the
// live 7-day windows and the year-long Met Office backfill.
function aggregateHourlyByDay(hourlyTimes, values, dayCount, mode) {
  const buckets = Array.from({ length: dayCount }, () => []);
  hourlyTimes.forEach((t, i) => {
    const dayIndex = Math.floor(i / 24);
    const v = values[i];
    if (dayIndex < dayCount && v !== null && v !== undefined) {
      buckets[dayIndex].push(v);
    }
  });
  return buckets.map(vals => {
    if (!vals.length) return null;
    switch (mode) {
      case "max": return Math.max(...vals);
      case "min": return Math.min(...vals);
      case "sum": return vals.reduce((a, b) => a + b, 0);
      case "mean":
      default:
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  });
}

function averageCloudByDay(hourlyTimes, hourlyCloud, dayCount) {
  return aggregateHourlyByDay(hourlyTimes, hourlyCloud, dayCount, "mean");
}

// Direction can't be averaged (0° and 360° are the same direction but
// average to a meaningless 180°), so this reports the direction AT the
// hour the day's peak wind speed occurred, paired with it rather than
// blended across the day.
function directionAtPeakHour(hourlyTimes, speedValues, directionValues, dayCount) {
  const buckets = Array.from({ length: dayCount }, () => []);
  hourlyTimes.forEach((t, i) => {
    const dayIndex = Math.floor(i / 24);
    if (dayIndex < dayCount && speedValues[i] !== null && speedValues[i] !== undefined) {
      buckets[dayIndex].push({ speed: speedValues[i], direction: directionValues[i] });
    }
  });
  return buckets.map(entries => {
    if (!entries.length) return null;
    // Prefer the day's genuine peak-speed hour, but if THAT specific
    // hour's direction field happens to be missing — seen in practice on
    // "today" specifically, where the model's direction field for the
    // most recent hour(s) can lag slightly behind its own speed field
    // and fill in a little later — fall back to the next-highest-speed
    // hour that actually has one, rather than giving up on direction for
    // the whole day just because its single busiest hour hasn't got a
    // reading yet. This is exactly why the wind arrow could sit missing
    // at "Now" and then appear later with no other change: the peak
    // hour's direction backfilled upstream in the meantime.
    const withDirection = entries
      .filter(e => e.direction !== null && e.direction !== undefined)
      .sort((a, b) => b.speed - a.speed);
    return withDirection.length ? withDirection[0].direction : null;
  });
}

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compassLabel(degrees) {
  if (degrees === null || degrees === undefined) return null;
  const index = Math.round(degrees / 22.5) % 16;
  return COMPASS_POINTS[index];
}

// Meteorological wind direction is the direction the wind blows FROM.
// The arrow instead points where it's blowing TO (downwind) — more
// directly useful for "which way will this push me," given the app's
// watersports use case — so it's rotated 180° from the raw reading.
function windArrowRotation(degrees) {
  if (degrees === null || degrees === undefined) return null;
  return (degrees + 180) % 360;
}

async function fetchActualWeather(lat, lon) {
  state.actual.status = "loading";
  state.actual.error = null;
  renderActualStatus();

  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "windspeed_10m_max",
        "windgusts_10m_max",
        "sunshine_duration",
        "uv_index_max"
      ].join(","),
      hourly: "cloudcover,pressure_msl,soil_temperature_0cm,dewpoint_2m",
      past_days: MAX_ROLLBACK,
      forecast_days: 1,
      wind_speed_unit: "mph",
      timezone: "auto"
    });

    const res = await fetchWithTimeout(`${WEATHER_URL}?${params.toString()}`);
    if (!res.ok) throw new Error("Weather lookup failed");
    const data = await res.json();

    const dayCount = data.daily.time.length; // MAX_ROLLBACK + 1, oldest first

    state.actual.dates = data.daily.time;
    state.actual.temperature_2m_max = data.daily.temperature_2m_max;
    state.actual.temperature_2m_min = data.daily.temperature_2m_min;
    state.actual.precipitation_sum = data.daily.precipitation_sum;
    state.actual.windspeed_10m_max = data.daily.windspeed_10m_max;
    state.actual.windgusts_10m_max = data.daily.windgusts_10m_max;
    state.actual.sunshine_duration = data.daily.sunshine_duration;
    state.actual.uv_index_max = data.daily.uv_index_max;
    state.actual.pressure_hourly_times = data.hourly.time;
    state.actual.pressure_hourly_values = data.hourly.pressure_msl;
    state.actual.cloud_mean = averageCloudByDay(
      data.hourly.time,
      data.hourly.cloudcover,
      dayCount
    );
    state.actual.pressure_mean = aggregateHourlyByDay(
      data.hourly.time,
      data.hourly.pressure_msl,
      dayCount,
      "mean"
    );
    state.actual.soilTemp_mean = aggregateHourlyByDay(
      data.hourly.time,
      data.hourly.soil_temperature_0cm,
      dayCount,
      "mean"
    );
    state.actual.dewPoint_mean = aggregateHourlyByDay(
      data.hourly.time,
      data.hourly.dewpoint_2m,
      dayCount,
      "mean"
    );
    state.actual.status = "ready";
  } catch (err) {
    state.actual.status = "error";
    state.actual.error = err.message || "Could not load actual weather";
  }

  renderActualStatus();
  renderTable();
}

// Live real data for the same rolling window as Actual (extended into
// the future too) — one lead-time series (previous_day1..7) per
// condition, all sharing the same valid-time axis as state.actual, so
// the same rollback index works for both. Called once per REAL_SOURCES
// entry, in parallel, from loadLocationData.
async function fetchRealSourceLive(sourceId, model, lat, lon) {
  const slot = state.realSources[sourceId];
  slot.status = "loading";
  slot.error = null;
  renderRealSourceStatus();

  try {
    const hourlyVars = [];
    for (let d = 1; d <= 7; d++) {
      hourlyVars.push(
        `temperature_2m_previous_day${d}`,
        `precipitation_previous_day${d}`,
        `wind_speed_10m_previous_day${d}`,
        `wind_direction_10m_previous_day${d}`,
        `wind_gusts_10m_previous_day${d}`,
        `cloud_cover_previous_day${d}`,
        `pressure_msl_previous_day${d}`,
        `soil_temperature_0cm_previous_day${d}`,
        `dewpoint_2m_previous_day${d}`
      );
    }

    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      hourly: hourlyVars.join(","),
      past_days: MAX_ROLLBACK,
      forecast_days: MAX_FUTURE + 1,
      models: model,
      wind_speed_unit: "mph",
      timezone: "auto"
    });

    const res = await fetchWithTimeout(`${PREVIOUS_RUNS_URL}?${params.toString()}`);
    if (!res.ok) throw new Error("Data lookup failed");
    const data = await res.json();

    const hourlyTimes = data.hourly.time;
    const dayCount = Math.floor(hourlyTimes.length / 24);
    const byLeadDay = emptyLeadDayData();

    for (let d = 1; d <= 7; d++) {
      const tempMax = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
      const tempMin = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
      const windSpeedHourly = data.hourly[`wind_speed_10m_previous_day${d}`];
      byLeadDay[d] = {
        tempMax,
        tempMin,
        tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
        precip: aggregateHourlyByDay(hourlyTimes, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
        wind: aggregateHourlyByDay(hourlyTimes, windSpeedHourly, dayCount, "max"),
        windGust: aggregateHourlyByDay(hourlyTimes, data.hourly[`wind_gusts_10m_previous_day${d}`], dayCount, "max"),
        windDirection: directionAtPeakHour(hourlyTimes, windSpeedHourly, data.hourly[`wind_direction_10m_previous_day${d}`], dayCount),
        cloud: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean"),
        pressure: aggregateHourlyByDay(hourlyTimes, data.hourly[`pressure_msl_previous_day${d}`], dayCount, "mean"),
        soilTemp: aggregateHourlyByDay(hourlyTimes, data.hourly[`soil_temperature_0cm_previous_day${d}`], dayCount, "mean"),
        dewPoint: aggregateHourlyByDay(hourlyTimes, data.hourly[`dewpoint_2m_previous_day${d}`], dayCount, "mean")
      };
    }

    // One date label per day-bucket, taken straight from the hourly
    // timeline already being fetched — not a separate `daily` field,
    // which was never requested in the params above and so was always
    // missing from the response. That left `dates` permanently empty,
    // which in turn made every live real-source lookup (today's figures,
    // wind direction, the Compare table's Raw column) fail its bounds
    // check and silently fall back to the placeholder formula — for
    // every date, not just today. This is the actual fix for the
    // frozen/placeholder headline, separate from the render-timing
    // change made previously.
    slot.dates = Array.from({ length: dayCount }, (_, i) => isoDate(new Date(hourlyTimes[i * 24])));
    slot.byLeadDay = byLeadDay;
    slot.status = "ready";
  } catch (err) {
    slot.status = "error";
    slot.error = err.message || "Could not load data";
  }

  renderRealSourceStatus();
  renderTable();
}

// The daily GitHub Action commits data/history.json — no location info in
// it, just dates and numbers. This is Met Office's authoritative FFV
// source: every load, its store entries are rebuilt from scratch by
// replaying the whole file, so there's no incremental double-counting no
// matter how often the page is opened. This is the "consistent collection
// even if the app is barely opened" guarantee — the Action runs daily
// regardless, and whatever it collected is just replayed here.
const HISTORY_URL = "./data/history.json";

// ---- Moon phase & day/night (for the Sunshine cell while the hour
// slider is active) ----
// Standard synodic-month approximation: days since a known new moon,
// mod the ~29.53-day cycle. Accurate to within about a day, plenty for
// a decorative icon rather than a navigation instrument.
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC
const SYNODIC_MONTH_MS = 29.530588 * 24 * 60 * 60 * 1000;

// Returns 0–1: 0/1 = new moon, 0.5 = full moon, 0.25 = first quarter, etc.
function moonPhaseFraction(date) {
  const age = ((date.getTime() - KNOWN_NEW_MOON) % SYNODIC_MONTH_MS + SYNODIC_MONTH_MS) % SYNODIC_MONTH_MS;
  return age / SYNODIC_MONTH_MS;
}

// A real SVG rather than an emoji — the 🌕 Full Moon emoji renders as a
// plain pale disc on most platforms, easy to mistake for the Sun icon at
// a glance (which is exactly the "looks like false data" problem this
// replaces). This draws the ACTUAL current phase via a dark shadow
// circle offset and clipped over a light disc, so it's always
// recognisably "moon" — even at full, a sliver of the shadow's edge
// still shows — and it's genuinely informative rather than decorative.
function moonPhaseSvg(date) {
  const fraction = moonPhaseFraction(date);
  // Waxing (0 → 0.5): shadow retreats off the LEFT edge as it fills.
  // Waning (0.5 → 1): shadow advances back over from the LEFT edge.
  // Offset of the shadow circle's center from the moon's center, as a
  // multiple of the radius: +2r (shadow fully clear, moon fully lit) at
  // fraction 0.5, down to 0 (shadow dead-center, moon fully dark) at
  // fraction 0 or 1.
  const litAmount = 1 - Math.abs(fraction - 0.5) * 2; // 0 at new, 1 at full
  const waxing = fraction < 0.5;
  const shadowOffset = litAmount * 2 * (waxing ? 1 : -1) * -1; // sign flips which side the lit crescent is on
  const r = 9;
  const cx = 12;
  const cy = 12;
  const shadowCx = cx + shadowOffset * r;
  return (
    `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">` +
    `<defs><clipPath id="moonclip-${Math.round(fraction * 1000)}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#cfd8e3"/>` +
    `<circle cx="${shadowCx}" cy="${cy}" r="${r * 0.97}" fill="#1b2430" clip-path="url(#moonclip-${Math.round(fraction * 1000)})"/>` +
    `</svg>`
  );
}

function isDaytime(date) {
  const dateKey = isoDate(date);
  const sunrise = state.hourly.sunriseByDate[dateKey];
  const sunset = state.hourly.sunsetByDate[dateKey];
  if (!sunrise || !sunset) return true; // no data yet — default to day, safest fallback
  const t = date.getTime();
  return t >= new Date(sunrise).getTime() && t < new Date(sunset).getTime();
}

// Real hourly UV expressed as a percentage of that day's peak UV, rather
// than a raw index number — more intuitive for a single hour ("75% of
// today's strongest UV") than an absolute figure, and a natural way to
// combine UV with Sunshine into one hourly reading (Sunshine itself has
// no hourly concept — see hourlyValueFor). Null at night is expected and
// handled by the moon swap instead, not shown as 0%.
function hourlyUVPercent(idx) {
  const uv = state.hourly.uvIndex?.[idx];
  const iso = state.hourly.times?.[idx];
  if (uv === null || uv === undefined || !iso) return null;
  const dayMax = state.hourly.uvMaxByDate[isoDate(new Date(iso))];
  if (!dayMax) return null;
  return Math.round((uv / dayMax) * 100);
}

// The hourly slider's data source. Deliberately NOT the previous_dayN
// lead-time data used elsewhere — that answers "what was forecast N days
// ago," which isn't what "what's happening in the next 24-48h" needs.
// This is a plain live forecast: what the model currently thinks, right
// now, for the hours immediately ahead.
async function fetchHourlyForecast(lat, lon) {
  state.hourly.status = "loading";
  state.hourly.error = null;

  try {
    const perSource = {};
    let from = 0;
    let sharedTimes = [];

    for (const { id, model } of REAL_SOURCES) {
      const params = new URLSearchParams({
        latitude: lat,
        longitude: lon,
        hourly: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,soil_temperature_0cm,dewpoint_2m" + (id === "metoffice" ? ",uv_index,cloud_cover" : ""),
        models: model,
        wind_speed_unit: "mph",
        forecast_days: 3,
        timezone: "auto",
        ...(id === "metoffice" ? { daily: "sunrise,sunset,uv_index_max" } : {})
      });

      const res = await fetchWithTimeout(`${WEATHER_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`Hourly forecast lookup failed for ${id}`);
      const data = await res.json();

      if (id === "metoffice") {
        const now = new Date();
        const startIdx = data.hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);
        from = startIdx >= 0 ? startIdx : 0;
        sharedTimes = data.hourly.time.slice(from);

        state.hourly.uvIndex = data.hourly.uv_index.slice(from);
        state.hourly.cloudCover = data.hourly.cloud_cover.slice(from);
        state.hourly.sunriseByDate = {};
        state.hourly.sunsetByDate = {};
        state.hourly.uvMaxByDate = {};
        data.daily.time.forEach((date, i) => {
          state.hourly.sunriseByDate[date] = data.daily.sunrise[i];
          state.hourly.sunsetByDate[date] = data.daily.sunset[i];
          state.hourly.uvMaxByDate[date] = data.daily.uv_index_max[i];
        });
      }

      perSource[id] = {
        temperature: data.hourly.temperature_2m.slice(from, from + sharedTimes.length || undefined),
        precipitation: data.hourly.precipitation.slice(from, from + sharedTimes.length || undefined),
        windSpeed: data.hourly.wind_speed_10m.slice(from, from + sharedTimes.length || undefined),
        windGust: data.hourly.wind_gusts_10m.slice(from, from + sharedTimes.length || undefined),
        windDirection: data.hourly.wind_direction_10m.slice(from, from + sharedTimes.length || undefined),
        pressure: data.hourly.pressure_msl.slice(from, from + sharedTimes.length || undefined),
        soilTemperature: data.hourly.soil_temperature_0cm.slice(from, from + sharedTimes.length || undefined),
        dewPoint: data.hourly.dewpoint_2m.slice(from, from + sharedTimes.length || undefined)
      };
    }

    state.hourly.times = sharedTimes;
    const count = sharedTimes.length;

    // Each real source's own FFV correction is applied per hour first
    // (same day-bucket convention used throughout the hourly view — an
    // hour before midnight tonight is "day 1", the next day is "day 2"),
    // then the corrected values are medianed together across sources —
    // mirroring exactly how the daily table blends Met Office and ECMWF.
    function blend(field, conditionName) {
      return Array.from({ length: count }, (_, i) => {
        const day = i < 24 ? 1 : 2;
        const values = REAL_SOURCES.map(({ id }) => {
          const raw = perSource[id]?.[field]?.[i];
          if (raw === null || raw === undefined) return null;
          const source = CONFIG.forecasters.find(s => s.id === id);
          const ffv = ffvFor(source, conditionName, day);
          return ffv !== null ? applyCorrection(raw, ffv, conditionName) : raw;
        }).filter(v => v !== null && v !== undefined);
        return values.length ? median(values) : null;
      });
    }

    state.hourly.temperature = blend("temperature", "temperature");
    state.hourly.precipitation = blend("precipitation", "rain");
    state.hourly.windSpeed = blend("windSpeed", "wind");
    // Gust has no FFV history of its own — there's no dedicated Gust
    // condition to compare against Actual the way Wind/Rain/etc. do, so
    // this reuses Wind's own learned ratio as the closest available
    // correction rather than showing the raw model figure uncorrected.
    state.hourly.windGust = blend("windGust", "wind");
    state.hourly.pressure = blend("pressure", "pressure");
    state.hourly.soilTemperature = blend("soilTemperature", "soilTemperature");
    state.hourly.dewPoint = blend("dewPoint", "dewPoint");
    // Direction can't be medianed the way speed can (it's angular, not
    // linear) — first real source with a reading for that hour, same
    // convention as anyRealWindDirection() uses for the daily table.
    state.hourly.windDirection = Array.from({ length: count }, (_, i) => {
      for (const { id } of REAL_SOURCES) {
        const d = perSource[id]?.windDirection?.[i];
        if (d !== null && d !== undefined) return d;
      }
      return null;
    });

    state.hourly.status = "ready";
  } catch (err) {
    state.hourly.status = "error";
    state.hourly.error = err.message || "Could not load hourly forecast";
  }

  // Every other fetch in this file redraws on its own completion — this
  // one didn't, which meant "Today" could sit showing the plain daily
  // blend indefinitely even after the live hourly data (which
  // headlineDisplayValueFor prefers once ready) had quietly finished
  // loading in the background. Nothing was wrong with the data itself,
  // just that nothing ever told the page to look at it again — a nudge
  // to the hour slider or opening the graph sheet forced a redraw and
  // "fixed" it, which is what made this look like inconsistent/fake
  // values rather than a stale render.
  renderTable();
}

function meanFromHistoryDay(dayEntry, sourceId, day, conditionName) {
  const leadDays = day === 1 ? [1, 2] : day === 7 ? [6, 7] : [day - 1, day, day + 1];
  const values = leadDays
    .map(d => dayEntry.models?.[sourceId]?.[d]?.[conditionName])
    .filter(v => v !== null && v !== undefined);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function renderHistoryStatus() {
  if (!historyStatus) return;
  historyStatus.classList.remove("is-error");

  if (state.history.status === "loading") {
    historyStatus.textContent = "Loading collected history…";
  } else if (state.history.status === "error") {
    historyStatus.textContent = `Collected history unavailable: ${state.history.error}`;
    historyStatus.classList.add("is-error");
  } else if (state.history.status === "ready") {
    if (state.history.areaMismatch) {
      historyStatus.textContent = "The daily-collected history is for a different postcode area, so it isn't used here — this area relies on its own one-off backfill instead.";
    } else {
      historyStatus.textContent = state.history.dayCount > 0
        ? `Real-source accuracy is built from ${state.history.dayCount} day${state.history.dayCount === 1 ? "" : "s"} collected automatically once a day.`
        : "No collected history yet — the daily Action hasn't run yet, or hasn't been set up.";
    }
  } else {
    historyStatus.textContent = "";
  }
}

async function loadCommittedHistory() {
  if (!state.areaCode) return;

  state.history.status = "loading";
  state.history.error = null;
  state.history.areaMismatch = false;
  renderHistoryStatus();

  try {
    const res = await fetchWithTimeout(HISTORY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("history.json not found");
    const data = await res.json();

    // This file is only ever collected for ONE fixed postcode area (set
    // once via the GitHub Action's secrets) — it is not per-visitor. If
    // the current postcode's area doesn't match, applying it anyway
    // would silently treat one location's real weather history as
    // another's. Skip it entirely rather than risk that; this area's
    // real-source accuracy then relies solely on its own one-off
    // backfill (see anyRealSourceHasHistory / backfillRealSourceHistory)
    // instead of the shared daily collection.
    if (!data.areaCode || data.areaCode !== state.areaCode) {
      state.history.status = "ready";
      state.history.dayCount = 0;
      state.history.areaMismatch = true;
      renderHistoryStatus();
      renderTable();
      return;
    }

    const dates = Object.keys(data.days || {});

    const store = loadFFVStore(state.areaCode);
    const eligStore = loadEligibilityStore(state.areaCode);
    // Rebuild every real source's entries from scratch — this file is the
    // single source of truth for them, so a partial/incremental merge
    // would risk exactly the double-counting this mechanism exists to avoid.
    Object.keys(CONFIG.conditions).forEach(conditionName => {
      realSourceIds().forEach(sourceId => {
        if (store[conditionName]) delete store[conditionName][sourceId];
        if (eligStore[conditionName]) delete eligStore[conditionName][sourceId];
      });
    });

    dates.forEach(date => {
      const dayEntry = data.days[date];
      if (!dayEntry.actual) return;

      realSourceIds().forEach(sourceId => {
        if (!dayEntry.models?.[sourceId]) return;

        REAL_DATA_CONDITIONS.forEach(conditionName => {
          const actual = dayEntry.actual[conditionName];
          if (actual === null || actual === undefined) return;

          for (let day = 1; day <= 7; day++) {
            const mean = meanFromHistoryDay(dayEntry, sourceId, day, conditionName);
            if (!mean) continue;
            recordFFVSample(store, conditionName, sourceId, day, mean, actual, eligStore, date);
          }
        });
      });
    });

    saveFFVStore(state.areaCode, store);
    saveEligibilityStore(state.areaCode, eligStore);
    state.history.status = "ready";
    state.history.dayCount = dates.length;
  } catch (err) {
    state.history.status = "error";
    state.history.error = err.message || "Could not load collected history";
  }

  renderHistoryStatus();
  renderTable();
}

// Geocodes once, then kicks off Actual and the live Met Office fetch from
// the same coordinates rather than each resolving location separately.
function anyRealSourceHasHistory() {
  if (!state.areaCode) return false;
  const store = loadFFVStore(state.areaCode);
  return realSourceIds().some(sourceId =>
    Object.keys(CONFIG.conditions).some(conditionName => {
      const bySource = store[conditionName]?.[sourceId];
      if (!bySource) return false;
      return Object.values(bySource).some(entry => entry.count > 0);
    })
  );
}

// Guards against overlapping runs of loadLocationData — with NINE real
// sources now fetched (each sequentially awaited inside
// fetchHourlyForecast/fetchRealSourceLive), a single full load can
// genuinely take long enough that the 30-second retry timer, the
// "online" listener, or a rapid re-tap of Update could start a SECOND
// run before the first has finished. Both would then be writing into
// the same shared state.hourly/state.actual/state.realSources fields at
// once, and whichever happened to finish last would silently overwrite
// the other's — for Rain's running total specifically, this could show
// as the figure appearing to climb, then snap to a smaller "final"
// number once every overlapping run had actually settled. Any call
// while one is already in flight just reuses that same in-flight
// promise instead of starting a second, competing run.
let loadLocationDataPromise = null;
let loadLocationPromisePostcode = null;
let loadLocationQueuedPostcode = null;
let loadLocationGeneration = 0;

// This used to race the real fetch against a timeout and, when the
// timeout won, treat the real fetch as abandoned — freeing
// loadLocationDataPromise back to null even though the real work was
// STILL genuinely running in the background. That was the actual cause
// of the flickering: the freed guard let the 30-second background retry
// (and any other trigger) start a brand new, fully independent second
// fetch on top of the still-running first one — and with six real
// sources now fetched, sometimes a third or fourth — each eventually
// finishing at its own staggered time and overwriting whatever the
// previous one had just shown, which is exactly the repeated
// error/data/error/different-data cycling that could take minutes to
// finally settle.
//
// This version never abandons the real request — loadLocationDataPromise
// stays pointing at it for as long as it's genuinely running, however
// long that takes, so the guard actually guards. The timer below only
// ever updates what's ON SCREEN if things are taking a while; it never
// starts a second fetch or gives up on the first one.
const LOAD_SLOW_WARNING_MS = 45000;

function loadLocationData() {
  // Only ever one fetch actually runs at a time — every fetch function
  // (fetchActualWeather, fetchRealSourceLive, fetchHourlyForecast)
  // writes straight into this same shared state.actual/state.realSources/
  // state.hourly, so two genuinely concurrent fetches for two DIFFERENT
  // places could interleave their writes into that one shared object —
  // reopening the exact "flash of mixed-up data" problem fixed earlier,
  // just via a new route.
  //
  // But a switch that arrives while another is still in flight is
  // QUEUED rather than dropped — remembered here, and automatically
  // re-issued the moment the current fetch finishes. Before this, it was
  // silently discarded entirely: nothing else ever re-triggered it, so a
  // second place switched to quickly could get stuck on "Loading
  // weather…" indefinitely, only recovering if something else happened
  // to nudge it (a manual retry, or switching away and back again).
  // resetForLocationChange has already updated what's ON SCREEN for the
  // new place immediately either way (its cached snapshot, or a plain
  // loading state) — queueing only affects how soon its FRESH data
  // actually arrives, never what's shown in the meantime.
  if (loadLocationDataPromise) {
    if (loadLocationPromisePostcode !== state.postcode) {
      loadLocationQueuedPostcode = state.postcode;
    }
    return loadLocationDataPromise;
  }

  const myGeneration = ++loadLocationGeneration;
  const myPostcode = state.postcode;
  loadLocationPromisePostcode = myPostcode;
  loadLocationQueuedPostcode = null;

  const warnTimeoutId = setTimeout(() => {
    // Only touches the display if this is still the current attempt for
    // whatever place is actually on screen right now.
    if (loadLocationGeneration === myGeneration && state.postcode === myPostcode) {
      state.actual.status = "error";
      state.actual.error = "Taking longer than usual to load — still trying in the background.";
      renderActualStatus();
      renderTable();
    }
  }, LOAD_SLOW_WARNING_MS);

  loadLocationDataPromise = runLoadLocationData().finally(() => {
    clearTimeout(warnTimeoutId);
    loadLocationDataPromise = null;
    loadLocationPromisePostcode = null;
    // A switch to somewhere else arrived while this was running — it was
    // queued rather than dropped, so pick it up now. The postcode check
    // guards against yet another switch having happened in the meantime
    // (away from what was queued) — in that case its OWN call to
    // loadLocationData already re-queued the right, newer target.
    if (loadLocationQueuedPostcode !== null && loadLocationQueuedPostcode === state.postcode) {
      loadLocationQueuedPostcode = null;
      loadLocationData();
    }
  });

  return loadLocationDataPromise;
}

async function runLoadLocationData() {
  // Captured up front so a late-arriving result from an abandoned or
  // timed-out request can tell it's been superseded by a newer switch —
  // and skip committing/rendering itself over the newer, correct data.
  const requestedFor = state.postcode;
  try {
    const { lat, lon, label, areaCode } = await resolveLocation(state.postcode);

    // resolveLocation is itself a network round-trip (postcodes.io or
    // Open-Meteo's geocoder) — if a newer switch has already taken over
    // by the time this one resolves, committing these coordinates to the
    // shared state.lat/lon/areaCode anyway would silently overwrite
    // whatever the CURRENT, correctly-displayed location is using with
    // this old, now-irrelevant one's. Every fetch below reads lat/lon
    // straight off this closure (not back off state), so nothing past
    // this point actually needs the shared fields updated to keep
    // running correctly for THIS request — checking here rather than
    // only after the fetches finish (as below) closes the gap where a
    // slow, superseded resolve could corrupt a newer, already-displayed
    // location's identity for anything else that reads state.areaCode in
    // the meantime (FFV lookups, the eligibility store, and so on).
    if (state.postcode !== requestedFor) return;

    state.lat = lat;
    state.lon = lon;
    state.areaCode = areaCode;
    state.actual.coordLabel = label;
    await Promise.all([
      fetchActualWeather(lat, lon),
      ...REAL_SOURCES.map(({ id, model }) => fetchRealSourceLive(id, model, lat, lon)),
      loadCommittedHistory(),
      fetchHourlyForecast(lat, lon)
    ]);

    if (state.postcode !== requestedFor) return; // a newer switch has since taken over — this result is stale, leave it alone

    // Everything from here on is bookkeeping (learning FFV, and the
    // one-off backfill for a genuinely new area) rather than data the
    // page needs to show. If any of it throws, the fetches above still
    // succeeded — so the render at the bottom must still run with
    // whatever real data did load, rather than being skipped entirely.
    // Previously an error here fell through to the outer catch, which
    // only shows a status message (and only on pages that have that
    // element) without ever redrawing the headline/table — leaving the
    // page stuck showing stale/placeholder figures with no visible sign
    // anything had gone wrong.
    try {
      updateFFVHistory();

      // First time this postcode area has ever been seen (no real-source
      // samples at all yet, even after the committed-history replay
      // above): pull a year of real history automatically for every real
      // source rather than leaving it to be found via the advanced
      // backfill button. Only ever fires once per area — after it runs,
      // count > 0 and this is skipped on future loads.
      if (!anyRealSourceHasHistory()) {
        await backfillRealSourceHistory();
      }

      // Refresh which sources currently count as underperforming here —
      // cheap (pure localStorage math, no fetching) and needs to run on
      // every page, not just Compare, so the front page's escalation
      // banner always reflects the latest accuracy comparison too.
      syncUnderperformFlags();

      // One snapshot of the app's own merged accuracy per calendar day —
      // must run after updateFFVHistory() above, which is what actually
      // records today's samples into appAccuracyStore in the first place.
      updateAccuracyTrend();
    } catch (bookkeepingErr) {
      console.error("FFV bookkeeping failed (data itself still loaded fine):", bookkeepingErr);
    }

    if (state.postcode !== requestedFor) return; // superseded partway through bookkeeping — same reasoning as above

    // The final render of a load always reveals what was actually
    // fetched — this is what currentDisplayIsComplete flips true for,
    // marking the display as genuinely settled for this postcode from
    // here on, protected from being blanked by anything else that
    // happens to trigger a render afterwards.
    currentDisplayIsComplete = true;
    renderActualStatus();
    renderRealSourceStatus();
    renderTable();
    cacheCurrentLocationSnapshot();
  } catch (err) {
    if (state.postcode !== requestedFor) return; // the newer request's own success/error handling owns the display now
    state.actual.status = "error";
    state.actual.error = err.message || "Could not resolve location";
    renderActualStatus();
    renderTable();
  }
}

// Actual can only ever be past or today — the array is never extended
// into the future (there's nothing to fetch: it hasn't happened), so any
// future rollbackDays correctly falls outside these bounds.
function actualIndexForRollback(rollbackDays) {
  if (rollbackDays < 0) return null;
  const idx = state.actual.dates.length - 1 - rollbackDays;
  return idx >= 0 && idx < state.actual.dates.length ? idx : null;
}

function actualValueFor(conditionName, rollbackDays) {
  const idx = actualIndexForRollback(rollbackDays);
  if (idx === null) return null;

  switch (conditionName) {
    case "rain":
      return state.actual.precipitation_sum[idx];
    case "cloud":
      return state.actual.cloud_mean[idx];
    case "wind":
      return state.actual.windspeed_10m_max[idx];
    case "temperature": {
      const max = state.actual.temperature_2m_max[idx];
      const min = state.actual.temperature_2m_min[idx];
      return max !== null && min !== null ? (max + min) / 2 : null;
    }
    case "sunshine": {
      const seconds = state.actual.sunshine_duration[idx];
      return seconds !== null && seconds !== undefined ? seconds / 3600 : null;
    }
    case "uv":
      return state.actual.uv_index_max[idx];
    case "pressure":
      return state.actual.pressure_mean[idx];
    case "soilTemperature":
      return state.actual.soilTemp_mean[idx];
    case "dewPoint":
      return state.actual.dewPoint_mean[idx];
    default:
      return null;
  }
}

// Each real source's live window spans MAX_ROLLBACK days back through
// MAX_FUTURE days ahead (see fetchRealSourceLive) — wider than Actual's,
// since it also carries today's live forecast for upcoming dates. Index
// MAX_ROLLBACK is always "today", same convention as
// actualIndexForRollback but over a longer array.
function realSourceIndexForRollback(sourceId, rollbackDays) {
  const idx = MAX_ROLLBACK - rollbackDays;
  const dates = state.realSources[sourceId]?.dates ?? [];
  return idx >= 0 && idx < dates.length ? idx : null;
}

// Real value for a given source/condition/lead-day/target-date, or null
// if not loaded, not covered, or out of the fetched window.
function realSourceValueFor(sourceId, conditionName, day, rollbackDays) {
  const slot = state.realSources[sourceId];
  if (!slot || slot.status !== "ready" || day > 7) return null;
  const idx = realSourceIndexForRollback(sourceId, rollbackDays);
  if (idx === null) return null;
  const byDay = slot.byLeadDay[day];
  if (!byDay) return null;

  switch (conditionName) {
    case "rain": return byDay.precip[idx] ?? null;
    case "wind": return byDay.wind[idx] ?? null;
    case "cloud": return byDay.cloud[idx] ?? null;
    case "temperature": return byDay.tempAvg[idx] ?? null;
    case "pressure": return byDay.pressure[idx] ?? null;
    case "soilTemperature": return byDay.soilTemp[idx] ?? null;
    case "dewPoint": return byDay.dewPoint[idx] ?? null;
    default: return null;
  }
}

// Wind direction for a given real source — no demo source has direction
// data, so unlike speed there's no fallback here.
function realSourceWindDirectionFor(sourceId, day, rollbackDays) {
  const slot = state.realSources[sourceId];
  if (!slot || slot.status !== "ready" || day > 7) return null;
  const idx = realSourceIndexForRollback(sourceId, rollbackDays);
  if (idx === null) return null;
  const byDay = slot.byLeadDay[day];
  return byDay?.windDirection?.[idx] ?? null;
}

// Whether this source has genuine real data behind it for this
// condition. Shared between forecastValueFor (per-cell fallback) and the
// headline (which filters to real sources only, so demo noise can't
// dilute it).
function isRealSource(source, conditionName) {
  return realSourceIds().includes(source.id) && REAL_DATA_CONDITIONS.has(conditionName);
}

// The single point where a cell's forecast value is decided: real data
// for Rain/Cloud/Wind/Temperature when it's loaded for this source, the
// demo formula for everything else (including a real source's own
// Sunshine/UV, and as a fallback while real data is loading or if it
// errors). Day > 7 always returns null for a real source rather than
// falling back to demo, so threeDayMean's day-7 edge case never mixes
// real and demo values in the same average — see threeDayMean below.
function forecastValueFor(day, source, conditionName, rollbackDays) {
  if (isRealSource(source, conditionName)) {
    if (day > 7) return null;
    const real = realSourceValueFor(source.id, conditionName, day, rollbackDays);
    if (real !== null) return real;
  }
  return demoValue(day, source, conditionName);
}

function renderRealSourceStatus() {
  if (!realSourceStatus) return;
  realSourceStatus.classList.remove("is-error");
  const errorOnly = realSourceStatus.classList.contains("status-error-only");

  const errored = REAL_SOURCES.filter(({ id }) => state.realSources[id].status === "error");
  const loading = REAL_SOURCES.filter(({ id }) => state.realSources[id].status === "loading");
  const ready = REAL_SOURCES.filter(({ id }) => state.realSources[id].status === "ready");

  if (errored.length > 0) {
    const names = errored.map(({ id }) => CONFIG.forecasters.find(f => f.id === id)?.name || id);
    realSourceStatus.textContent = `${names.join(", ")} real data unavailable (falling back to demo)`;
    realSourceStatus.classList.add("is-error");
  } else if (errorOnly) {
    realSourceStatus.textContent = "";
  } else if (loading.length > 0) {
    realSourceStatus.textContent = "Loading real forecast data…";
  } else if (ready.length > 0) {
    const names = ready.map(({ id }) => CONFIG.forecasters.find(f => f.id === id)?.name || id);
    realSourceStatus.textContent =
      `Real data for Rain, Cloud, Wind and Temperature from: ${names.join(", ")}. Sunshine and UV remain demo (not available from these sources).`;
  } else {
    realSourceStatus.textContent = "";
  }
}

function renderActualStatus() {
  if (headlineStatus) {
    headlineStatus.classList.remove("is-error");
    if (state.actual.status === "error") {
      headlineStatus.textContent = `Couldn't load weather: ${state.actual.error}`;
      headlineStatus.classList.add("is-error");
      if (headlineStatusBlock) headlineStatusBlock.hidden = false;
    } else {
      headlineStatus.textContent = "";
      if (headlineStatusBlock) headlineStatusBlock.hidden = true;
    }
  }

  if (!actualStatus) return;
  actualStatus.classList.remove("is-error");
  const errorOnly = actualStatus.classList.contains("status-error-only");

  if (state.actual.status === "error") {
    actualStatus.textContent = `Actual weather unavailable: ${state.actual.error}`;
    actualStatus.classList.add("is-error");
  } else if (errorOnly) {
    actualStatus.textContent = "";
  } else if (state.actual.status === "loading") {
    actualStatus.textContent = "Loading actual weather…";
  } else if (state.actual.status === "ready") {
    const samples = ffvSampleTotal(state.condition);
    const ffvNote = samples > 0
      ? ` · FFV data: ${samples} sample${samples === 1 ? "" : "s"} for ${CONFIG.conditions[state.condition].name} in ${state.areaCode}`
      : "";
    actualStatus.textContent = `Actual weather via Open-Meteo for ${state.actual.coordLabel}${ffvNote}`;
  } else {
    actualStatus.textContent = "";
  }
}

// ---- Fudge Factor (FFV): 3-day mean of forecast values, corrected by a
// per-area, per-source, per-condition, per-lead-time ratio learned from
// past forecast-vs-actual comparisons. Stored in localStorage, keyed by
// postcode area so different gardens build their own correction history.

const FFV_MIN_SAMPLES = 3;
const FFV_RATIO_CLAMP = [0.1, 5]; // guards against near-zero means blowing up the ratio
const FFV_OFFSET_CLAMP = [-15, 15]; // °C or hPa — generous but rules out a single wild sample skewing things

// FFV used to be a plain lifetime average (every sample ever recorded
// counted equally) — a source's bias from 8 months ago held exactly as
// much sway as yesterday's. This makes it recency-weighted instead: an
// exponential moving average with roughly a 30-day "memory", so a source
// that's genuinely drifted (a model update, a change in local skew)
// gets picked up within about a month rather than being diluted by
// everything that came before. The classic N-period EMA smoothing
// constant, 2/(N+1), with N=30.
const FFV_EMA_ALPHA = 2 / (30 + 1);

// An existing entry (recorded before this change) has count/sumRatio/
// sumOffset but no ema fields yet — this seeds them ONCE from the
// lifetime average as a starting point, so switching to EMA doesn't
// throw away everything already learned; every sample after this point
// updates via the EMA blend instead of the plain running mean.
function ensureFFVEmaSeeded(entry) {
  if (entry.emaRatio === undefined) {
    entry.emaRatio = entry.count > 0 ? entry.sumRatio / entry.count : 1;
  }
  if (entry.emaOffset === undefined) {
    entry.emaOffset = entry.count > 0 ? entry.sumOffset / entry.count : 0;
  }
}

// Same recency-weighting, same reasoning, applied to the accuracy
// figures (raw and corrected error) rather than the correction itself —
// see recordFFVSample. Sharing FFV_EMA_ALPHA rather than a second
// constant is deliberate: there's no reason accuracy should have a
// shorter or longer memory than the correction it's judging.
const ACCURACY_EMA_ALPHA = FFV_EMA_ALPHA;

function ensureAccuracyEmaSeeded(entry) {
  if (entry.emaErrorRaw === undefined) {
    entry.emaErrorRaw = entry.count > 0 ? entry.sumAbsErrorRaw / entry.count : undefined;
  }
  if (entry.emaErrorCorrected === undefined) {
    entry.emaErrorCorrected = (entry.scoredCount ?? 0) > 0 ? entry.sumAbsErrorCorrected / entry.scoredCount : undefined;
  }
}

// Rain/Cloud/Wind are ratio quantities ("20% too high" is meaningful) so
// a multiplicative correction (mean × FFV) is right for them. Temperature
// in °C has no true zero — 20°C isn't "twice as hot" as 10°C — so a
// ratio correction can behave oddly near/below freezing. It gets an
// additive correction instead (mean + FFV), tracked as a separate running
// average alongside the ratio one, rather than reinterpreting.
function isRatioCondition(conditionName) {
  // Temperature, Pressure, Soil Temp, and Dew Point all sit on scales
  // without a practically-meaningful zero for this purpose — same
  // reasoning as Temperature/Pressure above, applied consistently to the
  // two newer °C-scale conditions.
  return !["temperature", "pressure", "soilTemperature", "dewPoint"].includes(conditionName);
}

function applyCorrection(mean, ffv, conditionName) {
  return isRatioCondition(conditionName) ? mean * ffv : mean + ffv;
}

// ---- In-memory read cache for the five per-area localStorage stores
// (FFV, eligibility, underperform, app-accuracy, accuracy-trend) ----
// Every one of these follows the exact same load-parses-JSON /
// save-stringifies-JSON shape, and every headline/table render calls
// several of them PER FORECASTER PER CONDITION — the Compare page alone
// re-derives Eligibility, FFV, and Underperform status for up to 20
// forecasters across 7 rows on every single render. None of that is a
// problem in isolation, but the Date and Hour sliders fire a full
// re-render on every "input" event while being dragged — not just on
// release — so a drag gesture could trigger this same expensive
// JSON.parse-from-localStorage fan-out dozens of times a second, on
// stores that only grow over a testing session (FFV/eligibility keep
// per-source-per-condition-per-day entries capped at 400). That's the
// real explanation for sliders, the "back to Cloude" link, and Compare's
// date scroller all feeling like they're wading through treacle: none of
// them are doing anything expensive themselves, they're just triggering
// a render that re-reads and re-parses megabytes' worth of localStorage
// from scratch, repeatedly, for data that hasn't actually changed since
// the last render.
//
// None of these five stores are ever mutated except through their own
// saveXStore() below (bookkeeping after a location load, or the
// Backfill action) — never read-modify-write via a stale intermediate,
// and never touched directly by anything else (Restore backup replaces
// localStorage wholesale but then forces a full page reload, which wipes
// this cache along with everything else in memory). So a simple
// per-areaCode cache, kept in sync by having saveXStore() write straight
// into it, is safe: a read either returns the same object last handed
// back for this areaCode (no disk hit at all), or — the first time this
// areaCode is asked for, or after a hard reload — does the one real
// parse and remembers it for next time.
const _perAreaStoreCache = new Map(); // "<kind>:<areaCode>" -> parsed store object

function cachedLoadStore(kind, areaCode, storageKey) {
  const cacheKey = `${kind}:${areaCode}`;
  if (_perAreaStoreCache.has(cacheKey)) return _perAreaStoreCache.get(cacheKey);
  let store;
  try {
    const raw = localStorage.getItem(storageKey);
    store = raw ? JSON.parse(raw) : {};
  } catch {
    store = {};
  }
  _perAreaStoreCache.set(cacheKey, store);
  return store;
}

function cachedSaveStore(kind, areaCode, storageKey, store) {
  _perAreaStoreCache.set(`${kind}:${areaCode}`, store);
  try {
    localStorage.setItem(storageKey, JSON.stringify(store));
  } catch {
    // Storage unavailable (e.g. private browsing) — this just won't
    // persist to the NEXT page load, but the cache above still keeps it
    // correct for the rest of THIS session rather than silently
    // reverting every read back to empty.
  }
}

function ffvStorageKey(areaCode) {
  return `forecast-compare:ffv:${areaCode}`;
}

function loadFFVStore(areaCode) {
  return cachedLoadStore("ffv", areaCode, ffvStorageKey(areaCode));
}

function saveFFVStore(areaCode, store) {
  cachedSaveStore("ffv", areaCode, ffvStorageKey(areaCode), store);
}

// ---- Eligibility: how many distinct CALENDAR DATES a source/condition
// pair has actually been compared against Actual for — kept as its own
// small store (separate from the FFV averages above) purely to avoid
// disturbing the existing day-keyed (1-7) shape those already use.
// This is deliberately dates, not sample count: updateFFVHistory can
// process the same rollback window more than once (e.g. reopening the
// app the same day), and a demo source has no backfill, so real time has
// to pass for this to grow — which is exactly what "2 weeks of data"
// should mean. Real sources cross the threshold immediately after their
// one-off backfill, since that already covers a year of distinct dates.
const ELIGIBILITY_MIN_DAYS = 14;

function eligibilityStorageKey(areaCode) {
  return `forecast-compare:eligibility:${areaCode}`;
}

function loadEligibilityStore(areaCode) {
  return cachedLoadStore("eligibility", areaCode, eligibilityStorageKey(areaCode));
}

function saveEligibilityStore(areaCode, store) {
  cachedSaveStore("eligibility", areaCode, eligibilityStorageKey(areaCode), store);
}

// ---- App's own accuracy ----
// Tracks how the app's own merged/weighted figure (the Compare table's
// "App" column) has actually done against real Actual — separate from
// any individual forecaster's FFV, since the merge isn't itself
// corrected against anything further (that would be circular); this is
// pure measurement, answering "is all this blending and weighting
// actually working?" rather than feeding back into it.
//
// Honest limitation: unlike real sources, there's no equivalent backfill
// for this — retroactively computing "what would the merge have said a
// year ago" would need the exact weights/eligibility that applied back
// then, which aren't preserved. So this only ever builds up from the
// same rolling 7-day live window everything else here uses, at roughly
// the same pace as a demo forecaster earning its own eligibility.
function appAccuracyStorageKey(areaCode) {
  return `forecast-compare:appAccuracy:${areaCode}`;
}

function loadAppAccuracyStore(areaCode) {
  return cachedLoadStore("appAccuracy", areaCode, appAccuracyStorageKey(areaCode));
}

function saveAppAccuracyStore(areaCode, store) {
  cachedSaveStore("appAccuracy", areaCode, appAccuracyStorageKey(areaCode), store);
}

// Recency-weighted the same way FFV itself is (see FFV_EMA_ALPHA below) —
// this used to be a plain lifetime average, which is exactly what the
// 370-day simulation exposed as misleading: a source (or, here, the
// app's own merge) that had a genuinely bad multi-month stretch would
// barely recover for MONTHS afterward even once behaving perfectly,
// because a few dozen good days can't meaningfully dilute a sum going
// back to day one. An EMA answers "how's it doing lately" instead of
// "how's it done ever", which is what "accuracy" should mean here.
function recordAppAccuracySample(store, conditionName, day, forecastValue, actual) {
  if (forecastValue === null || forecastValue === undefined) return;
  store[conditionName] ??= {};
  const entry = (store[conditionName][day] ??= { count: 0, sumAbsError: 0 });
  // An entry recorded before this change has count/sumAbsError but no
  // emaError yet — seed it ONCE from the lifetime average so switching
  // to EMA doesn't throw away everything already measured.
  if (entry.emaError === undefined) {
    entry.emaError = entry.count > 0 ? entry.sumAbsError / entry.count : undefined;
  }
  const error = Math.abs(forecastValue - actual);
  entry.emaError = entry.emaError === undefined ? error : FFV_EMA_ALPHA * error + (1 - FFV_EMA_ALPHA) * entry.emaError;
  entry.count += 1;
}

function appAccuracyStatsFor(conditionName) {
  if (!state.areaCode) return null;
  const store = loadAppAccuracyStore(state.areaCode);
  const byDay = store[conditionName];
  if (!byDay) return null;

  // Each lead-day (1-7) has its own EMA — combined here as a
  // count-weighted average across them, so a lead-day with barely any
  // samples yet doesn't pull the combined figure as hard as one with a
  // long track record.
  let count = 0, weightedSum = 0;
  Object.values(byDay).forEach(entry => {
    if (entry.emaError === undefined) {
      entry.emaError = entry.count > 0 ? entry.sumAbsError / entry.count : undefined;
    }
    count += entry.count;
    if (entry.emaError !== undefined) weightedSum += entry.emaError * entry.count;
  });
  if (count === 0) return null;
  return { count, avgError: weightedSum / count };
}

// ---- Accuracy over time ----
// appAccuracyStatsFor above only ever answers "what's the app's accuracy
// right now" — it has no memory of what that number used to be, so there
// was no way to see whether the merge is actually improving over time,
// which is a big part of the point of learning FFV in the first place.
// This keeps a separate, small time series: one snapshot of that same
// avgError per condition, once per calendar day, capped so it can't grow
// forever. Deliberately just the App's own merged figure rather than
// every individual forecaster too — that would multiply the storage and
// the graph's complexity a lot for a question ("is my blend of everyone
// actually getting better") this already answers on its own.
const ACCURACY_TREND_MAX_POINTS = 120; // roughly 4 months of daily snapshots

function accuracyTrendStorageKey(areaCode) {
  return `forecast-compare:accuracyTrend:${areaCode}`;
}

function loadAccuracyTrendStore(areaCode) {
  return cachedLoadStore("accuracyTrend", areaCode, accuracyTrendStorageKey(areaCode));
}

function saveAccuracyTrendStore(areaCode, store) {
  cachedSaveStore("accuracyTrend", areaCode, accuracyTrendStorageKey(areaCode), store);
}

// Appends today's snapshot for every condition that has an accuracy
// figure yet, once per calendar day (checked against the series' own
// last entry, not a separate "last run" flag, so it self-corrects if a
// day is skipped rather than drifting out of step with what's actually
// stored). Called once per page load, after updateFFVHistory() has
// already recorded today's samples into appAccuracyStore.
function updateAccuracyTrend() {
  if (!state.areaCode) return;
  const today = isoDate(new Date());
  const store = loadAccuracyTrendStore(state.areaCode);
  let changed = false;

  Object.keys(CONFIG.conditions).forEach(conditionName => {
    const stats = appAccuracyStatsFor(conditionName);
    if (!stats) return;
    const series = (store[conditionName] ??= []);
    if (series.length && series[series.length - 1].date === today) return; // already snapshotted today
    series.push({ date: today, avgError: stats.avgError });
    if (series.length > ACCURACY_TREND_MAX_POINTS) {
      series.splice(0, series.length - ACCURACY_TREND_MAX_POINTS);
    }
    changed = true;
  });

  if (changed) saveAccuracyTrendStore(state.areaCode, store);
}

function markDateSeen(eligStore, conditionName, sourceId, dateKey) {
  if (!dateKey) return;
  eligStore[conditionName] ??= {};
  eligStore[conditionName][sourceId] ??= {};
  eligStore[conditionName][sourceId][dateKey] = true;
  // Cap so a long-running real source's entry can't grow forever —
  // nothing beyond ELIGIBILITY_MIN_DAYS is ever needed for the threshold
  // check, so trimming the oldest dates loses nothing meaningful.
  const keys = Object.keys(eligStore[conditionName][sourceId]);
  if (keys.length > 400) {
    keys.sort().slice(0, keys.length - 400).forEach(k => delete eligStore[conditionName][sourceId][k]);
  }
}

function daysSeenCount(eligStore, conditionName, sourceId) {
  return Object.keys(eligStore[conditionName]?.[sourceId] ?? {}).length;
}

function daysSeenFor(source, conditionName) {
  if (!state.areaCode) return 0;
  return daysSeenCount(loadEligibilityStore(state.areaCode), conditionName, source.id);
}

// Whether this source has earned a place in the live merge/Compare view
// for this condition yet — see ELIGIBILITY_MIN_DAYS above. Deliberately
// separate from ffvFor's own FFV_MIN_SAMPLES gate (which only asks "is
// there enough to compute a correction at all") — this is the stricter,
// user-facing "has this been watched for two weeks" bar.
function isForecasterEligible(source, conditionName) {
  return daysSeenFor(source, conditionName) >= ELIGIBILITY_MIN_DAYS;
}

// 3-day mean for a given day-out row, at whatever target date the current
// rollback resolves to. Day 1 averages with day 2 only (no "day 0"
// forecast exists). Day 7 tries an invisible day 8 point — for demo
// sources that's just the formula one step further out; for real Met
// Office data there's no day-8 lead time, so forecastValueFor returns
// null for it and this quietly falls back to a 2-point mean instead,
// without ever mixing real and demo values in the same average.
function threeDayMean(day, source, conditionName, rollbackDays) {
  const days = day === 1 ? [1, 2] : day === 7 ? [6, 7, 8] : [day - 1, day, day + 1];
  const values = days
    .map(d => forecastValueFor(d, source, conditionName, rollbackDays))
    .filter(v => v !== null && v !== undefined);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clampRatio(ratio) {
  return Math.min(FFV_RATIO_CLAMP[1], Math.max(FFV_RATIO_CLAMP[0], ratio));
}

function clampOffset(offset) {
  return Math.min(FFV_OFFSET_CLAMP[1], Math.max(FFV_OFFSET_CLAMP[0], offset));
}

// Records one (mean, actual) sample into the FFV store, extended to also
// track accuracy: the raw error is straightforward (|mean - actual|).
// The corrected error is scored using the FFV as it stood BEFORE this
// sample is folded in — an honest, non-circular "how would today's
// correction have done on this one" rather than retroactively applying
// the final FFV to old data. Scoring only starts once FFV_MIN_SAMPLES is
// already met, since there's no meaningful correction before that.
//
// Both error figures are EMA-tracked (see FFV_EMA_ALPHA), same as the
// correction itself — this used to be a plain lifetime average, which a
// 370-day simulation showed was genuinely misleading: a source that had
// one bad multi-month stretch stayed flagged as underperforming for
// months after it had gone back to being perfectly fine, since a lifetime
// sum can't be meaningfully diluted by a comparatively short good streak.
// An EMA answers "how's it been doing lately", which is what both the
// Accuracy table and the underperformance check actually want to know.
function recordFFVSample(store, conditionName, sourceId, day, mean, actual, eligStore, dateKey) {
  if (!mean) return; // guards against divide-by-zero ratios
  if (eligStore) markDateSeen(eligStore, conditionName, sourceId, dateKey);

  store[conditionName] ??= {};
  store[conditionName][sourceId] ??= {};
  const entry = (store[conditionName][sourceId][day] ??= {
    count: 0,
    sumRatio: 0,
    sumOffset: 0,
    sumAbsErrorRaw: 0,
    scoredCount: 0,
    sumAbsErrorCorrected: 0
  });
  ensureFFVEmaSeeded(entry);
  ensureAccuracyEmaSeeded(entry);

  const rawError = Math.abs(mean - actual);
  entry.emaErrorRaw = entry.emaErrorRaw === undefined ? rawError : ACCURACY_EMA_ALPHA * rawError + (1 - ACCURACY_EMA_ALPHA) * entry.emaErrorRaw;

  if (entry.count >= FFV_MIN_SAMPLES) {
    const currentFFV = isRatioCondition(conditionName) ? entry.emaRatio : entry.emaOffset;
    const correctedError = Math.abs(applyCorrection(mean, currentFFV, conditionName) - actual);
    entry.emaErrorCorrected = entry.emaErrorCorrected === undefined ? correctedError : ACCURACY_EMA_ALPHA * correctedError + (1 - ACCURACY_EMA_ALPHA) * entry.emaErrorCorrected;
    entry.scoredCount += 1;
  }

  const newRatio = clampRatio(actual / mean);
  const newOffset = clampOffset(actual - mean);
  // EMA blend — the very first sample simply becomes the starting value
  // rather than being diluted by the neutral 1/0 default.
  entry.emaRatio = entry.count === 0 ? newRatio : FFV_EMA_ALPHA * newRatio + (1 - FFV_EMA_ALPHA) * entry.emaRatio;
  entry.emaOffset = entry.count === 0 ? newOffset : FFV_EMA_ALPHA * newOffset + (1 - FFV_EMA_ALPHA) * entry.emaOffset;

  // Kept for eligibility gating and as the one-time seed for the EMAs
  // above on an entry recorded before this change — no longer used to
  // derive either the correction or the accuracy figures directly.
  entry.sumRatio += newRatio;
  entry.sumOffset += newOffset;
  entry.count += 1;
}

// Sweeps every rollback position with a known Actual value and folds each
// (mean, actual) pair into the running per-day FFV average for this area,
// for every DEMO source. Real sources are deliberately excluded here —
// their FFV data comes from the committed history file instead (see
// loadCommittedHistory), which is the single, de-duplicated source of
// truth for them. Re-running this for the same rollback window on every
// page load WOULD double-count if real sources were included, since a
// revisit re-adds the same days; the committed-history replay avoids
// that by rebuilding from scratch each time rather than incrementing.
function updateFFVHistory() {
  if (!state.areaCode || state.actual.status !== "ready") return;

  const store = loadFFVStore(state.areaCode);
  const eligStore = loadEligibilityStore(state.areaCode);
  const appStore = loadAppAccuracyStore(state.areaCode);
  const realIds = realSourceIds();

  for (let rollbackDays = 1; rollbackDays <= MAX_ROLLBACK; rollbackDays++) {
    const dateKey = isoDate(targetDateForRollback(rollbackDays));
    Object.keys(CONFIG.conditions).forEach(conditionName => {
      const actual = actualValueFor(conditionName, rollbackDays);
      if (actual === null || actual === undefined) return;

      // The app's own merge, scored at every lead-time — same figure the
      // Compare table's App column shows for that row, checked directly
      // against what actually happened.
      for (let day = 1; day <= 7; day++) {
        const forecast = mergedValueFor(conditionName, day, rollbackDays);
        recordAppAccuracySample(appStore, conditionName, day, forecast, actual);
      }

      CONFIG.forecasters
        .filter(source => !realIds.includes(source.id))
        .forEach(source => {
          for (let day = 1; day <= 7; day++) {
            const mean = threeDayMean(day, source, conditionName, rollbackDays);
            if (!mean) continue; // skip zero/near-zero means, avoids ratio blow-ups
            recordFFVSample(store, conditionName, source.id, day, mean, actual, eligStore, dateKey);
          }
        });
    });
  }

  saveFFVStore(state.areaCode, store);
  saveEligibilityStore(state.areaCode, eligStore);
  saveAppAccuracyStore(state.areaCode, appStore);
}

// Returns the learned FFV for this source/condition/day, or null if there
// isn't enough history yet to trust it. For Temperature this is an
// additive offset (°C); for everything else, a multiplicative ratio —
// see applyCorrection for how each gets used.
function ffvFor(source, conditionName, day) {
  if (!state.areaCode) return null;
  const store = loadFFVStore(state.areaCode);
  const entry = store[conditionName]?.[source.id]?.[day];
  if (!entry || entry.count < FFV_MIN_SAMPLES) return null;
  ensureFFVEmaSeeded(entry); // handles reading an entry untouched since this update
  return isRatioCondition(conditionName) ? entry.emaRatio : entry.emaOffset;
}

// The corrected (FFV-adjusted) value now gets its own column to the left
// of each forecaster's raw column (see renderTable). This inline per-cell
// hint predates that and is now redundant — kept in code, just not
// rendered, rather than deleted outright.
const SHOW_INLINE_FFV_HINT = false;

function ffvSampleTotal(conditionName) {
  if (!state.areaCode) return 0;
  const store = loadFFVStore(state.areaCode);
  const bySource = store[conditionName];
  if (!bySource) return 0;
  return Object.values(bySource).reduce((sum, byDay) => {
    return sum + Object.values(byDay).reduce((s, e) => s + e.count, 0);
  }, 0);
}

// Approximate 0-100 closeness scale per condition — the error (in real
// units) at which the score bottoms out at 0. Deliberately simple, not a
// formal statistic; the average-error-in-units figure is the primary one.
const ACCURACY_SCALE = { rain: 5, cloud: 60, wind: 15, temperature: 8, pressure: 8, sunshine: 4, uv: 3, soilTemperature: 4, dewPoint: 6 };

function accuracyPercent(avgError, conditionName) {
  if (avgError === null) return null;
  const scale = ACCURACY_SCALE[conditionName] ?? 10;
  return Math.max(0, Math.min(100, 100 * (1 - avgError / scale)));
}

// Weighted average error across all 7 lead-time days for one source and
// condition — a single "how far off is this source, typically" figure
// rather than 7 separate per-day numbers. Weighted by sample count, not
// averaged-of-averages, so days with more history count proportionally.
function accuracyStatsFor(source, conditionName) {
  if (!state.areaCode) return null;
  const store = loadFFVStore(state.areaCode);
  const byDay = store[conditionName]?.[source.id];
  if (!byDay) return null;

  // Each lead-day (1-7) has its own EMA — combined here as a
  // count-weighted average across them, same reasoning as
  // appAccuracyStatsFor: a lead-day with barely any samples yet
  // shouldn't pull the combined figure as hard as one with a long track
  // record.
  let count = 0, weightedRawSum = 0, scoredCount = 0, weightedCorrectedSum = 0;
  Object.values(byDay).forEach(entry => {
    ensureAccuracyEmaSeeded(entry); // handles an entry untouched since this change
    count += entry.count;
    if (entry.emaErrorRaw !== undefined) weightedRawSum += entry.emaErrorRaw * entry.count;
    const sCount = entry.scoredCount ?? 0;
    scoredCount += sCount;
    if (entry.emaErrorCorrected !== undefined) weightedCorrectedSum += entry.emaErrorCorrected * sCount;
  });

  if (count === 0) return null;

  return {
    count,
    avgErrorRaw: weightedRawSum / count,
    scoredCount,
    avgErrorCorrected: scoredCount > 0 ? weightedCorrectedSum / scoredCount : null
  };
}



function formatError(avgError, conditionName, mode) {
  if (avgError === null) return "–";
  const unitsText = `±${formatValue(avgError, conditionName, true)}${unitLabel(conditionName)}`;
  const percentText = `${Math.round(accuracyPercent(avgError, conditionName))}%`;

  if (mode === "units") return unitsText;
  if (mode === "percent") return percentText;
  return `${unitsText} (${percentText})`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The headline figure: for each of the four displayed conditions, the
// median across every CHOSEN forecaster's day-1 value (Corrected where
// enough samples exist, Raw otherwise) at the current target date. Median
// rather than mean deliberately — a single wildly-off value (e.g. a stray
// 45°C in November) gets outvoted rather than dragging an average off
// course, with no arbitrary rejection threshold needed.
// Rain/Temperature/Wind are always shown — the "obvious" ones nobody
// would want to hide. Pressure, Sunshine, Soil Temp, and Dew Point are
// each individually toggleable from Settings, so the front page only
// shows what a given person actually finds useful — Sunshine matters a
// lot to a gardener, barely at all to someone else, and there's no
// reason to force either way.
const HEADLINE_CORE_CONDITIONS = ["rain", "temperature", "wind"];
const HEADLINE_OPTIONAL_CONDITIONS = ["pressure", "sunshine", "soilTemperature", "dewPoint", "tide"];
const HEADLINE_TOGGLES_KEY = "forecast-compare:headlineToggles";
const DEFAULT_HEADLINE_TOGGLES = {
  pressure: true,
  sunshine: true,
  soilTemperature: false,
  dewPoint: false,
  tide: false
};

function loadHeadlineToggles() {
  let stored = {};
  try {
    const raw = localStorage.getItem(HEADLINE_TOGGLES_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_HEADLINE_TOGGLES, ...stored };
}

function saveHeadlineToggle(conditionName, enabled) {
  const toggles = loadHeadlineToggles();
  toggles[conditionName] = enabled;
  try {
    localStorage.setItem(HEADLINE_TOGGLES_KEY, JSON.stringify(toggles));
  } catch {
    // Storage unavailable — choice just won't persist between visits.
  }
}

function activeHeadlineConditions() {
  const toggles = loadHeadlineToggles();
  return [...HEADLINE_CORE_CONDITIONS, ...HEADLINE_OPTIONAL_CONDITIONS.filter(c => toggles[c])];
}

// The freshest available real forecast for the current target date. For
// past/today (rollback >= 0) that's always day 1 — the closest forecast
// issued before the target. For a future target, day 1 doesn't exist yet
// (it'd need to be issued after today) — the freshest REAL data is
// whichever lead-time equals how far ahead the target is, since that's
// the one issued today. Using day 1 unconditionally would silently fall
// back to demo data for anything more than a day ahead.
function freshestDayFor(rollbackDays) {
  if (rollbackDays >= 0) return 1;
  return Math.min(7, Math.max(1, -rollbackDays));
}

function weightedMedian(entries) {
  const valid = entries.filter(e => e.value !== null && e.value !== undefined && e.weight > 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, e) => sum + e.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= totalWeight / 2) return entry.value;
  }
  return sorted[sorted.length - 1].value;
}

// A source's say in the merged figure, based on its own Corrected
// accuracy — lower error means more weight, higher error means less,
// rather than every eligible source getting an equal vote regardless of
// track record. Falls back to a flat weight (1) whenever there isn't
// enough scored history to trust the comparison yet (under 5 scored
// samples), so a source never gets down-weighted on a fluke before it's
// had a fair chance to prove itself either way.
function sourceWeight(source, conditionName) {
  const stats = accuracyStatsFor(source, conditionName);
  if (!stats || stats.avgErrorCorrected === null || stats.scoredCount < 5) return 1;
  const scale = ACCURACY_SCALE[conditionName] ?? 1;
  return 1 / (0.2 + stats.avgErrorCorrected / scale);
}

// ---- Underperformance tracking ----
// A source that's been notably worse than its peers for a sustained
// stretch is quietly left out of the merge — not removed from the
// user's selection, just not counted here, at THIS location, for THIS
// condition. Tracked separately per postcode area (like FFV itself),
// so a source that struggles in hilly terrain but is fine somewhere
// flat isn't penalised everywhere just because of one place.
const POOR_ACCURACY_MIN_DAYS = 30; // deliberately well past the 14-day eligibility bar — long enough to be a pattern, not a bad fortnight
const POOR_ACCURACY_RATIO = 1.5; // must be at least this many times worse than the peer median to count as underperforming
const HOME_ESCALATION_DAYS = 14; // if a flagged notice sits unacknowledged this long, it also surfaces on the front page

function underperformStorageKey(areaCode) {
  return `forecast-compare:underperform:${areaCode}`;
}

function loadUnderperformStore(areaCode) {
  return cachedLoadStore("underperform", areaCode, underperformStorageKey(areaCode));
}

function saveUnderperformStore(areaCode, store) {
  cachedSaveStore("underperform", areaCode, underperformStorageKey(areaCode), store);
}

function daysSince(dateStr) {
  const then = new Date(dateStr + "T00:00:00Z").getTime();
  return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
}

// Recomputes, from accuracy stats alone, which selected sources currently
// qualify as underperforming for one condition. Needs at least 2 peers
// with their own scored history — "worse than the others" is meaningless
// with no others to compare against.
function computeUnderperformingIds(conditionName) {
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));
  const scored = selectedSources
    .filter(source => daysSeenFor(source, conditionName) >= POOR_ACCURACY_MIN_DAYS)
    .map(source => ({ source, stats: accuracyStatsFor(source, conditionName) }))
    .filter(entry => entry.stats && entry.stats.avgErrorCorrected !== null);

  if (scored.length < 3) return [];

  return scored
    .filter(entry => {
      const peerErrors = scored.filter(e => e.source.id !== entry.source.id).map(e => e.stats.avgErrorCorrected);
      const peerMedian = median(peerErrors);
      return peerMedian !== null && peerMedian > 0 && entry.stats.avgErrorCorrected > peerMedian * POOR_ACCURACY_RATIO;
    })
    .map(entry => entry.source.id);
}

// Runs once per page load (see loadLocationData) so the flag store stays
// current everywhere — Compare's notice and the front page's escalation
// banner both just read whatever this last wrote, rather than each
// recomputing the accuracy comparison themselves.
function syncUnderperformFlags() {
  if (!state.areaCode) return;
  const store = loadUnderperformStore(state.areaCode);
  const today = isoDate(new Date());

  Object.keys(CONFIG.conditions).forEach(conditionName => {
    const badIds = new Set(computeUnderperformingIds(conditionName));
    store[conditionName] ??= {};

    badIds.forEach(id => {
      store[conditionName][id] ??= { firstFlagged: today, dismissed: null };
    });
    // A source no longer underperforming clears entirely — if it slips
    // again later, that's treated as a fresh episode with its own timer.
    Object.keys(store[conditionName]).forEach(id => {
      if (!badIds.has(id)) delete store[conditionName][id];
    });
  });

  saveUnderperformStore(state.areaCode, store);
}

function isUnderperforming(source, conditionName) {
  if (!state.areaCode) return false;
  const store = loadUnderperformStore(state.areaCode);
  return !!store[conditionName]?.[source.id];
}

// ---- Compare page: quiet per-condition notice ----
// Shows for whichever condition is currently selected — matches "in the
// accuracy table" framing, since that's where the comparison this is
// based on lives. Only the oldest undismissed flag for this condition is
// shown at once, to avoid stacking up notices.
function renderUnderperformNotice() {
  const el = document.getElementById("underperformNotice");
  if (!el) return;
  if (!state.areaCode) { el.hidden = true; return; }

  const store = loadUnderperformStore(state.areaCode);
  const entries = Object.entries(store[state.condition] ?? {}).filter(([, flag]) => !flag.dismissed);
  if (!entries.length) { el.hidden = true; return; }

  entries.sort((a, b) => a[1].firstFlagged.localeCompare(b[1].firstFlagged));
  const [sourceId, flag] = entries[0];
  const source = CONFIG.forecasters.find(s => s.id === sourceId);
  const conditionData = CONFIG.conditions[state.condition];

  el.hidden = false;
  el.innerHTML = "";
  const text = document.createElement("p");
  text.textContent = `${source ? source.name : sourceId}'s ${conditionData.name} forecasts have been notably less accurate than the others here for over ${POOR_ACCURACY_MIN_DAYS} days, so it's being left out of the merged figure for ${conditionData.name} for now.`;
  el.appendChild(text);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.textContent = "Got it";
  dismissBtn.addEventListener("click", () => {
    const freshStore = loadUnderperformStore(state.areaCode);
    if (freshStore[state.condition]?.[sourceId]) {
      freshStore[state.condition][sourceId].dismissed = isoDate(new Date());
      saveUnderperformStore(state.areaCode, freshStore);
    }
    renderUnderperformNotice();
  });
  el.appendChild(dismissBtn);
}

// ---- Front page: escalation banner ----
// Only reached if a Compare notice has sat undismissed for
// HOME_ESCALATION_DAYS — a quiet nudge that's been ignored long enough
// to warrant a more visible one, not a duplicate of the same message.
function findEscalatedUnderperformance() {
  if (!state.areaCode) return null;
  const store = loadUnderperformStore(state.areaCode);
  for (const conditionName of Object.keys(CONFIG.conditions)) {
    for (const [sourceId, flag] of Object.entries(store[conditionName] ?? {})) {
      if (!flag.dismissed && daysSince(flag.firstFlagged) >= HOME_ESCALATION_DAYS) {
        return { conditionName, sourceId, flag };
      }
    }
  }
  return null;
}

function renderUnderperformBanner() {
  const el = document.getElementById("underperformBanner");
  if (!el) return;

  const found = findEscalatedUnderperformance();
  if (!found) { el.hidden = true; return; }

  const source = CONFIG.forecasters.find(s => s.id === found.sourceId);
  const conditionData = CONFIG.conditions[found.conditionName];

  el.hidden = false;
  el.innerHTML = "";
  const text = document.createElement("p");
  text.textContent = `${source ? source.name : found.sourceId} has been a consistently weaker ${conditionData.name} forecaster here for a while now.`;
  el.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "underperform-banner-actions";

  const reviewLink = document.createElement("a");
  reviewLink.href = "compare.html";
  reviewLink.textContent = "Review in Compare";
  actions.appendChild(reviewLink);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => {
    const freshStore = loadUnderperformStore(state.areaCode);
    if (freshStore[found.conditionName]?.[found.sourceId]) {
      freshStore[found.conditionName][found.sourceId].dismissed = isoDate(new Date());
      saveUnderperformStore(state.areaCode, freshStore);
    }
    renderUnderperformBanner();
  });
  actions.appendChild(dismissBtn);

  el.appendChild(actions);
}

// The app's own weighted-merge figure at a SPECIFIC lead-time (day) for
// a specific target date (rollbackDays) — the core merge logic, shared
// by the headline (which always wants the freshest lead-time) and the
// Compare table's own "App" column (which wants this at every lead-time
// row, so each forecaster's Raw/Corrected can be checked directly
// against what the app itself would have said at that same lead-time).
function mergedValueFor(conditionName, day, rollbackDays) {
  const sourcesToUse = eligibleOrFallbackSources(conditionName);

  const entries = sourcesToUse.map(source => {
    const ffv = ffvFor(source, conditionName, day);
    let value = null;
    if (ffv !== null) {
      const mean = threeDayMean(day, source, conditionName, rollbackDays);
      if (mean !== null) value = applyCorrection(mean, ffv, conditionName);
    }
    if (value === null || value === undefined) {
      value = forecastValueFor(day, source, conditionName, rollbackDays);
    }
    return { value, weight: sourceWeight(source, conditionName) };
  });
  return weightedMedian(entries);
}

function headlineValueFor(conditionName) {
  return mergedValueFor(conditionName, freshestDayFor(state.rollback), state.rollback);
}

function currentHourDate() {
  const iso = state.hourly.times[state.hourIndex];
  return iso ? new Date(iso) : new Date();
}

// Reuses the existing daily FFV rather than a new hour-specific one —
// day 1's correction for the first 24h, day 2's beyond that. Slower to
// mature would mean starting from zero across dozens of buckets instead
// of borrowing history that's already there.
function hourlyValueFor(conditionName) {
  if (state.hourly.status !== "ready") return null;
  const idx = state.hourIndex;
  if (idx === null || idx === undefined) return null;

  // state.hourly.{precipitation,temperature,windSpeed} are already a
  // median across every real source, each corrected by its own FFV —
  // built once in fetchHourlyForecast so every consumer (this readout,
  // the graphs, wind direction) shares the same figures rather than
  // each applying correction separately.
  switch (conditionName) {
    case "rain": return state.hourly.precipitation[idx] ?? null;
    case "wind": return state.hourly.windSpeed[idx] ?? null;
    case "temperature": return state.hourly.temperature[idx] ?? null;
    case "pressure": return state.hourly.pressure[idx] ?? null;
    case "soilTemperature": return state.hourly.soilTemperature[idx] ?? null;
    case "dewPoint": return state.hourly.dewPoint[idx] ?? null;
    default: return null; // Sunshine has no hourly reading — see renderHeadline
  }
}

// Direction can't be medianed across sources the way speed can (it's
// angular, not linear) — this just takes the first real source that has
// a direction available, in REAL_SOURCES order.
function anyRealWindDirection(day, rollbackDays) {
  for (const { id } of REAL_SOURCES) {
    const direction = realSourceWindDirectionFor(id, day, rollbackDays);
    if (direction !== null) return direction;
  }
  return null;
}

// ---- "Today" specifically: forward-looking, matching the graph ----
// Every other date on the slider (past or future) has to use a fixed
// forecast snapshot — FFV training needs a stable "this was forecast,
// this is what happened" pair, and a constantly-shifting live number
// would make that comparison meaningless. "Today" doesn't need to be a
// training sample to be shown, so it uses the freshest information
// instead — but it must show the SAME thing the graph/hour-slider show,
// or the two can silently disagree (this used to blend in what had
// already happened today, which could make the headline read higher —
// or the low read warmer — than anything actually still forecast,
// confusingly, since the graph never included that past portion).
// Purely forward-looking now: the next 24 or 48 hours from right now
// (matching the Settings hour-range choice), nothing before it.
function displayWindowHourCount() {
  return Math.min(loadHourRange(), state.hourly.times.length);
}

// Returns null for anything without a live path (currently Sunshine —
// there's no hourly sunshine feed to build one from) so the caller can
// fall back to the usual snapshot. Temperature and Wind aren't handled
// here — they have their own dedicated range/pair functions below,
// reached first in renderHeadline.
function liveTodayValueFor(conditionName) {
  const count = displayWindowHourCount();

  switch (conditionName) {
    case "rain":
      return state.hourly.precipitation
        .slice(0, count)
        .reduce((sum, v) => sum + (v ?? 0), 0);
    case "pressure":
      return state.hourly.pressure[0] ?? null;
    // Same shape as Pressure: both are point-in-time readings, not a
    // running total the way Rain is, so "now" is the right figure — this
    // was simply missed when Soil Temp/Dew Point were added as headline
    // conditions, leaving them stuck on the older daily-snapshot figure
    // even once the live hourly data (fetched for both already, see
    // fetchHourlyForecast) was sitting there ready to use.
    case "soilTemperature":
      return state.hourly.soilTemperature[0] ?? null;
    case "dewPoint":
      return state.hourly.dewPoint[0] ?? null;
    default:
      return null;
  }
}

// Shared by the headline and the range/pair helpers below: prefer
// sources that have earned their place (eligibility) AND aren't
// currently flagged as underperforming here, fall back progressively
// looser only when that leaves nothing to work with.
function eligibleOrFallbackSources(conditionName) {
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));
  const eligibleSources = selectedSources.filter(source => isForecasterEligible(source, conditionName));
  const goodSources = eligibleSources.filter(source => !isUnderperforming(source, conditionName));
  if (goodSources.length > 0) return goodSources;
  // Every eligible source happens to be flagged — better to still use
  // them than collapse all the way back to unfiltered/demo fallback.
  if (eligibleSources.length > 0) return eligibleSources;
  const realSources = selectedSources.filter(source => isRealSource(source, conditionName));
  return realSources.length > 0 ? realSources : selectedSources;
}

// ---- Temperature high/low ----
// rollbackDays follows the same convention as the rest of the app:
// positive = N days ago (genuine actual), 0 = today, negative = N days
// ahead (forecast only).
function temperatureRangeFor(rollbackDays) {
  if (rollbackDays > 0) {
    const idx = actualIndexForRollback(rollbackDays);
    const max = idx !== null ? state.actual.temperature_2m_max[idx] : null;
    const min = idx !== null ? state.actual.temperature_2m_min[idx] : null;
    if (max === null || max === undefined || min === null || min === undefined) return null;
    return { low: min, high: max };
  }

  if (rollbackDays === 0 && state.hourly.status === "ready") {
    // Purely forward-looking — the same next-24/48h window the graph and
    // hour slider show, so this can never disagree with them the way
    // blending in what already happened today used to.
    const count = displayWindowHourCount();
    const windowTemps = state.hourly.temperature.slice(0, count).filter(v => v !== null && v !== undefined);
    if (windowTemps.length) return { low: Math.min(...windowTemps), high: Math.max(...windowTemps) };
  }

  // Future (or today with hourly not ready yet): merge every eligible
  // source's own forecast high/low, each corrected by Temperature's own
  // learned offset — there's no separate FFV history for the spread
  // itself, so the mean's own correction is the closest available.
  const day = freshestDayFor(rollbackDays);
  const highs = [];
  const lows = [];
  eligibleOrFallbackSources("temperature").forEach(source => {
    const weight = sourceWeight(source, "temperature");
    const ffv = ffvFor(source, "temperature", day);
    if (isRealSource(source, "temperature") && day <= 7) {
      const slot = state.realSources[source.id];
      const idx = realSourceIndexForRollback(source.id, rollbackDays);
      const byDay = slot?.byLeadDay?.[day];
      if (slot?.status === "ready" && idx !== null && byDay) {
        const max = byDay.tempMax[idx];
        const min = byDay.tempMin[idx];
        if (max !== null && max !== undefined) highs.push({ value: ffv !== null ? applyCorrection(max, ffv, "temperature") : max, weight });
        if (min !== null && min !== undefined) lows.push({ value: ffv !== null ? applyCorrection(min, ffv, "temperature") : min, weight });
        return;
      }
    }
    // Demo sources have no real max/min concept — approximate a diurnal
    // spread around the single demo figure rather than showing nothing.
    const mean = demoValue(day, source, "temperature");
    if (mean !== null && mean !== undefined) {
      const corrected = ffv !== null ? applyCorrection(mean, ffv, "temperature") : mean;
      highs.push({ value: corrected + 2.5, weight });
      lows.push({ value: corrected - 2.5, weight });
    }
  });
  if (!highs.length || !lows.length) return null;
  return { low: weightedMedian(lows), high: weightedMedian(highs) };
}

// ---- Frost risk (Temperature cell tint, Today only) ----
// A simple, well-established combination rather than a bare temperature
// threshold: ground frost forms when it's cold AND skies are clear AND
// wind is light — clear skies let heat radiate away overnight, and wind
// mixing prevents that radiative cooling. A low reading alone, with
// cloud holding heat in or wind keeping the air stirred, often doesn't
// actually frost. Deliberately just a colour tint — no text, no
// notification — the "gentle nudge" this was asked for, not another
// warning to grow fatigued by.
const FROST_TEMP_THRESHOLD = 2; // °C — ground frost can form even when air temp reads a little above freezing
const FROST_CLOUD_THRESHOLD = 40; // % — below this counts as "clear enough"
const FROST_WIND_THRESHOLD = 8; // mph — below this counts as "light enough"

function frostRiskTonight() {
  if (state.hourly.status !== "ready") return false;
  const count = displayWindowHourCount();
  const temps = state.hourly.temperature.slice(0, count);
  if (!temps.length) return false;

  let minIdx = -1;
  let minTemp = Infinity;
  temps.forEach((v, i) => {
    if (v !== null && v !== undefined && v < minTemp) {
      minTemp = v;
      minIdx = i;
    }
  });
  if (minIdx === -1 || minTemp > FROST_TEMP_THRESHOLD) return false;

  const cloud = state.hourly.cloudCover?.[minIdx];
  const wind = state.hourly.windSpeed?.[minIdx];
  if (cloud === null || cloud === undefined || wind === null || wind === undefined) return false;

  return cloud < FROST_CLOUD_THRESHOLD && wind < FROST_WIND_THRESHOLD;
}

// ---- Wind speed / gust pairing ----
// A gust reading only earns its own callout (headline's "gust X" line,
// the graph's scrubber readout) once it's genuinely higher than sustained
// speed — always in native mph regardless of the display unit, so the
// bar doesn't quietly shift depending on someone's mph/km-h setting. A
// couple of mph either side of sustained speed is well within normal
// noise for a model's own gust parameter, not a "gust" worth naming. The
// gust LINE on the graph itself still draws throughout — this only
// gates the text callouts, since the line is useful context for the
// whole day's shape even on an otherwise calm one.
const GUST_NOTABLE_MARGIN_MPH = 5;

function windGustValueFor(day, source, rollbackDays) {
  if (isRealSource(source, "wind") && day <= 7) {
    const slot = state.realSources[source.id];
    const idx = realSourceIndexForRollback(source.id, rollbackDays);
    const byDay = slot?.byLeadDay?.[day];
    if (slot?.status === "ready" && idx !== null && byDay) {
      const gust = byDay.windGust[idx];
      if (gust !== null && gust !== undefined) {
        const ffv = ffvFor(source, "wind", day); // Gust has no FFV history of its own — Wind's ratio is the nearest available correction.
        return ffv !== null ? applyCorrection(gust, ffv, "wind") : gust;
      }
    }
  }
  const demoWind = demoValue(day, source, "wind");
  return demoWind !== null && demoWind !== undefined ? demoWind * 1.4 : null; // ~1.4x sustained is a conventional gust-factor approximation
}

function windSpeedGustFor(rollbackDays) {
  if (rollbackDays > 0) {
    const idx = actualIndexForRollback(rollbackDays);
    const speed = idx !== null ? state.actual.windspeed_10m_max[idx] : null;
    const gust = idx !== null ? state.actual.windgusts_10m_max[idx] : null;
    if (speed === null || speed === undefined) return null;
    return { speed, gust: gust ?? null };
  }

  if (rollbackDays === 0 && state.hourly.status === "ready") {
    // Purely forward-looking, same window as the graph/slider — see
    // temperatureRangeFor's comment for why this no longer blends in
    // what's already happened today.
    const count = displayWindowHourCount();
    const windowSpeeds = state.hourly.windSpeed.slice(0, count).filter(v => v !== null && v !== undefined);
    const windowGusts = state.hourly.windGust.slice(0, count).filter(v => v !== null && v !== undefined);
    if (windowSpeeds.length) {
      return {
        speed: Math.max(...windowSpeeds),
        gust: windowGusts.length ? Math.max(...windowGusts) : null
      };
    }
  }

  const day = freshestDayFor(rollbackDays);
  const speeds = [];
  const gusts = [];
  eligibleOrFallbackSources("wind").forEach(source => {
    const weight = sourceWeight(source, "wind");
    const speed = forecastValueFor(day, source, "wind", rollbackDays);
    const ffv = ffvFor(source, "wind", day);
    if (speed !== null && speed !== undefined) {
      speeds.push({ value: ffv !== null ? applyCorrection(speed, ffv, "wind") : speed, weight });
    }
    const gust = windGustValueFor(day, source, rollbackDays);
    if (gust !== null && gust !== undefined) gusts.push({ value: gust, weight });
  });
  if (!speeds.length) return null;
  return { speed: weightedMedian(speeds), gust: gusts.length ? weightedMedian(gusts) : null };
}

// ---- Pressure trend ----
// Today gets a genuine live trend from real recorded hourly pressure
// (the last ~3 hours). Every other date on the slider uses a coarser
// day-over-day trend instead (that day's figure vs. the day before it) —
// less precise, but still a real, date-appropriate comparison rather
// than no trend at all outside of Today.
function pressureTrendFor(rollbackDays) {
  if (rollbackDays === 0 && state.actual.pressure_hourly_values.length) {
    const times = state.actual.pressure_hourly_times;
    const values = state.actual.pressure_hourly_values;
    const now = new Date();
    let nowIdx = -1;
    for (let i = times.length - 1; i >= 0; i--) {
      if (new Date(times[i]).getTime() <= now.getTime()) { nowIdx = i; break; }
    }
    if (nowIdx >= 3 && values[nowIdx] !== null && values[nowIdx - 3] !== null) {
      return { delta: values[nowIdx] - values[nowIdx - 3], hours: 3 };
    }
  }

  // Day-over-day fallback: this date's merged pressure vs. the day
  // immediately before it, using the same source-merge as the headline.
  const valueFor = rb => {
    const day = freshestDayFor(rb);
    if (rb > 0) {
      const idx = actualIndexForRollback(rb);
      return idx !== null ? state.actual.pressure_mean[idx] : null;
    }
    const values = eligibleOrFallbackSources("pressure").map(source => {
      const raw = forecastValueFor(day, source, "pressure", rb);
      const ffv = ffvFor(source, "pressure", day);
      const value = raw !== null && raw !== undefined ? (ffv !== null ? applyCorrection(raw, ffv, "pressure") : raw) : null;
      return { value, weight: sourceWeight(source, "pressure") };
    });
    return weightedMedian(values);
  };
  const current = valueFor(rollbackDays);
  const previous = valueFor(rollbackDays > 0 ? rollbackDays - 1 : rollbackDays + 1); // "the day before" — subtract a day either side of the past/future divide
  if (current === null || previous === null) return null;
  return { delta: current - previous, hours: 24 };
}

// Maps a pressure delta to an arrow: angle away from horizontal (bigger
// or faster change = steeper, up to fully vertical) and stroke weight
// (bigger/faster = bolder). hoursSpan lets the 3-hour live comparison and
// the 24-hour fallback comparison share one scale, normalised to "per 3h".
function pressureTrendArrowSvg({ delta, hours }) {
  const per3h = delta / (hours / 3);
  const magnitude = Math.min(Math.abs(per3h), 4); // clamp — beyond this it's already about as bold/steep as it gets
  const angle = 15 + (magnitude / 4) * 75; // 15°(barely inclined) .. 90°(vertical)
  const weight = 1.8 + (magnitude / 4) * 2.2; // 1.8 (thin) .. 4 (bold)
  const rotation = per3h >= 0 ? -angle : angle; // negative (CCW) = up-right when rising, positive (CW) = down-right when falling
  return (
    `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="transform: rotate(${rotation}deg)">` +
    `<line x1="3" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="${weight.toFixed(1)}" stroke-linecap="round"/>` +
    `<polygon points="19,8.25 24,12 19,15.75" fill="currentColor"/>` +
    `</svg>`
  );
}

// Today gets the live treatment above where one exists; every other date
// (and Sunshine, which has none) keeps the existing snapshot.
function headlineDisplayValueFor(conditionName) {
  if (state.rollback === 0 && state.hourly.status === "ready") {
    const live = liveTodayValueFor(conditionName);
    if (live !== null && live !== undefined) return live;
  }
  return headlineValueFor(conditionName);
}

// forecastValueFor() deliberately falls back to a real source's demo
// formula while that source's own real data is still loading — a
// sensible default for the Compare table, which wants something to show
// per cell as sources stream in. But headlineValueFor()'s merge reads
// straight from that same fallback, which meant the headline could
// render a "final-looking" figure that was actually part real, part
// demo stand-in — then visibly shift over the next few seconds as each
// real source's own load finished and replaced its stand-in. Gating on
// this (alongside the state.actual.status check below) means the
// headline only ever shows one number: the one every selected real
// source actually settles on, never a partway blend.
function selectedRealSourcesStillLoading() {
  return REAL_SOURCES.some(
    ({ id }) => state.selected.has(id) && state.realSources[id].status === "loading"
  );
}

// Tracks whether what's currently on screen is a complete, correct
// render for state.postcode as it stands right now — true once either a
// cache restore or a fully finished load has shown something, false the
// moment a switch to somewhere not yet shown happens. The gate below
// keys off this rather than raw status flags for a reason: during a
// background refresh behind an already-displayed cached snapshot, each
// fetch function still flips its OWN status back to "loading" the
// instant it starts (fetchActualWeather, fetchRealSourceLive,
// fetchHourlyForecast all do this, unconditionally, right at their own
// top) — entirely correctly, since that status still needs to reflect
// reality for other things that read it. Gating the blank-out purely on
// those statuses meant ANY render triggered during that window — not
// just the fetch functions' own progressive ones, but genuinely anything
// else in the app that calls renderHeadline(), like the visibility/
// resume handlers — would see "loading" and blank over perfectly good,
// still-valid cached data, undoing the entire point of showing it
// instantly. This flag is the one thing that actually needs checking:
// "do we already have something complete to show", independent of
// whatever happens to be mid-flight underneath it.
let currentDisplayIsComplete = false;

function actualNotYetReady() {
  return state.actual.status === "idle" || state.actual.status === "loading";
}

function renderHeadline() {
  if (!headlineGrid) return;

  // True while ANY selected real source, actual, or hourly fetch is
  // still mid-flight for whatever's currently on screen — regardless of
  // whether that's a fresh load with nothing shown yet, or a background
  // refresh running quietly behind an already-displayed cached snapshot.
  const stillSettling = actualNotYetReady() || selectedRealSourcesStillLoading() || state.hourly.status === "idle" || state.hourly.status === "loading";

  // A location switch just started (see resetForLocationChange) with
  // nothing valid to show yet — refuse to build cells from whatever's
  // still sitting in state.hourly/state.actual at this exact moment,
  // since that's the PREVIOUS place's data and the new fetch hasn't
  // landed. Better to show nothing briefly than numbers that belong
  // somewhere else.
  if (!currentDisplayIsComplete && stillSettling) {
    headlineGrid.innerHTML = "";
    if (headlineDate) headlineDate.textContent = "";
    const loadingMsg = document.createElement("p");
    loadingMsg.className = "headline-loading";
    loadingMsg.textContent = "Loading weather…";
    headlineGrid.appendChild(loadingMsg);
    return;
  }

  // There IS already something valid on screen (a cache restore, or a
  // load that finished earlier) but a background refresh for the SAME
  // place is still incomplete — e.g. only 4 of 9 real sources have
  // landed so far. Rebuilding now would blend whichever sources happen
  // to be ready yet against the rest's still-loading placeholders, which
  // is exactly the "flickers through partial data" bug: each source
  // finishing at its own staggered time would repaint the headline with
  // a slightly different partial mix, and whatever partial mix happened
  // to be on screen when the user looked could then sit there until
  // something else (like nudging the Hour slider) forced a fresh
  // rebuild. Leaving the DOM completely untouched here — not even
  // clearing it — means the existing (cache or prior load's) render just
  // keeps showing as-is until the refresh is FULLY done, at which point
  // the fetch that finishes last calls this again with stillSettling now
  // false and rebuilds once, atomically, with the complete new data.
  if (currentDisplayIsComplete && stillSettling) return;

  headlineGrid.innerHTML = "";

  const day = freshestDayFor(state.rollback);

  if (headlineDate) {
    headlineDate.textContent = state.rollback === 0
      // "Today" now means "the next 24/48h from now" (see
      // displayWindowHourCount) rather than the calendar day — with 48h
      // selected that window genuinely spans into tomorrow, so the
      // title says so rather than silently showing tomorrow's figures
      // under a title that still just says "Today".
      ? (loadHourRange() === 48 ? "Today and Tomorrow" : "Today")
      : formatDateLong(targetDateForRollback(state.rollback));
  }

  const hourDate = currentHourDate();
  const showHourly = state.hourlyActive && state.hourly.status === "ready";
  const night = showHourly && !isDaytime(hourDate);

  activeHeadlineConditions().forEach(conditionName => {
    // Tide doesn't go through this generic per-forecaster cell loop at
    // all — it has its own data source, own full-width row, and its own
    // render path (renderTideRow in tide-ui.js, called separately
    // below). It's still listed in HEADLINE_OPTIONAL_CONDITIONS so it
    // shares Settings' existing "Front page cells" toggle UI exactly
    // the way Dew Point and Soil Temp do, rather than needing a
    // bespoke toggle built from scratch.
    if (conditionName === "tide") return;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "headline-cell";
    cell.addEventListener("click", () => openHourlySheet(conditionName));

    const label = document.createElement("span");
    label.className = "headline-label";

    const valueEl = document.createElement("span");
    valueEl.className = "headline-value";

    // Sunshine shows UV as a % while hourly is active during the day —
    // the label needs to reflect that, not Sunshine's usual "hrs" unit.
    const showingUVPercent = conditionName === "sunshine" && showHourly && !night;
    label.textContent = showingUVPercent
      ? `${CONFIG.conditions[conditionName].name} %`
      : `${CONFIG.conditions[conditionName].name} ${unitLabel(conditionName)}`;

    if (conditionName === "sunshine") {
      // Sunshine itself has no hourly concept — a daily total doesn't
      // decompose into an hour's reading. While the hour slider is
      // active, this cell shows real hourly UV instead, expressed as %
      // of that day's peak (see hourlyUVPercent) — genuinely informative
      // hour-by-hour, unlike a flat daily Sunshine figure, and a natural
      // way to combine UV with Sunshine into one reading rather than a
      // fifth headline cell. At night the UV% would just be a boring
      // string of zeros, so the moon phase takes over there instead.
      if (showHourly) {
        if (night) {
          valueEl.innerHTML = moonPhaseSvg(hourDate);
          valueEl.classList.add("headline-moon");
        } else {
          const percent = hourlyUVPercent(state.hourIndex);
          valueEl.textContent = percent !== null ? String(percent) : "–";
        }
      } else {
        const value = headlineDisplayValueFor(conditionName);
        valueEl.textContent = formatValue(value, conditionName);
      }
    } else if (showHourly) {
      const value = hourlyValueFor(conditionName);
      valueEl.textContent = value !== null ? formatValue(value, conditionName) : "–";
    } else if (conditionName === "temperature") {
      // High/low for the period rather than one single figure — mirrors
      // how a normal weather app frames a day's temperature. See
      // temperatureRangeFor for how past/today/future each source this.
      const range = temperatureRangeFor(state.rollback);
      valueEl.textContent = range
        ? `${formatValue(range.high, "temperature")} / ${formatValue(range.low, "temperature")}`
        : "–";
      if (state.rollback === 0 && frostRiskTonight()) {
        cell.classList.add("headline-cell-frost");
      }
    } else if (conditionName === "wind") {
      // Same one-line shape as Temperature's high/low — a plain speed
      // figure most days, "speed / gust" only once gust is genuinely
      // notable (see GUST_NOTABLE_MARGIN_MPH). This used to be a
      // separate small line appended below the cell, which meant the
      // cell's own height changed depending on whether a given hour or
      // day happened to have a notable gust — visibly jumping the whole
      // grid while scrubbing the Hour or Date slider. Folding it into
      // the one line that's always there removes the jump entirely,
      // the same way direction was already kept in the value row rather
      // than its own line for exactly this reason (see below).
      const pair = windSpeedGustFor(state.rollback);
      if (!pair) {
        valueEl.textContent = "–";
      } else if (pair.gust !== null && pair.gust > pair.speed + GUST_NOTABLE_MARGIN_MPH) {
        // No spaces around the slash, so the two numbers read as one
        // compact figure rather than wrapping mid-number ("19 /" / "32").
        valueEl.textContent = `${formatValue(pair.speed, "wind")}/${formatValue(pair.gust, "wind")}`;
      } else {
        valueEl.textContent = formatValue(pair.speed, "wind");
      }
    } else {
      const value = headlineDisplayValueFor(conditionName);
      valueEl.textContent = formatValue(value, conditionName);
    }

    const valueRow = document.createElement("div");
    valueRow.className = "headline-value-row";
    valueRow.appendChild(valueEl);

    cell.append(label, valueRow);

    if (conditionName === "wind") {
      const direction = showHourly
        ? state.hourly.windDirection?.[state.hourIndex] ?? null
        : anyRealWindDirection(day, state.rollback);
      const compass = compassLabel(direction);
      const rotation = windArrowRotation(direction);
      if (compass !== null && rotation !== null) {
        const arrow = document.createElement("span");
        arrow.className = "wind-arrow";
        // A hand-drawn shape, not a font glyph — arrow characters like "↑"
        // aren't actually centered within their own em-box in most fonts,
        // so even a perfectly centered CSS box rotates an off-center
        // picture. This SVG's geometry is centered on the viewBox
        // deliberately, so rotation has no font-rendering ambiguity to
        // go wrong. A single notched-kite shape (the same family as a
        // map/compass "current heading" glyph) rather than a plain
        // line-and-triangle — reads as more considered at a glance while
        // staying just as plain and legible as before.
        arrow.innerHTML =
          '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' +
          '<path d="M12 2.5 L18 20 L12 16 L6 20 Z" fill="currentColor"/>' +
          '</svg>';
        arrow.style.transform = `rotate(${rotation}deg)`;
        arrow.setAttribute("aria-hidden", "true");

        // Just the arrow, not the compass letters — the arrow alone
        // already encodes direction at a glance, and dropping the text
        // label leaves the value free to sit at full size instead of the
        // smaller is-compact treatment this cell used to need to fit
        // everything in. The letters are still available on the hourly
        // graph's scrubber readout for anyone who wants the precise
        // heading.
        valueRow.append(arrow);
      }
    }

    if (conditionName === "pressure" && !showHourly) {
      // See pressureTrendFor: a genuine live 3-hour trend for Today,
      // a day-over-day trend for every other date on the slider.
      const trend = pressureTrendFor(state.rollback);
      if (trend && Math.abs(trend.delta) > 0.05) {
        const arrow = document.createElement("span");
        arrow.className = "pressure-arrow";
        arrow.innerHTML = pressureTrendArrowSvg(trend);
        valueRow.appendChild(arrow);
      }
    }

    headlineGrid.appendChild(cell);
  });

  renderUnderperformBanner();

  // Defined in tide-ui.js, loaded after this file — guarded since this
  // function is also reachable from pages that don't include the tide
  // scripts at all (compare.html, settings.html).
  if (typeof renderTideRow === "function") renderTideRow();
}

// ---- Hourly graph sheet ----
// Tapping a headline figure opens this bottom sheet with that condition
// plotted across the next 24 or 48 hours (per the Settings choice),
// built from the same live hourly data already fetched for the "Hour"
// slider — nothing extra to load. Charts are hand-drawn SVG rather than
// a library, consistent with the rest of this dependency-free app.

const SHEET_SVG_NS = "http://www.w3.org/2000/svg";
const SHEET_W = 320, SHEET_H = 140, SHEET_PAD_L = 34, SHEET_PAD_B = 18, SHEET_PAD_T = 10;

function sheetSvgEl(tag, attrs) {
  const el = document.createElementNS(SHEET_SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Mirrors formatValue()'s rounding rules but skips the unit conversion,
// since callers here already converted the value via convertForDisplay —
// running it through formatValue again would convert it twice.
function formatConverted(displayValue, conditionName) {
  if (displayValue === null || displayValue === undefined || Number.isNaN(displayValue)) return "–";
  if (conditionName === "rain") {
    return conditionUnit("rain") === "imperial" ? displayValue.toFixed(2) : displayValue.toFixed(1);
  }
  if (conditionName === "pressure") {
    return conditionUnit("pressure") === "imperial" ? displayValue.toFixed(2) : Math.round(displayValue).toString();
  }
  return Math.round(displayValue).toString();
}

// The four y-axis gridlines on the hourly graphs are spaced by whatever
// niceStep() comes up with for the data's own range — which, on a very
// light rain day (or any other unusually flat range), can end up far
// smaller than the one decimal place formatConverted() normally uses.
// Two adjacent gridlines (say 0.04mm and 0.06mm) then both round to the
// same displayed text ("0.0"), which is exactly what showed up as
// apparently-duplicate labels. This adds decimal places on top of
// formatConverted's own baseline, but only as many as the step itself
// actually needs to keep every gridline visually distinct.
function decimalsNeededForStep(step) {
  if (!(step > 0)) return 0;
  return Math.max(0, -Math.floor(Math.log10(step)));
}

function formatAxisTick(value, conditionName, step) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const baseline = formatConverted(0, conditionName).includes(".") ? formatConverted(0, conditionName).split(".")[1].length : 0;
  const decimals = Math.min(3, Math.max(baseline, decimalsNeededForStep(step)));
  return value.toFixed(decimals);
}

function sheetClockLabel(iso) {
  const d = new Date(iso);
  const time = `${String(d.getHours()).padStart(2, "0")}:00`;
  // With 48h selected, dragging through the graph reaches well into
  // tomorrow — a bare "02:00" partway along doesn't say whether that's
  // later tonight or the small hours of the next day. Same pattern the
  // Hour slider's own label already uses.
  const crossesDay = isoDate(d) !== isoDate(new Date());
  return crossesDay ? `${time}, ${formatDateShort(d)}` : time;
}

function niceStep(rawStep) {
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const norm = rawStep / mag;
  // A finer set of "nice" multipliers than the old 1/2/5/10 — that
  // coarser set could nearly double the needed range (e.g. a raw step of
  // 1.1 rounding straight up to 2), leaving a lot of empty headroom above
  // the actual data. Picking the smallest candidate that still covers the
  // range keeps the axis snug against the real values.
  const candidates = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const step = candidates.find(c => c >= norm) ?? 10;
  return step * mag;
}

// hourTimes: array of ISO strings, one per point — everything else is
// derived from its length so 24h vs 48h needs no special-casing.
function sheetXFor(i, count) {
  const plotW = SHEET_W - SHEET_PAD_L - 10;
  return SHEET_PAD_L + (i / Math.max(1, count - 1)) * plotW;
}

// Axis ticks along the bottom always stay plain time-only — with 8 major
// ticks across a 48h graph there's no room for a date on top without the
// exact overlap this used to cause. The date only matters when actually
// scrubbing a specific point (see sheetClockLabel below), not for the
// static axis, which reads fine as a repeating 24h clock either way.
function sheetAxisTickLabel(iso) {
  return `${String(new Date(iso).getHours()).padStart(2, "0")}:00`;
}

function sheetBaseSvg(hourTimes, extraHeight = 16) {
  const wrap = document.createElement("div");
  wrap.className = "graph-wrap";
  const svg = sheetSvgEl("svg", { class: "graph-svg", viewBox: `0 0 ${SHEET_W} ${SHEET_H + extraHeight}` });
  wrap.appendChild(svg);
  const baseline = SHEET_H - SHEET_PAD_B;
  const count = hourTimes.length;
  // A labelled tick every 6 hours, with a short unlabelled tick every
  // hour in between — a sense of the hour-by-hour grid without 24+
  // separate text labels crowding the axis.
  hourTimes.forEach((iso, i) => {
    const hourOfDay = new Date(iso).getHours();
    const isMajor = hourOfDay % 6 === 0;
    const x = sheetXFor(i, count);
    svg.appendChild(sheetSvgEl("line", {
      x1: x, x2: x, y1: baseline, y2: baseline + (isMajor ? 5 : 3),
      class: "graph-tick"
    }));
    if (isMajor) {
      const t = sheetSvgEl("text", { x, y: SHEET_H + 12, class: "graph-axis-label", "text-anchor": "middle" });
      t.textContent = sheetAxisTickLabel(iso);
      svg.appendChild(t);
    }
  });
  return { wrap, svg, count };
}

// Three horizontal gridlines at 0 / mid / max (rounded to a tidy step),
// each labelled on the left — topPad lets a graph (e.g. wind) reserve
// extra room above the plot without shifting the plot itself down into
// the x-axis labels' space.
function sheetRenderYAxis(svg, minValue, maxValue, decimals, conditionName, topPad = SHEET_PAD_T) {
  const plotH = SHEET_H - topPad - SHEET_PAD_B;
  const step = niceStep((maxValue - minValue) / 3) || 1;
  const topValue = minValue + step * 3;
  [0, 1, 2, 3].forEach(i => {
    const value = minValue + step * i;
    const y = SHEET_H - SHEET_PAD_B - ((value - minValue) / (topValue - minValue)) * plotH;
    svg.appendChild(sheetSvgEl("line", { x1: SHEET_PAD_L, x2: SHEET_W - 6, y1: y, y2: y, class: "graph-gridline" }));
    const label = sheetSvgEl("text", { x: SHEET_PAD_L - 6, y: y + 3, class: "graph-axis-value", "text-anchor": "end" });
    label.textContent = formatAxisTick(value, conditionName, step);
    svg.appendChild(label);
  });
  return { topValue, minValue, plotH };
}

function sheetRenderBar(hourTimes, displayValues, color, conditionName) {
  const { wrap, svg, count } = sheetBaseSvg(hourTimes);
  const { topValue, plotH } = sheetRenderYAxis(svg, 0, Math.max(0.001, ...displayValues), true, conditionName);
  const barW = (SHEET_W - SHEET_PAD_L - 10) / count * 0.62;
  const pts = displayValues.map((v, i) => {
    const x = sheetXFor(i, count) - barW / 2;
    const barH = (v / topValue) * plotH;
    const y = SHEET_H - SHEET_PAD_B - barH;
    svg.appendChild(sheetSvgEl("rect", { x, y, width: barW, height: Math.max(1, barH), rx: 2, fill: color, opacity: i === 0 ? 1 : 0.72 }));
    return [sheetXFor(i, count), y];
  });
  return { wrap, svg, pts, extraHeight: 16 };
}

function sheetRenderLine(hourTimes, displayValues, color, conditionName) {
  const { wrap, svg, count } = sheetBaseSvg(hourTimes);
  const dataMin = Math.min(...displayValues);
  const { topValue, minValue, plotH } = sheetRenderYAxis(svg, dataMin, Math.max(...displayValues), false, conditionName);
  const range = Math.max(1, topValue - minValue);
  const pts = displayValues.map((v, i) => [sheetXFor(i, count), SHEET_H - SHEET_PAD_B - ((v - minValue) / range) * plotH]);
  const areaPath = `M${pts[0][0]},${SHEET_H - SHEET_PAD_B} ` + pts.map(p => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length-1][0]},${SHEET_H-SHEET_PAD_B} Z`;
  svg.appendChild(sheetSvgEl("path", { d: areaPath, fill: color, opacity: 0.12 }));
  const linePath = "M" + pts.map(p => p.join(",")).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: linePath, fill: "none", stroke: color, "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return { wrap, svg, pts, extraHeight: 16 };
}

// Dew point plus air temperature on one graph — genuinely useful
// together, not just decorative: whenever the two lines meet or nearly
// meet, relative humidity is at or near 100% (fog/dew/frost territory),
// and dew point's own height on a day when they stay well apart is a
// better "how muggy will it feel" read than raw humidity. Both share the
// same °C/°F scale, so there's no dual-axis awkwardness to work around.
// Temperature is always the higher of the two, drawn as a plain red line
// with no fill underneath — filling it too would just paint over dew
// point's own fill and muddy exactly the convergence this exists to show.
function sheetRenderDewPointWithTemp(hourTimes, dewDisplay, tempDisplay) {
  const { wrap, svg, count } = sheetBaseSvg(hourTimes);
  const dataMin = Math.min(...dewDisplay, ...tempDisplay);
  const dataMax = Math.max(...dewDisplay, ...tempDisplay);
  const { topValue, minValue, plotH } = sheetRenderYAxis(svg, dataMin, dataMax, false, "dewPoint");
  const range = Math.max(1, topValue - minValue);
  const yFor = v => SHEET_H - SHEET_PAD_B - ((v - minValue) / range) * plotH;

  const dewPts = dewDisplay.map((v, i) => [sheetXFor(i, count), yFor(v)]);
  const tempPts = tempDisplay.map((v, i) => [sheetXFor(i, count), yFor(v)]);

  const areaPath = `M${dewPts[0][0]},${SHEET_H - SHEET_PAD_B} ` + dewPts.map(p => `L${p[0]},${p[1]}`).join(" ") + ` L${dewPts[dewPts.length - 1][0]},${SHEET_H - SHEET_PAD_B} Z`;
  svg.appendChild(sheetSvgEl("path", { d: areaPath, fill: "#4c7a8a", opacity: 0.12 }));

  const tempLinePath = "M" + tempPts.map(p => p.join(",")).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: tempLinePath, fill: "none", stroke: "#c0392b", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // Dew point drawn last so it stays the visually primary line, on top
  // at the moments the two converge.
  const dewLinePath = "M" + dewPts.map(p => p.join(",")).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: dewLinePath, fill: "none", stroke: "#4c7a8a", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  const legend = document.createElement("div");
  legend.className = "graph-legend";
  const dewKey = document.createElement("span");
  dewKey.className = "graph-legend-item";
  dewKey.innerHTML = '<span class="graph-legend-swatch" style="background:#4c7a8a"></span>Dew point';
  const tempKey = document.createElement("span");
  tempKey.className = "graph-legend-item";
  tempKey.innerHTML = '<span class="graph-legend-swatch" style="background:#c0392b"></span>Temperature';
  legend.append(dewKey, tempKey);
  wrap.insertBefore(legend, svg);

  return { wrap, svg, pts: dewPts, extraHeight: 16 };
}

function sheetRenderWind(hourTimes, speedsDisplay, gustsDisplay, dirs) {
  // Arrow row needs its own clear space above the speed line — reserved
  // as extra top padding within the normal chart height (same baseline
  // as every other graph), rather than shifting the plotted line down
  // into the x-axis labels' space.
  const WIND_TOP_PAD = 34;
  const { wrap, svg, count } = sheetBaseSvg(hourTimes);
  const { topValue, plotH } = sheetRenderYAxis(svg, 0, Math.max(0.001, ...speedsDisplay, ...gustsDisplay), false, "wind", WIND_TOP_PAD);

  // Speed's own area fill, drawn first so it sits at the back of the
  // stack — same treatment every other line graph gets (see
  // sheetRenderLine): a solid fill under the primary line, in its own
  // colour at low opacity. Filled from speed only, not gust — gust is
  // the dashed secondary context line, filling under it too would just
  // muddy the one fill this graph needs.
  const pts = speedsDisplay.map((v, i) => [sheetXFor(i, count), SHEET_H - SHEET_PAD_B - (v / topValue) * plotH]);
  const areaPath = `M${pts[0][0]},${SHEET_H - SHEET_PAD_B} ` + pts.map(p => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length - 1][0]},${SHEET_H - SHEET_PAD_B} Z`;
  svg.appendChild(sheetSvgEl("path", { d: areaPath, fill: "#4c6a58", opacity: 0.12 }));

  // Gust drawn next (and dashed) so the solid speed line still sits
  // visually on top of it — gust is the secondary/context figure here,
  // speed is still the primary reading the cell and scrubber dot are
  // built around. Model gust is itself an hourly figure like everything
  // else in this graph, so a single sharp convective gust can still get
  // smoothed into its hour rather than standing out as a spike — worth
  // knowing, not a reason to leave it off.
  const gustPts = gustsDisplay.map((v, i) => [sheetXFor(i, count), SHEET_H - SHEET_PAD_B - (v / topValue) * plotH]);
  const gustPath = "M" + gustPts.map(p => p.join(",")).join(" L");
  svg.appendChild(sheetSvgEl("path", {
    d: gustPath, fill: "none", stroke: "#c0392b", "stroke-width": 1.8,
    "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": "4 3"
  }));

  const linePath = "M" + pts.map(p => p.join(",")).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: linePath, fill: "none", stroke: "#4c6a58", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // Direction arrows spaced out along the top strip — no connecting
  // lines down to the axis, just the arrow on a plain halo so the row
  // reads cleanly at a glance. Roughly every 4 hours for 24h, every 8
  // for 48h, so the row never gets crowded regardless of range.
  const step = Math.max(1, Math.round(count / 6));
  const arrowY = 15;
  dirs.forEach((deg, i) => {
    if (i % step !== 0 || deg === null || deg === undefined) return;
    const x = sheetXFor(i, count);
    svg.appendChild(sheetSvgEl("circle", { cx: x, cy: arrowY, r: 11, class: "wind-dir-halo" }));
    const rotation = windArrowRotation(deg);
    const g = sheetSvgEl("g", { transform: `translate(${x},${arrowY}) rotate(${rotation})` });
    g.appendChild(sheetSvgEl("path", { d: "M0,-7 L5,6 L0,2.5 L-5,6 Z", fill: "#2f6f4f" }));
    svg.appendChild(g);
  });

  const legend = document.createElement("div");
  legend.className = "graph-legend";
  const speedKey = document.createElement("span");
  speedKey.className = "graph-legend-item";
  speedKey.innerHTML = '<span class="graph-legend-swatch" style="background:#4c6a58"></span>Speed';
  const gustKey = document.createElement("span");
  gustKey.className = "graph-legend-item";
  gustKey.innerHTML = '<span class="graph-legend-swatch" style="background:#c0392b"></span>Gust';
  legend.append(speedKey, gustKey);
  wrap.insertBefore(legend, svg);

  return { wrap, svg, pts, extraHeight: 16 };
}

function sheetCloudIcon(cloudPct, isNight) {
  const c = document.createElementNS(SHEET_SVG_NS, "svg");
  c.setAttribute("viewBox", "0 0 32 32");
  c.classList.add("sun-icon");

  if (isNight) {
    c.appendChild(sheetSvgEl("path", { d: "M20 6a10 10 0 1 0 8 16 8 8 0 0 1-8-16z", fill: "#3b4a63" }));
    return c;
  }

  if (cloudPct < 15) {
    c.appendChild(sheetSvgEl("circle", { cx: 16, cy: 16, r: 8, fill: "#e8a83c" }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x1 = 16 + Math.cos(a) * 11, y1 = 16 + Math.sin(a) * 11;
      const x2 = 16 + Math.cos(a) * 14, y2 = 16 + Math.sin(a) * 14;
      c.appendChild(sheetSvgEl("line", { x1, y1, x2, y2, stroke: "#e8a83c", "stroke-width": 2, "stroke-linecap": "round" }));
    }
    return c;
  }

  // Cloud shading darkens with cover; a peek of sun behind it if partial.
  // Built from overlapping ellipses rather than a single fiddly path.
  const shade = 0.35 + (cloudPct / 100) * 0.55;
  const grey = Math.round(230 - shade * 130);
  if (cloudPct < 60) {
    c.appendChild(sheetSvgEl("circle", { cx: 12, cy: 13, r: 6, fill: "#e8a83c", opacity: 0.85 }));
  }
  const g = sheetSvgEl("g", {});
  g.appendChild(sheetSvgEl("ellipse", { cx: 13, cy: 19, rx: 7, ry: 5.5, fill: `rgb(${grey},${grey+6},${grey+8})` }));
  g.appendChild(sheetSvgEl("ellipse", { cx: 19, cy: 17, rx: 6, ry: 5.2, fill: `rgb(${grey},${grey+6},${grey+8})` }));
  g.appendChild(sheetSvgEl("ellipse", { cx: 16, cy: 21.5, rx: 9, ry: 4.2, fill: `rgb(${grey},${grey+6},${grey+8})` }));
  c.appendChild(g);
  return c;
}

function sheetRenderSunStrip(hourTimes, cloudCover) {
  const wrap = document.createElement("div");
  wrap.className = "graph-wrap";
  const strip = document.createElement("div");
  strip.className = "sun-strip";
  // Every 2 hours keeps a 48h range from feeling cramped; 24h just shows
  // every other hour too, which is plenty of resolution for cloud cover.
  hourTimes.forEach((iso, i) => {
    if (i % 2 !== 0) return;
    const date = new Date(iso);
    const isNight = !isDaytime(date);
    const cell = document.createElement("div");
    cell.className = "sun-cell";
    cell.appendChild(sheetCloudIcon(cloudCover[i] ?? 0, isNight));
    const label = document.createElement("span");
    label.className = "sun-hour-label";
    label.textContent = sheetAxisTickLabel(iso);
    cell.appendChild(label);
    strip.appendChild(cell);
  });
  wrap.appendChild(strip);
  return wrap;
}

// Runs a finger along the time axis: a vertical line tracks the nearest
// hour and a dot marks the exact data point, while the actual time+value
// readout lives in the fixed bar above the graph rather than under the
// finger — the one place guaranteed not to get covered by the hand doing
// the dragging.
function attachSheetScrubber({ svg, pts, extraHeight, formatReadout, defaultReadout }) {
  const touchArea = sheetSvgEl("rect", { x: 0, y: 0, width: SHEET_W, height: SHEET_H + extraHeight, class: "graph-touch-area" });
  svg.appendChild(touchArea);

  const crosshair = sheetSvgEl("line", { x1: 0, x2: 0, y1: 0, y2: SHEET_H + extraHeight, class: "scrub-line" });
  const dot = sheetSvgEl("circle", { r: 4.5, class: "scrub-dot" });
  crosshair.style.display = "none";
  dot.style.display = "none";
  svg.appendChild(crosshair);
  svg.appendChild(dot);

  function hourFromClientX(clientX) {
    const rect = svg.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * SHEET_W;
    const plotW = SHEET_W - SHEET_PAD_L - 10;
    const ratio = (localX - SHEET_PAD_L) / plotW;
    return Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))));
  }

  function showAt(i) {
    const [x, y] = pts[i];
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    crosshair.style.display = "";
    dot.style.display = "";
    const readout = formatReadout(i);
    readoutTime.textContent = readout.time;
    readoutValue.textContent = readout.value;
  }

  function reset() {
    crosshair.style.display = "none";
    dot.style.display = "none";
    readoutTime.textContent = defaultReadout.time;
    readoutValue.textContent = defaultReadout.value;
  }

  let dragging = false;
  touchArea.addEventListener("pointerdown", e => {
    dragging = true;
    touchArea.setPointerCapture(e.pointerId);
    showAt(hourFromClientX(e.clientX));
  });
  touchArea.addEventListener("pointermove", e => {
    if (!dragging) return;
    showAt(hourFromClientX(e.clientX));
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(evt => {
    touchArea.addEventListener(evt, () => {
      if (!dragging) return;
      dragging = false;
      reset();
    });
  });

  reset();
}

function closeHourlySheet() {
  if (!sheet) return;
  sheetBackdrop.classList.remove("is-open");
  sheet.classList.remove("is-open");
  window.setTimeout(() => { if (!sheet.classList.contains("is-open")) sheet.hidden = true; }, 280);
}

function openHourlySheet(conditionName) {
  if (!sheet) return;

  const hourRange = Number(loadHourRange());
  sheetTitle.textContent = CONFIG.conditions[conditionName].name;
  sheetRange.textContent = `Next ${hourRange}h`;
  sheetBody.innerHTML = "";
  sheetReadout.hidden = conditionName === "sunshine";
  // Dew Point's readout carries its own figure plus Temperature
  // alongside it, and Wind's carries speed plus gust plus direction —
  // both routinely longer than every other condition's plain single
  // number, so they get a slightly smaller readout size to keep them
  // comfortably on one line instead of the default full size.
  readoutValue.classList.toggle("is-compact", conditionName === "dewPoint" || conditionName === "wind");

  if (state.hourly.status !== "ready") {
    const empty = document.createElement("p");
    empty.className = "sheet-empty";
    empty.textContent = state.hourly.status === "error"
      ? "Hourly forecast isn't available right now."
      : "Loading hourly forecast…";
    sheetBody.appendChild(empty);
    sheetFootnote.textContent = "";
  } else {
    try {
      const count = Math.min(hourRange, state.hourly.times.length);
      const hourTimes = state.hourly.times.slice(0, count);

      if (conditionName === "rain") {
        const raw = state.hourly.precipitation.slice(0, count);
        const display = raw.map(v => convertForDisplay(v, "rain"));
        const g = sheetRenderBar(hourTimes, display, "#2f6f4f", "rain");
        sheetBody.appendChild(g.wrap);
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({ time: sheetClockLabel(hourTimes[i]), value: `${formatConverted(display[i], "rain")}${unitLabel("rain")}` }),
          defaultReadout: { time: "Now", value: `${formatConverted(display[0], "rain")}${unitLabel("rain")}` }
        });
        // Each bar is that ONE hour's rainfall, not a running total — on
        // its own that reads oddly next to the headline's whole-day
        // figure (e.g. a 5.7mm day made of many small hourly amounts, no
        // single bar anywhere near 5.7). Spelling out the sum across the
        // visible window closes that gap without needing a second chart.
        const total = display.reduce((a, b) => a + (b ?? 0), 0);
        sheetFootnote.textContent =
          `Total across shown ${count}h: ${formatConverted(total, "rain")}${unitLabel("rain")}`;
      } else if (conditionName === "temperature") {
        const raw = state.hourly.temperature.slice(0, count);
        const display = raw.map(v => convertForDisplay(v, "temperature"));
        const g = sheetRenderLine(hourTimes, display, "#b5651d", "temperature");
        sheetBody.appendChild(g.wrap);
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({ time: sheetClockLabel(hourTimes[i]), value: `${formatConverted(display[i], "temperature")}${unitLabel("temperature")}` }),
          defaultReadout: { time: "Now", value: `${formatConverted(display[0], "temperature")}${unitLabel("temperature")}` }
        });
      } else if (conditionName === "wind") {
        const raw = state.hourly.windSpeed.slice(0, count);
        const display = raw.map(v => convertForDisplay(v, "wind"));
        const gustRaw = state.hourly.windGust.slice(0, count);
        const gustDisplay = gustRaw.map(v => convertForDisplay(v, "wind"));
        const dirs = state.hourly.windDirection.slice(0, count);
        const g = sheetRenderWind(hourTimes, display, gustDisplay, dirs);
        sheetBody.appendChild(g.wrap);
        // Same "bare number most of the time, speed / gust only when
        // notable" convention as the headline (see GUST_NOTABLE_MARGIN_MPH)
        // — compared in native mph (raw/gustRaw), not the display-converted
        // arrays, so the threshold doesn't shift with the mph/km-h setting.
        const speedText = i => gustRaw[i] !== null && gustRaw[i] !== undefined && gustRaw[i] > raw[i] + GUST_NOTABLE_MARGIN_MPH
          ? `${formatConverted(display[i], "wind")} / ${formatConverted(gustDisplay[i], "wind")}`
          : formatConverted(display[i], "wind");
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({
            time: sheetClockLabel(hourTimes[i]),
            value: `${speedText(i)}${unitLabel("wind")} ${compassLabel(dirs[i]) ?? ""}`.trim()
          }),
          defaultReadout: {
            time: "Now",
            value: `${speedText(0)}${unitLabel("wind")} ${compassLabel(dirs[0]) ?? ""}`.trim()
          }
        });
      } else if (conditionName === "sunshine") {
        sheetBody.appendChild(sheetRenderSunStrip(hourTimes, state.hourly.cloudCover.slice(0, count)));
      } else if (conditionName === "pressure") {
        const raw = state.hourly.pressure.slice(0, count);
        const display = raw.map(v => convertForDisplay(v, "pressure"));
        const g = sheetRenderLine(hourTimes, display, "#5b6b7a", "pressure");
        sheetBody.appendChild(g.wrap);
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({ time: sheetClockLabel(hourTimes[i]), value: `${formatConverted(display[i], "pressure")}${unitLabel("pressure")}` }),
          defaultReadout: { time: "Now", value: `${formatConverted(display[0], "pressure")}${unitLabel("pressure")}` }
        });
      } else if (conditionName === "soilTemperature") {
        const raw = state.hourly.soilTemperature.slice(0, count);
        const display = raw.map(v => convertForDisplay(v, "soilTemperature"));
        const g = sheetRenderLine(hourTimes, display, "#8a6d4f", "soilTemperature");
        sheetBody.appendChild(g.wrap);
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({ time: sheetClockLabel(hourTimes[i]), value: `${formatConverted(display[i], "soilTemperature")}${unitLabel("soilTemperature")}` }),
          defaultReadout: { time: "Now", value: `${formatConverted(display[0], "soilTemperature")}${unitLabel("soilTemperature")}` }
        });
      } else if (conditionName === "dewPoint") {
        const dewRaw = state.hourly.dewPoint.slice(0, count);
        const dewDisplay = dewRaw.map(v => convertForDisplay(v, "dewPoint"));
        const tempRaw = state.hourly.temperature.slice(0, count);
        const tempDisplay = tempRaw.map(v => convertForDisplay(v, "temperature"));
        const g = sheetRenderDewPointWithTemp(hourTimes, dewDisplay, tempDisplay);
        sheetBody.appendChild(g.wrap);
        attachSheetScrubber({
          ...g,
          formatReadout: i => ({
            time: sheetClockLabel(hourTimes[i]),
            value: `${formatConverted(dewDisplay[i], "dewPoint")}${unitLabel("dewPoint")} · temp ${formatConverted(tempDisplay[i], "temperature")}${unitLabel("temperature")}`
          }),
          defaultReadout: {
            time: "Now",
            value: `${formatConverted(dewDisplay[0], "dewPoint")}${unitLabel("dewPoint")} · temp ${formatConverted(tempDisplay[0], "temperature")}${unitLabel("temperature")}`
          }
        });
      }

      sheetFootnote.textContent = conditionName === "sunshine"
        ? "Cloud cover shown hour by hour — a full sun means clear skies, darker cloud means heavier cover. Night hours show a moon instead."
        : conditionName === "rain"
        ? sheetFootnote.textContent // already set above with the running total
        : "";
    } catch (err) {
      // Whatever went wrong building the graph, the sheet still needs to
      // open and say so — a silent failure here previously meant tapping
      // a headline figure looked like it did nothing at all.
      console.error("Hourly graph failed to render:", err);
      sheetBody.innerHTML = "";
      const empty = document.createElement("p");
      empty.className = "sheet-empty";
      empty.textContent = "Couldn't build this graph right now.";
      sheetBody.appendChild(empty);
      sheetFootnote.textContent = "";
    }
  }

  sheet.hidden = false;
  // Force layout before adding the open class, so the slide-up actually
  // transitions instead of snapping straight to open (removing [hidden]
  // and adding a transform in the same tick can get collapsed into one
  // paint otherwise).
  requestAnimationFrame(() => {
    sheetBackdrop.classList.add("is-open");
    sheet.classList.add("is-open");
  });
}

if (sheetClose) sheetClose.addEventListener("click", closeHourlySheet);
if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeHourlySheet);

function renderAccuracy() {
  if (!accuracyBody) return;
  accuracyBody.innerHTML = "";

  const mode = accuracyMode ? accuracyMode.value : "both";
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));

  // The app's own merged output, measured the same way every forecaster
  // is — shown first and visually set apart, since it's not one of the
  // choices in Settings, it's the answer to "is all the blending and
  // weighting actually working better than any single source?"
  const appStats = appAccuracyStatsFor(state.condition);
  const appRow = document.createElement("tr");
  appRow.className = "accuracy-app-row";
  const appNameCell = document.createElement("td");
  appNameCell.textContent = "App (merged)";
  appRow.appendChild(appNameCell);
  if (appStats) {
    const appSamplesCell = document.createElement("td");
    appSamplesCell.textContent = appStats.count;
    appRow.appendChild(appSamplesCell);
    const appRawCell = document.createElement("td");
    appRawCell.textContent = "–"; // no separate Raw for the merge — it IS the corrected output
    appRow.appendChild(appRawCell);
    const appCorrectedCell = document.createElement("td");
    appCorrectedCell.textContent = formatError(appStats.avgError, state.condition, mode);
    appRow.appendChild(appCorrectedCell);
  } else {
    const collectingCell = document.createElement("td");
    collectingCell.colSpan = 3;
    collectingCell.className = "col-collecting";
    collectingCell.textContent = "Collecting data";
    appRow.appendChild(collectingCell);
  }
  accuracyBody.appendChild(appRow);

  selectedSources.forEach(source => {
    const stats = accuracyStatsFor(source, state.condition);
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = source.name;
    row.appendChild(nameCell);

    if (!isForecasterEligible(source, state.condition)) {
      // Under ELIGIBILITY_MIN_DAYS: an accuracy score from a handful of
      // samples is mostly noise — showing it (good or bad) before it
      // means anything would be misleading either way. "Collecting
      // data" replaces the whole stats block until it's earned trust.
      const seen = daysSeenFor(source, state.condition);
      const collectingCell = document.createElement("td");
      collectingCell.colSpan = 3;
      collectingCell.className = "col-collecting";
      collectingCell.textContent = `Collecting data (${seen}/${ELIGIBILITY_MIN_DAYS} days)`;
      row.appendChild(collectingCell);
      accuracyBody.appendChild(row);
      return;
    }

    const samplesCell = document.createElement("td");
    samplesCell.textContent = stats ? stats.count : "0";
    row.appendChild(samplesCell);

    const rawCell = document.createElement("td");
    rawCell.textContent = stats ? formatError(stats.avgErrorRaw, state.condition, mode) : "–";
    row.appendChild(rawCell);

    const correctedCell = document.createElement("td");
    correctedCell.textContent = stats ? formatError(stats.avgErrorCorrected, state.condition, mode) : "–";
    row.appendChild(correctedCell);

    accuracyBody.appendChild(row);
  });

  renderAccuracyTrend();
}

// Small standalone line graph, deliberately not reusing the hourly
// sheet's chart helpers — those are built around a fixed-count hourly
// x-axis (see sheetXFor/sheetBaseSvg), whereas this one has a variable
// number of daily points that only grows over time, and needs date
// labels rather than clock times. Simple enough to just draw directly.
function renderAccuracyTrend() {
  const container = document.getElementById("accuracyTrend");
  if (!container) return;
  container.innerHTML = "";

  if (!state.areaCode) return;
  const store = loadAccuracyTrendStore(state.areaCode);
  const series = store[state.condition] ?? [];

  const heading = document.createElement("h3");
  heading.className = "accuracy-trend-heading";
  heading.textContent = "Accuracy over time";
  container.appendChild(heading);

  if (series.length < 2) {
    const note = document.createElement("p");
    note.className = "actual-status";
    note.textContent = "Not enough history yet for a trend — one snapshot is recorded each day the app is opened.";
    container.appendChild(note);
    return;
  }

  const values = series.map(pt => pt.avgError);
  const W = 320, H = 90, PAD_L = 34, PAD_B = 16, PAD_T = 8;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "graph-svg");

  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = Math.max(0.001, maxV - minV);
  const plotW = W - PAD_L - 10;
  const plotH = H - PAD_T - PAD_B;
  const xFor = i => PAD_L + (i / Math.max(1, series.length - 1)) * plotW;
  const yFor = v => H - PAD_B - ((v - minV) / range) * plotH;

  // Just the min/max gridlines — this is a small at-a-glance shape, not
  // a precision instrument, so a middle line would add clutter without
  // adding anything worth reading.
  [minV, maxV].forEach(v => {
    const y = yFor(v);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", PAD_L); line.setAttribute("x2", String(W - 6));
    line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y));
    line.setAttribute("class", "graph-gridline");
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", String(PAD_L - 6));
    label.setAttribute("y", String(y + 3));
    label.setAttribute("class", "graph-axis-value");
    label.setAttribute("text-anchor", "end");
    label.textContent = formatValue(v, state.condition, true);
    svg.appendChild(label);
  });

  const pts = values.map((v, i) => [xFor(i), yFor(v)]);
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", "M" + pts.map(p => p.join(",")).join(" L"));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--accent)");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);

  const startLabel = document.createElementNS(svgNS, "text");
  startLabel.setAttribute("x", String(PAD_L));
  startLabel.setAttribute("y", String(H - 2));
  startLabel.setAttribute("class", "graph-axis-label");
  startLabel.textContent = formatDateShort(new Date(series[0].date));
  svg.appendChild(startLabel);

  const endLabel = document.createElementNS(svgNS, "text");
  endLabel.setAttribute("x", String(W - 6));
  endLabel.setAttribute("y", String(H - 2));
  endLabel.setAttribute("class", "graph-axis-label");
  endLabel.setAttribute("text-anchor", "end");
  endLabel.textContent = formatDateShort(new Date(series[series.length - 1].date));
  svg.appendChild(endLabel);

  const wrap = document.createElement("div");
  wrap.className = "graph-wrap accuracy-trend-graph";
  wrap.appendChild(svg);
  container.appendChild(wrap);

  const caption = document.createElement("p");
  caption.className = "sheet-footnote accuracy-trend-caption";
  caption.textContent =
    `App's own merged accuracy for ${CONFIG.conditions[state.condition].name} — average error in ${unitLabel(state.condition)}, one point per day, ${series.length} day${series.length === 1 ? "" : "s"} tracked so far. Lower is better.`;
  container.appendChild(caption);
}

if (accuracyMode) {
  accuracyMode.value = loadAccuracyMode();
  accuracyMode.addEventListener("change", () => {
    try {
      localStorage.setItem(ACCURACY_MODE_KEY, accuracyMode.value);
    } catch {
      // display-only preference, fine if it doesn't persist
    }
    renderAccuracy();
  });
}

// ---- What-if merge (Compare page) ----
// Recomputes the merged figure with specific forecasters ticked in/out,
// using each forecaster's full learned FFV history via ffvFor/threeDayMean
// exactly as the live headline does — those already ignore the 14-day
// eligibility gate (that's a separate, stricter "is this still noisy"
// check — see isForecasterEligible), so no extra plumbing is needed to
// make this a genuine hindsight comparison rather than a live decision.
//
// ONE selection, shared across every condition and persisted — picking
// which forecasters to compare is a single ongoing choice, not something
// to redo every time you switch from Rain to Wind. Only the very first
// time this is ever opened does it default itself (to whichever selected
// sources are eligible for the condition on screen at that moment); every
// choice after that is exactly what was left checked, everywhere.
const WHAT_IF_KEY = "forecast-compare:whatIf";

function loadWhatIf() {
  try {
    const raw = localStorage.getItem(WHAT_IF_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // fall through — treat as "never set" so the caller can default it
  }
  return null;
}

function saveWhatIf(set) {
  try {
    localStorage.setItem(WHAT_IF_KEY, JSON.stringify([...set]));
  } catch {
    // Storage unavailable — selection just won't persist between visits.
  }
}

function initWhatIfIfNeeded() {
  if (!whatIfChecks) return;
  if (state.whatIf) return;

  const stored = loadWhatIf();
  if (stored) {
    state.whatIf = stored;
    return;
  }

  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));
  state.whatIf = new Set(
    selectedSources.filter(source => isForecasterEligible(source, state.condition)).map(source => source.id)
  );
  saveWhatIf(state.whatIf);
}

function whatIfMergedValue() {
  const day = freshestDayFor(state.rollback);
  const chosen = CONFIG.forecasters.filter(source => state.whatIf?.has(source.id));
  // Weighted the same way the live merge is — otherwise this preview
  // could show a different figure than the real headline would actually
  // produce for the same selection, which would defeat the point of a
  // "what if" comparison.
  const entries = chosen.map(source => {
    const ffv = ffvFor(source, state.condition, day);
    let value = null;
    if (ffv !== null) {
      const mean = threeDayMean(day, source, state.condition, state.rollback);
      if (mean !== null) value = applyCorrection(mean, ffv, state.condition);
    }
    if (value === null || value === undefined) {
      value = forecastValueFor(day, source, state.condition, state.rollback);
    }
    return { value, weight: sourceWeight(source, state.condition) };
  });
  return weightedMedian(entries);
}

function renderWhatIfResult() {
  if (!whatIfResult) return;
  const value = whatIfMergedValue();
  whatIfResult.textContent = value !== null
    ? `Merged figure with this selection: ${formatValue(value, state.condition)} ${unitLabel(state.condition)}`
    : "Merged figure with this selection: – (nothing selected, or no data yet)";
}

function renderWhatIf() {
  if (!whatIfChecks) return;
  initWhatIfIfNeeded();
  whatIfChecks.innerHTML = "";
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));

  selectedSources.forEach(source => {
    const label = document.createElement("label");
    label.className = "check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.whatIf.has(source.id);
    input.addEventListener("change", () => {
      if (input.checked) state.whatIf.add(source.id);
      else state.whatIf.delete(source.id);
      saveWhatIf(state.whatIf);
      renderWhatIfResult();
    });

    const text = document.createElement("span");
    const eligible = isForecasterEligible(source, state.condition);
    text.textContent = source.name + (eligible ? "" : ` (under ${ELIGIBILITY_MIN_DAYS} days)`);

    label.append(input, text);
    whatIfChecks.appendChild(label);
  });

  renderWhatIfResult();
}

function renderTable() {
  // The comparison table only exists on the Compare page — the front
  // page and Settings share this same script but don't render it, so
  // everything table-specific is skipped there rather than throwing on
  // missing elements. renderAccuracy() and renderHeadline() still run
  // unconditionally at the end of this function since they guard
  // themselves and need to update independently (e.g. the front page's
  // headline reacting to its own Date slider).
  if (!table) {
    renderAccuracy();
    renderHeadline();
    return;
  }

  // Same principle as renderHeadline: refuse to build the table from
  // whatever's still sitting in state at this exact moment if a location
  // switch just started — that's the previous place's data, not this
  // one's — unless the display is already marked complete (see
  // currentDisplayIsComplete), in which case a mid-flight status flag
  // from a background refresh shouldn't be able to blank it either.
  if (!currentDisplayIsComplete && actualNotYetReady()) {
    table.innerHTML = "";
    if (actualStatus) actualStatus.textContent = "Loading weather…";
    if (metOfficeStatus) metOfficeStatus.textContent = "";
    renderAccuracy();
    renderHeadline();
    return;
  }

  const selectedSources = CONFIG.forecasters.filter(
    source => state.selected.has(source.id)
  );

  const conditionData = CONFIG.conditions[state.condition];

  conditionTitle.textContent = conditionData.name;
  locationLabel.textContent = state.postcode || "Location";

  // Column widths are fixed per-cell (see style.css) but the number of
  // forecaster columns varies with how many are selected. table-layout:
  // fixed only respects those per-cell widths up to the table's own
  // width — anything narrower than the real content width just
  // compresses every column proportionally, which is what was making
  // the table unreadable on a phone (numbers overlapping). Setting the
  // table's min-width here to the actual required width (day column +
  // 2 columns per selected forecaster) guarantees table-layout:fixed
  // always has enough room, so .table-wrap's horizontal scroll kicks in
  // properly instead.
  const DAY_COLUMN_WIDTH = 70;
  const APP_COLUMN_WIDTH = 64;
  const FORECASTER_PAIR_WIDTH = 96 * 2;
  table.style.minWidth = `${DAY_COLUMN_WIDTH + APP_COLUMN_WIDTH + FORECASTER_PAIR_WIDTH * selectedSources.length}px`;

  table.innerHTML = "";

  const thead = document.createElement("thead");

  const sourceRow = document.createElement("tr");
  const dayHead = document.createElement("th");
  dayHead.textContent = "Day out";
  dayHead.rowSpan = 2;
  dayHead.className = "day-head";
  sourceRow.appendChild(dayHead);

  // Fixed alongside Day out (not scrolled away with the forecaster
  // columns) so the app's own merged figure is always visible right next
  // to whichever row you're looking at — the point being an easy,
  // constant visual check of each forecaster against the app's own
  // output, not just against Actual at the bottom.
  const appHead = document.createElement("th");
  appHead.textContent = "App";
  appHead.rowSpan = 2;
  appHead.className = "app-head";
  sourceRow.appendChild(appHead);

  const subRow = document.createElement("tr");

  selectedSources.forEach((source, index) => {
    const tintClass = index % 2 === 1 ? " forecaster-tint" : "";

    const th = document.createElement("th");
    th.colSpan = 2;
    th.className = "th-source";
    th.textContent = source.name;
    sourceRow.appendChild(th);

    const correctedTh = document.createElement("th");
    correctedTh.className = "sub-corrected" + tintClass;
    const correctedLabel = document.createElement("span");
    correctedLabel.textContent = "Corrected";
    const correctedUnit = document.createElement("small");
    correctedUnit.textContent = unitLabel(state.condition);
    correctedTh.append(correctedLabel, correctedUnit);
    subRow.appendChild(correctedTh);

    const rawTh = document.createElement("th");
    rawTh.className = "sub-raw" + tintClass;
    const rawLabel = document.createElement("span");
    rawLabel.textContent = "Raw";
    const rawUnit = document.createElement("small");
    rawUnit.textContent = unitLabel(state.condition);
    rawTh.append(rawLabel, rawUnit);
    subRow.appendChild(rawTh);
  });

  thead.append(sourceRow, subRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const targetDate = targetDateForRollback(state.rollback);
  const rollbackDays = state.rollback;
  const freshestDay = freshestDayFor(rollbackDays);
  const actualToday = actualValueFor(state.condition, 0);
  const actual = actualValueFor(state.condition, rollbackDays);
  const actualKnown = state.actual.status === "ready" && rollbackDays > 0 && actual !== null;

  [1, 2, 3, 4, 5, 6, 7].forEach(day => {
    const row = document.createElement("tr");
    if (day === freshestDay) row.classList.add("row-final");

    const issueDate = addDays(targetDate, -day);

    const dayCell = document.createElement("td");
    dayCell.className = "day";

    const dayNum = document.createElement("span");
    dayNum.textContent = day;

    const dayDate = document.createElement("small");
    dayDate.textContent = formatDateShort(issueDate);

    dayCell.append(dayNum, dayDate);
    row.appendChild(dayCell);

    const appCell = document.createElement("td");
    appCell.className = "app";
    const appValue = mergedValueFor(state.condition, day, rollbackDays);
    appCell.textContent = appValue !== null && appValue !== undefined
      ? formatValue(appValue, state.condition)
      : "–";
    row.appendChild(appCell);

    selectedSources.forEach((source, index) => {
      const tintClass = index % 2 === 1 ? " forecaster-tint" : "";

      if (!isForecasterEligible(source, state.condition)) {
        // Under ELIGIBILITY_MIN_DAYS of its own history, this forecaster's
        // Raw/Corrected figures are placeholders that would just read as
        // "false diversity" — a single merged cell says so plainly
        // instead of showing numbers that don't mean anything yet.
        const seen = daysSeenFor(source, state.condition);
        const collectingCell = document.createElement("td");
        collectingCell.className = "col-collecting" + tintClass;
        collectingCell.colSpan = 2;
        collectingCell.textContent = `Collecting data (${seen}/${ELIGIBILITY_MIN_DAYS})`;
        row.appendChild(collectingCell);
        return;
      }

      const value = forecastValueFor(day, source, state.condition, rollbackDays);
      const ffv = ffvFor(source, state.condition, day);

      const correctedCell = document.createElement("td");
      correctedCell.className = "col-corrected" + tintClass;
      if (ffv !== null) {
        const mean = threeDayMean(day, source, state.condition, rollbackDays);
        correctedCell.textContent = mean !== null ? formatValue(applyCorrection(mean, ffv, state.condition), state.condition) : "–";
      } else {
        correctedCell.textContent = "–";
      }
      row.appendChild(correctedCell);

      const cell = document.createElement("td");
      cell.className = "col-raw" + tintClass;
      cell.textContent = formatValue(value, state.condition);

      if (SHOW_INLINE_FFV_HINT && ffv !== null) {
        const mean = threeDayMean(day, source, state.condition, rollbackDays);
        const adjusted = document.createElement("small");
        adjusted.className = "ffv-hint";
        adjusted.textContent = mean !== null ? `≈${formatValue(applyCorrection(mean, ffv, state.condition), state.condition)} adj.` : "";
        cell.appendChild(adjusted);
      }

      if (day === freshestDay && actualKnown) {
        const delta = value - actual;
        const badge = document.createElement("span");
        badge.className =
          "delta " + (Math.abs(delta) <= Math.abs(actual) * 0.15 + 0.3 ? "delta-close" : "delta-off");
        badge.textContent = (delta >= 0 ? "+" : "") + formatValue(delta, state.condition, true);
        cell.appendChild(badge);
      }

      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });

  table.appendChild(tbody);

  // Actual weather — deliberately NOT a row inside the horizontally
  // scrolling table. With enough forecasters selected the table scrolls
  // wide, and a colspan cell's text scrolls away with it — this sits
  // below the table-wrap instead, so it's always visible regardless of
  // scroll position.
  if (actualLine) {
    if (state.actual.status === "loading") {
      actualLine.textContent = "Actual: loading…";
    } else if (state.actual.status === "error") {
      actualLine.textContent = "Actual: unavailable";
    } else if (rollbackDays < 0) {
      actualLine.textContent = `Actual: hasn't happened yet — ${formatDateLong(targetDate)} is ${-rollbackDays} day${rollbackDays === -1 ? "" : "s"} away`;
    } else if (rollbackDays === 0) {
      actualLine.textContent = actualToday !== null
        ? `Actual: ${formatValue(actualToday, state.condition)} ${unitLabel(state.condition)} so far today (still recording)`
        : "Actual: still recording today";
    } else if (actual !== null) {
      actualLine.textContent = `Actual: ${formatValue(actual, state.condition)} ${unitLabel(state.condition)} on ${formatDateLong(targetDate)}`;
    } else {
      actualLine.textContent = "Actual: –";
    }
  }

  renderAccuracy();
  renderUnderperformNotice();
  renderWhatIf();
  renderHeadline();
}

// ---- One-off real-source history backfill ----
// A year of real (mean, actual) pairs for every real source, so FFV
// starts from a genuine base instead of building up one day at a time.
// Manually triggered — this is a large request, not something to re-run
// on every page load. Sunshine/UV aren't covered (see
// REAL_DATA_CONDITIONS) so they're skipped entirely here.
const BACKFILL_DAYS = 365;
const BACKFILL_FIELD_FOR_CONDITION = {
  rain: "precip",
  wind: "wind",
  cloud: "cloud",
  temperature: "tempAvg",
  pressure: "pressure",
  soilTemperature: "soilTemp",
  dewPoint: "dewPoint"
};

function renderBackfillStatus() {
  if (!backfillStatus) return;
  backfillStatus.classList.remove("is-error");

  if (state.backfill.status === "loading") {
    backfillStatus.textContent = "Fetching a year of real data — this is a big request, may take a little while…";
  } else if (state.backfill.status === "error") {
    backfillStatus.textContent = `Backfill failed: ${state.backfill.error}`;
    backfillStatus.classList.add("is-error");
  } else if (state.backfill.status === "done") {
    const failed = state.backfill.failedSourceIds || [];
    const failedNames = failed
      .map(id => CONFIG.forecasters.find(f => f.id === id)?.name || id)
      .join(", ");
    backfillStatus.textContent = failed.length
      ? `Done — added ${state.backfill.samplesAdded} real samples to ${state.areaCode || "this area"}'s FFV history. ${failedNames} couldn't be reached this time and will build up gradually instead.`
      : `Done — added ${state.backfill.samplesAdded} real samples to ${state.areaCode || "this area"}'s FFV history.`;
  } else {
    backfillStatus.textContent = "";
  }
  if (backfillButton) backfillButton.disabled = state.backfill.status === "loading";
}

async function fetchYearOfModelData(sourceId, model, start, end, dayCount) {
  const hourlyVars = [];
  for (let d = 1; d <= 7; d++) {
    hourlyVars.push(
      `temperature_2m_previous_day${d}`,
      `precipitation_previous_day${d}`,
      `wind_speed_10m_previous_day${d}`,
      `cloud_cover_previous_day${d}`,
      `pressure_msl_previous_day${d}`,
      `soil_temperature_0cm_previous_day${d}`,
      `dewpoint_2m_previous_day${d}`
    );
  }
  const params = new URLSearchParams({
    latitude: state.lat,
    longitude: state.lon,
    hourly: hourlyVars.join(","),
    start_date: isoDate(start),
    end_date: isoDate(end),
    models: model,
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetchWithTimeout(`${PREVIOUS_RUNS_URL}?${params.toString()}`, {}, 30000);
  if (!res.ok) throw new Error(`${sourceId} history lookup failed`);
  const data = await res.json();
  const hourlyTime = data.hourly.time;

  const byLeadDay = {};
  for (let d = 1; d <= 7; d++) {
    const tempMax = aggregateHourlyByDay(hourlyTime, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
    const tempMin = aggregateHourlyByDay(hourlyTime, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
    byLeadDay[d] = {
      tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
      precip: aggregateHourlyByDay(hourlyTime, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
      wind: aggregateHourlyByDay(hourlyTime, data.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
      cloud: aggregateHourlyByDay(hourlyTime, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean"),
      pressure: aggregateHourlyByDay(hourlyTime, data.hourly[`pressure_msl_previous_day${d}`], dayCount, "mean"),
      soilTemp: aggregateHourlyByDay(hourlyTime, data.hourly[`soil_temperature_0cm_previous_day${d}`], dayCount, "mean"),
      dewPoint: aggregateHourlyByDay(hourlyTime, data.hourly[`dewpoint_2m_previous_day${d}`], dayCount, "mean")
    };
  }
  return byLeadDay;
}

async function backfillRealSourceHistory() {
  if (!state.lat || !state.lon || !state.areaCode) {
    state.backfill = { status: "error", error: "Load a location on the main page first", samplesAdded: 0 };
    renderBackfillStatus();
    return;
  }

  state.backfill = { status: "loading", error: null, samplesAdded: 0 };
  renderBackfillStatus();

  try {
    const end = todayAtMidnight();
    const start = addDays(end, -BACKFILL_DAYS);

    // Real actual weather for the year (ERA5-backed archive) — fetched
    // once and shared across every real source, since Actual doesn't
    // depend on which forecast model is being scored against it.
    const actualParams = new URLSearchParams({
      latitude: state.lat,
      longitude: state.lon,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max",
      hourly: "cloudcover,pressure_msl,soil_temperature_0cm,dewpoint_2m",
      start_date: isoDate(start),
      end_date: isoDate(end),
      wind_speed_unit: "mph",
      timezone: "auto"
    });
    const actualRes = await fetchWithTimeout(`${ARCHIVE_URL}?${actualParams.toString()}`, {}, 30000);
    if (!actualRes.ok) throw new Error("Actual weather archive lookup failed");
    const actualData = await actualRes.json();
    const dayCount = actualData.daily.time.length;

    const yearActual = {
      precip: actualData.daily.precipitation_sum,
      wind: actualData.daily.windspeed_10m_max,
      cloud: aggregateHourlyByDay(actualData.hourly.time, actualData.hourly.cloudcover, dayCount, "mean"),
      pressure: aggregateHourlyByDay(actualData.hourly.time, actualData.hourly.pressure_msl, dayCount, "mean"),
      soilTemp: aggregateHourlyByDay(actualData.hourly.time, actualData.hourly.soil_temperature_0cm, dayCount, "mean"),
      dewPoint: aggregateHourlyByDay(actualData.hourly.time, actualData.hourly.dewpoint_2m, dayCount, "mean"),
      tempAvg: actualData.daily.temperature_2m_max.map((max, i) => {
        const min = actualData.daily.temperature_2m_min[i];
        return (max !== null && min !== null) ? (max + min) / 2 : null;
      })
    };

    // Real lead-time forecasts for the same year, one fetch per source.
    // Each source's fetch is isolated — with nine real sources now (see
    // REAL_SOURCES), the odds that at least one has a bad day (a timeout,
    // a transient 5xx, a rate limit) are much higher than they were with
    // six, and a single failure here used to abort the whole function
    // before anything was saved — discarding every OTHER source's
    // perfectly good year of data too, and leaving every source stuck on
    // "Collecting data (0/14 days)" until a fully clean run happened to
    // succeed. A source that fails here just sits out this run and
    // stays on demo data until eligibility builds up the normal way (or
    // a later backfill succeeds for it) — it doesn't take the other
    // eight down with it.
    const byLeadDayBySource = {};
    const failedSourceIds = [];
    for (const { id, model } of REAL_SOURCES) {
      try {
        byLeadDayBySource[id] = await fetchYearOfModelData(id, model, start, end, dayCount);
      } catch (err) {
        console.error(`Backfill: ${id} failed, continuing with the remaining sources`, err);
        failedSourceIds.push(id);
      }
    }

    // Fold every (mean, actual) pair straight into the same FFV store the
    // day-to-day app reads from.
    const store = loadFFVStore(state.areaCode);
    const eligStore = loadEligibilityStore(state.areaCode);
    let samplesAdded = 0;

    for (let i = 0; i < dayCount; i++) {
      const dateKey = isoDate(addDays(start, i));
      REAL_DATA_CONDITIONS.forEach(conditionName => {
        const actual = yearActual[BACKFILL_FIELD_FOR_CONDITION[conditionName]][i];
        if (actual === null || actual === undefined) return;

        REAL_SOURCES.forEach(({ id: sourceId }) => {
          const byLeadDay = byLeadDayBySource[sourceId];
          if (!byLeadDay) return; // this source failed its fetch above — sits out this run
          for (let day = 1; day <= 7; day++) {
            const leadDays = day === 1 ? [1, 2] : day === 7 ? [6, 7] : [day - 1, day, day + 1];
            const field = BACKFILL_FIELD_FOR_CONDITION[conditionName];
            const values = leadDays
              .map(d => byLeadDay[d]?.[field]?.[i])
              .filter(v => v !== null && v !== undefined);
            if (!values.length) return;
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            if (!mean) return;

            recordFFVSample(store, conditionName, sourceId, day, mean, actual, eligStore, dateKey);
            samplesAdded += 1;
          }
        });
      });
    }

    saveFFVStore(state.areaCode, store);
    saveEligibilityStore(state.areaCode, eligStore);
    state.backfill = {
      status: "done",
      error: null,
      samplesAdded,
      failedSourceIds
    };
  } catch (err) {
    state.backfill = { status: "error", error: err.message || "Backfill failed", samplesAdded: 0 };
  }

  renderBackfillStatus();
  renderTable();
}

function updateRollbackLabel() {
  if (!rollbackLabel) return;
  const targetDate = targetDateForRollback(state.rollback);
  rollbackLabel.textContent = state.rollback === 0 ? "Today" : formatDateLong(targetDate);
}

if (condition) {
  condition.addEventListener("change", () => {
    state.condition = condition.value;
    renderTable();
  });
}

// The slider's raw input runs min-to-max left-to-right as normal, but we
// want LEFT = past and RIGHT = future — so the raw value is negated to
// get rollbackDays (positive = past, negative = future), keeping that
// existing convention unchanged everywhere else in the app.
function updateSliderFill(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  const percent = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty("--fill", `${percent}%`);
}

if (rollback) {
  rollback.addEventListener("input", () => {
    state.rollback = -Number(rollback.value);
    updateSliderFill(rollback);
    resetHourly();
    updateRollbackLabel();
    renderTable();
  });
}

function updateHourLabel() {
  if (!hourLabel) return;
  if (state.hourIndex === 0) {
    // At rest, this cell isn't showing one instant anymore — it's
    // showing the whole Today range (see liveTodayValueFor). "+24h" /
    // "+48h" describes that span itself, matching whichever the
    // Settings hour-range choice is; dragging away from here switches to
    // an actual clock time for the specific hour landed on, unchanged.
    hourLabel.textContent = `+${loadHourRange()}h`;
    return;
  }
  const iso = state.hourly.times[state.hourIndex];
  if (!iso) {
    hourLabel.textContent = `+${state.hourIndex}h`;
    return;
  }
  const d = new Date(iso);
  const crossesDay = isoDate(d) !== isoDate(new Date());
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  hourLabel.textContent = crossesDay ? `${time}, ${formatDateShort(d)}` : time;
}

// No timer-based revert — a dragged position stays put indefinitely so
// there's never a countdown pressuring someone still fine-tuning a
// specific time. Only resets on an explicit signal: touching the Date
// slider (below), or the page being backgrounded/closed (see the
// visibilitychange listener below) — "off screen" is treated as "done
// looking," not "5 seconds have passed."
function resetHourly() {
  state.hourlyActive = false;
  state.hourIndex = 0;
  if (hourSlider) {
    hourSlider.value = 0;
    updateSliderFill(hourSlider);
  }
  updateHourLabel();
}

if (hourSlider) {
  hourSlider.max = String(loadHourRange());
  updateSliderFill(hourSlider);

  hourSlider.addEventListener("input", () => {
    state.hourIndex = Number(hourSlider.value);
    // Only a genuinely different hour switches to the hourly reading —
    // landing back on "Now" (0) behaves as if the slider was never
    // touched, so it matches what's shown on launch instead of jumping
    // to a different, single-source calculation that looks the same
    // ("Now") but isn't.
    state.hourlyActive = state.hourIndex !== 0;
    updateSliderFill(hourSlider);
    updateHourLabel();
    renderHeadline();
  });
}

// Resets the hourly slider once the page is backgrounded or closed, so
// it's back at "Now" whenever it's next opened — without needing a
// countdown that could interrupt someone still actively looking at it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.hourlyActive) {
    resetHourly();
    renderHeadline();
  }
});

// visibilitychange above is the primary signal, but iOS doesn't reliably
// fire it for a web app added to the home screen — background/resume
// there can leave the page's JS running untouched with no hide event at
// all, so hourlyActive could stay stuck true indefinitely across
// separate "launches" rather than resetting as documented. pageshow
// fires whenever the page becomes visible again regardless of how it
// got there (fresh load, back-forward cache restore, or an iOS
// standalone-app resume), so it catches what visibilitychange misses.
// Harmless to call unconditionally — resetHourly() is a no-op if hourly
// mode wasn't active.
window.addEventListener("pageshow", () => {
  if (state.hourlyActive) {
    resetHourly();
    renderHeadline();
  }
});

// The Retry button (see renderActualStatus) only ever fires on a tap —
// nothing previously noticed if connectivity came back on its own while
// the app stayed open, so the "couldn't load weather" block could sit
// there indefinitely even once the network was genuinely fine again.
// The browser's own "online" event catches exactly that case. Guarded to
// only re-fetch when there's an actual error showing, so a spurious or
// redundant "online" firing (some browsers fire it more than strictly
// necessary) doesn't trigger pointless extra network requests.
window.addEventListener("online", () => {
  if (state.actual.status === "error") {
    loadLocationData();
  }
});

// Belt-and-braces alongside the listener above: "online" only fires on a
// genuine OS-level network transition (e.g. leaving airplane mode) — it
// never fires if the original failure was a one-off fetch hiccup while
// the device stayed continuously connected the whole time, which would
// leave the error block stuck with no transition to catch. This just
// tries again periodically for as long as an error is actually showing,
// so it clears itself either way without needing a manual tap. Cheap and
// harmless when there's nothing wrong — it's a no-op unless
// state.actual.status is genuinely "error".
setInterval(() => {
  if (state.actual.status === "error") {
    loadLocationData();
  }
}, 30000);

const placeAmbiguityPicker = document.getElementById("placeAmbiguityPicker");

function clearPlaceAmbiguityPicker() {
  if (!placeAmbiguityPicker) return;
  placeAmbiguityPicker.hidden = true;
  placeAmbiguityPicker.innerHTML = "";
}

// Shared by Switch and Save — both take a plain typed name and both need
// to stop and ask, rather than silently resolving to whichever same-
// named place the geocoder ranks first, when a name genuinely matches
// more than one distinct UK town (Gillingham in Kent vs Dorset, and
// plenty of others). Returns true if it found (and is now displaying) a
// choice the caller should wait on; false means the caller can proceed
// normally — either the name was never ambiguous, or the network check
// itself failed, in which case the caller's own existing lookup will
// surface that same failure in its own error handling rather than this
// duplicating it.
async function checkPlaceAmbiguity(trimmed, onChosen) {
  clearPlaceAmbiguityPicker();
  if (!trimmed || looksLikePostcode(trimmed) || trimmed.includes(",")) return false;

  try {
    await resolveLocation(trimmed);
    return false; // resolved cleanly — not ambiguous
  } catch (err) {
    if (!(err instanceof AmbiguousLocationError)) return false; // let the caller's own lookup hit and report this
    if (!placeAmbiguityPicker) return false; // nowhere to show it — proceed and let the caller's own lookup pick one

    const heading = document.createElement("p");
    heading.className = "place-ambiguity-heading";
    heading.textContent = `More than one "${trimmed}" in the UK — which one?`;
    placeAmbiguityPicker.appendChild(heading);

    err.candidates.forEach(candidate => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "place-ambiguity-option";
      // admin2 is preferred over admin1 here since, for the UK, admin1
      // is usually just "England"/"Scotland"/"Wales" — not specific
      // enough to actually distinguish two same-named English towns —
      // whereas admin2 is typically the county (Kent, Dorset, etc.),
      // which is.
      const qualified = [candidate.name, candidate.admin2 || candidate.admin1].filter(Boolean).join(", ");
      button.textContent = [candidate.name, candidate.admin2, candidate.admin1, candidate.country].filter(Boolean).join(", ");
      button.addEventListener("click", () => {
        postcode.value = qualified;
        clearPlaceAmbiguityPicker();
        onChosen(qualified);
      });
      placeAmbiguityPicker.appendChild(button);
    });

    placeAmbiguityPicker.hidden = false;
    return true;
  }
}

const updateLocationButton = document.getElementById("updateLocation");
async function performSwitch() {
  const trimmed = postcode.value.trim();
  const isAmbiguous = await checkPlaceAmbiguity(trimmed, performSwitch);
  if (isAmbiguous) return;

  // Only postcodes get uppercased (their conventional display form,
  // and how looksLikePostcode expects to match them either way) — a
  // place name keeps whatever capitalisation was typed, since forcing
  // "LONDON" would just look wrong for no benefit.
  state.postcode = looksLikePostcode(trimmed) ? trimmed.toUpperCase() : trimmed;
  postcode.value = state.postcode;
  saveCurrentPostcode(state.postcode);
  resetForLocationChange();
  renderPlaceChip();
  renderPlaceDots();
  renderPlacesList();
  loadLocationData();
}
if (updateLocationButton) {
  updateLocationButton.addEventListener("click", performSwitch);
}

if (backfillButton) {
  backfillButton.addEventListener("click", backfillRealSourceHistory);
}

// ---- Saved places: quick-switch chip (front page header) and the
// manage-places list (Settings). Both read/write the same PLACES_KEY /
// CURRENT_POSTCODE_KEY, so a place saved on one page shows up on the
// other without needing a shared framework.

// ---- Recent-location cache ----
// Switching between a couple of saved places to compare (checking beach
// vs hills for tomorrow, say) used to mean a full blank-then-reload every
// single time, even switching straight back to somewhere just looked at
// moments ago. This keeps a short-lived snapshot of the last
// successfully completed load per place, so switching back within a few
// minutes shows that data immediately, with a fresh fetch still kicked
// off silently behind it. It only ever stores a genuinely COMPLETE,
// already-rendered snapshot, never a partial one, so this doesn't reopen
// the "flash of inconsistent data" problem fixed earlier — it's showing
// data that was fully correct a few minutes ago, the same trade-off any
// ordinary weather app's own caching already makes.
//
// Backed by sessionStorage rather than a plain in-memory variable — this
// is a plain multi-page site (index.html, compare.html, settings.html,
// help.html are each separate documents), so a variable would be wiped
// on every single navigation between them, and iOS reloads a backgrounded
// PWA's page fairly readily too. sessionStorage survives both of those
// (cleared only when the browser tab/window itself actually closes),
// which is the lifetime this feature is actually meant to have — a
// plain variable was silently making the buffer far less reliable than
// it looked like it should be.
const RECENT_LOCATION_CACHE_MS = 5 * 60 * 1000;
const RECENT_LOCATION_CACHE_KEY = "forecast-compare:recentLocationCache";

function loadRecentLocationCache() {
  try {
    const raw = sessionStorage.getItem(RECENT_LOCATION_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRecentLocationCache(cache) {
  try {
    sessionStorage.setItem(RECENT_LOCATION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable or full — the buffer just won't persist this
    // time, no different from it never having been cached at all.
  }
}

// While a background refresh is running behind an already-displayed
// cached snapshot, currentDisplayIsComplete (see renderHeadline) is set
// true immediately — which is what actually stops the screen blanking
// mid-refresh, regardless of what triggers a render during that window.
// The final render at the end of a load always sets it true again too
// (whether or not this cache path was involved), so the screen still
// updates once fresh data is genuinely ready.

function cacheCurrentLocationSnapshot() {
  if (state.actual.status !== "ready") return; // only a fully completed load is worth caching
  const cache = loadRecentLocationCache();
  cache[state.postcode] = {
    actual: state.actual,
    realSources: state.realSources,
    hourly: state.hourly,
    areaCode: state.areaCode,
    lat: state.lat,
    lon: state.lon,
    cachedAt: Date.now()
  };
  saveRecentLocationCache(cache);
}

// Restores state from a cached snapshot if one exists for this exact
// postcode/place string and is still within the buffer window. Returns
// true if it did (caller should render immediately and can rely on a
// background refresh to update things further), false if there was
// nothing usable (caller should fall back to its normal blank-and-load
// behaviour).
function restoreFromRecentLocationCache(pc) {
  const cache = loadRecentLocationCache();
  const snap = cache[pc];
  if (!snap || Date.now() - snap.cachedAt > RECENT_LOCATION_CACHE_MS) return false;
  // structuredClone here (rather than using snap's own nested objects
  // directly) matters: snap came straight out of JSON.parse, so it's
  // already a fresh, unshared set of objects — but state.actual etc. get
  // mutated in place by the fetch functions the moment a background
  // refresh starts, and cloning keeps this restored copy from being
  // affected if the SAME cache object were ever reused elsewhere.
  state.actual = structuredClone(snap.actual);
  state.realSources = structuredClone(snap.realSources);
  state.hourly = structuredClone(snap.hourly);
  state.areaCode = snap.areaCode;
  state.lat = snap.lat;
  state.lon = snap.lon;
  return true;
}

// A location switch just started (see resetForLocationChange) — refuse
// to build cells from whatever's still sitting in state.hourly/
// state.actual at this exact moment, since that's the PREVIOUS place's
// data and the new fetch hasn't landed yet. Better to show nothing
// briefly than to silently keep showing numbers that belong somewhere
// else while the switch is still in flight — UNLESS a fresh-enough
// cached snapshot for the NEW place exists, in which case there's no
// need to show nothing at all.
function resetForLocationChange() {
  if (restoreFromRecentLocationCache(state.postcode)) {
    currentDisplayIsComplete = true;
    renderActualStatus();
    renderRealSourceStatus();
    renderHeadline();
    renderTable();
    return;
  }

  currentDisplayIsComplete = false;
  state.actual.status = "loading";
  state.hourly.status = "loading";
  renderActualStatus();
  renderHeadline();
  renderTable();
}

function switchToPostcode(pc) {
  if (!pc || pc === state.postcode) return;
  state.postcode = pc;
  if (postcode) postcode.value = pc;
  saveCurrentPostcode(pc);
  resetForLocationChange();
  renderPlaceChip();
  renderPlaceDots();
  renderPlacesList();
  loadLocationData();
}

// ---- Swipe between saved places (front page) ----
// The whole "Today" card is the swipe zone — a much bigger, more
// discoverable target than the header chip alone — except the Hour
// slider itself, which already owns a horizontal drag gesture in the
// same card. Layering a second horizontal gesture directly on top of it
// would make both ambiguous, so touches starting on the slider are left
// alone entirely and it keeps behaving exactly as it always has.
//
// touch-action: pan-y on the card (see style.css) tells the browser to
// keep handling vertical page scrolling natively here — this code only
// ever looks at horizontal movement, so scrolling the page from inside
// the card is never intercepted or fought over.
const headlineSwipeZone = document.querySelector(".headline");
if (headlineSwipeZone) {
  const SWIPE_THRESHOLD_PX = 40;
  let swipeStartX = null;
  let swipeStartY = null;
  let swiping = false;
  // The direction is now decided the MOMENT the threshold is first
  // crossed (see pointermove) and frozen here, rather than recomputed
  // from scratch at pointerup — see the comment on pointerup below for
  // why recomputing it there was the actual "moves the wrong way" bug.
  let swipeDirection = null;
  // Pointer events only keep targeting the element they started on for
  // as long as the pointer stays over it — without explicitly capturing
  // it, a fast real-world flick that drifts even slightly outside the
  // card's bounds (very easy near a screen edge, or once the finger
  // moves diagonally enough) silently stops delivering pointermove/
  // pointerup to this listener entirely. That left swipeStartX stuck
  // non-null with no pointerup ever arriving to clear it — which is the
  // actual explanation for BOTH reported symptoms: "unresponsive" was
  // gestures getting silently dropped this way, and "moves the wrong
  // way" was the NEXT gesture's dx being measured against that stale,
  // leftover start position from the dropped one instead of its own.
  // Capturing the pointer on down guarantees this element keeps
  // receiving every move/up for that finger regardless of where it
  // wanders, so a gesture always ends with a real pointerup or
  // pointercancel to clean up after itself.
  let swipePointerId = null;

  function resetSwipeTracking() {
    swipeStartX = null;
    swipeStartY = null;
    swiping = false;
    swipeDirection = null;
    swipePointerId = null;
  }

  headlineSwipeZone.addEventListener("pointerdown", e => {
    if (e.target.closest(".hour-slider")) return; // the slider owns its own drag entirely
    // A second finger touching down mid-gesture (very easy to do by
    // accident while holding a phone) used to silently reset
    // swipeStartX to the NEW finger's position, corrupting whatever the
    // first finger's gesture was already tracking. Once a gesture is
    // underway, only its own pointerId is ever listened to again until
    // it ends.
    if (swipePointerId !== null) return;
    swipePointerId = e.pointerId;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
    swiping = false;
    swipeDirection = null;
    try {
      headlineSwipeZone.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture isn't available on every platform — the gesture
      // still works via normal event delivery, just without the
      // drift-outside-the-card protection described above.
    }
  });

  headlineSwipeZone.addEventListener("pointermove", e => {
    if (swipeStartX === null || e.pointerId !== swipePointerId) return;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    // Horizontal has to clearly dominate before this counts as a swipe
    // rather than the start of a vertical scroll or a plain tap on one
    // of the headline cells (which still needs to open its own graph
    // sheet normally — this only intervenes once movement is unambiguous).
    if (!swiping && Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiping = true;
      // Freeze direction right here, at the moment the gesture first
      // became unambiguous — see the note above on swipeDirection for
      // why pointerup must NOT recompute this from a fresh dx.
      swipeDirection = dx < 0 ? 1 : -1;
    }
  });

  headlineSwipeZone.addEventListener("pointerup", e => {
    if (swipeStartX === null || e.pointerId !== swipePointerId) return;
    if (swiping && swipeDirection !== null) {
      swipeToAdjacentPlace(swipeDirection);
    }
    resetSwipeTracking();
  });

  headlineSwipeZone.addEventListener("pointercancel", e => {
    if (e.pointerId !== swipePointerId) return;
    resetSwipeTracking();
  });
}

// Cycles to the next/previous saved place relative to whichever one is
// currently showing, wrapping around at either end. Does nothing if the
// current location isn't itself a saved place (nothing to cycle
// relative to) or there are fewer than two saved places to cycle between.
function swipeToAdjacentPlace(direction) {
  const places = loadPlaces();
  if (places.length < 2) return;
  const currentIndex = places.findIndex(place => place.postcode === state.postcode);
  if (currentIndex === -1) return;
  const nextIndex = (currentIndex + direction + places.length) % places.length;
  switchToPostcode(places[nextIndex].postcode);
}

function renderPlaceChip() {
  if (!placeChipLabel) return;
  const match = loadPlaces().find(place => place.postcode === state.postcode);
  placeChipLabel.textContent = match ? match.label : (state.postcode || "Set location");
}

const placeDots = document.getElementById("placeDots");

// A small position indicator — the same idea as a photo carousel's dots
// — so the swipe gesture (see swipeToAdjacentPlace above) isn't
// completely invisible: nothing else on screen hints that swiping the
// card does anything. Only shown with two or more saved places, since a
// single dot (or none) would just be visual noise for nothing to
// indicate. Rebuilt from scratch on every call rather than diffed —
// there are only ever a handful of saved places, so this is cheap.
function renderPlaceDots() {
  if (!placeDots) return;
  placeDots.innerHTML = "";

  const places = loadPlaces();
  if (places.length < 2) return;

  places.forEach(place => {
    // icon-192.png rather than a fresh SVG redraw — there's no source
    // artwork for the mark other than the existing PNGs, and downscaling
    // a 192px source to this size stays perfectly crisp.
    const icon = document.createElement("img");
    icon.src = "icon-192.png";
    icon.alt = "";
    icon.className = "place-dot" + (place.postcode === state.postcode ? " is-current" : "");
    placeDots.appendChild(icon);
  });
}

function closePlaceMenu() {
  if (!placeMenu) return;
  placeMenu.hidden = true;
  if (placeChip) placeChip.setAttribute("aria-expanded", "false");
}

function renderPlaceMenu() {
  if (!placeMenuList) return;
  placeMenuList.innerHTML = "";
  const places = loadPlaces();
  if (!places.length) {
    const hint = document.createElement("p");
    hint.className = "place-menu-empty";
    hint.textContent = "No saved places yet.";
    placeMenuList.appendChild(hint);
    return;
  }
  places.forEach(place => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "place-menu-item" + (place.postcode === state.postcode ? " is-current" : "");
    item.textContent = place.label;
    item.addEventListener("click", () => {
      closePlaceMenu();
      switchToPostcode(place.postcode);
    });
    placeMenuList.appendChild(item);
  });
}

if (placeChip) {
  renderPlaceChip();
  renderPlaceDots();
  placeChip.addEventListener("click", () => {
    if (!placeMenu) return;
    if (placeMenu.hidden) {
      renderPlaceMenu();
      placeMenu.hidden = false;
      placeChip.setAttribute("aria-expanded", "true");
    } else {
      closePlaceMenu();
    }
  });
  document.addEventListener("click", event => {
    // A tap on the chip almost never lands on the <button> element
    // itself — it lands on the label span or the caret span inside it,
    // since that's where the visible content (and so the actual tap
    // target) is. event.target !== placeChip is true for exactly those
    // taps, since the target is the CHILD span, not the button — so this
    // "close if the click was outside the chip" check was true for the
    // very same click that had just opened the menu a moment earlier in
    // the listener above, closing it again in the same event cycle
    // before it could ever actually be seen or used. Checking
    // placeChip.contains(event.target) instead correctly treats a click
    // anywhere inside the chip (button or either of its child spans) as
    // "inside", so opening and the outside-close check agree with each
    // other.
    if (placeMenu && !placeMenu.hidden && !placeMenu.contains(event.target) && !placeChip.contains(event.target)) {
      closePlaceMenu();
    }
  });
}

function renderPlacesList() {
  if (!placesList) return;
  placesList.innerHTML = "";
  const places = loadPlaces();

  if (!places.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No saved places yet — save your current location below.";
    placesList.appendChild(empty);
  }

  places.forEach(place => {
    const row = document.createElement("div");
    row.className = "place-row" + (place.postcode === state.postcode ? " is-current" : "");

    const info = document.createElement("div");
    info.className = "place-row-info";

    const nameLine = document.createElement("div");
    nameLine.className = "place-row-name-line";

    // Editable inline rather than a separate rename mode — defaults to
    // the postcode itself until changed, so a saved place is always
    // usable straight away and renaming is purely optional.
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "place-row-label";
    labelInput.value = place.label;
    labelInput.maxLength = 24;
    labelInput.setAttribute("aria-label", `Name for ${place.postcode}`);
    labelInput.addEventListener("change", () => {
      place.label = labelInput.value.trim() || place.postcode;
      labelInput.value = place.label;
      renderPostcodeSub();
      savePlaces(places);
      renderPlaceMenu();
      renderPlaceChip();
      renderPlaceDots();
    });
    nameLine.appendChild(labelInput);

    // Only shown once a place has actually been given a real nickname —
    // if the label is still just the postcode itself, showing the
    // postcode a second time right next to it would be pure repetition.
    const postcodeSub = document.createElement("small");
    postcodeSub.className = "place-row-postcode";
    function renderPostcodeSub() {
      postcodeSub.textContent = place.label !== place.postcode ? place.postcode : "";
    }
    renderPostcodeSub();
    nameLine.appendChild(postcodeSub);

    info.appendChild(nameLine);

    row.appendChild(info);

    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "place-row-switch";
    switchBtn.textContent = place.postcode === state.postcode ? "Current" : "Switch";
    switchBtn.disabled = place.postcode === state.postcode;
    switchBtn.addEventListener("click", () => switchToPostcode(place.postcode));
    row.appendChild(switchBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "place-row-remove";
    removeBtn.setAttribute("aria-label", `Remove ${place.label}`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      savePlaces(loadPlaces().filter(saved => saved.postcode !== place.postcode));
      renderPlacesList();
      renderPlaceMenu();
    });
    row.appendChild(removeBtn);

    placesList.appendChild(row);
  });
}

// Save reads directly from the same shared field Switch uses — typing a
// place and tapping Save works on its own, with no need to Switch first.
// Deliberately doesn't change what's currently shown (see the note in
// the markup): adding a place and looking at it right now are two
// different things, and someone adding a family member's postcode while
// wanting to keep looking at their own weather shouldn't have the view
// yanked away.
const addPlaceStatus = document.getElementById("addPlaceStatus");

function renderAddPlaceStatus(message, isError) {
  if (!addPlaceStatus) return;
  addPlaceStatus.textContent = message || "";
  addPlaceStatus.classList.toggle("is-error", !!isError);
}

async function performSave() {
  const rawInput = (postcode?.value || "").trim();
  if (!rawInput) {
    renderAddPlaceStatus("Enter a postcode or place name first.", true);
    return;
  }

  const isAmbiguous = await checkPlaceAmbiguity(rawInput, performSave);
  if (isAmbiguous) return;

  // Same rule as Switch: only postcodes get uppercased, a place name
  // keeps its natural capitalisation. This is also the string stored
  // as the place's postcode/query going forward, so it's what
  // switchToPostcode later feeds back into resolveLocation.
  const pc = looksLikePostcode(rawInput) ? rawInput.toUpperCase() : rawInput;

  const places = loadPlaces();
  if (places.some(place => place.postcode === pc)) {
    renderAddPlaceStatus(`${pc} is already saved.`, true);
    return;
  }

  addCurrentPlaceButton.disabled = true;
  renderAddPlaceStatus("Checking…", false);

  try {
    // Validates it actually resolves to a real place before saving it —
    // the same lookup Switch itself relies on — without loading full
    // weather data for it (that only happens once it's switched to).
    await resolveLocation(pc);
  } catch (err) {
    addCurrentPlaceButton.disabled = false;
    renderAddPlaceStatus(err.message || "Not found.", true);
    return;
  }

    // No separate name field any more — the saved places list already
    // lets you rename any entry inline after adding it, so there's no
    // need to ask for one upfront too.
    places.push({ postcode: pc, label: pc });
    savePlaces(places);

    addCurrentPlaceButton.disabled = false;
    renderAddPlaceStatus("", false);
    renderPlacesList();
    renderPlaceMenu();
}
if (addCurrentPlaceButton) {
  addCurrentPlaceButton.addEventListener("click", performSave);
}

function renderGeoStatus(message, isError) {
  if (!geoStatus) return;
  geoStatus.classList.toggle("is-error", !!isError);
  geoStatus.textContent = message || "";
}

if (headlineRetry) {
  headlineRetry.addEventListener("click", () => {
    headlineRetry.disabled = true;
    loadLocationData().finally(() => {
      headlineRetry.disabled = false;
    });
  });
}

if (useMyLocationButton) {
  useMyLocationButton.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      renderGeoStatus("Geolocation isn't available in this browser.", true);
      return;
    }
    renderGeoStatus("Finding your location…", false);
    navigator.geolocation.getCurrentPosition(
      async position => {
        try {
          const pc = await reverseGeocodeCoords(position.coords.latitude, position.coords.longitude);
          renderGeoStatus("", false);
          state.postcode = pc;
          if (postcode) postcode.value = pc;
          saveCurrentPostcode(pc);
          // This used to skip straight to loadLocationData() without ever
          // calling resetForLocationChange() — every OTHER way of
          // changing location (Switch button, saved-place tap, swipe,
          // header chip) goes through it, but this one didn't. Two real
          // consequences: (1) it never even checked the recent-location
          // cache, so "Use my location" always did a full cold reload
          // even when you'd looked at this exact spot moments ago; (2)
          // far worse, currentDisplayIsComplete was left exactly as it
          // was for the PREVIOUS place — usually true — so the headline
          // kept confidently showing the previous location's numbers
          // (not blanked, not marked mid-switch) while state.postcode
          // had already silently moved on to the new one underneath it.
          // Once the background fetch started flipping sources to
          // "loading", the mid-refresh guard in renderHeadline() (which
          // exists to stop a partial blend flickering into view) would
          // then refuse to repaint AT ALL until every source finished —
          // freezing the previous location's stale display on screen for
          // the whole fetch, with nothing forcing a repaint once it
          // finished either. Touching the Hour or Date slider afterwards
          // called renderHeadline() directly, which by then found
          // everything genuinely settled and finally painted the correct
          // figures — which is exactly why the data only ever seemed to
          // "fix itself" once a slider was nudged.
          resetForLocationChange();
          renderPlaceChip();
          renderPlaceDots();
          renderPlacesList();
          loadLocationData();
        } catch (err) {
          renderGeoStatus(err.message || "Could not find a postcode for your location.", true);
        }
      },
      error => {
        renderGeoStatus(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied."
            : "Could not get your location.",
          true
        );
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });
}

if (placesList) renderPlacesList();

if (rollback) {
  updateSliderFill(rollback);
  updateRollbackLabel();
}
updateHourLabel();

// The front page (headlineGrid) and Compare page (table) both need live
// weather data; Settings doesn't display anything weather-dependent, so
// it skips the fetch entirely rather than making wasted API calls.
//
// This used to call renderTable() directly here, which always shows the
// plain "Loading weather…" blank state and never once checked the
// recent-location cache — resetForLocationChange() (which DOES check it)
// was only ever called from the explicit in-page switch actions (Switch
// button, saved-place tap, swipe, header chip). But this is a plain
// multi-page site: index.html, compare.html, settings.html, and
// help.html are each a full separate document, so EVERY navigation
// between them re-runs this entire script from scratch and hits this
// exact line — there is no other bootstrap path. That made the recent-
// location cache effectively dead for the single most common case it
// was actually built for (per its own comments): switching pages, or
// backgrounding/resuming the app, for the SAME place you were just
// looking at. Calling resetForLocationChange() here instead means a
// fresh page load or navigation gets exactly the same cache check as an
// explicit switch — instant display from a fresh-enough snapshot if one
// exists for the current postcode, a plain loading blank otherwise —
// before the background fetch (still always run, to keep things
// current) kicks off underneath it.
if (headlineGrid || table) {
  resetForLocationChange();
  loadLocationData();
}
