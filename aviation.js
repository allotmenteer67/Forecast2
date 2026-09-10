// aviation.js — genuinely observed (not modelled) cloud cover from the
// nearest UK METAR-reporting airport, decoded into the same
// cloudLow/cloudMid/cloudHigh % shape the rest of the app already uses.
//
// Why this exists: app.js's "Actual" cloud figures (cloudLow_mean etc.,
// see averageCloudByDay) come from Open-Meteo's hourly reanalysis —
// itself a model output, not a human/sensor observation. METAR reports
// are actual aerodrome observations (oktas of cloud at a reported
// height, taken every 20-60 min), so this is a genuine independent
// ground-truth check on that figure, not just another forecaster.
// Scoped as a data-fetch/decode module only, same division of labour
// as tide.js vs tide-ui.js — wiring this into the Actual row / a
// display card is the next session's work, not this file's.
//
// Data source: aviationweather.gov's public METAR API — free, no key.
// Relayed through a small Cloudflare Worker (aviation-proxy-worker.js,
// same pattern as admiralty-proxy-worker.js) because several reports
// say aviationweather.gov doesn't send CORS headers, which blocks a
// direct browser fetch even though the API itself needs no auth.
//
// NOTE: this file was written without live network access to verify
// aviationweather.gov's exact current response shape, so the parsing
// below deliberately works from the raw METAR text (rawOb) rather than
// trusting specific JSON field names — the raw METAR format is a
// stable, decades-old international standard, so that's the safer
// thing to depend on. Worth a real test against a live response before
// relying on this.

// A working subset of UK METAR stations, not exhaustive. Picked for
// reasonable geographic spread (every English region, Wales, Scotland
// incl. islands, Northern Ireland) rather than completeness — same
// "good enough coverage, extend later" approach as EA_TIDE_STATIONS.
// Add more rows as gaps in coverage show up in practice.
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

// Reuses tide.js's haversineKm if it's already loaded on this page
// (same script-order convention tide-ui.js relies on for tide.js);
// falls back to a local copy so this file also works standalone.
function aviationHaversineKm(lat1, lon1, lat2, lon2) {
  if (typeof haversineKm === "function") return haversineKm(lat1, lon1, lat2, lon2);
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Same sparsity shape as the EA tide gauges: nearest station can
// genuinely be 30-50km away, which is far enough that the reading
// stops being representative of a specific place. No hard cutoff here
// (callers get distanceKm and decide) but MAX_USEFUL_DISTANCE_KM is a
// suggested cut-off for UI purposes — beyond this, cloud cover at the
// station and at the target location have likely diverged.
const AVIATION_MAX_USEFUL_DISTANCE_KM = 50;

function nearestMetarStation(lat, lon) {
  let best = null, bestDist = Infinity;
  UK_METAR_STATIONS.forEach(station => {
    const dist = aviationHaversineKm(lat, lon, station.lat, station.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  });
  return best ? { ...best, distanceKm: bestDist } : null;
}

// ---- Proxy URL, same localStorage pattern as tide.js's Discovery proxy ----

const AVIATION_PROXY_STORAGE = "cloude-aviation:proxyUrl";

function loadAviationProxyUrl() {
  try {
    return (localStorage.getItem(AVIATION_PROXY_STORAGE) || "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function saveAviationProxyUrl(url) {
  try {
    const trimmed = (url || "").replace(/\/+$/, "");
    if (trimmed) localStorage.setItem(AVIATION_PROXY_STORAGE, trimmed);
    else localStorage.removeItem(AVIATION_PROXY_STORAGE);
  } catch {
    // Storage unavailable — proxy URL just won't persist between visits.
  }
}

// Unlike Admiralty, aviationweather.gov needs no key at all, so a
// missing proxy URL is the only likely cause of a raw network failure
// here — the error message can be more specific than tide.js's.
async function fetchMetarRaw(icao) {
  const proxy = loadAviationProxyUrl();
  const base = proxy || "https://aviationweather.gov";
  const url = `${base}/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&taf=false`;
  try {
    return await fetchWithTimeout(url, { cache: "no-store" }, 30000);
  } catch (err) {
    if (!proxy) {
      throw new Error("Couldn't reach aviationweather.gov directly — browsers may need a small relay in between if this fails with a CORS-shaped error. Set an Aviation proxy URL in Settings (see aviation-proxy-worker.js in the project files).");
    }
    throw err;
  }
}

// Oktas → approximate sky-cover %, following the standard METAR cover
// codes. These are midpoints of each code's defined oktas range
// (FEW=1-2, SCT=3-4, BKN=5-7, OVC=8/8), not exact — METAR only ever
// reports in these four bins, so any mapping to a continuous %
// necessarily picks a representative value rather than a measured one.
const METAR_COVER_PCT = { FEW: 20, SCT: 40, BKN: 75, OVC: 100 };

// WMO's standard low/mid/high cloud altitude bands, matched to this
// app's existing cloudLow/Mid/High split. These are a genuine
// approximation of Open-Meteo's own bands (which are defined by
// pressure level, not a fixed ft AGL cutoff) — close enough for a
// sanity check, not exact enough to treat the two as directly
// interchangeable numbers.
function cloudBandForHeightFt(ft) {
  if (ft < 6500) return "cloudLow";
  if (ft < 20000) return "cloudMid";
  return "cloudHigh";
}

// Parses cloud groups straight out of the raw METAR body — e.g.
// "BKN025", "SCT100", "OVC008CB", "FEW250", "VV004", "SKC", "NSC",
// "CAVOK" — rather than trusting a specific JSON schema (see file-top
// note on why). Height is always reported in hundreds of feet AGL.
function decodeMetarClouds(rawOb) {
  const result = { cloudLow: null, cloudMid: null, cloudHigh: null, ceilingFt: null };
  if (!rawOb) return result;

  if (/\b(SKC|CLR|NSC|CAVOK)\b/.test(rawOb)) {
    // Explicitly clear/no significant cloud below 5000ft (NSC) —
    // safe to report all three bands as 0 rather than leaving them
    // null, since the observation is genuinely saying "no cloud",
    // not "no data".
    return { cloudLow: 0, cloudMid: 0, cloudHigh: 0, ceilingFt: null };
  }

  const tokens = rawOb.match(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b|\bVV(\d{3})\b/g) || [];
  let ceilingFt = null;

  tokens.forEach(token => {
    const layerMatch = token.match(/^(FEW|SCT|BKN|OVC)(\d{3})/);
    const vvMatch = token.match(/^VV(\d{3})$/);

    let cover, heightFt;
    if (layerMatch) {
      cover = layerMatch[1];
      heightFt = parseInt(layerMatch[2], 10) * 100;
    } else if (vvMatch) {
      // Vertical visibility = sky obscured (fog, heavy precip) rather
      // than a discrete cloud layer. Treated as fully overcast at the
      // reported height so it still shows up as "not clear" rather
      // than silently vanishing from the decode.
      cover = "OVC";
      heightFt = parseInt(vvMatch[1], 10) * 100;
    } else {
      return;
    }

    const band = cloudBandForHeightFt(heightFt);
    const pct = METAR_COVER_PCT[cover];
    // A higher layer doesn't erase a lower one, but within the same
    // band the highest coverage reported wins — max, not sum, because
    // "BKN at 2000ft, OVC at 3000ft" isn't 175% cloud, it's one band
    // that's at least mostly covered.
    result[band] = result[band] === null ? pct : Math.max(result[band], pct);

    if (cover === "BKN" || cover === "OVC") {
      ceilingFt = ceilingFt === null ? heightFt : Math.min(ceilingFt, heightFt);
    }
  });

  result.ceilingFt = ceilingFt;
  return result;
}

// Top-level entry point: nearest station → fetch → decode, in one
// call. Returns null (not a throw) if there's simply no station within
// range or the fetch comes back empty, so callers can treat "no
// ground truth available here" as a normal, expected outcome rather
// than an error state — same convention as nearestTideStation callers.
async function getAviationGroundTruth(lat, lon) {
  const station = nearestMetarStation(lat, lon);
  if (!station) return null;

  const res = await fetchMetarRaw(station.icao);
  if (!res.ok) throw new Error(`METAR fetch failed: ${res.status}`);
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || !entry.rawOb) return null;

  const clouds = decodeMetarClouds(entry.rawOb);
  return {
    station: { icao: station.icao, name: station.name, distanceKm: station.distanceKm },
    beyondUsefulRange: station.distanceKm > AVIATION_MAX_USEFUL_DISTANCE_KM,
    observedAt: entry.obsTime ? new Date(entry.obsTime * 1000).toISOString() : null,
    rawText: entry.rawOb,
    ...clouds
  };
}
