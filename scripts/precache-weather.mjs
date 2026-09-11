// Precache weather + fishing for a hand-maintained set of locations,
// run on a schedule by .github/workflows/precache-weather.yml, writing
// data/precache-weather.json for the app to read on launch.
//
// ---- What this deliberately does NOT do ----
// This does NOT apply FFV correction. That's not a shortcut taken for
// this first version — it's structural: the actual per-source accuracy
// bias (the numbers applyCorrection() in app.js adds/multiplies into a
// raw forecast) lives only in each phone's own localStorage, built from
// a manual "Backfill 1 year of real data" run on Compare. This script
// has no access to that, ever — there's no mechanism for a GitHub Action
// to read a specific phone's localStorage, and data/history.json (the
// OTHER thing this repo already collects daily) only covers Met Office,
// with no per-source or per-location breakdown, so it can't stand in
// for it either.
//
// What IS real accuracy value here: "top 4 of 9" (see
// data/precache-config.json) is itself informed by your own real
// accuracy data, even without a further numeric correction on top of
// it. So the precached figure is a genuine, source-informed estimate —
// not the fully-corrected figure the live app shows, but not a naive
// guess either. The live fetch, once it lands a moment later, still
// applies the full correction exactly as it always has.
//
// ---- Why the shape matches fetchHourlyForecast's output exactly ----
// Deliberately NOT reimplementing any of app.js's correction/aggregation
// logic in Node. This script's only job is the raw multi-source fetch;
// the client-side code that already exists (applyCorrection, the
// headline/table rendering, everything downstream of a fetch completing)
// runs completely unchanged against this data, the same as it would
// against a live fetch's result. See the "metoffice" constraint below
// for the one place that mattered for making that swap-in work.
//
// ---- Favourites (added this session) ----
// data/precache-config.json's weatherFavourites/fishingFavourites arrays
// are written automatically by favourite-relay-worker.js and only ever
// contain a postcode OUTWARD code (e.g. "TA6") — never lat/lon, never a
// resolved place name. This script is what turns that bare code into an
// actual fetchable location, via the same postcodes.io outcode lookup
// app.js's own geocodePostcode() already trusts, at fetch time — the
// coordinates themselves never get written back to the repo, only used
// in-memory for this run's fetches. A favourite that fails to geocode
// (a typo that slipped past the Worker's own shape check, a postcodes.io
// hiccup) is skipped with a logged error rather than failing the whole
// run.

import { writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const CONFIG_PATH = new URL("../data/precache-config.json", import.meta.url);
const OUTPUT_PATH = new URL("../data/precache-weather.json", import.meta.url);

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const FISHING_MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const OUTCODE_GEOCODE_URL = "https://api.postcodes.io/outcodes/";

// Kept in sync BY HAND with REAL_SOURCES in app.js — duplicated rather
// than imported, since this script runs in Node against a plain
// multi-page static site with no build step or shared module system,
// same reasoning every other duplicated helper in this project already
// follows (see e.g. tide.js's own copy of terrainElevationAt). If
// app.js's REAL_SOURCES model strings ever change, this needs updating
// to match or a chosen topForecasters id will silently fetch the wrong
// model.
const REAL_SOURCES_BY_ID = {
  metoffice: "ukmo_global_deterministic_10km",
  ecmwf: "ecmwf_ifs025",
  gfs: "gfs_seamless",
  icon: "icon_seamless",
  gem: "gem_seamless",
  meteofrance: "meteofrance_seamless",
  jma: "jma_seamless",
  bom: "bom_access_global",
  cma: "cma_grapes_global"
};

async function fetchJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  return res.json();
}

// Resolves a bare outward code (e.g. "TA6") to a centroid — same source
// and same area-level precision app.js's own geocodePostcode() already
// uses for a full postcode, just given an outcode directly rather than
// deriving one from a longer string. Returns null (never throws) on any
// failure, so one bad favourite can't take the whole run down — see the
// call sites below for how that's handled.
async function geocodeOutcode(outcode) {
  try {
    const res = await fetch(OUTCODE_GEOCODE_URL + encodeURIComponent(outcode), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    return { lat: data.result.latitude, lon: data.result.longitude };
  } catch (err) {
    console.error(`Favourite outcode "${outcode}" failed to geocode: ${err.message}`);
    return null;
  }
}

// Turns config.weatherFavourites into the same {id, label, lat, lon}
// shape as a hand-typed weatherLocations entry, so the rest of this
// script (and the app reading its output) never needs to know a given
// location came from a favourite rather than the hand-maintained list.
// label is deliberately just the outcode itself, never a resolved place
// name — keeping the same "outward code only" boundary the Worker
// itself enforces, all the way through to what ends up in memory here
// (though note this resolved lat/lon is NOT written back to the repo,
// only used for this run's fetches — see the file header).
async function resolveWeatherFavourites(favourites) {
  const resolved = await Promise.all((favourites || []).map(async fav => {
    const geo = await geocodeOutcode(fav.outcode);
    if (!geo) {
      console.error(`Skipping weather favourite "${fav.outcode}" — couldn't geocode.`);
      return null;
    }
    return { id: `fav-${fav.outcode.toLowerCase()}`, label: fav.outcode, lat: geo.lat, lon: geo.lon };
  }));
  return resolved.filter(Boolean);
}

async function resolveFishingFavourites(favourites) {
  const resolved = await Promise.all((favourites || []).map(async fav => {
    const geo = await geocodeOutcode(fav.outcode);
    if (!geo) {
      console.error(`Skipping fishing favourite "${fav.outcode}" — couldn't geocode.`);
      return null;
    }
    return { id: `fav-${fav.outcode.toLowerCase()}`, label: fav.outcode, lat: geo.lat, lon: geo.lon, markType: fav.markType || "estuary" };
  }));
  return resolved.filter(Boolean);
}

// Exact same params fetchHourlyForecast (app.js) builds for a single
// source, so the client can consume this precached data through its
// existing code completely unchanged. forecast_days: 3, not 7 — the
// front page's own rolling window never looks further than 48h ahead
// (see MAP_HOUR_STEP/displayWindowHourCount's own reasoning elsewhere
// in this project), so matching the live fetch's own 3-day window is
// enough and keeps the response smaller.
function buildSourceUrl(sourceId, model, lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,soil_temperature_0cm,dewpoint_2m" + (sourceId === "metoffice" ? ",uv_index,cloud_cover_low,cloud_cover_mid,cloud_cover_high" : ""),
    models: model,
    wind_speed_unit: "mph",
    forecast_days: 3,
    timezone: "auto",
    ...(sourceId === "metoffice" ? { daily: "sunrise,sunset,uv_index_max" } : {})
  });
  return `${WEATHER_URL}?${params.toString()}`;
}

async function fetchWeatherLocation(location, topForecasters) {
  const perSource = {};
  let failures = 0;

  await Promise.all(topForecasters.map(async sourceId => {
    const model = REAL_SOURCES_BY_ID[sourceId];
    if (!model) {
      console.error(`Unknown forecaster id "${sourceId}" — not in REAL_SOURCES_BY_ID, check spelling against app.js.`);
      failures++;
      return;
    }
    try {
      const data = await fetchJson(buildSourceUrl(sourceId, model, location.lat, location.lon), `${location.id}/${sourceId}`);
      perSource[sourceId] = data;
    } catch (err) {
      // One source failing shouldn't lose the other three, or the
      // location that was already cached from a previous run — see
      // the top-level catch below for how a failed location keeps
      // whatever was written last time instead of being overwritten
      // with nothing.
      console.error(`Weather fetch failed for ${location.id}/${sourceId}: ${err.message}`);
      failures++;
    }
  }));

  if (!perSource.metoffice) {
    // metoffice sets the shared time axis and is the only source with
    // cloud/UV/sunrise data — the same structural reliance
    // fetchHourlyForecast (app.js) already has. Without it there's no
    // sensible way to shape this location's output at all.
    throw new Error(`${location.id}: metoffice fetch failed or missing from topForecasters — cannot build this location's precache without it.`);
  }

  const metofficeData = perSource.metoffice;
  const now = new Date();
  const startIdx = metofficeData.hourly.time.findIndex(t => new Date(t).getTime() >= now.getTime() - 30 * 60 * 1000);
  const from = startIdx >= 0 ? startIdx : 0;
  const sharedTimes = metofficeData.hourly.time.slice(from);

  const sources = {};
  Object.entries(perSource).forEach(([sourceId, data]) => {
    sources[sourceId] = {
      temperature: data.hourly.temperature_2m.slice(from, from + sharedTimes.length || undefined),
      precipitation: data.hourly.precipitation.slice(from, from + sharedTimes.length || undefined),
      windSpeed: data.hourly.wind_speed_10m.slice(from, from + sharedTimes.length || undefined),
      windGust: data.hourly.wind_gusts_10m.slice(from, from + sharedTimes.length || undefined),
      windDirection: data.hourly.wind_direction_10m.slice(from, from + sharedTimes.length || undefined),
      pressure: data.hourly.pressure_msl.slice(from, from + sharedTimes.length || undefined),
      soilTemperature: data.hourly.soil_temperature_0cm.slice(from, from + sharedTimes.length || undefined),
      dewPoint: data.hourly.dewpoint_2m.slice(from, from + sharedTimes.length || undefined)
    };
  });

  const dailyByDate = {};
  metofficeData.daily.time.forEach((date, i) => {
    dailyByDate[date] = {
      sunrise: metofficeData.daily.sunrise[i],
      sunset: metofficeData.daily.sunset[i],
      uvMax: metofficeData.daily.uv_index_max[i]
    };
  });

  return {
    id: location.id,
    label: location.label,
    lat: location.lat,
    lon: location.lon,
    times: sharedTimes,
    uvIndex: metofficeData.hourly.uv_index.slice(from),
    cloudCoverLow: metofficeData.hourly.cloud_cover_low.slice(from),
    cloudCoverMid: metofficeData.hourly.cloud_cover_mid.slice(from),
    cloudCoverHigh: metofficeData.hourly.cloud_cover_high.slice(from),
    dailyByDate,
    sources,
    sourcesFetched: Object.keys(perSource),
    failures
  };
}

// Matches fishing.js's own fetchFishingForecast exactly — one default
// (unmodelled) source, no models= param, plus the marine API for a
// coastal mark. No correction here either, same reasoning as weather —
// fishing.js's own score calculation runs entirely client-side against
// this raw data, unchanged.
async function fetchFishingSpot(spot) {
  const weatherParams = new URLSearchParams({
    latitude: spot.lat,
    longitude: spot.lon,
    hourly: "wind_speed_10m,pressure_msl",
    wind_speed_unit: "mph",
    forecast_days: "7",
    timezone: "auto"
  });

  const fetches = [fetchJson(`${WEATHER_URL}?${weatherParams.toString()}`, `${spot.id}/weather`)];

  if (spot.markType === "coastal") {
    const marineParams = new URLSearchParams({
      latitude: spot.lat,
      longitude: spot.lon,
      hourly: "wave_height,swell_wave_height,swell_wave_period,sea_surface_temperature",
      forecast_days: "7",
      timezone: "auto"
    });
    fetches.push(fetchJson(`${FISHING_MARINE_URL}?${marineParams.toString()}`, `${spot.id}/marine`).catch(err => {
      // Matches fishing.js's own .catch(() => null) for the marine call
      // — wave data missing degrades the fishing score gracefully
      // (fishing.js already handles a null marine result), it's not
      // worth losing the wind/pressure half over.
      console.error(`Marine fetch failed for ${spot.id}: ${err.message}`);
      return null;
    }));
  }

  const [weather, marine] = await Promise.all(fetches);

  return {
    id: spot.id,
    label: spot.label,
    lat: spot.lat,
    lon: spot.lon,
    markType: spot.markType || "inland",
    weather,
    marine: marine || null
  };
}

// Fishing's own 4x/day cadence tracked via a UTC 6-hour bucket rather
// than an exact clock check — GitHub's own scheduling can drift 15-45+
// minutes (documented, best-effort), so a run landing a few minutes
// either side of a target hour still needs to recognise "this bucket's
// already done" or "this bucket's new", rather than silently missing a
// refresh or double-refreshing right next to a boundary.
function fishingBucketFor(date) {
  return Math.floor(date.getUTCHours() / 6); // 0,1,2,3 for 00-05/06-11/12-17/18-23 UTC
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));

  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    // First ever run, or the file's missing/corrupt — proceed with no
    // previous data to fall back on for a failed location.
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Favourites are resolved (outcode -> lat/lon) once up front, then
  // merged into the same lists the hand-maintained entries already go
  // through below — everything downstream treats them identically.
  const [weatherFavouriteLocations, fishingFavouriteSpots] = await Promise.all([
    resolveWeatherFavourites(config.weatherFavourites),
    resolveFishingFavourites(config.fishingFavourites)
  ]);
  const weatherLocations = [...config.weatherLocations, ...weatherFavouriteLocations];
  const fishingSpots = [...config.fishingSpots, ...fishingFavouriteSpots];

  console.log(`Precache run starting ${nowIso} — ${weatherLocations.length} weather location(s) (${weatherFavouriteLocations.length} favourite), ${fishingSpots.length} fishing spot(s) (${fishingFavouriteSpots.length} favourite).`);

  const weatherResults = await Promise.all(weatherLocations.map(async location => {
    try {
      return await fetchWeatherLocation(location, config.topForecasters);
    } catch (err) {
      console.error(`Weather location ${location.id} failed entirely: ${err.message}`);
      // Fall back to whatever was cached last run for this location,
      // rather than dropping it from the output — a temporary Open-Meteo
      // error (429, timeout) shouldn't make the app forget a place it
      // successfully precached an hour ago.
      const prev = previous?.weather?.find(w => w.id === location.id);
      if (prev) {
        console.error(`  using previous data for ${location.id} (from ${previous.dataAsOf}).`);
        return prev;
      }
      return null;
    }
  }));

  // Fishing: only refresh spots whose bucket has actually moved on from
  // last run. Spots not due yet keep last run's data untouched (not
  // refetched, not dropped) — this is what makes "4x/day" actually mean
  // 4x/day rather than "every run, accidentally".
  //
  // BUT also refresh regardless of bucket if the configured spots
  // themselves have changed since the last run — confirmed as a real
  // bug on the first live run with real locations: editing
  // precache-config.json's fishingSpots did nothing until the bucket
  // happened to roll over on its own, because this only ever compared
  // the CLOCK, never the actual configured spot ids against what was
  // last written. A config change is a deliberate, immediate action on
  // your part; it shouldn't sit blocked behind an unrelated timer. A new
  // favourite landing via the Worker counts as exactly this same kind of
  // change, for the same reason.
  const currentBucket = fishingBucketFor(now);
  const previousBucket = previous?.fishingBucket;
  const previousSpotIds = new Set((previous?.fishing || []).map(f => f.id));
  const currentSpotIds = new Set(fishingSpots.map(s => s.id));
  const spotsChanged = previousSpotIds.size !== currentSpotIds.size || [...currentSpotIds].some(id => !previousSpotIds.has(id));
  const fishingDue = previousBucket === undefined || previousBucket !== currentBucket || spotsChanged;
  if (spotsChanged && previousBucket !== undefined) {
    console.log("Fishing spots in config differ from last run's output — refreshing regardless of bucket.");
  }

  let fishingResults;
  let fishingDataAsOf;
  if (fishingDue) {
    console.log(`Fishing bucket ${currentBucket} due (previous was ${previousBucket ?? "none"}) — refreshing all fishing spots.`);
    fishingResults = await Promise.all(fishingSpots.map(async spot => {
      try {
        return await fetchFishingSpot(spot);
      } catch (err) {
        console.error(`Fishing spot ${spot.id} failed entirely: ${err.message}`);
        const prev = previous?.fishing?.find(f => f.id === spot.id);
        if (prev) {
          console.error(`  using previous data for ${spot.id} (from ${previous.fishingDataAsOf}).`);
          return prev;
        }
        return null;
      }
    }));
    fishingDataAsOf = nowIso;
  } else {
    console.log(`Fishing bucket ${currentBucket} not due yet (last refreshed bucket ${previousBucket}) — keeping previous fishing data untouched.`);
    fishingResults = previous?.fishing || [];
    fishingDataAsOf = previous?.fishingDataAsOf || nowIso;
  }

  const output = {
    // The one timestamp the app should actually judge freshness
    // against — not "when did my phone download this file", which is a
    // completely different, unrelated clock. See the session's own
    // note on why these two must never be conflated.
    dataAsOf: nowIso,
    fishingDataAsOf,
    fishingBucket: currentBucket,
    topForecasters: config.topForecasters,
    weather: weatherResults.filter(Boolean),
    fishing: fishingResults.filter(Boolean)
  };

  const failedWeatherCount = weatherLocations.length - output.weather.length;
  const failedFishingCount = fishingDue ? fishingSpots.length - fishingResults.filter(Boolean).length : 0;
  if (failedWeatherCount > 0 || failedFishingCount > 0) {
    console.error(`Run completed with ${failedWeatherCount} weather location(s) and ${failedFishingCount} fishing spot(s) having no data at all (no fresh fetch, no previous fallback available).`);
  }

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output), "utf8");
  console.log(`Wrote ${OUTPUT_PATH.pathname} — ${output.weather.length} weather location(s), ${output.fishing.length} fishing spot(s).`);
}

main().catch(err => {
  console.error("Precache run failed entirely:", err);
  process.exit(1);
});
