const CONFIG = {
  forecasters: [
    { id: "metoffice", name: "Met Office", enabled: true, offset: 0 },
    { id: "ecmwf", name: "ECMWF", enabled: true, offset: 0.2 },
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
    sunshine: { name: "Sunshine", unit: "hrs" },
    uv: { name: "UV", unit: "index" }
  }
};

// Everything is stored and computed internally in these native units —
// rain in mm, wind in mph, temperature in °C — regardless of the display
// toggle below. Only formatValue() and unit labels convert for display;
// FFV, accuracy, and all other math always operate on native values, so
// the toggle can never skew the numbers themselves, only how they're shown.
const UNIT_SYSTEM_KEY = "forecast-compare:unitSystem";
const CONDITION_UNIT_LABELS = {
  rain: { metric: "mm", imperial: "in" },
  cloud: { metric: "%", imperial: "%" },
  wind: { metric: "km/h", imperial: "mph" },
  temperature: { metric: "°C", imperial: "°F" },
  sunshine: { metric: "hrs", imperial: "hrs" },
  uv: { metric: "index", imperial: "index" }
};

function loadUnitSystem() {
  try {
    const raw = localStorage.getItem(UNIT_SYSTEM_KEY);
    if (raw === "metric" || raw === "imperial") return raw;
  } catch {
    // fall through to default
  }
  return "metric";
}

function unitLabel(conditionName) {
  return CONDITION_UNIT_LABELS[conditionName]?.[state.unitSystem] ?? CONFIG.conditions[conditionName].unit;
}

// Converts a native-unit value (mm / mph / °C) to whichever system the
// toggle is set to. Cloud, Sunshine, and UV are unitless/universal and
// pass through unchanged either way. isDelta matters only for
// temperature: a DIFFERENCE (badge deltas, accuracy error magnitudes)
// scales by 9/5 with no +32 offset — converting a 2°C gap should give a
// 3.6°F gap, not 2×9/5+32.
function convertForDisplay(value, conditionName, isDelta = false) {
  if (value === null || value === undefined) return value;
  if (state.unitSystem === "imperial") {
    if (conditionName === "rain") return value / 25.4; // mm -> in
    if (conditionName === "temperature") return isDelta ? value * 9 / 5 : value * 9 / 5 + 32; // °C -> °F
    return value; // wind is already mph natively
  }
  // metric
  if (conditionName === "wind") return value * 1.60934; // mph -> km/h
  return value; // rain (mm) and temperature (°C) are already metric natively
}

// ---- Actual weather (Open-Meteo, no API key) ----
// Geocoding: api.postcodes.io (UK postcodes -> lat/lon)
// Weather: api.open-meteo.com/v1/forecast with past_days to pull recent
// recorded days alongside today. No key required for either.
const GEOCODE_URL = "https://api.postcodes.io/outcodes/";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const MAX_ROLLBACK = 7; // days into the past the slider (and Actual) can reach
const MAX_FUTURE = 7; // days into the future the slider (and Met Office's live forecast) can reach

// Real data (Open-Meteo's Previous Runs API) only covers these four
// conditions for any source — Sunshine and UV aren't in that dataset, so
// real sources fall back to the demo formula for those two.
const REAL_DATA_CONDITIONS = new Set(["rain", "cloud", "wind", "temperature"]);

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
  { id: "ecmwf", model: "ecmwf_ifs025" }
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
    if (raw) return JSON.parse(raw);
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
    byLeadDay[d] = { tempMax: [], tempMin: [], tempAvg: [], precip: [], wind: [], windDirection: [], cloud: [] };
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
  unitSystem: loadUnitSystem(),
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
    sunshine_duration: [],
    uv_index_max: [],
    cloud_mean: []
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
    dayCount: 0
  },
  hourly: {
    status: "idle", // idle | loading | ready | error
    error: null,
    times: [], // ISO datetime strings, aligned across all arrays below
    temperature: [],
    precipitation: [],
    windSpeed: [],
    windDirection: [],
    uvIndex: [],
    sunriseByDate: {}, // "YYYY-MM-DD" -> ISO datetime
    sunsetByDate: {},
    uvMaxByDate: {} // "YYYY-MM-DD" -> that day's peak UV index
  },
  hourIndex: 0, // 0 = now; the hour slider's current position
  hourlyActive: false // true while the hour slider is showing a specific hour rather than "Now"
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
const hourSlider = document.getElementById("hourSlider");
const hourLabel = document.getElementById("hourLabel");
const placeChip = document.getElementById("placeChip");
const placeChipLabel = document.getElementById("placeChipLabel");
const placeMenu = document.getElementById("placeMenu");
const placeMenuList = document.getElementById("placeMenuList");
const placesList = document.getElementById("placesList");
const addCurrentPlaceButton = document.getElementById("addCurrentPlace");

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
    return state.unitSystem === "imperial" ? value.toFixed(2) : value.toFixed(1);
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

// ---- Actual weather fetching ----

async function geocodePostcode(pc) {
  // Location is resolved from the first 3 characters of the postcode
  // (area-level, not the exact address) via postcodes.io's outcode lookup.
  // Note: some outward codes are 4 characters (e.g. "SW1A"); truncating to
  // 3 will miss those and the lookup below will fail for them.
  const areaCode = pc.replace(/\s+/g, "").slice(0, 3);
  const res = await fetch(GEOCODE_URL + encodeURIComponent(areaCode));
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
    const peak = entries.reduce((a, b) => (b.speed > a.speed ? b : a));
    return peak.direction ?? null;
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
        "sunshine_duration",
        "uv_index_max"
      ].join(","),
      hourly: "cloudcover",
      past_days: MAX_ROLLBACK,
      forecast_days: 1,
      wind_speed_unit: "mph",
      timezone: "auto"
    });

    const res = await fetch(`${WEATHER_URL}?${params.toString()}`);
    if (!res.ok) throw new Error("Weather lookup failed");
    const data = await res.json();

    const dayCount = data.daily.time.length; // MAX_ROLLBACK + 1, oldest first

    state.actual.dates = data.daily.time;
    state.actual.temperature_2m_max = data.daily.temperature_2m_max;
    state.actual.temperature_2m_min = data.daily.temperature_2m_min;
    state.actual.precipitation_sum = data.daily.precipitation_sum;
    state.actual.windspeed_10m_max = data.daily.windspeed_10m_max;
    state.actual.sunshine_duration = data.daily.sunshine_duration;
    state.actual.uv_index_max = data.daily.uv_index_max;
    state.actual.cloud_mean = averageCloudByDay(
      data.hourly.time,
      data.hourly.cloudcover,
      dayCount
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
        `cloud_cover_previous_day${d}`
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

    const res = await fetch(`${PREVIOUS_RUNS_URL}?${params.toString()}`);
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
        windDirection: directionAtPeakHour(hourlyTimes, windSpeedHourly, data.hourly[`wind_direction_10m_previous_day${d}`], dayCount),
        cloud: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean")
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
const MOON_PHASE_EMOJI = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC
const SYNODIC_MONTH_MS = 29.530588 * 24 * 60 * 60 * 1000;

function moonPhaseEmoji(date) {
  const age = ((date.getTime() - KNOWN_NEW_MOON) % SYNODIC_MONTH_MS + SYNODIC_MONTH_MS) % SYNODIC_MONTH_MS;
  const fraction = age / SYNODIC_MONTH_MS; // 0 = new, 0.5 = full
  const index = Math.round(fraction * 8) % 8;
  return MOON_PHASE_EMOJI[index];
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
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      hourly: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,uv_index",
      daily: "sunrise,sunset,uv_index_max",
      models: REAL_SOURCES.find(s => s.id === "metoffice").model, // hourly stays Met Office-specific for now — see README
      wind_speed_unit: "mph",
      forecast_days: 3,
      timezone: "auto"
    });

    const res = await fetch(`${WEATHER_URL}?${params.toString()}`);
    if (!res.ok) throw new Error("Hourly forecast lookup failed");
    const data = await res.json();

    const now = new Date();
    const startIdx = data.hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);
    const from = startIdx >= 0 ? startIdx : 0;

    state.hourly.times = data.hourly.time.slice(from);
    state.hourly.temperature = data.hourly.temperature_2m.slice(from);
    state.hourly.precipitation = data.hourly.precipitation.slice(from);
    state.hourly.windSpeed = data.hourly.wind_speed_10m.slice(from);
    state.hourly.windDirection = data.hourly.wind_direction_10m.slice(from);
    state.hourly.uvIndex = data.hourly.uv_index.slice(from);

    state.hourly.sunriseByDate = {};
    state.hourly.sunsetByDate = {};
    state.hourly.uvMaxByDate = {};
    data.daily.time.forEach((date, i) => {
      state.hourly.sunriseByDate[date] = data.daily.sunrise[i];
      state.hourly.sunsetByDate[date] = data.daily.sunset[i];
      state.hourly.uvMaxByDate[date] = data.daily.uv_index_max[i];
    });

    state.hourly.status = "ready";
  } catch (err) {
    state.hourly.status = "error";
    state.hourly.error = err.message || "Could not load hourly forecast";
  }
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
    historyStatus.textContent = state.history.dayCount > 0
      ? `Real-source accuracy is built from ${state.history.dayCount} day${state.history.dayCount === 1 ? "" : "s"} collected automatically once a day.`
      : "No collected history yet — the daily Action hasn't run yet, or hasn't been set up.";
  } else {
    historyStatus.textContent = "";
  }
}

async function loadCommittedHistory() {
  if (!state.areaCode) return;

  state.history.status = "loading";
  state.history.error = null;
  renderHistoryStatus();

  try {
    const res = await fetch(HISTORY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("history.json not found");
    const data = await res.json();
    const dates = Object.keys(data.days || {});

    const store = loadFFVStore(state.areaCode);
    // Rebuild every real source's entries from scratch — this file is the
    // single source of truth for them, so a partial/incremental merge
    // would risk exactly the double-counting this mechanism exists to avoid.
    Object.keys(CONFIG.conditions).forEach(conditionName => {
      realSourceIds().forEach(sourceId => {
        if (store[conditionName]) delete store[conditionName][sourceId];
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
            recordFFVSample(store, conditionName, sourceId, day, mean, actual);
          }
        });
      });
    });

    saveFFVStore(state.areaCode, store);
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

async function loadLocationData() {
  try {
    const { lat, lon, label, areaCode } = await geocodePostcode(state.postcode);
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
    } catch (bookkeepingErr) {
      console.error("FFV bookkeeping failed (data itself still loaded fine):", bookkeepingErr);
    }

    renderActualStatus();
    renderRealSourceStatus();
    renderTable();
  } catch (err) {
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
    } else {
      headlineStatus.textContent = "";
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
const FFV_OFFSET_CLAMP = [-15, 15]; // °C — generous but rules out a single wild sample skewing things

// Rain/Cloud/Wind are ratio quantities ("20% too high" is meaningful) so
// a multiplicative correction (mean × FFV) is right for them. Temperature
// in °C has no true zero — 20°C isn't "twice as hot" as 10°C — so a
// ratio correction can behave oddly near/below freezing. It gets an
// additive correction instead (mean + FFV), tracked as a separate running
// average alongside the ratio one, rather than reinterpreting.
function isRatioCondition(conditionName) {
  return conditionName !== "temperature";
}

function applyCorrection(mean, ffv, conditionName) {
  return isRatioCondition(conditionName) ? mean * ffv : mean + ffv;
}

function ffvStorageKey(areaCode) {
  return `forecast-compare:ffv:${areaCode}`;
}

function loadFFVStore(areaCode) {
  try {
    const raw = localStorage.getItem(ffvStorageKey(areaCode));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveFFVStore(areaCode, store) {
  try {
    localStorage.setItem(ffvStorageKey(areaCode), JSON.stringify(store));
  } catch {
    // Storage unavailable (e.g. private browsing) — FFV just won't persist.
  }
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
function recordFFVSample(store, conditionName, sourceId, day, mean, actual) {
  if (!mean) return; // guards against divide-by-zero ratios

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

  if (entry.count >= FFV_MIN_SAMPLES) {
    const currentFFV = isRatioCondition(conditionName)
      ? entry.sumRatio / entry.count
      : entry.sumOffset / entry.count;
    entry.sumAbsErrorCorrected += Math.abs(applyCorrection(mean, currentFFV, conditionName) - actual);
    entry.scoredCount += 1;
  }

  entry.sumAbsErrorRaw += Math.abs(mean - actual);
  entry.sumRatio += clampRatio(actual / mean);
  entry.sumOffset += clampOffset(actual - mean);
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
  const realIds = realSourceIds();

  for (let rollbackDays = 1; rollbackDays <= MAX_ROLLBACK; rollbackDays++) {
    Object.keys(CONFIG.conditions).forEach(conditionName => {
      const actual = actualValueFor(conditionName, rollbackDays);
      if (actual === null || actual === undefined) return;

      CONFIG.forecasters
        .filter(source => !realIds.includes(source.id))
        .forEach(source => {
          for (let day = 1; day <= 7; day++) {
            const mean = threeDayMean(day, source, conditionName, rollbackDays);
            if (!mean) continue; // skip zero/near-zero means, avoids ratio blow-ups
            recordFFVSample(store, conditionName, source.id, day, mean, actual);
          }
        });
    });
  }

  saveFFVStore(state.areaCode, store);
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
  return isRatioCondition(conditionName) ? entry.sumRatio / entry.count : entry.sumOffset / entry.count;
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
const ACCURACY_SCALE = { rain: 5, cloud: 60, wind: 15, temperature: 8, sunshine: 4, uv: 3 };

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

  let count = 0, sumAbsErrorRaw = 0, scoredCount = 0, sumAbsErrorCorrected = 0;
  Object.values(byDay).forEach(entry => {
    count += entry.count;
    sumAbsErrorRaw += entry.sumAbsErrorRaw ?? 0;
    scoredCount += entry.scoredCount ?? 0;
    sumAbsErrorCorrected += entry.sumAbsErrorCorrected ?? 0;
  });

  if (count === 0) return null;

  return {
    count,
    avgErrorRaw: sumAbsErrorRaw / count,
    scoredCount,
    avgErrorCorrected: scoredCount > 0 ? sumAbsErrorCorrected / scoredCount : null
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
const HEADLINE_CONDITIONS = ["rain", "temperature", "wind", "sunshine"];

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

function headlineValueFor(conditionName) {
  const day = freshestDayFor(state.rollback);
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));
  const realSources = selectedSources.filter(source => isRealSource(source, conditionName));
  // Draw only from sources with genuine data behind them, so 11 demo
  // forecasters can never outvote the one real signal. Falls back to the
  // full selection only when no real source exists for this condition at
  // all yet (currently Sunshine and UV) — otherwise the headline would
  // just go blank rather than show a best-effort estimate.
  const sourcesToUse = realSources.length > 0 ? realSources : selectedSources;

  const values = sourcesToUse
    .map(source => {
      const ffv = ffvFor(source, conditionName, day);
      if (ffv !== null) {
        const mean = threeDayMean(day, source, conditionName, state.rollback);
        if (mean !== null) return applyCorrection(mean, ffv, conditionName);
      }
      return forecastValueFor(day, source, conditionName, state.rollback);
    })
    .filter(v => v !== null && v !== undefined);
  return median(values);
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

  let raw;
  switch (conditionName) {
    case "rain": raw = state.hourly.precipitation[idx]; break;
    case "wind": raw = state.hourly.windSpeed[idx]; break;
    case "temperature": raw = state.hourly.temperature[idx]; break;
    default: return null; // Sunshine has no hourly reading — see renderHeadline
  }
  if (raw === null || raw === undefined) return null;

  const metOffice = CONFIG.forecasters.find(source => source.id === "metoffice");
  const day = idx < 24 ? 1 : 2;
  const ffv = ffvFor(metOffice, conditionName, day);
  return ffv !== null ? applyCorrection(raw, ffv, conditionName) : raw;
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

function renderHeadline() {
  if (!headlineGrid) return;
  headlineGrid.innerHTML = "";
  const day = freshestDayFor(state.rollback);

  if (headlineDate) {
    headlineDate.textContent = state.rollback === 0
      ? "Today"
      : formatDateLong(targetDateForRollback(state.rollback));
  }

  const hourDate = currentHourDate();
  const showHourly = state.hourlyActive && state.hourly.status === "ready";
  const night = showHourly && !isDaytime(hourDate);

  HEADLINE_CONDITIONS.forEach(conditionName => {
    const cell = document.createElement("div");
    cell.className = "headline-cell";

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
          valueEl.textContent = moonPhaseEmoji(hourDate);
          valueEl.classList.add("headline-moon");
        } else {
          const percent = hourlyUVPercent(state.hourIndex);
          valueEl.textContent = percent !== null ? String(percent) : "–";
        }
      } else {
        const value = headlineValueFor(conditionName);
        valueEl.textContent = formatValue(value, conditionName);
      }
    } else if (showHourly) {
      const value = hourlyValueFor(conditionName);
      valueEl.textContent = value !== null ? formatValue(value, conditionName) : "–";
    } else {
      const value = headlineValueFor(conditionName);
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
        // go wrong.
        arrow.innerHTML =
          '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' +
          '<line x1="12" y1="19" x2="12" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
          '<polygon points="12,3 7,9 17,9" fill="currentColor"/>' +
          '</svg>';
        arrow.style.transform = `rotate(${rotation}deg)`;
        arrow.setAttribute("aria-hidden", "true");

        const dirEl = document.createElement("small");
        dirEl.className = "headline-direction";
        dirEl.textContent = compass;

        // Same row as the value, not a new line below it — otherwise the
        // cell's height itself changes depending on whether direction
        // data happens to be available, causing the whole grid to jump
        // as the slider moves between states.
        valueRow.append(arrow, dirEl);
      }
    }

    headlineGrid.appendChild(cell);
  });
}

function renderAccuracy() {
  if (!accuracyBody) return;
  accuracyBody.innerHTML = "";

  const mode = accuracyMode ? accuracyMode.value : "both";
  const selectedSources = CONFIG.forecasters.filter(source => state.selected.has(source.id));

  selectedSources.forEach(source => {
    const stats = accuracyStatsFor(source, state.condition);
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = source.name;
    row.appendChild(nameCell);

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
  const FORECASTER_PAIR_WIDTH = 108 * 2;
  table.style.minWidth = `${DAY_COLUMN_WIDTH + FORECASTER_PAIR_WIDTH * selectedSources.length}px`;

  table.innerHTML = "";

  const thead = document.createElement("thead");

  const sourceRow = document.createElement("tr");
  const dayHead = document.createElement("th");
  dayHead.textContent = "Day out";
  dayHead.rowSpan = 2;
  dayHead.className = "day-head";
  sourceRow.appendChild(dayHead);

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

  [7, 6, 5, 4, 3, 2, 1].forEach(day => {
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

    selectedSources.forEach((source, index) => {
      const tintClass = index % 2 === 1 ? " forecaster-tint" : "";
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
  temperature: "tempAvg"
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
    backfillStatus.textContent = `Done — added ${state.backfill.samplesAdded} real samples to ${state.areaCode || "this area"}'s FFV history.`;
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
      `cloud_cover_previous_day${d}`
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
  const res = await fetch(`${PREVIOUS_RUNS_URL}?${params.toString()}`);
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
      cloud: aggregateHourlyByDay(hourlyTime, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean")
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
      hourly: "cloudcover",
      start_date: isoDate(start),
      end_date: isoDate(end),
      wind_speed_unit: "mph",
      timezone: "auto"
    });
    const actualRes = await fetch(`${ARCHIVE_URL}?${actualParams.toString()}`);
    if (!actualRes.ok) throw new Error("Actual weather archive lookup failed");
    const actualData = await actualRes.json();
    const dayCount = actualData.daily.time.length;

    const yearActual = {
      precip: actualData.daily.precipitation_sum,
      wind: actualData.daily.windspeed_10m_max,
      cloud: aggregateHourlyByDay(actualData.hourly.time, actualData.hourly.cloudcover, dayCount, "mean"),
      tempAvg: actualData.daily.temperature_2m_max.map((max, i) => {
        const min = actualData.daily.temperature_2m_min[i];
        return (max !== null && min !== null) ? (max + min) / 2 : null;
      })
    };

    // Real lead-time forecasts for the same year, one fetch per source.
    const byLeadDayBySource = {};
    for (const { id, model } of REAL_SOURCES) {
      byLeadDayBySource[id] = await fetchYearOfModelData(id, model, start, end, dayCount);
    }

    // Fold every (mean, actual) pair straight into the same FFV store the
    // day-to-day app reads from.
    const store = loadFFVStore(state.areaCode);
    let samplesAdded = 0;

    for (let i = 0; i < dayCount; i++) {
      REAL_DATA_CONDITIONS.forEach(conditionName => {
        const actual = yearActual[BACKFILL_FIELD_FOR_CONDITION[conditionName]][i];
        if (actual === null || actual === undefined) return;

        REAL_SOURCES.forEach(({ id: sourceId }) => {
          const byLeadDay = byLeadDayBySource[sourceId];
          for (let day = 1; day <= 7; day++) {
            const leadDays = day === 1 ? [1, 2] : day === 7 ? [6, 7] : [day - 1, day, day + 1];
            const field = BACKFILL_FIELD_FOR_CONDITION[conditionName];
            const values = leadDays
              .map(d => byLeadDay[d]?.[field]?.[i])
              .filter(v => v !== null && v !== undefined);
            if (!values.length) return;
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            if (!mean) return;

            recordFFVSample(store, conditionName, sourceId, day, mean, actual);
            samplesAdded += 1;
          }
        });
      });
    }

    saveFFVStore(state.areaCode, store);
    state.backfill = { status: "done", error: null, samplesAdded };
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
    hourLabel.textContent = "Now";
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
    state.hourlyActive = true;
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

const updateLocationButton = document.getElementById("updateLocation");
if (updateLocationButton) {
  updateLocationButton.addEventListener("click", () => {
    state.postcode = postcode.value.trim().toUpperCase();
    postcode.value = state.postcode;
    saveCurrentPostcode(state.postcode);
    loadLocationData();
    renderPlaceChip();
    renderPlacesList();
  });
}

if (backfillButton) {
  backfillButton.addEventListener("click", backfillRealSourceHistory);
}

// ---- Saved places: quick-switch chip (front page header) and the
// manage-places list (Settings). Both read/write the same PLACES_KEY /
// CURRENT_POSTCODE_KEY, so a place saved on one page shows up on the
// other without needing a shared framework.

function switchToPostcode(pc) {
  if (!pc || pc === state.postcode) return;
  state.postcode = pc;
  if (postcode) postcode.value = pc;
  saveCurrentPostcode(pc);
  renderPlaceChip();
  renderPlacesList();
  loadLocationData();
}

function renderPlaceChip() {
  if (!placeChipLabel) return;
  placeChipLabel.textContent = state.postcode || "Set location";
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
  places.forEach(pc => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "place-menu-item" + (pc === state.postcode ? " is-current" : "");
    item.textContent = pc;
    item.addEventListener("click", () => {
      closePlaceMenu();
      switchToPostcode(pc);
    });
    placeMenuList.appendChild(item);
  });
}

if (placeChip) {
  renderPlaceChip();
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
    if (placeMenu && !placeMenu.hidden && !placeMenu.contains(event.target) && event.target !== placeChip) {
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

  places.forEach(pc => {
    const row = document.createElement("div");
    row.className = "place-row" + (pc === state.postcode ? " is-current" : "");

    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "place-row-switch";
    switchBtn.textContent = pc === state.postcode ? `${pc} (current)` : pc;
    switchBtn.disabled = pc === state.postcode;
    switchBtn.addEventListener("click", () => switchToPostcode(pc));
    row.appendChild(switchBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "place-row-remove";
    removeBtn.setAttribute("aria-label", `Remove ${pc}`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      savePlaces(loadPlaces().filter(saved => saved !== pc));
      renderPlacesList();
      renderPlaceMenu();
    });
    row.appendChild(removeBtn);

    placesList.appendChild(row);
  });
}

if (addCurrentPlaceButton) {
  addCurrentPlaceButton.addEventListener("click", () => {
    const places = loadPlaces();
    if (!places.includes(state.postcode)) {
      places.push(state.postcode);
      savePlaces(places);
      renderPlacesList();
      renderPlaceMenu();
    }
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
if (headlineGrid || table) {
  renderTable();
  loadLocationData();
}
