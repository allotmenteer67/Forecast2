// Plain top-of-file import rather than a top-level `await import(...)`.
// Top-level await only works when Node treats the file as an ES module,
// which depends on repo configuration this script should not have to
// assume — hence the .mjs extension, which forces ESM regardless.
import fs from "node:fs/promises";

// Builds data/elevation-uk.json — a single static elevation grid
// covering the UK and Ireland, fetched and committed to the repo,
// exactly like data/coastline-50m.json and data/places.json already are.
//
// WHY THIS EXISTS
// Terrain hillshading originally fetched elevation from Open-Meteo's
// Elevation API on demand, per area, every session. That was wrong on
// its own terms: elevation is fixed. It doesn't change between forecasts
// or between years, yet every new area cost 676-1521 locations of a
// WEATHER api's rate limit to re-learn the same unchanging hills — and
// because Open-Meteo weights that limit by location count, terrain alone
// was heavier than the rest of the app combined and could take the
// actual weather down with it.
//
// RESUMABLE — READ THIS BEFORE CHANGING ANYTHING
// The first real run reached 160 of 295 batches and then threw away all
// 16,000 points it had already fetched, because one exhausted retry
// sequence aborted the whole script. On a job this long that is the
// worst possible failure mode: an hour of successful work discarded over
// a single bad minute, with nothing to show for it.
//
// So progress is now saved to the output file AS IT GOES, and every run
// starts by loading whatever is already there and skipping those points.
// A run that dies partway is no longer wasted — re-running simply picks
// up from where it stopped. The file carries a "complete" flag so both
// this script and the app can tell a finished grid from a partial one.
// Several short runs are therefore exactly as good as one long one,
// which also sidesteps any Actions timeout entirely.

const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const MAX_COORDS_PER_REQUEST = 100;

// Bounding box: mainland GB, Northern Ireland, Ireland, plus enough
// margin for the Hebrides, Orkney, Shetland and the Scillies.
const LAT_MIN = 49.8, LAT_MAX = 61.0;
const LON_MIN = -8.4, LON_MAX = 2.0;

// Grid resolution. Coarsened from 0.05/0.08 after the first run showed
// 295 requests couldn't get through without being throttled. ~0.075°
// latitude is about 8.3km. The app's terrain layer samples between
// 6km and 26km depending on zoom and interpolates smoothly between grid
// nodes (see terrainShadeBilinear in map.js), so this is comfortably
// enough resolution for shaded relief while cutting the request count
// by more than half — 295 down to 132.
const D_LAT = 0.075;
const D_LON = 0.12;

// Pacing between requests. Raised from 12s: at 100 coordinates per
// request, 12s meant ~500 locations/minute against a 600/minute limit,
// which is too close to the edge — and the constant connect timeouts in
// the first run were very likely Open-Meteo shedding connections rather
// than a network fault, since they cleared and recurred in step with the
// explicit rate-limit responses. 20s is ~300/minute, half the limit.
const REQUEST_DELAY_MS = 20000;

// How often to write progress to disk. Every 5 batches is 500 points —
// frequent enough that a crash loses almost nothing, infrequent enough
// that it isn't rewriting a large file constantly.
const SAVE_EVERY_BATCHES = 5;

const OUTPUT_PATH = new URL("../data/elevation-uk.json", import.meta.url);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchBatch(lats, lons, attempt = 0) {
  const params = new URLSearchParams({
    latitude: lats.map(v => v.toFixed(4)).join(","),
    longitude: lons.map(v => v.toFixed(4)).join(",")
  });

  let res;
  try {
    res = await fetch(`${ELEVATION_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    // Network-level failure (connect timeout, DNS, refused) — these
    // reject rather than returning a response, so they need catching
    // separately from HTTP status handling below.
    if (attempt >= 8) throw err;
    const waitMs = Math.min(60000, 5000 * (attempt + 1));
    console.log(`  network error (${err?.cause?.code || err?.name}), retrying in ${waitMs / 1000}s…`);
    await sleep(waitMs);
    return fetchBatch(lats, lons, attempt + 1);
  }

  if (res.status === 429) {
    // Backs off progressively. The ceiling is deliberately high and the
    // attempt count generous: being throttled is expected on a job this
    // size, and waiting several minutes is always better than failing,
    // now that a failure means re-running rather than losing work.
    if (attempt >= 8) throw new Error("Persistently rate limited — progress has been saved; just run the workflow again.");
    const waitMs = Math.min(600000, 60000 * (attempt + 1));
    console.log(`  rate limited, waiting ${waitMs / 1000}s before retry ${attempt + 1}…`);
    await sleep(waitMs);
    return fetchBatch(lats, lons, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(body unreadable)");
    console.error(`Request failed with HTTP ${res.status}. Response body:\n${body}`);
    throw new Error(`Elevation fetch failed: ${res.status}`);
  }

  const data = await res.json();
  return data.elevation;
}

// Loads a previous run's partial output, if the grid it was built for
// matches the one being built now. A resolution or bounding-box change
// makes old values meaningless, so those start fresh rather than
// silently mixing two different grids together.
async function loadExisting(rows, cols) {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf-8");
    const prev = JSON.parse(raw);
    const sameGrid = prev.rows === rows && prev.cols === cols &&
      prev.lat0 === LAT_MIN && prev.lon0 === LON_MIN &&
      prev.dLat === D_LAT && prev.dLon === D_LON;
    if (!sameGrid) {
      console.log("Existing file was built for a different grid — starting fresh.");
      return [];
    }
    if (prev.complete) {
      console.log("Existing file is already complete. Nothing to do.");
      return prev.values;
    }
    console.log(`Resuming: ${prev.values.length} points already fetched.`);
    return prev.values;
  } catch {
    return [];
  }
}

async function save(values, rows, cols, total) {
  const output = {
    note: "Static elevation grid for terrain hillshading. Built by scripts/build-elevation.mjs — elevation does not change, so this never needs refreshing once complete.",
    source: "Open-Meteo Elevation API (Copernicus DEM GLO-90)",
    built: new Date().toISOString().slice(0, 10),
    complete: values.length >= total,
    lat0: LAT_MIN, lon0: LON_MIN,
    dLat: D_LAT, dLon: D_LON,
    rows, cols,
    // Flat row-major array (row 0 = southernmost), rounded to whole
    // metres with sea clamped to 0. Sub-metre precision in a hillshade
    // is meaningless and rounding roughly halves the file size.
    values: values.map(v => (v === null || v === undefined ? 0 : Math.max(0, Math.round(v))))
  };
  await fs.mkdir(new URL(".", OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output));
}

async function main() {
  console.log(`Node ${process.version}, starting elevation build.`);

  const rows = Math.round((LAT_MAX - LAT_MIN) / D_LAT) + 1;
  const cols = Math.round((LON_MAX - LON_MIN) / D_LON) + 1;
  const total = rows * cols;

  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(LAT_MIN + r * D_LAT);
      lons.push(LON_MIN + c * D_LON);
    }
  }

  const values = await loadExisting(rows, cols);
  if (values.length >= total) {
    console.log("Grid already complete.");
    await save(values, rows, cols, total);
    return;
  }

  const startIndex = Math.floor(values.length / MAX_COORDS_PER_REQUEST) * MAX_COORDS_PER_REQUEST;
  values.length = startIndex; // drop any partial trailing batch so batches stay aligned
  const totalBatches = Math.ceil(total / MAX_COORDS_PER_REQUEST);
  const startBatch = startIndex / MAX_COORDS_PER_REQUEST;

  console.log(`Grid: ${rows} x ${cols} = ${total} points, ${totalBatches} batches.`);
  console.log(`Starting at batch ${startBatch + 1}. Remaining: ${totalBatches - startBatch}.`);
  console.log(`Estimated time: ~${Math.round(((totalBatches - startBatch) * REQUEST_DELAY_MS) / 60000)} minutes.\n`);

  try {
    for (let i = startIndex; i < total; i += MAX_COORDS_PER_REQUEST) {
      if (i > startIndex) await sleep(REQUEST_DELAY_MS);
      const batchNum = Math.floor(i / MAX_COORDS_PER_REQUEST) + 1;
      const elevations = await fetchBatch(
        lats.slice(i, i + MAX_COORDS_PER_REQUEST),
        lons.slice(i, i + MAX_COORDS_PER_REQUEST)
      );
      values.push(...elevations);

      if (batchNum % SAVE_EVERY_BATCHES === 0) {
        await save(values, rows, cols, total);
      }
      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        console.log(`  ${batchNum}/${totalBatches} batches (${values.length}/${total} points)`);
      }
    }
  } catch (err) {
    // Whatever was fetched before the failure is kept, not discarded —
    // this is the whole point of the resumable design. The workflow
    // commits it and the next run continues from here.
    await save(values, rows, cols, total);
    console.error(`\nStopped early: ${err.message}`);
    console.error(`Progress saved: ${values.length}/${total} points (${Math.round(100 * values.length / total)}%).`);
    console.error("Re-run this workflow to continue from here — nothing has been lost.");
    process.exit(1);
  }

  await save(values, rows, cols, total);
  const bytes = (await fs.stat(OUTPUT_PATH)).size;
  console.log(`\nCOMPLETE — ${total} points, ${(bytes / 1024).toFixed(0)} KB written to data/elevation-uk.json.`);
}

main().catch(async err => {
  console.error(err);
  process.exit(1);
});
