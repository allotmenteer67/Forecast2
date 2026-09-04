// Solar panel calculator — a standalone feature, deliberately kept
// separate from the rest of Cloude (its own page, own button, no
// entanglement with the Sunshine cell or FFV machinery). Loaded
// alongside the shared app.js (same as every other page — see the
// handover doc), so it reuses that file's location resolution
// (resolveLocation, AmbiguousLocationError), fetch helper
// (fetchWithTimeout / fetchOpenMeteo), and URL constants (ARCHIVE_URL,
// WEATHER_URL) rather than duplicating them.
//
// Core idea, per the brief: most consumer solar calculators lean on a
// single regional average. This instead pulls real historical solar
// irradiance for the exact location from Open-Meteo, already resolved
// to the panel's own tilt/orientation by Open-Meteo's own
// global_tilted_irradiance product (their built-in geometry model,
// which is more sophisticated than anything worth hand-rolling here) —
// so "what would you have generated last year" is answered from real
// measured-and-modelled irradiance for that spot, not a generic
// estimate. The same pipeline runs forward too, against the live
// 7-day forecast, for a genuine (if inherently rougher) near-term
// estimate.
//
// ASSUMPTION WORTH FLAGGING: Open-Meteo's documented azimuth
// convention (per their own worked examples) is 0°=south,
// negative=east, positive=west. AZIMUTH_FOR_COMPASS below follows that
// convention — worth a quick real-world sanity check (does a
// south-facing input actually produce the year's highest total, does
// west skew the daily peak later than east) the first time this runs
// against live data, since it's the one piece of this that couldn't be
// verified from inside this session.

const SOLAR_NOCT_C = 45; // typical Nominal Operating Cell Temperature
const SOLAR_STC_TEMP_C = 25; // Standard Test Conditions reference temp

const SEASON_MONTHS = {
  winter: [12, 1, 2],
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11]
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthToSeason(month1to12) {
  for (const [season, months] of Object.entries(SEASON_MONTHS)) {
    if (months.includes(month1to12)) return season;
  }
  return "summer";
}

const AZIMUTH_FOR_COMPASS = {
  S: 0, SW: 45, SE: -45, W: 90, E: -90, NW: 135, NE: -135, N: 180
};

// ---- Fetching real irradiance + temperature ----

async function fetchSolarSeries(baseUrl, lat, lon, tilt, azimuth, extraParams) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "global_tilted_irradiance,temperature_2m",
    tilt: String(tilt),
    azimuth: String(azimuth),
    timezone: "auto",
    ...extraParams
  });
  // Routed through fetchOpenMeteo (app.js) rather than plain
  // fetchWithTimeout — same shared concurrency gate + 429 backoff as
  // every other Open-Meteo call in the app, added after real rate
  // limiting was observed on the map page. Solar isn't usually run
  // alongside a map/front-page burst, but it hits the same server and
  // the same published limit, so there's no reason to leave it out.
  const res = await fetchOpenMeteo(`${baseUrl}?${params.toString()}`, {}, 30000);
  if (!res.ok) throw new Error(`Weather data fetch failed: ${res.status}`);
  const data = await res.json();
  const gti = data.hourly.global_tilted_irradiance;
  const temp = data.hourly.temperature_2m;
  const times = data.hourly.time;

  // Fallback: if the archive endpoint hasn't actually populated
  // global_tilted_irradiance (documented as available, but this
  // couldn't be verified live from inside this session — see the note
  // at the top of this file), fall back to plain shortwave radiation
  // read straight off the ground, with no tilt/orientation adjustment
  // at all. Clearly worse than the real thing, but better than the
  // whole feature silently returning nothing.
  const allNull = gti.every(v => v === null || v === undefined);
  if (allNull) {
    return fetchSolarSeriesFallback(baseUrl, lat, lon, extraParams);
  }

  return {
    times,
    gti: gti.map(v => Math.max(0, v ?? 0)), // a small number of models can report a
                                             // slightly negative GTI right at dawn/dusk
                                             // (a known upstream quirk) — clamped here
                                             // rather than passed through as negative
                                             // generation
    temp,
    usedFallback: false
  };
}

async function fetchSolarSeriesFallback(baseUrl, lat, lon, extraParams) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "shortwave_radiation,temperature_2m",
    timezone: "auto",
    ...extraParams
  });
  const res = await fetchOpenMeteo(`${baseUrl}?${params.toString()}`, {}, 30000);
  if (!res.ok) throw new Error(`Weather data fetch failed: ${res.status}`);
  const data = await res.json();
  return {
    times: data.hourly.time,
    // Ground-level, untilted radiation used as-is — see the caller for
    // why this path is a fallback rather than the normal route.
    gti: data.hourly.shortwave_radiation.map(v => Math.max(0, v ?? 0)),
    temp: data.hourly.temperature_2m,
    usedFallback: true
  };
}

function lastFullCalendarYear() {
  const now = new Date();
  const year = now.getUTCFullYear() - 1;
  return { start: `${year}-01-01`, end: `${year}-12-31`, year };
}

async function fetchHistoricalSeries(lat, lon, tilt, azimuth) {
  const { start, end } = lastFullCalendarYear();
  return fetchSolarSeries(ARCHIVE_URL, lat, lon, tilt, azimuth, { start_date: start, end_date: end });
}

async function fetchForecastSeries(lat, lon, tilt, azimuth) {
  return fetchSolarSeries(WEATHER_URL, lat, lon, tilt, azimuth, { forecast_days: 7 });
}

// ---- Generation model ----

// NOCT-based cell temperature estimate — a standard, widely-used
// approximation (not a full King/Sandia thermal model, which needs
// wind speed and more panel-specific parameters than this calculator
// asks for) relating ambient air temperature and irradiance to the
// panel's own operating temperature.
function cellTemperatureC(ambientC, gtiWm2) {
  return ambientC + ((SOLAR_NOCT_C - 20) / 800) * gtiWm2;
}

function tempDerateFactor(cellTempC, coeffPctPerC) {
  const factor = 1 + (coeffPctPerC / 100) * (cellTempC - SOLAR_STC_TEMP_C);
  return Math.max(0, Math.min(1.1, factor));
}

// Builds a month → shading derate factor lookup from the four seasonal
// inputs, using each month's own average daylight-hour count from the
// fetched irradiance series itself (rather than a generic figure) —
// the number of hours actually available to shade in December is very
// different from June.
function shadeFactorsByMonth(times, gti, seasonInputs) {
  const daylightHoursByMonth = {};
  const hourCountByMonth = {};
  times.forEach((iso, i) => {
    const month = new Date(iso).getMonth() + 1;
    hourCountByMonth[month] = (hourCountByMonth[month] || 0) + 1;
    if (gti[i] > 0) daylightHoursByMonth[month] = (daylightHoursByMonth[month] || 0) + 1;
  });
  const daysInMonth = {};
  times.forEach(iso => {
    const d = new Date(iso);
    const month = d.getMonth() + 1;
    const key = `${d.getFullYear()}-${month}-${d.getDate()}`;
    daysInMonth[month] = daysInMonth[month] || new Set();
    daysInMonth[month].add(key);
  });

  const factors = {};
  for (let month = 1; month <= 12; month++) {
    const season = monthToSeason(month);
    const input = seasonInputs[season] || { shadePct: 0, hoursPerDay: 0 };
    const dayCount = daysInMonth[month] ? daysInMonth[month].size : 30;
    const avgDaylightHours = dayCount > 0 ? (daylightHoursByMonth[month] || 0) / dayCount : 8;
    if (avgDaylightHours <= 0 || input.hoursPerDay <= 0 || input.shadePct <= 0) {
      factors[month] = 1;
      continue;
    }
    const shadedShare = Math.min(1, input.hoursPerDay / avgDaylightHours);
    factors[month] = Math.max(0, 1 - shadedShare * (input.shadePct / 100));
  }
  return factors;
}

// Runs the full pipeline — tilted irradiance in, hourly generation
// (kWh) out — applying temperature derating, seasonal shading, system
// losses, and age-based degradation together.
function computeGeneration(series, systemKw, options) {
  const { tempCoeffPctPerC, systemLossPct, seasonShading, degradationPctPerYear, systemAgeYears } = options;
  const shadeFactors = shadeFactorsByMonth(series.times, series.gti, seasonShading);
  const lossFactor = 1 - systemLossPct / 100;
  const degradationFactor = Math.pow(1 - degradationPctPerYear / 100, Math.max(0, systemAgeYears));

  const hourlyKwh = series.times.map((iso, i) => {
    const gti = series.gti[i];
    const ambient = series.temp[i];
    if (gti <= 0 || ambient === null || ambient === undefined) return 0;
    const cellTemp = cellTemperatureC(ambient, gti);
    const tempFactor = tempDerateFactor(cellTemp, tempCoeffPctPerC);
    const month = new Date(iso).getMonth() + 1;
    const shadeFactor = shadeFactors[month];
    const powerKw = systemKw * (gti / 1000) * tempFactor * shadeFactor * lossFactor * degradationFactor;
    return Math.max(0, powerKw); // one hour of instantaneous kW = kWh
  });

  const monthlyKwh = Array(12).fill(0);
  series.times.forEach((iso, i) => {
    const month = new Date(iso).getMonth();
    monthlyKwh[month] += hourlyKwh[i];
  });

  const dailyKwh = [];
  const dailyLabels = [];
  let currentDay = null;
  series.times.forEach((iso, i) => {
    const dayKey = iso.slice(0, 10);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      dailyKwh.push(0);
      dailyLabels.push(dayKey);
    }
    dailyKwh[dailyKwh.length - 1] += hourlyKwh[i];
  });

  return {
    hourlyKwh,
    times: series.times,
    monthlyKwh,
    dailyKwh,
    dailyLabels,
    annualKwh: hourlyKwh.reduce((a, b) => a + b, 0),
    usedFallback: series.usedFallback
  };
}

// ---- Consumption + financial modelling ----

// Mode A: an annual total plus a rough daytime/nighttime split, spread
// flat across each window. A deliberately simple stand-in for people
// who don't have hourly usage data — see Mode B for the real thing.
function syntheticConsumptionProfile(times, annualKwh, daytimePct) {
  const dayShare = Math.max(0, Math.min(100, daytimePct)) / 100;
  const nightShare = 1 - dayShare;
  const dayHours = 12; // 7am–7pm
  const nightHours = 12;
  const days = new Set(times.map(t => t.slice(0, 10))).size || 365;
  const dayHourlyKwh = (annualKwh * dayShare) / (days * dayHours);
  const nightHourlyKwh = (annualKwh * nightShare) / (days * nightHours);
  return times.map(iso => {
    const hour = new Date(iso).getHours();
    return (hour >= 7 && hour < 19) ? dayHourlyKwh : nightHourlyKwh;
  });
}

// Mode B: real smart-meter export, pasted in as CSV. Accepts either
// hourly or half-hourly rows (most UK supplier exports are
// half-hourly) — half-hour pairs are summed into the matching hour.
// Expects two columns per row: an ISO-ish timestamp and a kWh reading,
// in either order, with a header row tolerated but not required.
function parseConsumptionCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  const hourly = new Map(); // "YYYY-MM-DDTHH" -> summed kWh
  let parsedRows = 0;
  rows.forEach(row => {
    const cols = row.split(",").map(c => c.trim());
    if (cols.length < 2) return;
    let timestamp = null, kwh = null;
    for (const col of cols) {
      if (timestamp === null && !Number.isNaN(Date.parse(col))) timestamp = col;
      else if (kwh === null && !Number.isNaN(parseFloat(col)) && col !== "") kwh = parseFloat(col);
    }
    if (timestamp === null || kwh === null) return;
    const d = new Date(timestamp);
    const hourKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`;
    hourly.set(hourKey, (hourly.get(hourKey) || 0) + kwh);
    parsedRows++;
  });
  return { hourly, parsedRows };
}

function alignConsumptionToGeneration(times, consumptionHourlyMap) {
  let matched = 0;
  const aligned = times.map(iso => {
    const d = new Date(iso);
    const hourKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`;
    const v = consumptionHourlyMap.get(hourKey);
    if (v !== undefined) matched++;
    return v !== undefined ? v : 0;
  });
  return { aligned, matched, total: times.length };
}

function computeFinancials(hourlyGenKwh, hourlyConsKwh, buyPencePerKwh, sellPencePerKwh) {
  let selfConsumed = 0, exported = 0, imported = 0, totalGen = 0, totalCons = 0;
  for (let i = 0; i < hourlyGenKwh.length; i++) {
    const gen = hourlyGenKwh[i], cons = hourlyConsKwh[i] || 0;
    totalGen += gen;
    totalCons += cons;
    selfConsumed += Math.min(gen, cons);
    exported += Math.max(0, gen - cons);
    imported += Math.max(0, cons - gen);
  }
  const costWithSolarPence = imported * buyPencePerKwh - exported * sellPencePerKwh;
  const costWithoutSolarPence = totalCons * buyPencePerKwh;
  return {
    totalGen, totalCons, selfConsumed, exported, imported,
    costWithSolar: costWithSolarPence / 100,
    costWithoutSolar: costWithoutSolarPence / 100,
    savings: (costWithoutSolarPence - costWithSolarPence) / 100
  };
}

// ---- Small formatting helpers ----

function formatKwh(v) {
  return `${Math.round(v).toLocaleString()} kWh`;
}

function formatMoney(v) {
  const sign = v < 0 ? "-" : "";
  return `${sign}£${Math.abs(v).toFixed(2)}`;
}
