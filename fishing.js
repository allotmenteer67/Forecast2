// Fishing conditions — maths and data fetching. Kept separate from
// fishing-ui.js's DOM code, the same split every other feature in this
// project uses (tide.js/tide-ui.js, solar.js/solar-ui.js).
//
// SCOPE AND HONESTY NOTE, worth reading before touching any of the
// thresholds below: there is no single authoritative source for "what
// makes fishing conditions good" the way there is for tide predictions
// or solar irradiance. Everything in this file is a reasonable,
// documented rule of thumb, not measured science — see each function's
// own comment for the specific reasoning, and Help for the plain-English
// version. The scoring deliberately leans harder on the factors with
// real physical backing (wind, wave/swell — you can directly observe
// these) than on the ones that are closer to angling folklore (pressure
// trend, tidal-range/"moon phase" strength) — see FISHING_WEIGHTS below.

const FISHING_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

// A location's fishing "mark type" — coastal marks get real wave/swell/
// sea-temperature data (Open-Meteo's Marine API, which only covers open
// coast); estuary marks skip that entirely rather than show a coastal
// number for a sheltered stretch of river it was never measured for.
// Stored directly on the shared location object (see loadTideLocations
// in tide.js) alongside station/discoveryStation, defaulting to
// "coastal" for any location added before this existed.
function fishingMarkType(location) {
  return location.markType === "estuary" ? "estuary" : "coastal";
}

const FISHING_SHOW_RAW_KEY = "cloude-fishing:showRaw";

function loadFishingShowRaw() {
  try {
    const raw = localStorage.getItem(FISHING_SHOW_RAW_KEY);
    return raw === null ? true : raw === "true"; // on by default
  } catch {
    return true;
  }
}

function saveFishingShowRaw(value) {
  try {
    localStorage.setItem(FISHING_SHOW_RAW_KEY, value ? "true" : "false");
  } catch {
    // Storage unavailable — choice just won't persist between visits.
  }
}

// ---- Fetching wind + pressure (both mark types) and marine data
// (coastal only) ----
//
// Deliberately a fresh, independent fetch for the fishing location's own
// coordinates rather than reusing the main weather headline's data —
// the fishing location is a genuinely separate saved place (matching
// tide's own "a favourite spot isn't always where you check the
// weather" reasoning), so it needs its own forecast, the same way
// solar.js fetches its own rather than borrowing state's.
//
// Cached in memory only, with a short time-to-live — unlike tide's
// harmonic fit (which is stable for weeks), wind/pressure/wave forecasts
// genuinely change hour to hour, so there's no sense persisting them
// the way tide.js persists its fit.
const FISHING_FORECAST_TTL_MS = 30 * 60000; // 30 minutes
const fishingForecastCache = new Map();

async function fetchFishingForecast(lat, lon, markType) {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)},${markType}`;
  const cached = fishingForecastCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FISHING_FORECAST_TTL_MS) return cached.data;

  const weatherParams = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "wind_speed_10m,pressure_msl",
    wind_speed_unit: "mph",
    forecast_days: "7",
    timezone: "auto"
  });
  const weatherRes = await fetchWithTimeout(`${WEATHER_URL}?${weatherParams.toString()}`, {}, 20000);
  if (!weatherRes.ok) throw new Error(`Weather fetch failed: ${weatherRes.status}`);
  const weather = await weatherRes.json();

  let marine = null;
  if (markType === "coastal") {
    const marineParams = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      hourly: "wave_height,swell_wave_height,swell_wave_period,sea_surface_temperature",
      forecast_days: "7",
      timezone: "auto"
    });
    try {
      const marineRes = await fetchWithTimeout(`${FISHING_MARINE_URL}?${marineParams.toString()}`, {}, 20000);
      if (marineRes.ok) marine = await marineRes.json();
      // A non-ok response (e.g. a mark just off the coast where Marine
      // API has no grid point) just means marine factors are skipped
      // for this fetch — not a hard failure of the whole forecast.
    } catch {
      marine = null;
    }
  }

  const data = { weather, marine, fetchedAt: Date.now() };
  fishingForecastCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

// Finds the hourly index nearest a given epoch-ms timestamp — every
// Open-Meteo hourly series here shares the same "times" shape, so one
// lookup function covers all of them.
// Returns -1 (no usable data) rather than silently clamping to the
// nearest hour when the target is too far outside the series' own
// coverage. This matters specifically for rolled-back PAST dates:
// Open-Meteo's plain forecast endpoint only ever covers from the real
// current moment forward, with no historical days in it at all — so a
// date a few days in the past falls entirely outside every hourly
// series here. Without this check, every such point silently reused
// whichever hour happened to be nearest (today's live reading), which
// looked like the factor had frozen rather than genuinely having no
// data for that date.
const FISHING_HOURLY_MATCH_TOLERANCE_MS = 90 * 60000; // 90 minutes

function fishingHourlyIndexFor(times, epochMs) {
  if (!times || !times.length) return -1;
  let best = 0, bestGap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const gap = Math.abs(times[i] - epochMs);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return bestGap <= FISHING_HOURLY_MATCH_TOLERANCE_MS ? best : -1;
}

// ---- Individual factor scores, each 0 (worst) to 1 (best) ----

// Tide movement: fish generally feed more actively while the water is
// genuinely moving than at dead slack — a widely-repeated angling rule
// of thumb, and physically plausible (moving water stirs up food and
// carries scent), though not something with a single settled scientific
// figure behind it. Scored via the tide curve's own rate of change at
// this moment, normalised against this station's typical peak rate —
// near slack scores low, mid-flow scores highest.
function fishingTideMovementScore(fit, hours) {
  const stepHours = 1 / 12; // 5-minute central difference
  const level1 = predictTideLevel(fit, hours - stepHours);
  const level2 = predictTideLevel(fit, hours + stepHours);
  const rate = Math.abs(level2 - level1) / (2 * stepHours); // metres/hour

  // "Typical peak rate" sampled once per call across a full nearby tidal
  // cycle rather than hardcoded — varies a lot station to station (the
  // Bristol Channel's huge range moves far faster than a small-range
  // Scottish loch), so a fixed number would be wrong almost everywhere.
  let peakRate = 0.01;
  for (let h = hours - 6; h <= hours + 6; h += 0.25) {
    const r = Math.abs(predictTideLevel(fit, h + stepHours) - predictTideLevel(fit, h - stepHours)) / (2 * stepHours);
    if (r > peakRate) peakRate = r;
  }
  return Math.max(0, Math.min(1, rate / peakRate));
}

// Tidal range strength (springs vs neaps) — the plain physical version
// of "the moon phase thing", per the discussion when this was scoped:
// bigger range means faster, stronger currents, which many anglers
// associate with better fishing, particularly for species that hunt by
// current-carried scent or bait movement. Scored by comparing the
// CURRENT tidal cycle's high-to-low range against this station's own
// range over a full lunar month (~29.5 days) — a station's biggest
// spring tide sitting at 1.0, its smallest neap at 0.0.
function fishingTidalRangeScore(fit, hours) {
  const events = findTideExtremes(fit, hours - 8, hours + 8);
  if (events.length < 2) return 0.5; // not enough to judge — neutral rather than guessing
  let before = null, after = null;
  for (const e of events) {
    if (e.hours <= hours) before = e;
    if (e.hours > hours && !after) after = e;
  }
  if (!before || !after) return 0.5;
  const currentRange = Math.abs(after.level - before.level);

  const monthEvents = findTideExtremes(fit, hours - 15 * 24, hours + 15 * 24);
  const ranges = [];
  for (let i = 1; i < monthEvents.length; i++) {
    ranges.push(Math.abs(monthEvents[i].level - monthEvents[i - 1].level));
  }
  if (!ranges.length) return 0.5;
  const minRange = Math.min(...ranges), maxRange = Math.max(...ranges);
  if (maxRange - minRange < 0.05) return 0.5; // barely any spring/neap variation at this station — not meaningful either way
  return Math.max(0, Math.min(1, (currentRange - minRange) / (maxRange - minRange)));
}

// Pressure trend — the most folklore-adjacent factor here: widely
// believed among anglers (steady or slowly rising pressure = good,
// rapid drops = fish go off the feed ahead of a storm) but the actual
// evidence for it is genuinely mixed in fisheries research. Included
// because it was asked for, weighted lightly (see FISHING_WEIGHTS), and
// always shown plainly as its own line in the raw factors rather than
// folded invisibly into the blend.
function fishingPressureTrendScore(pressures, nowIndex) {
  if (!pressures || nowIndex < 3) return 0.5;
  const delta = pressures[nowIndex] - pressures[nowIndex - 3]; // hPa over the last 3 hours
  if (delta > 0.5) return 0.75; // rising — traditionally favoured
  if (delta < -1.5) return 0.15; // dropping fast — traditionally poor
  if (delta < -0.5) return 0.4; // dropping gently
  return 0.6; // steady
}

// Wind — real, measurable, and it matters for practical reasons beyond
// folklore (casting, boat handling, comfort), not just fish behaviour.
// Peaks in a light-to-moderate band; very calm is fine but not
// exceptional (some surface ripple often helps), strong wind scores
// progressively worse.
function fishingWindScore(windMph) {
  if (windMph <= 3) return 0.6;
  if (windMph <= 12) return 1;
  if (windMph <= 20) return 1 - (windMph - 12) / 8 * 0.5; // eases down to 0.5
  if (windMph <= 30) return 0.5 - (windMph - 20) / 10 * 0.5; // down to 0
  return 0;
}

// Wave height (coastal only) — real, measured. A little wave action is
// often considered good for surf/shore fishing (stirs up food, breaks
// up the water's surface); flat calm or heavy surf both score lower.
function fishingWaveScore(waveHeightM) {
  if (waveHeightM === null || waveHeightM === undefined) return null;
  if (waveHeightM <= 0.2) return 0.5; // glassy calm — not bad, just not special
  if (waveHeightM <= 0.8) return 1;
  if (waveHeightM <= 1.5) return 1 - (waveHeightM - 0.8) / 0.7 * 0.5;
  if (waveHeightM <= 2.5) return 0.5 - (waveHeightM - 1.5) / 1.0 * 0.5;
  return 0;
}

// How much each factor counts toward the blended score. Wind and wave
// (real, directly measurable) carry the most weight; tidal range and
// pressure trend — the two closer to tradition than hard evidence —
// nudge the result rather than dominate it. Tide movement sits in the
// middle: a real, physical mechanism, but "how much it matters" is
// itself a rule of thumb rather than a measured constant.
const FISHING_WEIGHTS = {
  tideMovement: 0.30,
  tidalRange: 0.15,
  pressureTrend: 0.15,
  wind: 0.25,
  wave: 0.15 // redistributed proportionally across the other four for estuary marks, which have no wave data
};

function fishingBandForScore(score) {
  if (score >= 0.72) return "Excellent";
  if (score >= 0.52) return "Good";
  if (score >= 0.32) return "Fair";
  return "Poor";
}

const FISHING_BAND_ORDER = ["Poor", "Fair", "Good", "Excellent"];

function fishingBandRank(band) {
  return FISHING_BAND_ORDER.indexOf(band);
}

// Blends already-computed 0-1 factor scores (wave may be null for an
// estuary mark, or if marine data wasn't available) into one score/band.
// weights redistribute proportionally when wave is absent, so the
// remaining factors always sum to full weight rather than silently
// under-counting.
function blendFishingFactors(factors) {
  const weights = { ...FISHING_WEIGHTS };
  // Redistribute the weight of ANY missing factor proportionally across
  // the rest, rather than just silently dropping it (which would let
  // the remaining factors under-count) or — worse — filling it with a
  // fake neutral score that pretends to be real evidence.
  Object.keys(FISHING_WEIGHTS).forEach(key => {
    const value = factors[key];
    if (value === null || value === undefined) {
      const missingWeight = weights[key];
      delete weights[key];
      const totalRemaining = Object.values(weights).reduce((a, b) => a + b, 0);
      if (totalRemaining > 0) {
        Object.keys(weights).forEach(k => { weights[k] += missingWeight * (weights[k] / totalRemaining); });
      }
    }
  });
  let score = 0, totalWeight = 0;
  Object.entries(weights).forEach(([key, weight]) => {
    const value = factors[key];
    if (typeof value === "number") {
      score += value * weight;
      totalWeight += weight;
    }
  });
  const finalScore = totalWeight > 0 ? score / totalWeight : 0.5;
  return { score: finalScore, band: fishingBandForScore(finalScore) };
}

// Computes every factor for one moment (given as hours-from-epoch, same
// convention as the tide fit) and blends them — the one function
// fishing-ui.js actually needs to call per point on the score curve.
function computeFishingAt({ fit, epochIso, hours, weatherHourly, weatherTimesEpoch, marineHourly, marineTimesEpoch, isEstuary }) {
  const nowMs = Date.parse(epochIso) + hours * 3600000;
  const windIdx = fishingHourlyIndexFor(weatherTimesEpoch, nowMs);
  const windMph = windIdx >= 0 ? weatherHourly.wind_speed_10m[windIdx] : null;
  const pressureIdx = windIdx; // same series, same timeline

  let waveHeightM = null, swellPeriodS = null, seaTempC = null;
  if (!isEstuary && marineHourly) {
    const marineIdx = fishingHourlyIndexFor(marineTimesEpoch, nowMs);
    if (marineIdx >= 0) {
      waveHeightM = marineHourly.wave_height ? marineHourly.wave_height[marineIdx] : null;
      swellPeriodS = marineHourly.swell_wave_period ? marineHourly.swell_wave_period[marineIdx] : null;
      seaTempC = marineHourly.sea_surface_temperature ? marineHourly.sea_surface_temperature[marineIdx] : null;
    }
  }

  const factors = {
    tideMovement: fishingTideMovementScore(fit, hours),
    tidalRange: fishingTidalRangeScore(fit, hours),
    pressureTrend: windIdx >= 0 ? fishingPressureTrendScore(weatherHourly.pressure_msl, pressureIdx) : null,
    wind: typeof windMph === "number" ? fishingWindScore(windMph) : null,
    wave: typeof waveHeightM === "number" ? fishingWaveScore(waveHeightM) : null
  };

  const blended = blendFishingFactors(factors);
  return {
    hours,
    score: blended.score,
    band: blended.band,
    factors,
    windMph,
    waveHeightM,
    swellPeriodS,
    seaTempC
  };
}

// Finds the best contiguous window-hours-long stretch starting at or
// after "hours", using the WORST band within any candidate window
// (a window can only claim to be "Good" if it's at least Good for its
// whole span, not just at one favourable instant inside it). Returns
// null if nothing beats the current moment's own band.
function findBestFishingWindow(points, nowHours, windowHours, lookaheadHours) {
  const nowBand = points.find(p => p.hours >= nowHours)?.band || points[0]?.band;
  const nowRank = fishingBandRank(nowBand);

  let best = null;
  for (let i = 0; i < points.length; i++) {
    const start = points[i];
    if (start.hours < nowHours || start.hours > nowHours + lookaheadHours) continue;
    const windowEnd = start.hours + windowHours;
    const windowPoints = points.filter(p => p.hours >= start.hours && p.hours <= windowEnd);
    if (!windowPoints.length) continue;
    const worstRank = Math.min(...windowPoints.map(p => fishingBandRank(p.band)));
    if (worstRank > nowRank && (!best || worstRank > best.rank)) {
      best = { startHours: start.hours, endHours: windowEnd, rank: worstRank, band: FISHING_BAND_ORDER[worstRank] };
    }
  }
  return best;
}
