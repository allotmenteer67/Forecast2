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

// Real WMO definition, the same one Open-Meteo's own daily
// sunshine_duration field is built from: an hour counts as "sunshine"
// when Direct Normal Irradiance exceeds 120 W/m². Needed here (rather
// than just reading a ready-made value) because the previous-runs
// endpoint — the one that gives each MODEL's own historical
// prediction, which is the entire point of this collection — has no
// sunshine_duration field of its own, only the raw DNI it would have
// been calculated from. The archive side below doesn't need this: the
// real ARCHIVE api does provide sunshine_duration directly.
const SUNSHINE_DNI_THRESHOLD_WM2 = 120;
function sunshineHoursFromDni(dniValues) {
  const litHours = dniValues.filter(v => v !== null && v !== undefined && v > SUNSHINE_DNI_THRESHOLD_WM2).length;
  return litHours; // one value per hour already, so a count of hours IS the hour total
}

// Keep this list in sync with REAL_SOURCES in app.js. Adding a new model
// later is just a new entry here plus a matching forecaster id in app.js —
// this script doesn't need to know about the demo-only sources at all.
const MODELS = [
  { id: "metoffice", model: "ukmo_global_deterministic_10km" },
  { id: "ecmwf", model: "ecmwf_ifs025" },
  { id: "gfs", model: "gfs_seamless" },
  { id: "icon", model: "icon_seamless" },
  { id: "gem", model: "gem_seamless" },
  { id: "meteofrance", model: "meteofrance_seamless" },
  { id: "jma", model: "jma_seamless" },
  { id: "bom", model: "bom_access_global" },
  { id: "cma", model: "cma_grapes_global" }
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
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,sunshine_duration",
    // cloudcover_low/mid/high rather than the single blended cloudcover
    // this used to request — see the matching split in fetchModel below
    // for the full reasoning. Same "cloudcover" naming (no underscore
    // before "cover") as the plain blended field this replaces — the
    // ARCHIVE api's own hourly variable names are spelled differently
    // from the forecast/previous-runs endpoints used elsewhere in this
    // file, which use "cloud_cover" with an underscore.
    hourly: "cloudcover_low,cloudcover_mid,cloudcover_high,pressure_msl,soil_temperature_0cm,dewpoint_2m",
    start_date: isoDate(start),
    end_date: isoDate(end),
    wind_speed_unit: "mph",
    timezone: "auto"
  });
  const res = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Actual weather fetch failed: ${res.status}`);
  const data = await res.json();
  const dayCount = data.daily.time.length;

  const cloudLow = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_low, dayCount, "mean");
  const cloudMid = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_mid, dayCount, "mean");
  const cloudHigh = aggregateHourlyByDay(data.hourly.time, data.hourly.cloudcover_high, dayCount, "mean");
  const pressure = aggregateHourlyByDay(data.hourly.time, data.hourly.pressure_msl, dayCount, "mean");
  const soilTemperature = aggregateHourlyByDay(data.hourly.time, data.hourly.soil_temperature_0cm, dayCount, "mean");
  const dewPoint = aggregateHourlyByDay(data.hourly.time, data.hourly.dewpoint_2m, dayCount, "mean");

  const byDate = {};
  data.daily.time.forEach((date, i) => {
    const max = data.daily.temperature_2m_max[i];
    const min = data.daily.temperature_2m_min[i];
    // Real archive field, in seconds — Open-Meteo has already applied
    // the DNI > 120 W/m² rule for us here, unlike the per-model side
    // below where we have to apply it ourselves. Converted to hours to
    // match the unit the rest of the app already uses for Sunshine.
    const sunshineSeconds = data.daily.sunshine_duration ? data.daily.sunshine_duration[i] : null;
    byDate[date] = {
      rain: data.daily.precipitation_sum[i],
      wind: data.daily.windspeed_10m_max[i],
      cloudLow: cloudLow[i],
      cloudMid: cloudMid[i],
      cloudHigh: cloudHigh[i],
      pressure: pressure[i],
      soilTemperature: soilTemperature[i],
      dewPoint: dewPoint[i],
      temperature: (max !== null && min !== null) ? (max + min) / 2 : null,
      sunshine: sunshineSeconds !== null && sunshineSeconds !== undefined ? sunshineSeconds / 3600 : null
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
      // Split into three bands rather than one blended cloud_cover — see
      // fetchActual's own note on this. "cloud_cover" WITH the
      // underscore here, unlike the archive api's "cloudcover" above:
      // the previous-runs/forecast endpoints spell this field
      // differently from the archive endpoint, confirmed against
      // Open-Meteo's own docs rather than assumed.
      `cloud_cover_low_previous_day${d}`,
      `cloud_cover_mid_previous_day${d}`,
      `cloud_cover_high_previous_day${d}`,
      `pressure_msl_previous_day${d}`,
      `soil_temperature_0cm_previous_day${d}`,
      `dewpoint_2m_previous_day${d}`,
      // No sunshine_duration_previous_dayN exists on this endpoint at
      // all — checked directly against Open-Meteo's own documentation
      // rather than assumed, after an earlier, wrong assumption that
      // NOTHING sunshine-related was available here at all. What IS
      // available is the raw Direct Normal Irradiance this endpoint's
      // own solar radiation section lists with full previous-day
      // history, which sunshineHoursFromDni() above turns into real
      // sunshine hours using the same threshold rule Open-Meteo's own
      // archive-side sunshine_duration field is built from.
      `direct_normal_irradiance_previous_day${d}`
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
    // Not aggregated via aggregateHourlyByDay like the others — that
    // helper takes a mean/sum/max/min of whatever real values exist in
    // a day's 24 hours, but "sunshine hours" specifically needs to
    // COUNT how many of those hours passed the DNI threshold, which is
    // its own kind of aggregation aggregateHourlyByDay doesn't do.
    const dniSeries = data.hourly[`direct_normal_irradiance_previous_day${d}`];
    const sunshine = [];
    for (let day = 0; day < dayCount; day++) {
      const dayValues = dniSeries.slice(day * 24, day * 24 + 24);
      sunshine.push(dayValues.some(v => v !== null && v !== undefined) ? sunshineHoursFromDni(dayValues) : null);
    }
    byLeadDay[d] = {
      tempAvg: tempMax.map((max, i) => (max !== null && tempMin[i] !== null) ? (max + tempMin[i]) / 2 : null),
      precip: aggregateHourlyByDay(hourlyTimes, data.hourly[`precipitation_previous_day${d}`], dayCount, "sum"),
      wind: aggregateHourlyByDay(hourlyTimes, data.hourly[`wind_speed_10m_previous_day${d}`], dayCount, "max"),
      cloudLow: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_low_previous_day${d}`], dayCount, "mean"),
      cloudMid: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_mid_previous_day${d}`], dayCount, "mean"),
      cloudHigh: aggregateHourlyByDay(hourlyTimes, data.hourly[`cloud_cover_high_previous_day${d}`], dayCount, "mean"),
      pressure: aggregateHourlyByDay(hourlyTimes, data.hourly[`pressure_msl_previous_day${d}`], dayCount, "mean"),
      soilTemperature: aggregateHourlyByDay(hourlyTimes, data.hourly[`soil_temperature_0cm_previous_day${d}`], dayCount, "mean"),
      dewPoint: aggregateHourlyByDay(hourlyTimes, data.hourly[`dewpoint_2m_previous_day${d}`], dayCount, "mean"),
      sunshine
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
        cloudLow: byLeadDay[d].cloudLow[i],
        cloudMid: byLeadDay[d].cloudMid[i],
        cloudHigh: byLeadDay[d].cloudHigh[i],
        pressure: byLeadDay[d].pressure[i],
        soilTemperature: byLeadDay[d].soilTemperature[i],
        dewPoint: byLeadDay[d].dewPoint[i],
        temperature: byLeadDay[d].tempAvg[i],
        sunshine: byLeadDay[d].sunshine[i]
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
