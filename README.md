# Forecast Compare

A simple browser-based weather forecast comparison tool designed for GitHub Pages.

## No Swift

This project uses only:

- HTML
- CSS
- JavaScript
- JSON configuration

It does not require Xcode, Swift or Swift Playgrounds.

## Current build

The interface provides:

- postcode/location field
- 12 selectable forecasters (Met Office, BBC, Meteoblue, YR, AccuWeather,
  Netweather, XCWeather, Weather Underground, WeatherAPI, Windy,
  OpenWeatherMap, Tomorrow.io) — still demo data per source
- Rain / Cloud / Wind / Temperature / Sunshine / UV
- rollback slider that picks a **target date** (today back to 6 days ago)
- day-out rows (7 → 1) showing how each forecaster's prediction trended
  as the target date approached
- a live **Actual** row at the bottom of the table, fetched from Open-Meteo
  for the selected target date — no API key required
- a small delta badge on the "1 day out" row showing how far the final
  forecast was from what actually happened, once Actual is known
- responsive iPhone/iPad layout, styled to sit comfortably alongside My Plot

## Actual weather data

Actual weather comes from two free, keyless APIs:

- `api.postcodes.io` — turns a UK postcode into latitude/longitude
- `api.open-meteo.com/v1/forecast` (with `past_days`) — recent recorded
  daily weather for that location

Both run entirely client-side; no server or key is needed for GitHub Pages
hosting. Today's "Actual" figure is a running total and will read
"still recording" until the day is over.

Forecaster figures (Met Office, BBC, etc.) are still demo/placeholder data —
those providers don't offer free public APIs for past forecast runs, so
wiring in real per-source data (or an equivalent like Open-Meteo's
Previous Runs API) is a future step.

## GitHub Pages

Upload all files to a GitHub repository and enable GitHub Pages for the
repository. The site entry point is `index.html`.
