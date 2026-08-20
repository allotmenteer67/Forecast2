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
const GEOCODE_URL = "https://api.postcodes.io/postcodes/";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const MAX_ROLLBACK = 6;

const state = {
  condition: "rain",
  rollback: 0,
  postcode: "TA6",
  selected: new Set(CONFIG.forecasters.filter(f => f.enabled).map(f => f.id)),
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
  }
};

const postcode = document.getElementById("postcode");
const condition = document.getElementById("condition");
const rollback = document.getElementById("rollback");
const rollbackLabel = document.getElementById("rollbackLabel");
const targetDateLabel = document.getElementById("targetDateLabel");
const forecasters = document.getElementById("forecasters");
const table = document.getElementById("forecastTable");
const conditionTitle = document.getElementById("conditionTitle");
const locationLabel = document.getElementById("locationLabel");
const actualStatus = document.getElementById("actualStatus");

function renderForecasters() {
  forecasters.innerHTML = "";

  CONFIG.forecasters.forEach(source => {
    const label = document.createElement("label");
    label.className = "check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selected.has(source.id);

    input.addEventListener("change", () => {
      if (input.checked) {
        state.selected.add(source.id);
      } else {
        state.selected.delete(source.id);
      }
      renderTable();
    });

    const text = document.createElement("span");
    text.textContent = source.name;

    label.append(input, text);
    forecasters.appendChild(label);
  });
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
  const clean = pc.replace(/\s+/g, "");
  const res = await fetch(GEOCODE_URL + encodeURIComponent(clean));
  if (!res.ok) throw new Error("Postcode not found");
  const data = await res.json();
  if (!data.result) throw new Error("Postcode not found");
  return {
    lat: data.result.latitude,
    lon: data.result.longitude,
    label: data.result.admin_district || data.result.parish || pc
  };
}

function averageCloudByDay(hourlyTimes, hourlyCloud, dayCount) {
  // Groups the returned hourly cloudcover into per-day means, in the same
  // oldest-first order as the daily arrays.
  const buckets = Array.from({ length: dayCount }, () => []);
  hourlyTimes.forEach((t, i) => {
    const dayIndex = Math.floor(i / 24);
    if (dayIndex < dayCount && hourlyCloud[i] !== null && hourlyCloud[i] !== undefined) {
      buckets[dayIndex].push(hourlyCloud[i]);
    }
  });
  return buckets.map(vals =>
    vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  );
}

async function fetchActualWeather() {
  state.actual.status = "loading";
  state.actual.error = null;
  renderActualStatus();

  try {
    const { lat, lon, label } = await geocodePostcode(state.postcode);

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
    state.actual.coordLabel = label;
    state.actual.status = "ready";
  } catch (err) {
    state.actual.status = "error";
    state.actual.error = err.message || "Could not load actual weather";
  }

  renderActualStatus();
  renderTable();
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

function renderActualStatus() {
  actualStatus.classList.remove("is-error");

  if (state.actual.status === "loading") {
    actualStatus.textContent = "Loading actual weather…";
  } else if (state.actual.status === "error") {
    actualStatus.textContent = `Actual weather unavailable: ${state.actual.error}`;
    actualStatus.classList.add("is-error");
  } else if (state.actual.status === "ready") {
    actualStatus.textContent = `Actual weather via Open-Meteo for ${state.actual.coordLabel}`;
  } else {
    actualStatus.textContent = "";
  }
}

// ---- Table rendering ----

function renderTable() {
  const selectedSources = CONFIG.forecasters.filter(
    source => state.selected.has(source.id)
  );

  const conditionData = CONFIG.conditions[state.condition];

  conditionTitle.textContent = conditionData.name;
  locationLabel.textContent = state.postcode || "Location";

  table.innerHTML = "";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  const dayHead = document.createElement("th");
  dayHead.textContent = "Day out";
  headRow.appendChild(dayHead);

  selectedSources.forEach(source => {
    const th = document.createElement("th");

    const name = document.createElement("span");
    name.textContent = source.name;

    const unit = document.createElement("small");
    unit.textContent = conditionData.unit;

    th.append(name, unit);
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
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

    const dayCell = document.createElement("td");
    dayCell.className = "day";
    dayCell.textContent = day;
    row.appendChild(dayCell);

    selectedSources.forEach(source => {
      const cell = document.createElement("td");
      const value = demoValue(day, source, state.condition);
      cell.textContent = formatValue(value, state.condition);

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
  actualCell.colSpan = selectedSources.length;

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
  fetchActualWeather();
});

renderForecasters();
updateRollbackLabel();
renderTable();
fetchActualWeather();
