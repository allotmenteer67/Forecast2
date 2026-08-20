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

- postcode field — location is resolved from the first 3 characters
  (area-level, not the exact address)
- Rain / Cloud / Wind / Temperature / Sunshine / UV
- rollback slider that picks a **target date** (today back to 6 days ago)
- day-out rows (7 → 1) showing how each forecaster's prediction trended
  as the target date approached, with the calendar date of each forecast
  shown next to its day number
- each forecaster now shows two columns: a **Corrected** value (the FFV
  correction applied) to the left, and the **Raw** forecast value
- a live **Actual** row at the bottom of the table, fetched from Open-Meteo
  for the selected target date — no API key required
- a small delta badge on the raw "1 day out" cell showing how far the
  final forecast was from what actually happened, once Actual is known
- forecaster selection has moved to its own page (`settings.html`, linked
  from the footer) — 12 sources available, still all user-choosable, just
  out of the way of day-to-day use
- responsive iPhone/iPad layout, styled to sit comfortably alongside My Plot

## Actual weather data

Actual weather comes from two free, keyless APIs:

- `api.postcodes.io/outcodes/` — turns the first 3 characters of a
  postcode into an area-level latitude/longitude. Note: some outward
  codes are 4 characters (e.g. "SW1A"); truncating to 3 will miss those.
- `api.open-meteo.com/v1/forecast` (with `past_days`) — recent recorded
  daily weather for that location

Both run entirely client-side; no server or key is needed for GitHub Pages
hosting. Today's "Actual" figure is a running total and will read
"still recording" until the day is over.

Forecaster figures for BBC, Meteoblue, YR, AccuWeather etc. are still
demo/placeholder data — those providers don't offer free public APIs for
past forecast runs. **Met Office is different**: Rain, Cloud, Wind and
Temperature now use real UK Met Office model data (via Open-Meteo's
Previous Runs API, model `ukmo_global_deterministic_10km`), both for the
day-to-day table and for FFV. Sunshine and UV aren't in that dataset, so
Met Office still uses the demo formula for those two conditions only.

An "advanced" section on the main page (collapsed by default) can backfill
a year of real Met Office history straight into the FFV store for the
current postcode area, using Open-Meteo's Historical Weather Archive for
Actual and the Previous Runs API for Met Office's lead-time forecasts —
so the Met Office FFV doesn't have to build up one day at a time. It's a
large one-off request, not something that runs automatically.

## Fudge factor (FFV)

For each forecaster, condition, and day-out row, the app keeps a running
3-day mean of the forecast value (day 1 and day 7 use a 2/3-point mean at
the edges — see `threeDayMean()` in `app.js`). Every time Actual weather
loads for a postcode area, that mean is compared against Actual for every
past target date still in view, and the ratio (`actual ÷ mean`) is folded
into a running average — the Fudge Factor Value — stored in the browser's
`localStorage`, keyed by postcode area.

Once a cell has at least 3 samples, an adjusted figure (`mean × FFV`)
appears under it. Because the forecaster data is currently synthetic, this
adjusted figure is only a proof of the mechanism for now — it becomes
meaningful once real forecast data replaces the demo values, or as a
standalone experiment if you're comparing the demo model's internal
consistency against real Actual weather.

Once a cell has at least 3 samples, its Corrected column shows the
adjusted figure (`mean × FFV`); before that it shows "–". An older,
smaller inline version of this hint (shown under the Raw cell) still
exists in `app.js` behind `SHOW_INLINE_FFV_HINT = false` — turned off
now that Corrected has its own column, but left in rather than deleted.

FFV data lives entirely in the browser (no server, no account) and is
scoped to the postcode area, so different gardens/locations build up
independent correction histories.

## Pages

- `index.html` — the day-to-day comparison view
- `settings.html` — choose which forecasters appear (moved off the main
  page since it's not something you'd change often); both pages read and
  write the same `localStorage` key so the choice carries over

## GitHub Pages

Upload all files to a GitHub repository and enable GitHub Pages for the
repository. The site entry point is `index.html`.
