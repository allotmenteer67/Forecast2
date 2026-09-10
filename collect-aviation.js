// Companion to collect-weather.js — fetches real, observed METAR cloud
// data for the up-to-4 stations around the configured location (see
// aviation.js's nearestStationsByQuadrant for the reasoning behind
// quadrant matching over a single nearest station) and folds it into
// the same daily history.json entries collect-weather.js already
// builds, as a new `aviation` field alongside the existing `actual`
// and `models`.
//
// Why this lives here rather than reusing aviation-proxy-worker.js:
// this runs in a GitHub Action (Node), not a browser — no CORS
// restriction applies at all, so there's no proxy to route through.
// aviationweather.gov is called directly. The station list and
// bearing/quadrant/decode logic below is intentionally the same
// approach as aviation.js, just a self-contained copy without any
// browser-only bits (localStorage, fetchWithTimeout) — if the two
// ever drift, aviation.js's decode logic is the one that's actually
// been checked against live responses (see its own header comment),
// so treat that copy as canonical if the two disagree.
//
// Deliberately NOT wired into FFV training yet — this only collects
// the data into history.json. Whether/how a METAR reading should
// influence the cloud FFV correction (full weight, reduced for a
// low-confidence quadrant, blended across quadrants, etc.) is a real
// design decision on its own, better made once there's a few weeks of
// real collected data to actually look at rather than guessed at
// upfront.

const UK_METAR_STATIONS = [
  { icao: "EGLL", name: "London Heathrow", lat: 51.4700, lon: -0.4543 },
  { icao: "EGKK", name: "London Gatwick", lat: 51.1481, lon: -0.1903 },
  { icao: "EGSS", name: "London Stansted", lat: 51.8860, lon: 0.2389 },
  { icao: "EGGW", name: "London Luton", lat: 51.8747, lon: -0.3683 },
  { icao: "EGLC", name: "London City", lat: 51.5053, lon: 0.0553 },
  { icao: "EGMC", name: "Southend", lat: 51.5714, lon: 0.6956 },
  { icao: "EGKB", name: "Biggin Hill", lat: 51.3308, lon: 0.0325 },
  { icao: "EGLF", name: "Farnborough", lat: 51.2758, lon: -0.7764 },
  { icao: "EGHI", name: "Southampton", lat: 50.9503, lon: -1.3567 },
  { icao: "EGTE", name: "Exeter", lat: 50.7344, lon: -3.4139 },
  { icao: "EGHQ", name: "Newquay", lat: 50.4406, lon: -4.9954 },
  { icao: "EGHC", name: "Land's End", lat: 50.1028, lon: -5.6706 },
  { icao: "EGGD", name: "Bristol", lat: 51.3827, lon: -2.7191 },
  { icao: "EGBJ", name: "Gloucestershire", lat: 51.8942, lon: -2.1673 },
  { icao: "EGTK", name: "Oxford", lat: 51.8369, lon: -1.3200 },
  { icao: "EGVN", name: "RAF Brize Norton", lat: 51.7500, lon: -1.5836 },
  { icao: "EGBB", name: "Birmingham", lat: 52.4539, lon: -1.7480 },
  { icao: "EGNX", name: "East Midlands", lat: 52.8311, lon: -1.3281 },
  { icao: "EGSH", name: "Norwich", lat: 52.6758, lon: 1.2828 },
  { icao: "EGNJ", name: "Humberside", lat: 53.5744, lon: -0.3508 },
  { icao: "EGFF", name: "Cardiff", lat: 51.3967, lon: -3.3433 },
  { icao: "EGNR", name: "Hawarden (Chester)", lat: 53.1783, lon: -2.9781 },
  { icao: "EGGP", name: "Liverpool John Lennon", lat: 53.3336, lon: -2.8497 },
  { icao: "EGCC", name: "Manchester", lat: 53.3537, lon: -2.2750 },
  { icao: "EGNH", name: "Blackpool", lat: 53.7717, lon: -3.0286 },
  { icao: "EGNM", name: "Leeds Bradford", lat: 53.8659, lon: -1.6606 },
  { icao: "EGNT", name: "Newcastle", lat: 55.0375, lon: -1.6917 },
  { icao: "EGNV", name: "Durham Tees Valley", lat: 54.5092, lon: -1.4294 },
  { icao: "EGNS", name: "Isle of Man Ronaldsway", lat: 54.0836, lon: -4.6239 },
  { icao: "EGPH", name: "Edinburgh", lat: 55.9500, lon: -3.3725 },
  { icao: "EGPF", name: "Glasgow", lat: 55.8719, lon: -4.4331 },
  { icao: "EGPK", name: "Prestwick", lat: 55.5094, lon: -4.5864 },
  { icao: "EGPN", name: "Dundee", lat: 56.4525, lon: -3.0258 },
  { icao: "EGPD", name: "Aberdeen", lat: 57.2019, lon: -2.1978 },
  { icao: "EGPE", name: "Inverness", lat: 57.5425, lon: -4.0475 },
  { icao: "EGPC", name: "Wick", lat: 58.4589, lon: -3.0928 },
  { icao: "EGPO", name: "Stornoway", lat: 58.2158, lon: -6.3311 },
  { icao: "EGPB", name: "Sumburgh (Shetland)", lat: 59.8790, lon: -1.2956 },
  { icao: "EGPA", name: "Kirkwall (Orkney)", lat: 58.9578, lon: -2.9053 },
  { icao: "EGPI", name: "Islay", lat: 55.6819, lon: -6.2564 },
  { icao: "EGAA", name: "Belfast International", lat: 54.6575, lon: -6.2158 },
  { icao: "EGAC", name: "Belfast City", lat: 54.6181, lon: -5.8725 },
  { icao: "EGAE", name: "Derry/Eglinton", lat: 55.0428, lon: -7.1611 }
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const theta = Math.atan2(y, x);
  return (theta * 180 / Math.PI + 360) % 360;
}

function quadrantForBearing(bearing) {
  if (bearing >= 315 || bearing < 45) return "N";
  if (bearing < 135) return "E";
  if (bearing < 225) return "S";
  return "W";
}

// Same two thresholds as aviation.js — see that file for the reasoning.
const QUADRANT_PREFERRED_MAX_KM = 50;
const QUADRANT_FALLBACK_MAX_KM = 120;

function nearestStationsByQuadrant(lat, lon) {
  const byQuadrant = { N: [], E: [], S: [], W: [] };
  UK_METAR_STATIONS.forEach(station => {
    const distanceKm = haversineKm(lat, lon, station.lat, station.lon);
    const bearing = bearingDegrees(lat, lon, station.lat, station.lon);
    byQuadrant[quadrantForBearing(bearing)].push({ ...station, distanceKm, bearing });
  });

  const result = [];
  for (const quadrant of ["N", "E", "S", "W"]) {
    const nearest = byQuadrant[quadrant].sort((a, b) => a.distanceKm - b.distanceKm)[0];
    if (!nearest || nearest.distanceKm > QUADRANT_FALLBACK_MAX_KM) continue;
    result.push({
      quadrant,
      icao: nearest.icao,
      name: nearest.name,
      distanceKm: nearest.distanceKm,
      reducedConfidence: nearest.distanceKm > QUADRANT_PREFERRED_MAX_KM
    });
  }
  return result;
}

const METAR_COVER_PCT = { FEW: 20, SCT: 40, BKN: 75, OVC: 100 };

function cloudBandForHeightFt(ft) {
  if (ft < 6500) return "cloudLow";
  if (ft < 20000) return "cloudMid";
  return "cloudHigh";
}

// Same decode as aviation.js's decodeMetarClouds, including the NCD fix
// confirmed against a real EGLL AUTO response — see that file's own
// comments for the full reasoning on each choice made here.
function decodeMetarClouds(rawOb) {
  const result = { cloudLow: null, cloudMid: null, cloudHigh: null };
  if (!rawOb) return result;

  if (/\b(SKC|CLR|NSC|CAVOK|NCD)\b/.test(rawOb)) {
    return { cloudLow: 0, cloudMid: 0, cloudHigh: 0 };
  }

  const tokens = rawOb.match(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b|\bVV(\d{3})\b/g) || [];
  tokens.forEach(token => {
    const layerMatch = token.match(/^(FEW|SCT|BKN|OVC)(\d{3})/);
    const vvMatch = token.match(/^VV(\d{3})$/);
    let cover, heightFt;
    if (layerMatch) { cover = layerMatch[1]; heightFt = parseInt(layerMatch[2], 10) * 100; }
    else if (vvMatch) { cover = "OVC"; heightFt = parseInt(vvMatch[1], 10) * 100; }
    else return;
    const band = cloudBandForHeightFt(heightFt);
    const pct = METAR_COVER_PCT[cover];
    result[band] = result[band] === null ? pct : Math.max(result[band], pct);
  });
  return result;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// One station, one call, covering the whole window — far cheaper than
// one call per date. aviationweather.gov's own docs advertise up to 15
// days (360h) of history; hoursBack here is sized to the actual
// start/end window plus a day's buffer, comfortably under that.
async function fetchStationHistory(icao, hoursBack) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&taf=false&hours=${hoursBack}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`METAR history fetch failed for ${icao}: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Averages every report that fell on a given UTC calendar date into
// one cloudLow/Mid/High figure for that date — same "mean of whatever
// samples exist that day" approach as aggregateHourlyByDay in
// collect-weather.js, just keyed by calendar date instead of a fixed
// 24-per-day hourly index, since METAR reports arrive at irregular
// times rather than on the hour.
function averageCloudsByDate(reports) {
  const byDate = {};
  reports.forEach(entry => {
    if (!entry.rawOb || !entry.obsTime) return;
    const date = isoDate(new Date(entry.obsTime * 1000));
    const clouds = decodeMetarClouds(entry.rawOb);
    (byDate[date] ??= []).push(clouds);
  });

  const result = {};
  for (const [date, samples] of Object.entries(byDate)) {
    const meanFor = band => {
      const vals = samples.map(s => s[band]).filter(v => v !== null && v !== undefined);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    result[date] = {
      cloudLow: meanFor("cloudLow"),
      cloudMid: meanFor("cloudMid"),
      cloudHigh: meanFor("cloudHigh"),
      sampleCount: samples.length
    };
  }
  return result;
}

// Top-level entry point for collect-weather.js: one call per quadrant
// station (up to 4 network requests total, not 4×WINDOW_DAYS), merged
// into { [date]: { N: {...}, E: {...}, S: {...}, W: {...} } } — any
// quadrant with no station nearby, or whose fetch fails, is simply
// absent from each date's object rather than the whole collection
// failing (a flaky/missing station shouldn't take down the existing
// actual/models collection this runs alongside).
export async function fetchAviationActual(lat, lon, start, end) {
  const stations = nearestStationsByQuadrant(Number(lat), Number(lon));
  if (!stations.length) return {};

  const now = new Date();
  const hoursBack = Math.min(360, Math.ceil((now - start) / 3600000) + 24);

  const settled = await Promise.allSettled(
    stations.map(station => fetchStationHistory(station.icao, hoursBack))
  );

  const startIso = isoDate(start);
  const endIso = isoDate(end);
  const byDate = {};

  stations.forEach((station, i) => {
    const outcome = settled[i];
    if (outcome.status !== "fulfilled") {
      console.warn(`Aviation: skipping ${station.icao} (${station.quadrant}) — ${outcome.reason}`);
      return;
    }
    const byDateForStation = averageCloudsByDate(outcome.value);
    for (const [date, clouds] of Object.entries(byDateForStation)) {
      if (date < startIso || date > endIso) continue; // outside the requested window — hoursBack deliberately over-fetches a buffer day either side
      byDate[date] ??= {};
      byDate[date][station.quadrant] = {
        icao: station.icao,
        name: station.name,
        distanceKm: station.distanceKm,
        reducedConfidence: station.reducedConfidence,
        ...clouds
      };
    }
  });

  return byDate;
}
