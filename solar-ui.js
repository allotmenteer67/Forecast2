// Page wiring for solar.html — form handling and rendering. Kept
// separate from solar.js's calculation pipeline so the maths can be
// followed (and sanity-checked, or reused elsewhere) without wading
// through DOM code, the same separation of concerns app.js/settings.js
// already use elsewhere in this project.

const form = document.getElementById("solarForm");
const locationInput = document.getElementById("solarLocation");
const modeHistorical = document.getElementById("modeHistorical");
const modeForecast = document.getElementById("modeForecast");
const consumptionModeSimple = document.getElementById("consumptionModeSimple");
const consumptionModeCsv = document.getElementById("consumptionModeCsv");
const simpleConsumptionFields = document.getElementById("simpleConsumptionFields");
const csvConsumptionFields = document.getElementById("csvConsumptionFields");
const resultsPanel = document.getElementById("solarResults");
const statusEl = document.getElementById("solarStatus");

function field(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function numField(id, fallback = 0) {
  const v = parseFloat(field(id));
  return Number.isFinite(v) ? v : fallback;
}

[consumptionModeSimple, consumptionModeCsv].forEach(input => {
  if (!input) return;
  input.addEventListener("change", () => {
    const simple = consumptionModeSimple.checked;
    if (simpleConsumptionFields) simpleConsumptionFields.hidden = !simple;
    if (csvConsumptionFields) csvConsumptionFields.hidden = simple;
  });
});

function setStatus(message, isError) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("is-error", !!isError);
}

// ---- Small bar chart, built the same way the rest of the app builds
// its SVG graphs (see sheetSvgEl in app.js) but with its own layout —
// the existing sheet charts are built specifically around an
// hourly time axis, which doesn't fit a 12-bar monthly or 7-bar daily
// breakdown.
function renderBarChart(container, labels, values, options = {}) {
  container.innerHTML = "";
  const width = 320, height = 150, padL = 34, padB = 22, padT = 10;
  const svg = sheetSvgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "graph-svg" });
  const maxValue = Math.max(0.001, ...values);
  const plotW = width - padL - 10;
  const plotH = height - padT - padB;
  const barW = (plotW / labels.length) * 0.62;

  // Gridlines + axis labels, same visual language as the hourly sheet.
  [0, 0.5, 1].forEach(frac => {
    const y = padT + plotH * (1 - frac);
    svg.appendChild(sheetSvgEl("line", { x1: padL, x2: width - 6, y1: y, y2: y, class: "graph-gridline" }));
    svg.appendChild(sheetSvgEl("text", { x: padL - 6, y: y + 3, class: "graph-axis-value", "text-anchor": "end" })).textContent = Math.round(maxValue * frac);
  });

  values.forEach((v, i) => {
    const x = padL + (plotW / labels.length) * i + (plotW / labels.length - barW) / 2;
    const barH = (v / maxValue) * plotH;
    const y = height - padB - barH;
    svg.appendChild(sheetSvgEl("rect", { x, y, width: barW, height: Math.max(1, barH), rx: 2, fill: options.color || "#c9a227" }));
    const label = svg.appendChild(sheetSvgEl("text", { x: x + barW / 2, y: height - padB + 14, class: "graph-axis-label", "text-anchor": "middle" }));
    label.textContent = labels[i];
  });

  container.appendChild(svg);
}

function renderResults({ generation, financials, locationLabel, mode }) {
  resultsPanel.hidden = false;
  resultsPanel.innerHTML = "";

  if (generation.usedFallback) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Note: tilted irradiance wasn't available for this location/date range, so this estimate falls back to flat ground-level radiation with no tilt or orientation adjustment — treat it as rougher than usual.";
    resultsPanel.appendChild(note);
  }

  const heading = document.createElement("h3");
  heading.textContent = mode === "historical"
    ? `What you'd have generated last year at ${locationLabel}`
    : `Next 7 days at ${locationLabel}`;
  resultsPanel.appendChild(heading);

  const totalP = document.createElement("p");
  totalP.className = "target-date";
  totalP.textContent = `Total generation: ${formatKwh(generation.annualKwh ?? generation.dailyKwh.reduce((a, b) => a + b, 0))}`;
  resultsPanel.appendChild(totalP);

  const chartWrap = document.createElement("div");
  chartWrap.className = "graph-wrap";
  resultsPanel.appendChild(chartWrap);

  if (mode === "historical") {
    renderBarChart(chartWrap, MONTH_NAMES, generation.monthlyKwh, { color: "#c9a227" });
  } else {
    const shortLabels = generation.dailyLabels.map(d => new Date(d).toLocaleDateString(undefined, { weekday: "short" }));
    renderBarChart(chartWrap, shortLabels, generation.dailyKwh, { color: "#c9a227" });
  }

  if (financials) {
    const finHeading = document.createElement("h3");
    finHeading.textContent = "What that means for your bill";
    resultsPanel.appendChild(finHeading);

    const list = document.createElement("ul");
    list.innerHTML = `
      <li>Self-used: ${formatKwh(financials.selfConsumed)}</li>
      <li>Exported: ${formatKwh(financials.exported)}</li>
      <li>Imported (shortfall): ${formatKwh(financials.imported)}</li>
      <li>Cost with solar: ${formatMoney(financials.costWithSolar)}</li>
      <li>Cost without solar: ${formatMoney(financials.costWithoutSolar)}</li>
      <li><strong>Estimated saving: ${formatMoney(financials.savings)}</strong></li>
    `;
    resultsPanel.appendChild(list);
  }
}

if (form) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    setStatus("Looking up location…", false);
    resultsPanel.hidden = true;

    try {
      const location = await resolveLocation(locationInput.value);

      const tilt = numField("solarTilt", 30);
      const orientation = field("solarOrientation") || "S";
      const azimuth = AZIMUTH_FOR_COMPASS[orientation] ?? 0;
      const systemKw = numField("solarSystemKw", 4);
      const systemLossPct = numField("solarSystemLoss", 14);
      const tempCoeffPctPerC = numField("solarTempCoeff", -0.4);
      const degradationPctPerYear = numField("solarDegradation", 0.5);
      const systemAgeYears = numField("solarSystemAge", 0);

      const seasonShading = {};
      ["winter", "spring", "summer", "autumn"].forEach(season => {
        seasonShading[season] = {
          shadePct: numField(`shade_${season}_pct`, 0),
          hoursPerDay: numField(`shade_${season}_hours`, 0)
        };
      });

      const mode = modeForecast && modeForecast.checked ? "forecast" : "historical";

      setStatus(mode === "historical" ? "Fetching last year's real irradiance data…" : "Fetching the 7-day forecast…", false);
      const series = mode === "historical"
        ? await fetchHistoricalSeries(location.lat, location.lon, tilt, azimuth)
        : await fetchForecastSeries(location.lat, location.lon, tilt, azimuth);

      const generation = computeGeneration(series, systemKw, {
        tempCoeffPctPerC, systemLossPct, seasonShading, degradationPctPerYear, systemAgeYears
      });

      let financials = null;
      const wantsFinancials = numField("solarBuyPrice", 0) > 0 || numField("solarSellPrice", 0) > 0;
      if (wantsFinancials) {
        const buyPrice = numField("solarBuyPrice", 0);
        const sellPrice = numField("solarSellPrice", 0);
        let hourlyCons;
        if (consumptionModeCsv && consumptionModeCsv.checked) {
          const csvText = field("solarConsumptionCsv");
          const { hourly, parsedRows } = parseConsumptionCsv(csvText);
          if (parsedRows === 0) {
            setStatus("Couldn't read any rows from that consumption data — check it has a timestamp and a kWh figure per row.", true);
            return;
          }
          const { aligned, matched, total } = alignConsumptionToGeneration(generation.times, hourly);
          hourlyCons = aligned;
          if (matched < total * 0.5) {
            setStatus(`Only matched ${matched} of ${total} hours against your consumption data — check it covers the same period (last calendar year for a historical lookup). Showing the estimate anyway.`, true);
          }
        } else {
          const annualKwh = numField("solarAnnualConsumption", 3000);
          const daytimePct = numField("solarDaytimePct", 35);
          hourlyCons = syntheticConsumptionProfile(generation.times, annualKwh, daytimePct);
        }
        financials = computeFinancials(generation.hourlyKwh, hourlyCons, buyPrice, sellPrice);
      }

      setStatus("", false);
      renderResults({ generation, financials, locationLabel: location.label, mode });
    } catch (err) {
      if (err && err.name === "AmbiguousLocationError") {
        setStatus(`That place name matches more than one UK location — try adding a county, e.g. "${locationInput.value}, Somerset".`, true);
      } else {
        setStatus(err.message || "Something went wrong fetching weather data.", true);
      }
    }
  });
}
