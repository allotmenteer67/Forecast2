const CONFIG = {
  forecasters: [
    { id: "metoffice", name: "Met Office", enabled: true, offset: 0 },
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

// ---- Actual weather (Open-Meteo, no API key) ----
// Geocoding: api.postcodes.io (UK postcodes -> lat/lon)
// Weather: api.open-meteo.com/v1/forecast with past_days to pull recent
// recorded days alongside today. No key required for either.
const GEOCODE_URL = "https://api.postcodes.io/outcodes/";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const MAX_ROLLBACK = 6;

// Real Met Office data (Open-Meteo's Previous Runs API) only covers these
// four conditions — Sunshine and UV aren't in that dataset, so Met Office
// stays on the demo formula for those two.
const REAL_METOFFICE_CONDITIONS = new Set(["rain", "cloud", "wind", "temperature"]);
// The pure global 10km model (rather than the seamless UKV+global blend)
// so every lead-time offset 1-7 is available on equal footing — UKV 2km
// only forecasts 2 days out, which would make longer lead times inconsistent.
const METOFFICE_MODEL = "ukmo_global_deterministic_10km";

// Forecaster selection now lives on its own page (settings.html) so it
// isn't cluttering the day-to-day view. Both pages read/write this same
// localStorage key to stay in sync.
const SELECTED_FORECASTERS_KEY = "forecast-compare:selectedForecasters";

function loadSelectedForecasters() {
  try {
    const raw = localStorage.getItem(SELECTED_FORECASTERS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // fall through to default
  }
  return new Set(CONFIG.forecasters.filter(f => f.enabled).map(f => f.id));
}

function emptyMetOfficeByLeadDay() {
  const byLeadDay = {};
  for (let d = 1; d <= 7; d++) {
    byLeadDay[d] = { tempMax: [], tempMin: [], tempAvg: [], precip: [], wind: [], cloud: [] };
  }
  return byLeadDay;
}

const state = {
  condition: "rain",
  rollback: 0,
  postcode: "TA6",
  selected: loadSelectedForecasters(),
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
  metOffice: {
    status: "idle", // idle | loading | ready | error
    error: null,
    dates: [],
    byLeadDay: emptyMetOfficeByLeadDay()
  },
  backfill: {
    status: "idle", // idle | loading | done | error
    error: null,
    samplesAdded: 0
  }
};

const postcode = document.getElementById("postcode");
const condition = document.getElementById("condition");
const rollback = document.getElementById("rollback");
const rollbackLabel = document.getElementById("rollbackLabel");
const targetDateLabel = document.getElementById("targetDateLabel");
const table = document.getElementById("forecastTable");
const conditionTitle = document.getElementById("conditionTitle");
const locationLabel = document.getElementById("locationLabel");
const actualStatus = document.getElementById("actualStatus");
const metOfficeStatus = document.getElementById("metOfficeStatus");
const backfillButton = document.getElementById("backfillButton");
const backfillStatus = document.getElementById("backfillStatus");

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

function formatValue(value, conditionName) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  if (conditionName === "cloud") {
    return Math.round(value).toString();
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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

// Live Met Office real data for the same rolling 7-day window as Actual —
// one lead-time series (previous_day1..7) per condition, all sharing the
// same valid-time axis as state.actual, so the same rollback index works
// for both (see actualIndexForRollback).
async function fetchMetOfficeReal(lat, lon) {
  state.metOffice.status = "loading";
  state.metOffice.error = null;
  renderMetOfficeStatus();

  try {
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
      latitude: lat,
      longitude: lon,
      hourly: hourlyVars.join(","),
      past_days: MAX_ROLLBACK,
      forecast_days: 1,
      models: METOFFICE_MODEL,
      timezone: "auto"
    });

    const res = await fetch(`${PREVIOUS_RUNS_URL}?${params.toString()}`);
    if (!res.ok) throw new Error("Met Office data lookup failed");
    const data = await res.json();

    const hourlyTimes = data.hourly.time;
    const dayCount = Math.floor(hourlyTimes.length / 24);
    const byLeadDay = emptyMetOfficeByLeadDay();

    for (let d = 1; d <= 7; d++) {
      const tempMax = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
      const tempMin = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
      byLeadDay[d] = {
        tempMax,
        tempMin,
        tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
        precip: aggregateHourlyByDay(hourlyTimes, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
        wind: aggregateHourlyByDay(hourlyTimes, data.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
        cloud: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean")
      };
    }

    state.metOffice.dates = data.daily?.time || [];
    state.metOffice.byLeadDay = byLeadDay;
    state.metOffice.status = "ready";
  } catch (err) {
    state.metOffice.status = "error";
    state.metOffice.error = err.message || "Could not load Met Office data";
  }

  renderMetOfficeStatus();
  renderTable();
}

// Geocodes once, then kicks off Actual and the live Met Office fetch from
// the same coordinates rather than each resolving location separately.
async function loadLocationData() {
  try {
    const { lat, lon, label, areaCode } = await geocodePostcode(state.postcode);
    state.lat = lat;
    state.lon = lon;
    state.areaCode = areaCode;
    state.actual.coordLabel = label;
    await Promise.all([fetchActualWeather(lat, lon), fetchMetOfficeReal(lat, lon)]);
    updateFFVHistory();
    renderActualStatus();
    renderMetOfficeStatus();
    renderTable();
  } catch (err) {
    state.actual.status = "error";
    state.actual.error = err.message || "Could not resolve location";
    renderActualStatus();
  }
}

function actualIndexForRollback(rollbackDays) {
  // dates[] is oldest-first, length MAX_ROLLBACK+1, last entry is today.
  const idx = state.actual.dates.length - 1 - rollbackDays;
  return idx >= 0 ? idx : null;
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

// Real Met Office value for a condition/lead-day/target-date, or null if
// not loaded, not covered by this dataset, or out of the fetched window.
function metOfficeValueFor(conditionName, day, rollbackDays) {
  if (state.metOffice.status !== "ready" || day > 7) return null;
  const idx = actualIndexForRollback(rollbackDays);
  if (idx === null) return null;
  const byDay = state.metOffice.byLeadDay[day];
  if (!byDay) return null;

  switch (conditionName) {
    case "rain": return byDay.precip[idx] ?? null;
    case "wind": return byDay.wind[idx] ?? null;
    case "cloud": return byDay.cloud[idx] ?? null;
    case "temperature": return byDay.tempAvg[idx] ?? null;
    default: return null;
  }
}

// The single point where a cell's forecast value is decided: real Met
// Office data for Rain/Cloud/Wind/Temperature when it's loaded, the demo
// formula for everything else (including Met Office's own Sunshine/UV,
// and as a fallback while real data is loading or if it errors).
// Day > 7 always returns null for Met Office rather than falling back to
// demo, so threeDayMean's day-7 edge case never mixes real and demo
// values in the same average — see threeDayMean below.
function forecastValueFor(day, source, conditionName, rollbackDays) {
  if (source.id === "metoffice" && REAL_METOFFICE_CONDITIONS.has(conditionName)) {
    if (day > 7) return null;
    const real = metOfficeValueFor(conditionName, day, rollbackDays);
    if (real !== null) return real;
  }
  return demoValue(day, source, conditionName);
}

function renderMetOfficeStatus() {
  if (!metOfficeStatus) return;
  metOfficeStatus.classList.remove("is-error");

  if (state.metOffice.status === "loading") {
    metOfficeStatus.textContent = "Loading real Met Office data…";
  } else if (state.metOffice.status === "error") {
    metOfficeStatus.textContent = `Met Office real data unavailable: ${state.metOffice.error} (falling back to demo)`;
    metOfficeStatus.classList.add("is-error");
  } else if (state.metOffice.status === "ready") {
    metOfficeStatus.textContent =
      "Met Office: real UK Met Office model data for Rain, Cloud, Wind and Temperature. Sunshine and UV remain demo (not available from this data source).";
  } else {
    metOfficeStatus.textContent = "";
  }
}

function renderActualStatus() {
  actualStatus.classList.remove("is-error");

  if (state.actual.status === "loading") {
    actualStatus.textContent = "Loading actual weather…";
  } else if (state.actual.status === "error") {
    actualStatus.textContent = `Actual weather unavailable: ${state.actual.error}`;
    actualStatus.classList.add("is-error");
  } else if (state.actual.status === "ready") {
    const samples = ffvSampleTotal(state.condition);
    const ffvNote = samples > 0
      ? ` · fudge-factor data: ${samples} sample${samples === 1 ? "" : "s"} for ${CONFIG.conditions[state.condition].name} in ${state.areaCode}`
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

// Sweeps every rollback position with a known Actual value and folds each
// (mean, actual) pair into the running per-day FFV average for this area.
// Safe to call repeatedly — revisiting the same target date just nudges an
// already-idempotent running mean, it doesn't double-count meaningfully.
function updateFFVHistory() {
  if (!state.areaCode || state.actual.status !== "ready") return;

  const store = loadFFVStore(state.areaCode);

  for (let rollbackDays = 1; rollbackDays <= MAX_ROLLBACK; rollbackDays++) {
    Object.keys(CONFIG.conditions).forEach(conditionName => {
      const actual = actualValueFor(conditionName, rollbackDays);
      if (actual === null || actual === undefined) return;

      CONFIG.forecasters.forEach(source => {
        for (let day = 1; day <= 7; day++) {
          const mean = threeDayMean(day, source, conditionName, rollbackDays);
          if (!mean) continue; // skip zero/near-zero means, avoids ratio blow-ups

          const ratio = clampRatio(actual / mean);

          store[conditionName] ??= {};
          store[conditionName][source.id] ??= {};
          const entry = (store[conditionName][source.id][day] ??= { count: 0, sumRatio: 0 });
          entry.count += 1;
          entry.sumRatio += ratio;
        }
      });
    });
  }

  saveFFVStore(state.areaCode, store);
}

// Returns the learned FFV for this source/condition/day, or null if there
// isn't enough history yet to trust it.
function ffvFor(source, conditionName, day) {
  if (!state.areaCode) return null;
  const store = loadFFVStore(state.areaCode);
  const entry = store[conditionName]?.[source.id]?.[day];
  if (!entry || entry.count < FFV_MIN_SAMPLES) return null;
  return entry.sumRatio / entry.count;
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



function renderTable() {
  const selectedSources = CONFIG.forecasters.filter(
    source => state.selected.has(source.id)
  );

  const conditionData = CONFIG.conditions[state.condition];

  conditionTitle.textContent = conditionData.name;
  locationLabel.textContent = state.postcode || "Location";

  table.innerHTML = "";

  const thead = document.createElement("thead");

  const sourceRow = document.createElement("tr");
  const dayHead = document.createElement("th");
  dayHead.textContent = "Day out";
  dayHead.rowSpan = 2;
  sourceRow.appendChild(dayHead);

  const subRow = document.createElement("tr");

  selectedSources.forEach(source => {
    const th = document.createElement("th");
    th.colSpan = 2;
    th.textContent = source.name;
    sourceRow.appendChild(th);

    const correctedTh = document.createElement("th");
    correctedTh.className = "sub-corrected";
    const correctedLabel = document.createElement("span");
    correctedLabel.textContent = "Corrected";
    const correctedUnit = document.createElement("small");
    correctedUnit.textContent = conditionData.unit;
    correctedTh.append(correctedLabel, correctedUnit);
    subRow.appendChild(correctedTh);

    const rawTh = document.createElement("th");
    rawTh.className = "sub-raw";
    const rawLabel = document.createElement("span");
    rawLabel.textContent = "Raw";
    const rawUnit = document.createElement("small");
    rawUnit.textContent = conditionData.unit;
    rawTh.append(rawLabel, rawUnit);
    subRow.appendChild(rawTh);
  });

  thead.append(sourceRow, subRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const targetDate = targetDateForRollback(state.rollback);
  const rollbackDays = state.rollback;
  const actualToday = actualValueFor(state.condition, 0);
  const actual = actualValueFor(state.condition, rollbackDays);
  const actualKnown = state.actual.status === "ready" && rollbackDays > 0 && actual !== null;

  [7, 6, 5, 4, 3, 2, 1].forEach(day => {
    const row = document.createElement("tr");
    if (day === 1) row.classList.add("row-final");

    const issueDate = addDays(targetDate, -day);

    const dayCell = document.createElement("td");
    dayCell.className = "day";

    const dayNum = document.createElement("span");
    dayNum.textContent = day;

    const dayDate = document.createElement("small");
    dayDate.textContent = formatDateShort(issueDate);

    dayCell.append(dayNum, dayDate);
    row.appendChild(dayCell);

    selectedSources.forEach(source => {
      const value = forecastValueFor(day, source, state.condition, rollbackDays);
      const ffv = ffvFor(source, state.condition, day);

      const correctedCell = document.createElement("td");
      correctedCell.className = "col-corrected";
      if (ffv !== null) {
        const mean = threeDayMean(day, source, state.condition, rollbackDays);
        correctedCell.textContent = mean !== null ? formatValue(mean * ffv, state.condition) : "–";
      } else {
        correctedCell.textContent = "–";
      }
      row.appendChild(correctedCell);

      const cell = document.createElement("td");
      cell.className = "col-raw";
      cell.textContent = formatValue(value, state.condition);

      if (SHOW_INLINE_FFV_HINT && ffv !== null) {
        const mean = threeDayMean(day, source, state.condition, rollbackDays);
        const adjusted = document.createElement("small");
        adjusted.className = "ffv-hint";
        adjusted.textContent = mean !== null ? `≈${formatValue(mean * ffv, state.condition)} adj.` : "";
        cell.appendChild(adjusted);
      }

      if (day === 1 && actualKnown) {
        const delta = value - actual;
        const badge = document.createElement("span");
        badge.className =
          "delta " + (Math.abs(delta) <= Math.abs(actual) * 0.15 + 0.3 ? "delta-close" : "delta-off");
        badge.textContent = (delta >= 0 ? "+" : "") + formatValue(delta, state.condition);
        cell.appendChild(badge);
      }

      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });

  // Actual weather row — one real value for the target date, spanning
  // all visible forecaster columns for comparison.
  const actualRow = document.createElement("tr");
  actualRow.className = "row-actual";

  const actualLabelCell = document.createElement("td");
  actualLabelCell.className = "day";
  actualLabelCell.textContent = "Actual";
  actualRow.appendChild(actualLabelCell);

  const actualCell = document.createElement("td");
  actualCell.colSpan = selectedSources.length * 2;

  if (state.actual.status === "loading") {
    actualCell.textContent = "Loading…";
  } else if (state.actual.status === "error") {
    actualCell.textContent = "Unavailable";
  } else if (rollbackDays === 0) {
    actualCell.textContent = actualToday !== null
      ? `${formatValue(actualToday, state.condition)} so far today (still recording)`
      : "Still recording today";
  } else if (actual !== null) {
    actualCell.textContent = `${formatValue(actual, state.condition)} ${conditionData.unit} on ${formatDateLong(targetDate)}`;
  } else {
    actualCell.textContent = "–";
  }

  actualRow.appendChild(actualCell);
  tbody.appendChild(actualRow);

  table.appendChild(tbody);
}

// ---- One-off Met Office history backfill ----
// A year of real (mean, actual) pairs for Met Office, so the FFV for
// that source starts from a genuine base instead of building up one day
// at a time. Manually triggered — this is a large request, not something
// to re-run on every page load. Sunshine/UV aren't covered (see
// REAL_METOFFICE_CONDITIONS) so they're skipped entirely here.
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
    backfillStatus.textContent = "Fetching a year of real Met Office data — this is a big request, may take a little while…";
  } else if (state.backfill.status === "error") {
    backfillStatus.textContent = `Backfill failed: ${state.backfill.error}`;
    backfillStatus.classList.add("is-error");
  } else if (state.backfill.status === "done") {
    backfillStatus.textContent = `Done — added ${state.backfill.samplesAdded} real Met Office samples to ${state.areaCode || "this area"}'s fudge-factor history.`;
  } else {
    backfillStatus.textContent = "";
  }
  if (backfillButton) backfillButton.disabled = state.backfill.status === "loading";
}

async function backfillMetOfficeHistory() {
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

    // Real actual weather for the year (ERA5-backed archive).
    const actualParams = new URLSearchParams({
      latitude: state.lat,
      longitude: state.lon,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max",
      hourly: "cloudcover",
      start_date: isoDate(start),
      end_date: isoDate(end),
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

    // Real Met Office lead-time forecasts for the same year.
    const hourlyVars = [];
    for (let d = 1; d <= 7; d++) {
      hourlyVars.push(
        `temperature_2m_previous_day${d}`,
        `precipitation_previous_day${d}`,
        `wind_speed_10m_previous_day${d}`,
        `cloud_cover_previous_day${d}`
      );
    }
    const moParams = new URLSearchParams({
      latitude: state.lat,
      longitude: state.lon,
      hourly: hourlyVars.join(","),
      start_date: isoDate(start),
      end_date: isoDate(end),
      models: METOFFICE_MODEL,
      timezone: "auto"
    });
    const moRes = await fetch(`${PREVIOUS_RUNS_URL}?${moParams.toString()}`);
    if (!moRes.ok) throw new Error("Met Office history lookup failed");
    const moData = await moRes.json();
    const moHourlyTime = moData.hourly.time;

    const byLeadDay = {};
    for (let d = 1; d <= 7; d++) {
      const tempMax = aggregateHourlyByDay(moHourlyTime, moData.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
      const tempMin = aggregateHourlyByDay(moHourlyTime, moData.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
      byLeadDay[d] = {
        tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
        precip: aggregateHourlyByDay(moHourlyTime, moData.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
        wind: aggregateHourlyByDay(moHourlyTime, moData.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
        cloud: aggregateHourlyByDay(moHourlyTime, moData.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean")
      };
    }

    // Fold every (mean, actual) pair straight into the same FFV store the
    // day-to-day app reads from.
    const store = loadFFVStore(state.areaCode);
    let samplesAdded = 0;

    for (let i = 0; i < dayCount; i++) {
      REAL_METOFFICE_CONDITIONS.forEach(conditionName => {
        const actual = yearActual[BACKFILL_FIELD_FOR_CONDITION[conditionName]][i];
        if (actual === null || actual === undefined) return;

        for (let day = 1; day <= 7; day++) {
          const leadDays = day === 1 ? [1, 2] : day === 7 ? [6, 7] : [day - 1, day, day + 1];
          const field = BACKFILL_FIELD_FOR_CONDITION[conditionName];
          const values = leadDays
            .map(d => byLeadDay[d]?.[field]?.[i])
            .filter(v => v !== null && v !== undefined);
          if (!values.length) continue;
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          if (!mean) continue;

          const ratio = clampRatio(actual / mean);
          store[conditionName] ??= {};
          store[conditionName].metoffice ??= {};
          const entry = (store[conditionName].metoffice[day] ??= { count: 0, sumRatio: 0 });
          entry.count += 1;
          entry.sumRatio += ratio;
          samplesAdded += 1;
        }
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
  const targetDate = targetDateForRollback(state.rollback);
  rollbackLabel.textContent =
    state.rollback === 0
      ? "Latest forecast — today"
      : `${state.rollback} day${state.rollback === 1 ? "" : "s"} back`;
  targetDateLabel.textContent = `Target date: ${formatDateLong(targetDate)}`;
}

condition.addEventListener("change", () => {
  state.condition = condition.value;
  renderTable();
});

rollback.addEventListener("input", () => {
  state.rollback = Number(rollback.value);
  updateRollbackLabel();
  renderTable();
});

document.getElementById("updateLocation").addEventListener("click", () => {
  state.postcode = postcode.value.trim().toUpperCase();
  postcode.value = state.postcode;
  loadLocationData();
});

if (backfillButton) {
  backfillButton.addEventListener("click", backfillMetOfficeHistory);
}

updateRollbackLabel();
renderTable();
loadLocationData();
