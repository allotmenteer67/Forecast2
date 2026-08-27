// Runs once a day via .github/workflows/collect-weather.yml.
// Reads FORECAST_LAT / FORECAST_LON / FORECAST_AREA_CODE from environment
// (populated from GitHub Actions secrets — never written to disk or
// committed), fetches a rolling window of real weather data, and merges
// it into data/history.json. That file deliberately contains no precise
// location info — just the postcode AREA (e.g. "TA6", the same
// coarse level already used everywhere else in the app) plus dates and
// weather numbers — so it's safe to commit to a public repo.
//
// The area code matters: this collection only ever runs for the one
// location configured in this repo's secrets. If someone else opens the
// app with a different postcode, the app checks this file's areaCode
// against theirs and skips applying it if they don't match, rather than
// silently treating one location's weather history as another's.
//
// Window size: 7 days, same as the app's own rolling window. A single
// missed run (Action failure, outage) self-heals on the next run rather
// than needing manual backfill.

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const WINDOW_DAYS = 7;
const HISTORY_PATH = new URL("../data/history.json", import.meta.url);
const KEEP_DAYS = 400; // rolling cap so the committed file doesn't grow forever

// Keep this list in sync with REAL_SOURCES in app.js. Adding a new model
// later is just a new entry here plus a matching forecaster id in app.js —
// this script doesn't need to know about the demo-only sources at all.
const MODELS = [
  { id: "metoffice", model: "ukmo_global_deterministic_10km" },
  { id: "ecmwf", model: "ecmwf_ifs025" },
  { id: "gfs", model: "gfs_seamless" },
  { id: "icon", model: "icon_seamless" },
  { id: "gem", model: "gem_seamless" },
  { id: "meteofrance", model: "meteofrance_seamless" }
];

const fs = await import("node:fs/promises");

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

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

async function fetchActual(lat, lon, start, end) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max",
    hourly: "cloudcover,pressure_msl",
    start_date: isoDate(start),
    end_date: isoDate(end),
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Actual weather fetch failed: ${res.status}`);
  const data = await res.json();
  const dayCount = data.daily.time.length;

  const cloud = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover, dayCount, "mean");
  const pressure = aggregateHourlyByDay(data.hourly.time, data.hourly.pressure_msl, dayCount, "mean");

  const byDate = {};
  data.daily.time.forEach((date, i) => {
    const max = data.daily.temperature_2m_max[i];
    const min = data.daily.temperature_2m_min[i];
    byDate[date] = {
      rain: data.daily.precipitation_sum[i],
      wind: data.daily.windspeed_10m_max[i],
      cloud: cloud[i],
      pressure: pressure[i],
      temperature: (max !== null && min !== null) ? (max + min) / 2 : null
    };
  });
  return byDate;
}

async function fetchModel(lat, lon, model, start, end) {
  const hourlyVars = [];
  for (let d = 1; d <= 7; d++) {
    hourlyVars.push(
      `temperature_2m_previous_day${d}`,
      `precipitation_previous_day${d}`,
      `wind_speed_10m_previous_day${d}`,
      `cloud_cover_previous_day${d}`,
      `pressure_msl_previous_day${d}`
    );
  }

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: hourlyVars.join(","),
    start_date: isoDate(start),
    end_date: isoDate(end),
    models: model,
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetch(`${PREVIOUS_RUNS_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Model fetch failed for ${model}: ${res.status}`);
  const data = await res.json();
  const hourlyTimes = data.hourly.time;
  const dayCount = Math.floor(hourlyTimes.length / 24);
  const dates = [];
  for (let i = 0; i < dayCount; i++) dates.push(isoDate(addDays(start, i)));

  const byLeadDay = {};
  for (let d = 1; d <= 7; d++) {
    const tempMax = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "max");
    const tempMin = aggregateHourlyByDay(hourlyTimes, data.hourly[`temperature_2m_previous_day${d}`], dayCount, "min");
    byLeadDay[d] = {
      tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
      precip: aggregateHourlyByDay(hourlyTimes, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
      wind: aggregateHourlyByDay(hourlyTimes, data.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
      cloud: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean"),
      pressure: aggregateHourlyByDay(hourlyTimes, data.hourly[`pressure_msl_previous_day${d}`], dayCount, "mean")
    };
  }

  // Reshape into per-date, per-lead-day, per-condition — matches how
  // app.js wants to read it back.
  const byDate = {};
  dates.forEach((date, i) => {
    byDate[date] = {};
    for (let d = 1; d <= 7; d++) {
      byDate[date][d] = {
        rain: byLeadDay[d].precip[i],
        wind: byLeadDay[d].wind[i],
        cloud: byLeadDay[d].cloud[i],
        pressure: byLeadDay[d].pressure[i],
        temperature: byLeadDay[d].tempAvg[i]
      };
    }
  });
  return byDate;
}

async function loadExistingHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { updated: null, areaCode: null, days: {} };
  }
}

async function main() {
  const lat = process.env.FORECAST_LAT;
  const lon = process.env.FORECAST_LON;
  const areaCode = process.env.FORECAST_AREA_CODE;
  if (!lat || !lon) {
    throw new Error("FORECAST_LAT / FORECAST_LON secrets are not set");
  }
  if (!areaCode) {
    // Not fatal — the collection itself is still useful — but the app
    // will refuse to apply data with no area code attached, since it has
    // no way to check it's being used for the right postcode.
    console.warn("FORECAST_AREA_CODE secret is not set — collected data won't be applied by the app until it is.");
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = addDays(today, -1); // yesterday — today's actual isn't final yet
  const start = addDays(end, -(WINDOW_DAYS - 1));

  const actualByDate = await fetchActual(lat, lon, start, end);

  const modelsByDate = {};
  for (const { id, model } of MODELS) {
    modelsByDate[id] = await fetchModel(lat, lon, model, start, end);
  }

  const history = await loadExistingHistory();

  for (const date of Object.keys(actualByDate)) {
    history.days[date] ??= { actual: null, models: {} };
    history.days[date].actual = actualByDate[date];
    for (const { id } of MODELS) {
      if (modelsByDate[id][date]) {
        history.days[date].models[id] = modelsByDate[id][date];
      }
    }
  }

  // Roll off anything older than the cap.
  const allDates = Object.keys(history.days).sort();
  if (allDates.length > KEEP_DAYS) {
    for (const date of allDates.slice(0, allDates.length - KEEP_DAYS)) {
      delete history.days[date];
    }
  }

  history.updated = isoDate(today);
  // Written on every run regardless — if this ever changes (repo reused
  // for a different postcode), the file self-heals to the new area
  // rather than staying stuck on stale data from before.
  history.areaCode = areaCode || null;

  await fs.mkdir(new URL(".", HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
  console.log(`Updated history.json — ${Object.keys(history.days).length} days on file for area ${history.areaCode ?? "(not set)"}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
