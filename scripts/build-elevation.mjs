// Plain top-of-file import rather than a top-level `await import(...)`.
// Top-level await only works when Node treats the file as an ES module,
// which depends on repo configuration this script should not have to
// assume — hence the .mjs extension on this file, which forces ESM
// regardless of whether a package.json exists or what it says.
import fs from "node:fs/promises";

// Builds data/elevation-uk.json — a single static elevation grid
// covering the whole UK and Ireland, fetched ONCE and committed to the
// repo, exactly like data/coastline-50m.json and data/places.json
// already are.
//
// WHY THIS EXISTS
// Terrain hillshading originally fetched elevation from Open-Meteo's
// Elevation API live, every time you looked at a new area. That was
// wrong on its own terms: elevation is fixed data. It does not change
// between forecasts, it does not change between years, and spending a
// weather API's rate limit on it meant a single map open could exhaust
// the minutely limit and take the actual weather down with it — which
// is exactly what happened. The old approach requested 676-1521
// coordinates PER MAP OPEN; this script requests roughly 29,000 once,
// ever, and then the app never calls the elevation API again at all.
//
// Run it from the Actions tab (see .github/workflows/build-elevation.yml)
// — a manual, one-off job, not a schedule. There is no reason to ever
// re-run it unless the grid resolution or coverage area below changes.
//
// PACING
// Deliberately slow. Open-Meteo weights its rate limit by number of
// locations, so 100 coordinates in one request is not one unit of
// budget, it's a hundred. At the default delay this takes roughly an
// hour of wall-clock time inside the Action — which is completely fine
// for something that runs once and is free on public repos, and much
// better than being rate-limited halfway through and committing a file
// with holes in it.

const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const MAX_COORDS_PER_REQUEST = 100;

// Bounding box: mainland GB, Northern Ireland, Ireland, and enough
// margin to cover the Hebrides, Orkney, Shetland and the Scillies.
const LAT_MIN = 49.8, LAT_MAX = 61.0;
const LON_MIN = -8.4, LON_MAX = 2.0;

// Grid resolution. ~0.05° latitude is about 5.5km; 0.08° longitude is
// about 5km at UK latitudes. That is finer than any zoom level the map
// actually renders terrain at (the coarsest samples at 26km), so the
// app downsamples from this rather than ever needing more than it has.
// Going finer multiplies both the build time and the committed file
// size for detail that gets drawn into single pixels.
const D_LAT = 0.05;
const D_LON = 0.08;

// Milliseconds between requests. 12s ≈ 5 requests/minute ≈ 500
// locations/minute, comfortably under the 600/minute minutely limit
// that caused all the trouble in the first place. Raise it if this
// still gets throttled; there's no hurry on a one-off job.
const REQUEST_DELAY_MS = 12000;

const OUTPUT_PATH = new URL("../data/elevation-uk.json", import.meta.url);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchBatch(lats, lons, attempt = 0) {
  const params = new URLSearchParams({
    latitude: lats.map(v => v.toFixed(4)).join(","),
    longitude: lons.map(v => v.toFixed(4)).join(",")
  });

  // Network-level failures (connection refused, DNS, connect timeout)
  // reject rather than returning a response, so they need catching
  // separately from the HTTP status handling further down — an
  // uncaught one here kills the whole run on its very first request,
  // which is exactly what happened the first time this was deployed:
  // UND_ERR_CONNECT_TIMEOUT against api.open-meteo.com, before a single
  // batch had been fetched.
  let res;
  try {
    res = await fetch(`${ELEVATION_URL}?${params.toString()}`, {
      // A connection that hasn't opened in 30s isn't going to; failing
      // here lets the retry below run rather than hanging on undici's
      // own default.
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    if (attempt >= 5) {
      console.error(`Network error after 6 attempts: ${err?.cause?.code || err?.name || err}`);
      throw err;
    }
    const waitMs = 5000 * (attempt + 1);
    console.log(`  network error (${err?.cause?.code || err?.name}), retrying in ${waitMs / 1000}s…`);
    await sleep(waitMs);
    return fetchBatch(lats, lons, attempt + 1);
  }

  if (res.status === 429) {
    // Backs off and retries rather than failing the whole run — an hour
    // of work shouldn't be thrown away because one request landed in a
    // busy minute. Waits progressively longer each time.
    if (attempt >= 5) throw new Error("Still rate limited after 5 retries — raise REQUEST_DELAY_MS and re-run.");
    const waitMs = 60000 * (attempt + 1);
    console.log(`  rate limited, waiting ${waitMs / 1000}s before retry ${attempt + 1}…`);
    await sleep(waitMs);
    return fetchBatch(lats, lons, attempt + 1);
  }

  if (!res.ok) {
    // The body carries Open-Meteo's own "reason" text, which names the
    // actual problem (bad parameter, limit exceeded, etc.). Printed in
    // full rather than truncated into the thrown message, because this
    // log is the only diagnostic available for a job running on
    // GitHub's machines.
    const body = await res.text().catch(() => "(body unreadable)");
    console.error(`Request failed with HTTP ${res.status}. Response body:\n${body}`);
    console.error(`Failing URL: ${ELEVATION_URL}?${params.toString().slice(0, 300)}…`);
    throw new Error(`Elevation fetch failed: ${res.status}`);
  }

  const data = await res.json();
  return data.elevation;
}

async function main() {
  // Printed before anything else so the Actions log always shows the
  // script at least started — distinguishing "the script failed" from
  // "the script was never found/run at all", which look identical in
  // the run summary (both are just exit code 1).
  console.log(`Node ${process.version}, starting elevation build.`);
  const rows = Math.round((LAT_MAX - LAT_MIN) / D_LAT) + 1;
  const cols = Math.round((LON_MAX - LON_MIN) / D_LON) + 1;
  const total = rows * cols;
  const batches = Math.ceil(total / MAX_COORDS_PER_REQUEST);

  console.log(`Grid: ${rows} rows x ${cols} cols = ${total} points, ${batches} requests.`);
  console.log(`Estimated time: ~${Math.round((batches * REQUEST_DELAY_MS) / 60000)} minutes.\n`);

  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(LAT_MIN + r * D_LAT);
      lons.push(LON_MIN + c * D_LON);
    }
  }

  const values = [];
  for (let i = 0; i < total; i += MAX_COORDS_PER_REQUEST) {
    if (i > 0) await sleep(REQUEST_DELAY_MS);
    const batchNum = Math.floor(i / MAX_COORDS_PER_REQUEST) + 1;
    const elevations = await fetchBatch(
      lats.slice(i, i + MAX_COORDS_PER_REQUEST),
      lons.slice(i, i + MAX_COORDS_PER_REQUEST)
    );
    values.push(...elevations);
    if (batchNum % 10 === 0 || batchNum === batches) {
      console.log(`  ${batchNum}/${batches} batches (${values.length}/${total} points)`);
    }
  }

  if (values.length !== total) {
    throw new Error(`Expected ${total} elevations, got ${values.length} — refusing to write a partial grid.`);
  }

  // Rounded to whole metres and sea clamped to 0. Sub-metre precision in
  // a hillshade is meaningless, and rounding roughly halves the
  // committed file size versus raw floats.
  const rounded = values.map(v => (v === null || v === undefined ? 0 : Math.max(0, Math.round(v))));

  const output = {
    note: "Static elevation grid for terrain hillshading. Built once by scripts/build-elevation.js — elevation does not change, so this never needs refreshing.",
    source: "Open-Meteo Elevation API (Copernicus DEM GLO-90)",
    built: new Date().toISOString().slice(0, 10),
    lat0: LAT_MIN,
    lon0: LON_MIN,
    dLat: D_LAT,
    dLon: D_LON,
    rows,
    cols,
    // Flat row-major array (row 0 = southernmost). Flat rather than
    // nested so the committed file has no per-row bracket overhead.
    values: rounded
  };

  await fs.mkdir(new URL(".", OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output));
  const bytes = (await fs.stat(OUTPUT_PATH)).size;
  console.log(`\nWrote data/elevation-uk.json — ${total} points, ${(bytes / 1024).toFixed(0)} KB.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
