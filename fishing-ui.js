// Fishing UI — DOM and rendering for the fishing conditions card.
// Deliberately reuses tide's own saved-location list and "current"
// selection (loadTideLocations/loadCurrentTideLocationId in tide.js)
// rather than keeping a separate list — a fishing mark and a tide spot
// are so often the same place that maintaining two lists in sync would
// just be two copies of the same thing drifting apart. Switching the
// current location via tide's own dots switches fishing's display too.

const fishingRow = document.getElementById("fishingRow");

// ---- Fishing card colour ----
// Mirrors tide's own card colour picker exactly (see TIDE_CARD_COLORS
// in tide-ui.js) — its own storage key and swatch list, since the two
// cards are visually separate and someone might reasonably want them
// distinguishable at a glance.
const FISHING_CARD_COLOR_KEY = "cloude-fishing:cardColor";
const FISHING_CARD_COLORS = [
  { id: "mint", name: "Mint" },
  { id: "blue", name: "Light blue" },
  { id: "teal", name: "Teal" },
  { id: "sand", name: "Sand" },
  { id: "lavender", name: "Lavender" },
  { id: "white", name: "Plain white" }
];

function loadFishingCardColor() {
  try {
    return localStorage.getItem(FISHING_CARD_COLOR_KEY) || "mint";
  } catch {
    return "mint";
  }
}

function saveFishingCardColor(id) {
  try {
    localStorage.setItem(FISHING_CARD_COLOR_KEY, id);
  } catch {
    // Storage unavailable — choice just won't persist between visits.
  }
}

function applyFishingCardColor(id) {
  const fishingCard = document.querySelector(".fishing-card");
  if (fishingCard) fishingCard.dataset.color = id; // no-op on pages with no fishing card, e.g. Settings
}

applyFishingCardColor(loadFishingCardColor());

let fishingRenderToken = 0;

function setFishingCardVisible(visible) {
  const card = document.querySelector(".fishing-card");
  if (card) card.hidden = !visible;
}

async function renderFishingRow() {
  if (!fishingRow) return;
  const toggles = loadHeadlineToggles();
  if (!toggles.fishing) {
    fishingRow.hidden = true;
    setFishingCardVisible(false);
    return;
  }

  const location = currentTideLocation(); // shared with tide — see file header
  if (!location) {
    fishingRow.hidden = true;
    setFishingCardVisible(false);
    return;
  }
  fishingRow.hidden = false;
  setFishingCardVisible(true);

  const myToken = ++fishingRenderToken;
  const labelHtml = `FISHING — ${location.label}${tideDateQualifier()}`;
  fishingRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><span class="tide-row-value">Loading…</span>`;

  let built;
  try {
    built = await getOrBuildTideFit(location.station);
  } catch {
    built = null;
  }
  if (myToken !== fishingRenderToken) return;
  if (!built) {
    fishingRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><span class="tide-row-value">Not available right now</span>`;
    return;
  }

  const markType = fishingMarkType(location);
  let forecast;
  try {
    forecast = await fetchFishingForecast(location.station.lat, location.station.lon, markType);
  } catch {
    forecast = null;
  }
  if (myToken !== fishingRenderToken) return;
  if (!forecast) {
    fishingRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><span class="tide-row-value">Not available right now</span>`;
    return;
  }

  const weatherTimesEpoch = forecast.weather.hourly.time.map(t => Date.parse(t));
  const marineTimesEpoch = forecast.marine ? forecast.marine.hourly.time.map(t => Date.parse(t)) : null;
  const nowHours = (tideReferenceNow() - Date.parse(built.epochIso)) / 3600000;

  // Sample every 15 minutes across the next 24h to find the best
  // contiguous 2-hour window — fine-grained enough to catch a real
  // window without being an expensive number of points.
  const points = [];
  for (let h = nowHours; h <= nowHours + 24; h += 0.25) {
    points.push(computeFishingAt({
      fit: built.fit, epochIso: built.epochIso, hours: h,
      weatherHourly: forecast.weather.hourly, weatherTimesEpoch,
      marineHourly: forecast.marine ? forecast.marine.hourly : null, marineTimesEpoch,
      isEstuary: markType === "estuary"
    }));
  }

  const nowPoint = points[0];
  const best = findBestFishingWindow(points, nowHours, 2, 24);

  let valueHtml;
  if (!best) {
    valueHtml = `<span class="fishing-band fishing-band-${nowPoint.band.toLowerCase()}">${nowPoint.band} now</span>`;
  } else {
    const startWhen = new Date(Date.parse(built.epochIso) + best.startHours * 3600000);
    const endWhen = new Date(Date.parse(built.epochIso) + best.endHours * 3600000);
    const fmt = d => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    valueHtml = `<span class="fishing-band fishing-band-${nowPoint.band.toLowerCase()}">${nowPoint.band} now</span>` +
      `<span class="fishing-band fishing-band-${best.band.toLowerCase()}">${best.band} ${fmt(startWhen)}–${fmt(endWhen)}</span>`;
  }

  fishingRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><div class="fishing-row-value">${valueHtml}</div>`;
}

// ---- Sheet: scrolling score curve + optional raw factors ----

let openFishingSheetToken = 0;

async function openFishingSheet() {
  if (!sheet) return;
  const location = currentTideLocation();
  if (!location) return;
  const myToken = ++openFishingSheetToken;

  sheetTitle.textContent = `Fishing — ${location.label}`;
  sheetRange.textContent = tideDateQualifier().replace(/^ · /, "");
  sheetReadout.hidden = true;
  sheetBody.innerHTML = "";
  sheetFootnote.textContent = "";

  sheet.hidden = false;
  requestAnimationFrame(() => {
    sheetBackdrop.classList.add("is-open");
    sheet.classList.add("is-open");
  });

  const loading = document.createElement("p");
  loading.className = "sheet-empty";
  loading.textContent = "Loading fishing conditions…";
  sheetBody.appendChild(loading);

  let built, forecast;
  try {
    built = await getOrBuildTideFit(location.station);
    const markType = fishingMarkType(location);
    forecast = built ? await fetchFishingForecast(location.station.lat, location.station.lon, markType) : null;
  } catch {
    built = null;
    forecast = null;
  }
  if (myToken !== openFishingSheetToken) return;
  sheetBody.innerHTML = "";
  if (!built || !forecast) {
    const empty = document.createElement("p");
    empty.className = "sheet-empty";
    empty.textContent = "Fishing conditions aren't available right now.";
    sheetBody.appendChild(empty);
    return;
  }

  const markType = fishingMarkType(location);
  const weatherTimesEpoch = forecast.weather.hourly.time.map(t => Date.parse(t));
  const marineTimesEpoch = forecast.marine ? forecast.marine.hourly.time.map(t => Date.parse(t)) : null;
  const nowHours = (tideReferenceNow() - Date.parse(built.epochIso)) / 3600000;

  // The curve can only run as far as the shortest-lived input allows —
  // wind/pressure/marine forecasts run 7 days, but capped a little
  // short of that so the last stretch of the curve isn't sitting right
  // at the forecast's own edge, where Open-Meteo's hourly data can thin
  // out or turn stale-feeling.
  const maxForecastHours = Math.min(
    (weatherTimesEpoch[weatherTimesEpoch.length - 1] - Date.parse(built.epochIso)) / 3600000 - 6,
    marineTimesEpoch ? (marineTimesEpoch[marineTimesEpoch.length - 1] - Date.parse(built.epochIso)) / 3600000 - 6 : Infinity
  );
  const endHours = Math.min(nowHours + 5 * 24, maxForecastHours);
  const startHours = Math.max(nowHours - 24, (weatherTimesEpoch[0] - Date.parse(built.epochIso)) / 3600000);

  const points = [];
  for (let h = startHours; h <= endHours; h += 0.5) {
    points.push(computeFishingAt({
      fit: built.fit, epochIso: built.epochIso, hours: h,
      weatherHourly: forecast.weather.hourly, weatherTimesEpoch,
      marineHourly: forecast.marine ? forecast.marine.hourly : null, marineTimesEpoch,
      isEstuary: markType === "estuary"
    }));
  }

  sheetBody.appendChild(renderFishingCurve(points, built.epochIso, nowHours, startHours, endHours, location, built.fit));

  if (loadFishingShowRaw()) {
    const nowPoint = points.find(p => p.hours >= nowHours) || points[0];
    sheetBody.appendChild(renderFishingRawFactors(nowPoint, markType));
  }

  sheetFootnote.textContent = "Fishing conditions are a rule-of-thumb estimate, not measured science — see Help for exactly how each factor is worked out and weighted.";
}

// The scrolling score curve — visually matches tide's own wide,
// horizontally-scrolling chart (same TIDE_GRAPH_PX_PER_HOUR density,
// same day-boundary gridlines), but the y-axis is the four score bands
// rather than a height in metres.
//
// Also draws the location's own corrected tide height as a faint
// background line, purely for TIMING — auto-scaled to its own min/max
// within the visible window (same idea as Temperature/Dew Point
// overlaying each other), with no y-axis of its own and no claim that
// a given height corresponds to a given score band. The tide contributor
// to the fishing score is really tide MOVEMENT (rate of change, which
// peaks mid-tide and drops to ~0 at both slack high and slack low), not
// height — so a height curve here answers "is a low-tide-only mark
// accessible when the score is good", which is what was actually asked
// for, without implying a low/high-to-score relationship that isn't how
// the score works.
function renderFishingCurve(points, epochIso, nowHours, startHours, endHours, location, tideFit) {
  const totalHours = endHours - startHours;
  const padL = 66, padR = 16, padT = 16, padB = 34;
  const plotW = Math.max(280, totalHours * TIDE_GRAPH_PX_PER_HOUR);
  const plotH = 210;
  const width = plotW + padL + padR;
  const height = plotH + padT + padB;

  const xFor = h => padL + ((h - startHours) / totalHours) * plotW;
  const yForBand = rank => padT + plotH - (rank / (FISHING_BAND_ORDER.length - 1)) * plotH;
  const yForScore = score => padT + plotH - score * plotH; // continuous, for a smooth line rather than a stepped one

  const svg = sheetSvgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    class: "graph-svg fishing-graph-svg"
  });

  FISHING_BAND_ORDER.forEach((band, rank) => {
    const y = yForBand(rank);
    svg.appendChild(sheetSvgEl("line", { x1: padL, x2: width - padR, y1: y, y2: y, class: "graph-gridline" }));
    const label = svg.appendChild(sheetSvgEl("text", { x: padL - 6, y: y + 3, class: "graph-axis-label", "text-anchor": "end" }));
    label.textContent = band;
  });

  let lastDay = null;
  for (let h = startHours; h <= endHours; h += 1) {
    const when = new Date(Date.parse(epochIso) + h * 3600000);
    const dayKey = when.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const x = xFor(h);
      svg.appendChild(sheetSvgEl("line", { x1: x, x2: x, y1: padT, y2: padT + plotH, class: "graph-gridline", "stroke-dasharray": "2 3" }));
      const label = svg.appendChild(sheetSvgEl("text", { x: x + 4, y: padT + plotH + 20, class: "graph-axis-label", "text-anchor": "start" }));
      label.textContent = when.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
    }
  }

  const nowX = xFor(nowHours);
  svg.appendChild(sheetSvgEl("line", { x1: nowX, x2: nowX, y1: padT, y2: padT + plotH, class: "graph-gridline", "stroke-dasharray": "3 3" }));

  // Tide overlay — drawn BEFORE the score line so the score sits
  // visually on top. Uses the exact same correction path as tide's own
  // sheet (getOrBuildTideFit + loadTideFudge + applyLocationCorrection),
  // so a location with a learned Admiralty correction shows the same
  // corrected shape here as it does on its own tide card — not the raw
  // nearest-gauge curve underneath it.
  if (location) {
    try {
      const fit = tideFit;
      if (!fit) throw new Error("no tide fit available");
      const fudge = loadTideFudge(location.station.id);
      const tidePts = [];
      const step = totalHours / 200;
      for (let h = startHours; h <= endHours; h += step) {
        const r = applyLocationCorrection(location, fit, h, applyTideFudge(predictTideLevel(fit, h), fudge));
        tidePts.push({ hours: r.hours, level: r.level });
      }
      const levels = tidePts.map(p => p.level);
      const minLevel = Math.min(...levels), maxLevel = Math.max(...levels);
      const levelSpan = maxLevel - minLevel || 1;
      // Auto-scaled to fill the SAME plot area as the score line, purely
      // for shape/timing comparison — deliberately no axis or labels,
      // since the numbers themselves aren't the point here (the tide
      // card already shows those) and adding a second labelled axis
      // would clutter a chart that's meant to answer one question: does
      // the timing line up.
      const yForTide = level => padT + plotH - ((level - minLevel) / levelSpan) * plotH;
      const tidePath = "M" + tidePts.map(p => `${xFor(p.hours)},${yForTide(p.level)}`).join(" L");
      svg.appendChild(sheetSvgEl("path", {
        d: tidePath, fill: "none", stroke: "#3d6d95", "stroke-width": 1.4,
        "stroke-linecap": "round", "stroke-linejoin": "round", opacity: "0.28"
      }));
    } catch {
      // Missing tide fit for this location shouldn't block the fishing
      // chart itself from rendering — just skip the overlay silently.
    }
  }

  const path = "M" + points.map(p => `${xFor(p.hours)},${yForScore(p.score)}`).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: path, fill: "none", stroke: "#3d6d95", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // Tap anywhere to read off that moment's band + factors — same tap
  // (not drag) approach as tide's curve, for the same reason: this
  // chart is wide enough to need native horizontal scroll, and a
  // drag-based scrubber would fight that gesture.
  const touchArea = sheetSvgEl("rect", { x: 0, y: 0, width, height, class: "tide-touch-area" });
  svg.appendChild(touchArea);
  const crosshair = sheetSvgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + plotH, class: "scrub-line" });
  const dot = sheetSvgEl("circle", { r: 4.5, class: "scrub-dot" });
  svg.appendChild(crosshair);
  svg.appendChild(dot);

  function nearestPoint(hours) {
    let best = points[0], bestGap = Infinity;
    points.forEach(p => {
      const gap = Math.abs(p.hours - hours);
      if (gap < bestGap) { bestGap = gap; best = p; }
    });
    return best;
  }

  function showReadoutAt(hours) {
    const clamped = Math.max(startHours, Math.min(endHours, hours));
    const point = nearestPoint(clamped);
    const x = xFor(point.hours);
    const y = yForScore(point.score);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    const when = new Date(Date.parse(epochIso) + point.hours * 3600000);
    readoutTime.textContent = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    readoutValue.textContent = point.band;
    sheetReadout.hidden = false;

    if (loadFishingShowRaw()) {
      const existing = sheetBody.querySelector(".fishing-raw-factors");
      if (existing) existing.replaceWith(renderFishingRawFactors(point, currentTideLocation() ? fishingMarkType(currentTideLocation()) : "coastal"));
    }
  }

  touchArea.addEventListener("click", e => {
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (localX - padL) / plotW;
    showReadoutAt(startHours + ratio * totalHours);
  });

  showReadoutAt(nowHours);

  const wrap = document.createElement("div");
  wrap.className = "graph-wrap tide-graph-wrap";
  wrap.appendChild(svg);
  return wrap;
}

// Plain list of the individual factors behind whichever point the curve
// is currently showing — kept visually distinct between the
// real-evidence factors (wind, wave/swell) and the folklore-adjacent
// ones (tidal range/"moon phase" strength, pressure trend), per the
// decision that a blended score shouldn't paper over how much weight
// each kind of evidence actually deserves.
function renderFishingRawFactors(point, markType) {
  const wrap = document.createElement("div");
  wrap.className = "fishing-raw-factors admiralty-events-summary"; // reuses the same "separate block below the graph" styling as tide's Admiralty summary

  const heading = document.createElement("h3");
  heading.className = "admiralty-events-heading";
  heading.textContent = "Raw factors";
  wrap.appendChild(heading);

  function row(label, valueText, group) {
    const r = document.createElement("div");
    r.className = "fishing-factor-row fishing-factor-" + group;
    r.innerHTML = `<span>${label}</span><strong>${valueText}</strong>`;
    return r;
  }

  const evidence = document.createElement("div");
  evidence.className = "fishing-factor-group";
  const evidenceLabel = document.createElement("small");
  evidenceLabel.className = "fishing-group-label";
  evidenceLabel.textContent = "Measured";
  evidence.appendChild(evidenceLabel);
  evidence.appendChild(row("Wind", typeof point.windMph === "number" ? `${Math.round(point.windMph)}mph` : "–", "evidence"));
  if (markType === "coastal") {
    evidence.appendChild(row("Wave height", typeof point.waveHeightM === "number" ? `${point.waveHeightM.toFixed(1)}m` : "–", "evidence"));
    evidence.appendChild(row("Swell period", typeof point.swellPeriodS === "number" ? `${point.swellPeriodS.toFixed(0)}s` : "–", "evidence"));
    evidence.appendChild(row("Sea temperature", typeof point.seaTempC === "number" ? `${point.seaTempC.toFixed(1)}°C` : "–", "evidence"));
  }
  function factorLabel(value) {
    return typeof value === "number" ? fishingBandForScore(value) : "–";
  }

  evidence.appendChild(row("Tide movement", factorLabel(point.factors.tideMovement), "evidence"));
  wrap.appendChild(evidence);

  const folklore = document.createElement("div");
  folklore.className = "fishing-factor-group";
  const folkloreLabel = document.createElement("small");
  folkloreLabel.className = "fishing-group-label";
  folkloreLabel.textContent = "Traditional (softer evidence)";
  folklore.appendChild(folkloreLabel);
  folklore.appendChild(row("Tidal range (springs/neaps)", factorLabel(point.factors.tidalRange), "folklore"));
  folklore.appendChild(row("Pressure trend", factorLabel(point.factors.pressureTrend), "folklore"));
  wrap.appendChild(folklore);

  return wrap;
}

// ---- Settings page: fishing mark type (Coastal/Estuary) per location ----
// Lives in its own Fishing-section list rather than inside tide's own
// location rows — it's a fishing-specific concern about a shared
// location, not something that belongs in tide's own list.
const fishingMarkTypeList = document.getElementById("fishingMarkTypeList");

function renderFishingMarkTypeList() {
  if (!fishingMarkTypeList) return;
  fishingMarkTypeList.innerHTML = "";
  const locations = loadTideLocations();
  const currentId = loadCurrentTideLocationId();

  if (!locations.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No saved locations yet — add one under Tides above.";
    fishingMarkTypeList.appendChild(empty);
    return;
  }

  locations.forEach(loc => {
    const row = document.createElement("div");
    row.className = "unit-row";

    const name = document.createElement("span");
    name.className = "unit-row-name";
    name.textContent = loc.label;
    row.appendChild(name);

    const toggle = document.createElement("div");
    toggle.className = "unit-row-toggle";
    [
      { value: "coastal", text: "Coastal" },
      { value: "estuary", text: "Estuary" }
    ].forEach(opt => {
      const pillLabel = document.createElement("label");
      pillLabel.className = "unit-pill";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `markType-${loc.id}`;
      input.value = opt.value;
      input.checked = fishingMarkType(loc) === opt.value;
      input.addEventListener("change", () => {
        loc.markType = opt.value;
        saveTideLocations(locations);
        if (loc.id === currentId) renderFishingRow();
      });
      const text = document.createElement("span");
      text.textContent = opt.text;
      pillLabel.append(input, text);
      toggle.appendChild(pillLabel);
    });
    row.appendChild(toggle);
    fishingMarkTypeList.appendChild(row);
  });
}

renderFishingMarkTypeList();

// ---- Settings page: fishing card colour ----
const fishingCardColorSwatches = document.getElementById("fishingCardColorSwatches");
if (fishingCardColorSwatches) {
  const current = loadFishingCardColor();
  FISHING_CARD_COLORS.forEach(color => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-swatch" + (color.id === current ? " is-selected" : "");
    button.dataset.fishingColor = color.id;
    button.setAttribute("aria-pressed", color.id === current ? "true" : "false");
    button.setAttribute("aria-label", color.name);
    button.title = color.name;
    button.addEventListener("click", () => {
      saveFishingCardColor(color.id);
      applyFishingCardColor(color.id);
      [...fishingCardColorSwatches.children].forEach(el => {
        const selected = el === button;
        el.classList.toggle("is-selected", selected);
        el.setAttribute("aria-pressed", selected ? "true" : "false");
      });
    });
    fishingCardColorSwatches.appendChild(button);
  });
}

// ---- Settings page: show/hide raw factors ----
const fishingShowRawToggle = document.getElementById("fishingShowRawToggle");
if (fishingShowRawToggle) {
  fishingShowRawToggle.checked = loadFishingShowRaw();
  fishingShowRawToggle.addEventListener("change", () => {
    saveFishingShowRaw(fishingShowRawToggle.checked);
  });
}

if (fishingRow) {
  fishingRow.addEventListener("click", () => openFishingSheet());
}

renderFishingRow();
