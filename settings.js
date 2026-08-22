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

const SELECTED_FORECASTERS_KEY = "forecast-compare:selectedForecasters";
const UNIT_SYSTEM_KEY = "forecast-compare:unitSystem";

function loadUnitSystem() {
  try {
    const raw = localStorage.getItem(UNIT_SYSTEM_KEY);
    if (raw === "metric" || raw === "imperial") return raw;
  } catch {
    // fall through to default
  }
  return "metric";
}

const HOUR_RANGE_KEY = "forecast-compare:hourRange";

function loadHourRange() {
  try {
    const raw = localStorage.getItem(HOUR_RANGE_KEY);
    if (raw === "24" || raw === "48") return raw;
  } catch {
    // fall through to default
  }
  return "48";
}

const hourRange48 = document.getElementById("hourRange48");
const hourRange24 = document.getElementById("hourRange24");
const currentHourRange = loadHourRange();
if (hourRange48 && hourRange24) {
  hourRange48.checked = currentHourRange === "48";
  hourRange24.checked = currentHourRange === "24";

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
const unitMetric = document.getElementById("unitMetric");
const unitImperial = document.getElementById("unitImperial");
const currentUnitSystem = loadUnitSystem();
if (unitMetric && unitImperial) {
  unitMetric.checked = currentUnitSystem === "metric";
  unitImperial.checked = currentUnitSystem === "imperial";

  [unitMetric, unitImperial].forEach(input => {
    input.addEventListener("change", () => {
      try {
        localStorage.setItem(UNIT_SYSTEM_KEY, input.value);
      } catch {
        // display-only preference, fine if it doesn't persist
      }
    });
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
