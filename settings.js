// Keep this list in sync with CONFIG.forecasters in app.js — duplicated
// here rather than shared, since this is a plain multi-page static site
// with no build step. Only id/name/enabled matter on this page.
const FORECASTERS = [
  { id: "metoffice", name: "Met Office", enabled: true },
  { id: "ecmwf", name: "ECMWF", enabled: true },
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
// saveConditionUnit(), and loadHourRange() all now come from app.js, which
// this page loads first — settings.html includes both scripts in the same
// global scope, so redeclaring the same names here would be a
// duplicate-const syntax error that silently breaks this entire file
// (which is exactly what was happening: nothing on this page was saving
// because the file never ran).

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

// ---- Per-condition units ----
// Each condition with a real unit gets its own Metric/Imperial radio pair
// (see CONDITION_UNIT_TOGGLES in app.js for which conditions have one) —
// replaces the old single global Metric/Imperial toggle, so Rain can stay
// in mm while Wind stays in mph, matching how people actually mix units
// day to day.
const unitFieldsets = document.getElementById("conditionUnits");
if (unitFieldsets) {
  const units = loadConditionUnits();
  CONDITION_UNIT_TOGGLES.forEach(conditionName => {
    const conditionData = CONFIG.conditions[conditionName];
    const current = units[conditionName] || DEFAULT_CONDITION_UNITS[conditionName];

    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = conditionData.name;
    fieldset.appendChild(legend);

    const row = document.createElement("div");
    row.className = "checks";

    [
      { value: "metric", text: CONDITION_UNIT_LABELS[conditionName].metric },
      { value: "imperial", text: CONDITION_UNIT_LABELS[conditionName].imperial }
    ].forEach(opt => {
      const label = document.createElement("label");
      label.className = "check";
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
      row.appendChild(label);
    });

    fieldset.appendChild(row);
    unitFieldsets.appendChild(fieldset);
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
