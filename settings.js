// Keep this list in sync with CONFIG.forecasters in app.js — duplicated
// here rather than shared, since this is a plain multi-page static site
// with no build step. Only id/name/enabled matter on this page.
const FORECASTERS = [
  { id: "metoffice", name: "Met Office", enabled: true },
  { id: "ecmwf", name: "ECMWF", enabled: true },
  { id: "gfs", name: "GFS (US)", enabled: true },
  { id: "icon", name: "ICON (Germany)", enabled: true },
  { id: "gem", name: "GEM (Canada)", enabled: true },
  { id: "meteofrance", name: "Météo-France", enabled: true },
  { id: "jma", name: "JMA (Japan)", enabled: true },
  { id: "bom", name: "BOM (Australia)", enabled: true },
  { id: "cma", name: "CMA (China)", enabled: true },
  { id: "bbc", name: "BBC", enabled: true },
  { id: "meteo", name: "Meteoblue", enabled: true },
  { id: "yr", name: "YR", enabled: true },
  { id: "accuweather", name: "AccuWeather", enabled: true },
  { id: "netweather", name: "Netweather", enabled: false },
  { id: "xcweather", name: "XCWeather", enabled: false },
  { id: "wunderground", name: "Weather Underground", enabled: false },
  { id: "weatherapi", name: "WeatherAPI", enabled: false },
  { id: "windy", name: "Windy", enabled: false },
  { id: "openweather", name: "OpenWeatherMap", enabled: false },
  { id: "tomorrow", name: "Tomorrow.io", enabled: false }
];

// HOUR_RANGE_KEY, SELECTED_FORECASTERS_KEY, CONDITION_UNIT_TOGGLES,
// CONDITION_UNIT_LABELS, DEFAULT_CONDITION_UNITS, loadConditionUnits(),
// saveConditionUnit(), loadHourRange(), THEMES, loadTheme(), saveTheme(),
// and applyTheme() all now come from app.js, which this page loads first
// — settings.html includes both scripts in the same global scope, so
// redeclaring the same names here would be a duplicate-const syntax
// error that silently breaks this entire file (which is exactly what was
// happening: nothing on this page was saving because the file never ran).

const hourRange48 = document.getElementById("hourRange48");
const hourRange24 = document.getElementById("hourRange24");
const currentHourRange = loadHourRange();
if (hourRange48 && hourRange24) {
  hourRange48.checked = String(currentHourRange) === "48";
  hourRange24.checked = String(currentHourRange) === "24";

  [hourRange48, hourRange24].forEach(input => {
    input.addEventListener("change", () => {
      try {
        localStorage.setItem(HOUR_RANGE_KEY, input.value);
      } catch {
        // display-only preference, fine if it doesn't persist
      }
    });
  });
}

// ---- Appearance: colour theme ----
// Swatches show each theme's OWN accent colour (via CSS, keyed off
// data-theme on the button itself — see style.css) regardless of which
// theme is currently active, so tapping one gives an honest before/after
// rather than every swatch looking like the current theme.
const themeSwatchesEl = document.getElementById("themeSwatches");
if (themeSwatchesEl) {
  const currentTheme = loadTheme();
  THEMES.forEach(theme => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-swatch" + (theme.id === currentTheme ? " is-selected" : "");
    button.dataset.theme = theme.id;
    button.setAttribute("aria-pressed", theme.id === currentTheme ? "true" : "false");
    // No visible label on the swatch itself (kept deliberately small) —
    // the colour is the point, so the name only needs to be available to
    // a screen reader or a hover tooltip, not printed on top of the tile.
    button.setAttribute("aria-label", theme.name);
    button.title = theme.name;

    button.addEventListener("click", () => {
      saveTheme(theme.id);
      applyTheme(theme.id);
      [...themeSwatchesEl.children].forEach(el => {
        const selected = el === button;
        el.classList.toggle("is-selected", selected);
        el.setAttribute("aria-pressed", selected ? "true" : "false");
      });
    });

    themeSwatchesEl.appendChild(button);
  });
}

// ---- Backup & restore ----
const exportButton = document.getElementById("exportButton");
const exportStatus = document.getElementById("exportStatus");
const exportOutput = document.getElementById("exportOutput");

function renderExportStatus(message, isError) {
  if (!exportStatus) return;
  exportStatus.textContent = message || "";
  exportStatus.classList.toggle("is-error", !!isError);
}

if (exportButton) {
  exportButton.addEventListener("click", async () => {
    const backup = exportAppData();
    try {
      await navigator.clipboard.writeText(backup);
      renderExportStatus("Copied to clipboard.", false);
      if (exportOutput) exportOutput.hidden = true;
    } catch {
      // Clipboard access can fail or be unavailable (older Safari,
      // permissions) — fall back to a plain selectable text box so the
      // backup is still reachable by hand, rather than a dead end.
      if (exportOutput) {
        exportOutput.hidden = false;
        exportOutput.value = backup;
        exportOutput.focus();
        exportOutput.select();
      }
      renderExportStatus("Couldn't copy automatically — select the text below and copy it manually.", true);
    }
  });
}

const importInput = document.getElementById("importInput");
const importButton = document.getElementById("importButton");
const importStatus = document.getElementById("importStatus");

function renderImportStatus(message, isError) {
  if (!importStatus) return;
  importStatus.textContent = message || "";
  importStatus.classList.toggle("is-error", !!isError);
}

if (importButton) {
  importButton.addEventListener("click", () => {
    const text = (importInput?.value || "").trim();
    if (!text) {
      renderImportStatus("Paste a backup first.", true);
      return;
    }
    // Genuinely destructive if the pasted backup is stale or from
    // somewhere else — a plain confirm is enough friction for a
    // one-off, user-initiated action like this.
    if (!confirm("This replaces this device's Cloude data (FFV history, places, settings) with the pasted backup. Continue?")) {
      return;
    }
    const result = importAppData(text);
    if (!result.ok) {
      renderImportStatus(result.error, true);
      return;
    }
    renderImportStatus(`Restored ${result.keyCount} item${result.keyCount === 1 ? "" : "s"} — reloading…`, false);
    setTimeout(() => location.reload(), 600);
  });
}

// ---- Per-condition units ----
// Each condition with a real unit gets its own compact Metric/Imperial
// toggle (see CONDITION_UNIT_TOGGLES in app.js for which conditions have
// one — Soil Temp and Dew Point deliberately don't, they follow
// Temperature's own setting instead, see conditionUnit() in app.js).
// Laid out as short rows in a 2-column grid rather than a full
// bordered fieldset per condition, so this doesn't turn into a long
// scroll as more conditions gain a unit choice.
const unitFieldsets = document.getElementById("conditionUnits");
if (unitFieldsets) {
  const units = loadConditionUnits();
  CONDITION_UNIT_TOGGLES.forEach(conditionName => {
    const conditionData = CONFIG.conditions[conditionName];
    const current = units[conditionName] || DEFAULT_CONDITION_UNITS[conditionName];

    const row = document.createElement("div");
    row.className = "unit-row";

    const name = document.createElement("span");
    name.className = "unit-row-name";
    name.textContent = conditionData.name;
    row.appendChild(name);

    const toggle = document.createElement("div");
    toggle.className = "unit-row-toggle";

    [
      { value: "metric", text: CONDITION_UNIT_LABELS[conditionName].metric },
      { value: "imperial", text: CONDITION_UNIT_LABELS[conditionName].imperial }
    ].forEach(opt => {
      const label = document.createElement("label");
      label.className = "unit-pill";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `unit-${conditionName}`;
      input.value = opt.value;
      input.checked = current === opt.value;
      input.addEventListener("change", () => {
        saveConditionUnit(conditionName, opt.value);
      });
      const text = document.createElement("span");
      text.textContent = opt.text;
      label.append(input, text);
      toggle.appendChild(label);
    });

    row.appendChild(toggle);
    unitFieldsets.appendChild(row);
  });
}

// ---- Front page cells ----
// HEADLINE_OPTIONAL_CONDITIONS, loadHeadlineToggles(), and
// saveHeadlineToggle() come from app.js. Rain/Temperature/Wind aren't
// listed here at all — they're not optional (see HEADLINE_CORE_CONDITIONS).
const headlineToggleList = document.getElementById("headlineToggles");
if (headlineToggleList) {
  const toggles = loadHeadlineToggles();
  HEADLINE_OPTIONAL_CONDITIONS.forEach(conditionName => {
    const conditionData = CONFIG.conditions[conditionName];
    const label = document.createElement("label");
    label.className = "check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!toggles[conditionName];
    input.addEventListener("change", () => {
      saveHeadlineToggle(conditionName, input.checked);
    });

    const text = document.createElement("span");
    text.textContent = conditionData.name;

    label.append(input, text);
    headlineToggleList.appendChild(label);
  });
}

function loadSelected() {
  try {
    const raw = localStorage.getItem(SELECTED_FORECASTERS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // fall through to default
  }
  return new Set(FORECASTERS.filter(f => f.enabled).map(f => f.id));
}

function saveSelected(selected) {
  try {
    localStorage.setItem(SELECTED_FORECASTERS_KEY, JSON.stringify([...selected]));
  } catch {
    // Storage unavailable — selection just won't persist between visits.
  }
}

const selected = loadSelected();
const forecasters = document.getElementById("forecasters");

FORECASTERS.forEach(source => {
  const label = document.createElement("label");
  label.className = "check";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = selected.has(source.id);

  input.addEventListener("change", () => {
    if (input.checked) {
      selected.add(source.id);
    } else {
      selected.delete(source.id);
    }
    saveSelected(selected);
  });

  const text = document.createElement("span");
  text.textContent = source.name;

  label.append(input, text);
  forecasters.appendChild(label);
});
