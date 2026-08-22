// Runs once a day via .github/workflows/collect-weather.yml.
// Reads FORECAST_LAT / FORECAST_LON from environment (populated from
// GitHub Actions secrets — never written to disk or committed), fetches
// a rolling window of real weather data, and merges it into
// data/history.json. That file deliberately contains NO location info —
// just dates and weather numbers — so it's safe to commit to a public repo.
//
// Window size: 7 days, same as the app's own rolling window. A single
// missed run (Action failure, outage) self-heals on the next run rather
// than needing manual backfill.

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const WINDOW_DAYS = 7;
const HISTORY_PATH = new URL("../data/history.json", import.meta.url);
const KEEP_DAYS = 400; // rolling cap so the committed file doesn't grow forever

// Keep this list in sync with REAL_METOFFICE_CONDITIONS / MODELS-style
// setup in app.js. Adding a new model later is just a new entry here plus
// a matching forecaster id in app.js — this script doesn't need to know
// about the demo-only sources at all.
const MODELS = [
  { id: "metoffice", model: "ukmo_global_deterministic_10km" },
  { id: "ecmwf", model: "ecmwf_ifs025" }
  // { id: "gfs", model: "gfs_seamless" },
  // ...add more real Open-Meteo models here as the app grows to use them
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
    hourly: "cloudcover",
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

  const byDate = {};
  data.daily.time.forEach((date, i) => {
    const max = data.daily.temperature_2m_max[i];
    const min = data.daily.temperature_2m_min[i];
    byDate[date] = {
      rain: data.daily.precipitation_sum[i],
      wind: data.daily.windspeed_10m_max[i],
      cloud: cloud[i],
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
      `cloud_cover_previous_day${d}`
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
      cloud: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_previous_day${d}`], dayCount, "mean")
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
    return { updated: null, days: {} };
  }
}

async function main() {
  const lat = process.env.FORECAST_LAT;
  const lon = process.env.FORECAST_LON;
  if (!lat || !lon) {
    throw new Error("FORECAST_LAT / FORECAST_LON secrets are not set");
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

  await fs.mkdir(new URL(".", HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
  console.log(`Updated history.json — ${Object.keys(history.days).length} days on file.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
