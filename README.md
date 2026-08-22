# Cloude

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
past forecast runs. **Real sources are different**: Rain, Cloud, Wind and
Temperature use real model data (via Open-Meteo's Previous Runs API) for
sources listed in `REAL_SOURCES` in `app.js` — currently Met Office
(`ukmo_global_deterministic_10km`) and ECMWF (`ecmwf_ifs025`) — both for
the day-to-day table and for FFV. Sunshine and UV aren't in that dataset,
so real sources fall back to the demo formula for those two conditions
only. Adding another real source later is just another entry in
`REAL_SOURCES` (plus a matching forecaster in `CONFIG.forecasters` and
`settings.js`) — everything else (fetching, indexing, FFV, accuracy, the
headline) already loops over the registry rather than naming a specific
source.

An "advanced" section on the main page (collapsed by default) can backfill
a year of real history straight into the FFV store for the current
postcode area, for every real source — using Open-Meteo's Historical
Weather Archive for Actual (fetched once, shared across sources) and the
Previous Runs API for each source's own lead-time forecasts, so FFV
doesn't have to build up one day at a time. It's a large one-off request,
not something that runs automatically.

## Target date: past and future

The rollback slider spans a full two weeks — 7 days back through 7 days
ahead, today in the middle, left = past, right = future. Internally this
is still one `rollback` value (positive = past, negative = future); the
slider's raw input is just negated so the on-screen direction reads
naturally (left = further back, right = further ahead), rather than
inverting that convention everywhere else in the code.

**Past/today** works exactly as before: full lead-time comparison, real
Actual weather, FFV training, accuracy scoring.

**Future** reuses the same machinery to produce a genuine prediction: the
Corrected column applies FFV (learned entirely from past data) to today's
live forecast, turning "raw forecast" into "the app's own best guess."
The **freshest available real day** shifts with how far ahead you're
looking — 3 days ahead, the freshest real data for any given real source
is the lead-3 forecast (issued today), not lead-1 (which would need to be
issued tomorrow and doesn't exist yet). Rows for lead times that haven't been
issued yet just fall back to demo data, same convention already used
everywhere else in the app when real data isn't available — not a new
special case. FFV training itself only ever runs over past dates (it
can't be otherwise — accuracy requires a known Actual), so looking into
the future never pollutes or skews it.

The headline figure and delta badge both follow this same freshest-day
logic automatically.

## Hour slider

A second slider beneath the headline grid, always anchored to "now"
rather than following the Date slider — the two are fully independent.
Its data source is deliberately a plain live forecast (`WEATHER_URL`,
Met Office's model specifically — see below), not the `previous_dayN`
lead-time data used everywhere else — that answers "what was forecast N
days ago," not "what's happening in the next two days."

Rather than building a slow-maturing hour-specific FFV (24 hours × up to
48 lead-hours would mean hundreds of buckets competing for the same pool
of history), it reuses the existing daily FFV: day 1's correction for
the first 24h, day 2's beyond that. Deliberately Met Office only, even
though the daily view now draws on multiple real sources (see
`REAL_SOURCES`) — extending hourly to more than one source would mean a
second live fetch per source, which felt like its own piece of work
rather than something to fold in alongside adding ECMWF. Demo sources
have never had an hourly concept regardless.

Dragging updates Rain/Temperature/Wind live; releasing starts a 5-second
hold (`state.hourlyHoldTimer`) before reverting to the daily view, so
there's a moment to read the dragged-to value. Touching the Date slider
calls `cancelHourlyHold()` and reverts immediately instead — an
unambiguous "done with hourly" signal.

Sunshine has no hourly reading (a daily total doesn't split into one),
so it stays on its daily figure, shown at reduced opacity
(`.headline-cell-dimmed`) while hourly is active. Specifically at night
(checked against real sunrise/sunset for the currently-shown hour) it
swaps to a moon phase emoji instead — a simple synodic-month
approximation (`moonPhaseEmoji()`), accurate to within about a day, which
is plenty for a decorative icon.

24 vs 48 hour range is set on the Forecasters page and persists in
`localStorage` (`forecast-compare:hourRange`).

## The headline figure

A box at the top of the page shows one number per condition (Rain,
Temperature, Wind, Sunshine) — the **median** across every selected
forecaster's most-refined forecast for the target date, using each
source's Corrected value where it has enough FFV history, Raw otherwise.
Median deliberately, not mean: one wildly-off value (a stray 45°C in
November) gets outvoted rather than skewing the figure, with no
threshold to tune. `headlineValueFor()` filters to real sources only when
any exist for that condition (see `isRealSource`), so demo noise can't
dilute a real signal — currently Met Office and ECMWF for Rain/Cloud/
Wind/Temperature, falling back to the full selection for Sunshine/UV
since nothing real exists for those yet.

Wind direction (shown as a rotating arrow, plus compass letters
underneath, alongside the headline's wind figure — works for both the
daily and hourly views now) comes from whichever real source has it
available first, in `REAL_SOURCES` order (`anyRealWindDirection()`) —
direction can't be medianed across sources the way speed can, since it's
angular, not linear. Reported at the hour the day's peak wind speed
occurred for the daily view, or live for whichever hour
the hour slider is on. The arrow points **downwind** (deliberately
rotated 180° from the raw meteorological reading, which is the direction
wind blows *from*) — more directly useful for "which way will this push
me" than the met-convention reading.

## Auto-backfill on first setup

The first time a postcode area has no real-source FFV history at all, the
app automatically runs the same year-long backfill the advanced button
triggers manually, for every source in `REAL_SOURCES` — no need to find
and press it. It only ever fires once per area; after that, the daily
Action and the committed history file keep it current.

## Fudge factor (FFV)

For each forecaster, condition, and day-out row, the app keeps a running
3-day mean of the forecast value (day 1 and day 7 use a 2/3-point mean at
the edges — see `threeDayMean()` in `app.js`). Every time Actual weather
loads for a postcode area, that mean is compared against Actual for every
past target date still in view, and the result is folded into a running
average — the Fudge Factor Value — stored in the browser's
`localStorage`, keyed by postcode area.

**Two correction types, not one** (`isRatioCondition()` in `app.js`):
Rain, Cloud, and Wind are ratio quantities, so FFV there is
`actual ÷ mean`, applied as `mean × FFV`. Temperature has no true zero on
the Celsius scale — 20°C isn't "twice as hot" as 10°C — so a
multiplicative correction can misbehave near/below freezing. Temperature
instead gets an additive FFV (`actual − mean`), applied as `mean + FFV`.
Both are tracked as separate running sums in the same store entry
(`sumRatio` and `sumOffset`), so the fix didn't require migrating or
discarding any existing Temperature history — it just started
accumulating the right kind of correction from that point on.
`applyCorrection(mean, ffv, conditionName)` is the one place that decides
which formula to use; every call site (the table, the headline, the
hourly slider, accuracy scoring) goes through it.

Once a cell has at least 3 samples, its Corrected column shows the
adjusted figure (`mean × FFV`); before that it shows "–". An older,
smaller inline version of this hint (shown under the Raw cell) still
exists in `app.js` behind `SHOW_INLINE_FFV_HINT = false` — turned off
now that Corrected has its own column, but left in rather than deleted.

FFV data lives entirely in the browser (no server, no account) and is
scoped to the postcode area, so different gardens/locations build up
independent correction histories.

## Accuracy scoring

A collapsible "Accuracy so far" section (open by default) shows, per
forecaster, how far Raw and Corrected typically land from Actual for
whichever condition is selected — averaged across all 7 "days out" rows,
weighted by sample count. Two numbers per cell: the average error in the
condition's own units (e.g. "±1.2mm"), and an approximate 0–100% closeness
score (a simple heuristic, not a formal statistic — see `ACCURACY_SCALE`
in `app.js`). A dropdown lets you show units only, percent only, or both;
the choice persists in `localStorage`.

Corrected accuracy is scored honestly rather than retroactively: each
sample is checked against whatever FFV existed *before* that sample was
folded in, so it reflects how the correction would actually have
performed in practice, not hindsight applied to old data.

## Automatic daily collection

A GitHub Action (`.github/workflows/collect-weather.yml`) runs once a day,
fetches a 7-day rolling window of real Actual + real-source data for
every source in `MODELS` (the collector script's own registry, kept in
sync with `REAL_SOURCES` in `app.js`), and commits the result to
`data/history.json`. That file deliberately holds **no location
information** — just dates and weather numbers — so it's safe in a
public repo. The app fetches it on every load and rebuilds every real
source's FFV entries from scratch each time, so revisiting the page
never double-counts, and a single missed run self-heals on the next one
(the window overlaps by design).

**One-time setup**, since the location itself has to stay out of the
repo: in the repo's **Settings → Secrets and variables → Actions**, add
two repository secrets:

- `FORECAST_LAT` — your postcode area's latitude
- `FORECAST_LON` — your postcode area's longitude

(Loading the app once and checking what it resolved your postcode to is
the easiest way to get these — or look up the postcode area on
postcodes.io directly.) Secrets are masked in logs and never appear in
the repo's history, unlike a value hardcoded in the workflow file.

Once the secrets are set, the Action runs automatically on its daily
schedule — or trigger it manually from the repo's **Actions** tab
(**Collect weather data → Run workflow**) to test it or catch up sooner.

ECMWF was added this way as the second real source — a matter of adding
an entry to `MODELS` in `scripts/collect-weather.js`, a matching entry
in `REAL_SOURCES` in `app.js`, and a forecaster entry in both
`CONFIG.forecasters` and `settings.js`'s list. Adding a third (GFS, DWD
ICON, or any of the dozen or so other national models Open-Meteo covers
the same way) is the same four small additions — everything else in the
codebase already loops over the registries rather than naming a specific
source.

## Display precision

Figures round to the nearest whole number throughout (`Math.round`),
except:

- **Rain** — stays at 1 decimal place (2 for imperial), since typical
  daily totals are well under 1mm/1in and would just read as "0"
  otherwise.
- **Deltas and accuracy errors** (`isDelta: true` in `formatValue`) —
  keep 1 decimal place too, since a good accuracy score is a small
  number close to zero, and rounding it away would defeat the point of
  showing it.

## Units

Metric or Imperial is set on the Forecasters (`settings.html`) page and
persists in `localStorage`. Rain converts mm ↔ inches, Wind converts
km/h ↔ mph, Temperature converts °C ↔ °F. Cloud, Sunshine, and UV are
unitless/universal and don't change. Internally everything is always
stored and computed in native units (mm, mph, °C) regardless of the
toggle — FFV, accuracy scoring, and all other math are unaffected by
display choice; only `formatValue()` and the unit labels convert.

(Fixed alongside this: every live fetch now explicitly requests
`wind_speed_unit: "mph"` from Open-Meteo. It previously didn't, so wind
values were actually being returned in km/h while labelled "mph" —
about 1.6× too low as displayed. That's corrected in the live fetches,
the backfill, and the daily collector script.)

## Pages

- `index.html` — the day-to-day comparison view; kept to controls and
  live status only, no explanatory text
- `help.html` — everything that used to be inline instructional text on
  the main page now lives here instead
- `settings.html` — choose which forecasters appear and pick Metric or
  Imperial units (moved off the main page since neither is a daily
  decision); all three pages read/write shared `localStorage` keys

## GitHub Pages

Upload all files to a GitHub repository and enable GitHub Pages for the
repository. The site entry point is `index.html`.
