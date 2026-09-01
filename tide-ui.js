// Tide UI — DOM, rendering, and the swipe gesture for saved tide
// locations. Kept separate from tide.js's maths, the same split
// solar.js/solar-ui.js already use. Loaded after both app.js and
// tide.js on index.html, so it can call into either freely.

const tideRow = document.getElementById("tideRow");
const tideDots = document.getElementById("tideDots");

let tideRenderToken = 0; // bumped on every location switch so a
                          // slow-to-arrive backfill for a PREVIOUS
                          // location can't overwrite the current one's
                          // display — the exact "supersession" pattern
                          // resetForLocationChange already uses for the
                          // main weather fetch.

function currentTideLocation() {
  const locations = loadTideLocations();
  if (!locations.length) return null;
  const currentId = loadCurrentTideLocationId();
  return locations.find(l => l.id === currentId) || locations[0];
}

// Ties tide predictions to the SAME "Date" rollback slider the rest of
// the front page already uses (state.rollback: positive = days into the
// past, negative = days into the future — see targetDateForRollback in
// app.js). Unlike weather's forecasts, the tide fit is one continuous
// harmonic function of time with no separate past/future data source or
// 14-day eligibility gate, so "what's the reference moment" is the only
// thing that needs to move — everything downstream (which events are
// "next", the sheet's window) just recentres on it.
function tideReferenceNow() {
  const rollbackDays = (typeof state !== "undefined" && state.rollback) ? state.rollback : 0;
  return Date.now() - rollbackDays * 86400000;
}

// A short qualifier appended to the tide row/sheet titles whenever the
// Date slider isn't on "today" — without it, tides for a rolled-back
// date would look identical to today's and be easy to misread as live.
function tideDateQualifier() {
  const rollbackDays = (typeof state !== "undefined" && state.rollback) ? state.rollback : 0;
  if (!rollbackDays) return "";
  return ` · ${formatDateLong(targetDateForRollback(rollbackDays))}`;
}

// Applies a location's learned Admiralty correction (if any) to a single
// hours/OD-level pair. Falls back to the plain (TFV-corrected, OD/mAOD)
// value when there's no secondary offset for this location — which is
// every location until it's been checked against Admiralty at least
// once. Centralised here so the row and the sheet apply it identically.
function applyLocationCorrection(location, fit, hours, odLevel) {
  const secondary = location.discoveryStation ? loadSecondaryOffset(location.discoveryStation.id) : null;
  if (secondary) {
    const result = applySecondaryOffset(fit, hours, odLevel, location.station, secondary);
    if (result) return { hours: result.hours, level: result.levelCD, isCD: true };
  }
  return { hours, level: odLevel, isCD: false };
}

async function renderTideRow() {
  if (!tideRow) return;
  const toggles = loadHeadlineToggles();
  if (!toggles.tide) {
    tideRow.hidden = true;
    return;
  }

  const location = currentTideLocation();
  if (!location) {
    tideRow.hidden = true;
    return;
  }
  tideRow.hidden = false;

  const myToken = ++tideRenderToken;
  const labelHtml = `TIDE — ${location.label}${tideDateQualifier()}`;
  tideRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><span class="tide-row-value">Loading…</span>`;

  let built;
  try {
    built = await getOrBuildTideFit(location.station);
  } catch {
    built = null;
  }
  if (myToken !== tideRenderToken) return; // superseded by a later switch

  if (!built) {
    tideRow.innerHTML = `<span class="tide-row-label">${labelHtml}</span><span class="tide-row-value">Not available right now</span>`;
    return;
  }

  const fudge = loadTideFudge(location.station.id);
  const nowHours = (tideReferenceNow() - Date.parse(built.epochIso)) / 3600000;
  const rawEvents = findTideExtremes(built.fit, nowHours - 1, nowHours + 30);
  const corrected = rawEvents
    .map(e => {
      const odLevel = applyTideFudge(e.level, fudge);
      const result = applyLocationCorrection(location, built.fit, e.hours, odLevel);
      return { type: e.type, hours: result.hours, level: result.level, isCD: result.isCD };
    })
    .sort((a, b) => a.hours - b.hours)
    .filter(e => e.hours >= nowHours)
    .slice(0, 2);

  const isCorrected = corrected.some(e => e.isCD);
  const finalLabelHtml = `TIDE — ${location.label}${tideDateQualifier()}${isCorrected ? " · Admiralty-corrected" : ""}`;

  const partsHtml = corrected.map(e => {
    const when = new Date(Date.parse(built.epochIso) + e.hours * 3600000);
    const timeStr = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `<span class="tide-event"><span class="tide-event-type">${e.type === "high" ? "H" : "L"}</span>${timeStr} <small>${e.level.toFixed(1)}m</small></span>`;
  }).join("");

  tideRow.innerHTML = `<span class="tide-row-label">${finalLabelHtml}</span><div class="tide-row-events">${partsHtml}</div>`;
  renderTideDots();
}

function renderTideDots() {
  if (!tideDots) return;
  tideDots.innerHTML = "";
  const locations = loadTideLocations();
  if (locations.length < 2) return;
  const currentId = loadCurrentTideLocationId();
  locations.forEach(loc => {
    const icon = document.createElement("img");
    icon.src = "icon-192.png";
    icon.alt = "";
    icon.className = "place-dot" + (loc.id === currentId ? " is-current" : "");
    tideDots.appendChild(icon);
  });
}

function switchToAdjacentTideLocation(direction) {  const locations = loadTideLocations();
  if (locations.length < 2) return;
  const currentId = loadCurrentTideLocationId();
  const currentIndex = locations.findIndex(l => l.id === currentId);
  if (currentIndex === -1) return;
  const nextIndex = (currentIndex + direction + locations.length) % locations.length;
  saveCurrentTideLocationId(locations[nextIndex].id);
  renderTideRow();
}

// ---- Swipe gesture ----
// A deliberately separate pointer-tracking zone from the weather
// headline's own swipe (see swipeToAdjacentPlace in app.js) — tide
// locations are an independent list, so this needs its own
// start/direction/pointerId state rather than sharing the weather
// swipe's variables, but otherwise mirrors that implementation exactly
// (including the pointer-capture and per-finger tracking fixes that
// swipe needed this session — no reason for this one to start without
// them and rediscover the same bugs later).
if (tideRow) {
  const SWIPE_THRESHOLD_PX = 32;
  const CANCEL_TAP_TOLERANCE_PX = 10;
  let startX = null, startY = null, lastX = null, lastY = null, swiping = false, direction = null, pointerId = null;

  function reset() {
    startX = null; startY = null; lastX = null; lastY = null;
    swiping = false; direction = null; pointerId = null;
  }

  tideRow.addEventListener("pointerdown", e => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    swiping = false;
    direction = null;
    try {
      tideRow.setPointerCapture(e.pointerId);
    } catch {
      // still works via normal event delivery without capture
    }
  });

  tideRow.addEventListener("pointermove", e => {
    if (startX === null || e.pointerId !== pointerId) return;
    lastX = e.clientX;
    lastY = e.clientY;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!swiping && Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiping = true;
      direction = dx < 0 ? 1 : -1;
    }
  });

  tideRow.addEventListener("pointerup", e => {
    if (startX === null || e.pointerId !== pointerId) return;
    if (swiping && direction !== null) {
      switchToAdjacentTideLocation(direction);
    } else {
      openTideSheet();
    }
    reset();
  });

  tideRow.addEventListener("pointercancel", e => {
    if (e.pointerId !== pointerId) return;
    // The browser can cancel a touch the moment it decides to start its
    // own native scroll (touch-action: pan-y grants it that right on any
    // vertical movement) — including a real tap's few pixels of
    // incidental jitter. If we never crossed the swipe threshold and
    // barely moved at all, this was meant as a tap, so honour it as one
    // rather than silently dropping it.
    if (!swiping && startX !== null && lastX !== null) {
      const dx = lastX - startX;
      const dy = lastY - startY;
      if (Math.abs(dx) <= CANCEL_TAP_TOLERANCE_PX && Math.abs(dy) <= CANCEL_TAP_TOLERANCE_PX) {
        openTideSheet();
      }
    }
    reset();
  });
}

// ---- Tap-to-open sheet: continuous curve with peak/trough labels ----
// Reuses the SAME sheet DOM/backdrop/close mechanism as the hourly
// weather graphs (see openHourlySheet/closeHourlySheet in app.js) —
// simplest, most consistent option, and closeHourlySheet is already
// generic enough to close this one too. The rendering itself is
// separate (openHourlySheet's chain is built entirely around
// state.hourly, which tide doesn't use at all), so this doesn't touch
// that function.
const TIDE_SHEET_WINDOW_PAST_HOURS = 24;
const TIDE_SHEET_WINDOW_FUTURE_HOURS = 72;

let openTideSheetToken = 0;

async function openTideSheet() {
  if (!sheet) return;
  const location = currentTideLocation();
  if (!location) return;
  const myToken = ++openTideSheetToken;

  sheetTitle.textContent = `Tide — ${location.label}`;
  sheetRange.textContent = tideDateQualifier().replace(/^ · /, "");
  sheetReadout.hidden = false;
  readoutValue.classList.remove("is-compact");
  sheetBody.innerHTML = "";
  sheetFootnote.textContent = "";

  sheet.hidden = false;
  requestAnimationFrame(() => {
    sheetBackdrop.classList.add("is-open");
    sheet.classList.add("is-open");
  });

  const loading = document.createElement("p");
  loading.className = "sheet-empty";
  loading.textContent = "Loading tide data…";
  sheetBody.appendChild(loading);

  let built;
  try {
    built = await getOrBuildTideFit(location.station);
  } catch {
    built = null;
  }
  if (myToken !== openTideSheetToken) return; // superseded by a later open
  sheetBody.innerHTML = "";
  if (!built) {
    const empty = document.createElement("p");
    empty.className = "sheet-empty";
    empty.textContent = "Tide data isn't available right now.";
    sheetBody.appendChild(empty);
    return;
  }

  const fudge = loadTideFudge(location.station.id);
  const nowHours = (tideReferenceNow() - Date.parse(built.epochIso)) / 3600000;
  const startHours = nowHours - TIDE_SHEET_WINDOW_PAST_HOURS;
  const endHours = nowHours + TIDE_SHEET_WINDOW_FUTURE_HOURS;

  sheetBody.appendChild(renderTideCurve(built.fit, fudge, built.epochIso, startHours, endHours, nowHours, location));

  const hasSecondaryOffset = location.discoveryStation && loadSecondaryOffset(location.discoveryStation.id);
  sheetFootnote.textContent = hasSecondaryOffset
    ? `The marked highs/lows are corrected for this exact location using its own learned Admiralty offset, in Chart Datum. The curve's shape still follows ${location.station.label}'s own model.`
    : "";
}

// Pixels of horizontal room per hour of tide data. At the old fixed
// 340-unit width stretched to fit the screen, ~96 hours of data packed
// consecutive highs/lows roughly 35-40px apart — nowhere near enough
// room for a value label plus a time label under each one, which is
// what caused the overlapping mess. This constant instead drives a
// genuinely wider SVG (see width calculation below) that the wrapper
// scrolls to, rather than squashing everything into one screen's width.
const TIDE_GRAPH_PX_PER_HOUR = 10;

function renderTideCurve(fit, fudge, epochIso, startHours, endHours, nowHours, location) {
  const totalHours = endHours - startHours;
  const padL = 44, padR = 16, padT = 50, padB = 46;
  // Never narrower than a phone screen even for a short window — only
  // grows wider (and scrolls) once there's enough data to need it.
  const plotW = Math.max(280, totalHours * TIDE_GRAPH_PX_PER_HOUR);
  const plotH = 148;
  const width = plotW + padL + padR;
  const height = plotH + padT + padB;

  const stepHours = totalHours / 200;
  const rawPts = [];
  for (let h = startHours; h <= endHours; h += stepHours) {
    rawPts.push({ hours: h, level: predictTideLevel(fit, h) });
  }
  const correctedPts = rawPts.map(p => ({ hours: p.hours, level: applyTideFudge(p.level, fudge) }));

  const allLevels = correctedPts.map(p => p.level).concat(rawPts.map(p => p.level));
  const minLevel = Math.min(...allLevels), maxLevel = Math.max(...allLevels);
  const levelRange = Math.max(0.5, maxLevel - minLevel);

  const xFor = h => padL + ((h - startHours) / totalHours) * plotW;
  const yFor = level => padT + plotH - ((level - minLevel) / levelRange) * plotH;

  // Explicit pixel width/height (not just viewBox) so the SVG renders at
  // its true intrinsic size inside the scrolling wrapper below, instead
  // of being stretched down to the container's width like the other
  // (single-screen) sheet graphs deliberately are.
  const svg = sheetSvgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    class: "graph-svg tide-graph-svg"
  });

  [0, 0.5, 1].forEach(frac => {
    const y = padT + plotH * (1 - frac);
    svg.appendChild(sheetSvgEl("line", { x1: padL, x2: width - padR, y1: y, y2: y, class: "graph-gridline" }));
    const label = svg.appendChild(sheetSvgEl("text", { x: padL - 6, y: y + 3, class: "graph-axis-value", "text-anchor": "end" }));
    label.textContent = (minLevel + levelRange * frac).toFixed(1);
  });

  // Day boundaries as dashed vertical gridlines with the date at the
  // TOP of the chart — kept well away from the tide-event labels below,
  // which already occupy the bottom band (troughs) and just above the
  // curve (peaks). Putting both sets of labels at the bottom was the
  // other half of the original overlap.
  let lastDay = null;
  for (let h = startHours; h <= endHours; h += 1) {
    const when = new Date(Date.parse(epochIso) + h * 3600000);
    const dayKey = when.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const x = xFor(h);
      svg.appendChild(sheetSvgEl("line", { x1: x, x2: x, y1: padT, y2: padT + plotH, class: "graph-gridline", "stroke-dasharray": "2 3" }));
      const label = svg.appendChild(sheetSvgEl("text", { x: x + 4, y: 14, class: "graph-axis-label", "text-anchor": "start" }));
      label.textContent = when.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
    }
  }

  const nowX = xFor(nowHours);
  svg.appendChild(sheetSvgEl("line", { x1: nowX, x2: nowX, y1: padT, y2: padT + plotH, class: "graph-gridline", "stroke-dasharray": "3 3" }));

  const rawPath = "M" + rawPts.map(p => `${xFor(p.hours)},${yFor(p.level)}`).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: rawPath, fill: "none", stroke: "#5b6b7a", "stroke-width": 1.5, opacity: 0.4 }));

  const correctedPath = "M" + correctedPts.map(p => `${xFor(p.hours)},${yFor(p.level)}`).join(" L");
  svg.appendChild(sheetSvgEl("path", { d: correctedPath, fill: "none", stroke: "#2b7a78", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  const events = findTideExtremes(fit, startHours, endHours);
  events.forEach(e => {
    const odLevel = applyTideFudge(e.level, fudge);
    const result = location ? applyLocationCorrection(location, fit, e.hours, odLevel) : null;
    const eventHours = result ? result.hours : e.hours;
    const level = result ? result.level : odLevel;
    const x = xFor(eventHours);
    const y = yFor(level);
    svg.appendChild(sheetSvgEl("circle", { cx: x, cy: y, r: 3.5, fill: "#2b7a78" }));
    const labelY = e.type === "high" ? y - 12 : y + 18;
    const label = svg.appendChild(sheetSvgEl("text", {
      x, y: labelY, class: "graph-axis-value", "text-anchor": "middle"
    }));
    label.textContent = `${level.toFixed(1)}m`;
    const when = new Date(Date.parse(epochIso) + eventHours * 3600000);
    const timeLabel = svg.appendChild(sheetSvgEl("text", {
      x, y: labelY + (e.type === "high" ? -14 : 15), class: "graph-axis-label", "text-anchor": "middle"
    }));
    timeLabel.textContent = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  });

  // ---- Tap anywhere on the curve to read off the predicted height at
  // that exact moment — the harmonic fit is a continuous function of
  // time, so a point between a high and a low is just as genuinely
  // predicted as the marked extremes themselves, this just gives a way
  // to read one off. A tap (click), not a pointermove drag: the chart is
  // already a native horizontal-scroll area (see .tide-graph-wrap), and
  // a drag-based scrubber would fight that same gesture. A tap never
  // fires from a scroll drag, so the two coexist without conflict.
  const touchArea = sheetSvgEl("rect", { x: 0, y: 0, width, height, class: "tide-touch-area" });
  svg.appendChild(touchArea);

  const crosshair = sheetSvgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + plotH, class: "scrub-line" });
  const dot = sheetSvgEl("circle", { r: 4.5, class: "scrub-dot" });
  svg.appendChild(crosshair);
  svg.appendChild(dot);

  function showReadoutAt(hours) {
    const clamped = Math.max(startHours, Math.min(endHours, hours));
    const level = applyTideFudge(predictTideLevel(fit, clamped), fudge);
    const x = xFor(clamped);
    const y = yFor(level);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    const when = new Date(Date.parse(epochIso) + clamped * 3600000);
    readoutTime.textContent = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    readoutValue.textContent = `${level.toFixed(2)}m`;
  }

  touchArea.addEventListener("click", e => {
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (localX - padL) / plotW;
    showReadoutAt(startHours + ratio * totalHours);
  });

  // Defaults to "now" (or the rolled-back reference moment) so the
  // readout bar always shows something sensible before the first tap.
  showReadoutAt(nowHours);

  const wrap = document.createElement("div");
  wrap.className = "graph-wrap tide-graph-wrap";
  wrap.appendChild(svg);
  return wrap;
}

// ---- Settings page: Admiralty Discovery API key + proxy URL ----
const discoveryApiKeyInput = document.getElementById("discoveryApiKeyInput");
const discoveryProxyUrlInput = document.getElementById("discoveryProxyUrlInput");
const saveDiscoveryKeyButton = document.getElementById("saveDiscoveryKeyButton");
const discoveryKeyStatus = document.getElementById("discoveryKeyStatus");

function setDiscoveryKeyStatus(message, isError) {
  if (!discoveryKeyStatus) return;
  discoveryKeyStatus.textContent = message || "";
  discoveryKeyStatus.classList.toggle("is-error", !!isError);
}

if (discoveryApiKeyInput) {
  const existing = loadDiscoveryKey();
  if (existing) discoveryApiKeyInput.value = existing;
}
if (discoveryProxyUrlInput) {
  const existingProxy = loadDiscoveryProxyUrl();
  if (existingProxy) discoveryProxyUrlInput.value = existingProxy;
}

if (saveDiscoveryKeyButton) {
  saveDiscoveryKeyButton.addEventListener("click", () => {
    const key = (discoveryApiKeyInput?.value || "").trim();
    const proxyUrl = (discoveryProxyUrlInput?.value || "").trim();
    saveDiscoveryKey(key);
    saveDiscoveryProxyUrl(proxyUrl);
    if (!key) {
      setDiscoveryKeyStatus("Removed — locations will use their nearest gauge unmodified.", false);
    } else if (!proxyUrl) {
      setDiscoveryKeyStatus("Key saved, but a proxy URL is needed too — Admiralty can't be called directly from a browser (see the note above).", true);
    } else {
      setDiscoveryKeyStatus("Saved.", false);
    }
    renderTideLocationsList(); // re-render so each location's Admiralty row reflects the new key/proxy
  });
}

// Builds the "Admiralty accuracy" sub-row for one saved location: the
// learned offset if there is one, or a plain explanation of why
// checking isn't available yet, plus the check/re-check button itself.
// A fresh function per render (not cached) since it needs to reflect
// whatever the current key and this location's own state are right now.
function renderAdmiraltyRow(loc, allLocations) {
  const wrap = document.createElement("div");
  wrap.className = "place-row-admiralty";

  const summary = document.createElement("small");
  summary.className = "place-row-sub";
  wrap.appendChild(summary);

  const apiKey = loadDiscoveryKey();
  const hasCdOffset = typeof loc.station.cdOffsetOD === "number";

  function renderSummary() {
    if (!apiKey) {
      summary.textContent = "Admiralty: add a free API key above to check this location's real accuracy.";
      return;
    }
    if (!hasCdOffset) {
      summary.textContent = "Admiralty: not available — this location's nearest gauge has no confirmed Chart Datum reference yet.";
      return;
    }
    const offset = loc.discoveryStation ? loadSecondaryOffset(loc.discoveryStation.id) : null;
    if (!offset) {
      summary.textContent = "Admiralty: not checked yet.";
      return;
    }
    const parts = [];
    if (offset.highTimeMin !== null) {
      const sign = offset.highTimeMin >= 0 ? "+" : "";
      parts.push(`high ${sign}${Math.round(offset.highTimeMin)}min / ${offset.highHeightM >= 0 ? "+" : ""}${offset.highHeightM.toFixed(1)}m`);
    }
    if (offset.lowTimeMin !== null) {
      const sign = offset.lowTimeMin >= 0 ? "+" : "";
      parts.push(`low ${sign}${Math.round(offset.lowTimeMin)}min / ${offset.lowHeightM >= 0 ? "+" : ""}${offset.lowHeightM.toFixed(1)}m`);
    }
    summary.textContent = `Admiralty: learned ${parts.join(", ")} vs ${loc.station.label} (${offset.sampleCount} events, ${formatDateLong(new Date(offset.learnedAt))}).`;
  }
  renderSummary();

  if (apiKey && hasCdOffset) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-row-admiralty-check";
    button.textContent = loc.discoveryStation ? "Re-check against Admiralty" : "Check against Admiralty";
    const status = document.createElement("small");
    status.className = "place-row-sub place-row-admiralty-status";

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Checking…";
      try {
        let discoveryStation = loc.discoveryStation;
        if (!discoveryStation) {
          discoveryStation = await nearestDiscoveryStation(loc.station.lat, loc.station.lon, apiKey);
          if (!discoveryStation) throw new Error("No Admiralty station found nearby.");
          loc.discoveryStation = { id: discoveryStation.id, name: discoveryStation.name, distanceKm: discoveryStation.distanceKm };
          saveTideLocations(allLocations);
        }
        const built = await getOrBuildTideFit(loc.station);
        if (!built) throw new Error("This location's own tide model isn't ready yet — try again shortly.");
        await learnSecondaryOffset({
          eaStation: loc.station,
          discoveryStationId: discoveryStation.id,
          apiKey,
          fit: built.fit,
          epochIso: built.epochIso
        });
        status.textContent = "";
        renderSummary();
        renderTideRow(); // reflect the new correction immediately if this is the current location
      } catch (err) {
        status.textContent = err.message || "Couldn't check against Admiralty right now.";
      } finally {
        button.disabled = false;
      }
    });

    wrap.appendChild(button);
    wrap.appendChild(status);
  }

  return wrap;
}

// ---- Settings page: manage saved tide locations ----
const tideLocationsList = document.getElementById("tideLocationsList");
const tideLocationInput = document.getElementById("tideLocationInput");
const addTideLocationButton = document.getElementById("addTideLocationButton");
const tideLocationStatus = document.getElementById("tideLocationStatus");

function setTideLocationStatus(message, isError) {
  if (!tideLocationStatus) return;
  tideLocationStatus.textContent = message || "";
  tideLocationStatus.classList.toggle("is-error", !!isError);
}

function renderTideLocationsList() {
  if (!tideLocationsList) return;
  tideLocationsList.innerHTML = "";
  const locations = loadTideLocations();
  const currentId = loadCurrentTideLocationId();

  if (!locations.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No saved tide locations yet — add one below.";
    tideLocationsList.appendChild(empty);
    return;
  }

  locations.forEach(loc => {
    const row = document.createElement("div");
    row.className = "place-row" + (loc.id === currentId ? " is-current" : "");

    const info = document.createElement("div");
    info.className = "place-row-info";

    const nameLine = document.createElement("div");
    nameLine.className = "place-row-name-line";

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "place-row-label";
    labelInput.value = loc.label;
    labelInput.maxLength = 24;
    labelInput.setAttribute("aria-label", `Name for ${loc.label}`);
    labelInput.addEventListener("change", () => {
      loc.label = labelInput.value.trim() || loc.station.label;
      labelInput.value = loc.label;
      saveTideLocations(locations);
    });
    nameLine.appendChild(labelInput);

    const stationSub = document.createElement("small");
    stationSub.className = "place-row-sub";
    stationSub.textContent = `nearest gauge: ${loc.station.label} (${loc.station.distanceKm.toFixed(0)}km)`;

    info.appendChild(nameLine);
    info.appendChild(stationSub);
    info.appendChild(renderAdmiraltyRow(loc, locations));
    row.appendChild(info);

    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "place-row-switch";
    switchBtn.textContent = loc.id === currentId ? "Current" : "Switch";
    switchBtn.disabled = loc.id === currentId;
    switchBtn.addEventListener("click", () => {
      saveCurrentTideLocationId(loc.id);
      renderTideLocationsList();
    });
    row.appendChild(switchBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "place-row-remove";
    removeBtn.setAttribute("aria-label", `Remove ${loc.label}`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      saveTideLocations(loadTideLocations().filter(saved => saved.id !== loc.id));
      if (currentId === loc.id) {
        const remaining = loadTideLocations();
        saveCurrentTideLocationId(remaining.length ? remaining[0].id : null);
      }
      renderTideLocationsList();
    });
    row.appendChild(removeBtn);

    tideLocationsList.appendChild(row);
  });
}

if (addTideLocationButton) {
  addTideLocationButton.addEventListener("click", async () => {
    const input = (tideLocationInput?.value || "").trim();
    if (!input) {
      setTideLocationStatus("Enter a postcode or place name first.", true);
      return;
    }
    setTideLocationStatus("Looking up location…", false);
    try {
      const resolved = await resolveLocation(input);
      const station = nearestTideStation(resolved.lat, resolved.lon);
      const locations = loadTideLocations();
      const newLocation = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: resolved.label || input,
        station
      };
      locations.push(newLocation);
      saveTideLocations(locations);
      if (!loadCurrentTideLocationId()) saveCurrentTideLocationId(newLocation.id);
      if (tideLocationInput) tideLocationInput.value = "";
      setTideLocationStatus(`Added — nearest tide gauge is ${station.label}, ${station.distanceKm.toFixed(0)}km away.`, false);
      renderTideLocationsList();
    } catch (err) {
      if (err && err.name === "AmbiguousLocationError") {
        setTideLocationStatus(`That place name matches more than one UK location — try adding a county.`, true);
      } else {
        setTideLocationStatus(err.message || "Couldn't look up that location.", true);
      }
    }
  });
}

if (tideLocationsList) renderTideLocationsList();

// renderHeadline() (app.js) already calls renderTideRow() at its end,
// but it has early-return paths for weather data that's still mid-fetch
// — which would silently delay tide's own update on a slider drag until
// whatever weather refresh happens to be running finishes. Tide has no
// such loading state of its own to wait on, so it gets this direct,
// unconditional hook instead of depending on weather's render path.
if (rollback) {
  rollback.addEventListener("input", () => {
    renderTideRow();
  });
}
