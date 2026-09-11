// Cloude service worker — makes the installed app shell (HTML/CSS/JS)
// available instantly and offline, so opening the app never shows a
// blank "not connected" screen. Only live weather/postcode data needs a
// real connection, and the app already shows its own inline status
// messages when that's unavailable — this only covers the app's own
// files, nothing more.
//
// Strategy: stale-while-revalidate for every same-origin app-shell file —
// serve whatever's cached immediately (fast, and works with no
// connection at all), then fetch a fresh copy in the background to
// update the cache for next time. Deliberately needs no manual "bump the
// cache version" step on every deploy — each update to app.js/style.css
// gets picked up automatically the next time the app opens online.
//
// BUT: "picked up automatically" only means the NEXT open gets a fresh
// copy in the background — THIS open still serves whatever was cached
// from before, stale-while-revalidate's whole point. That's invisible
// for small tweaks, but map.js isn't even in SHELL_FILES below (it's
// still cached anyway — the fetch handler applies this strategy to
// every same-origin request, not just the precached list) and a
// substantial change to it (new layers, new fetch/dedupe logic) landing
// on top of an old cached copy is a real way for things to look like
// they've silently broken or reverted after a deploy, with no error
// anywhere to explain why. Bumping this version string forces every
// old cache to be dropped on the next activate (see below) and
// everything refetched fresh — do this on any deploy where "it looks
// like an old version" is a live possibility, not just for
// SHELL_FILES changes.
//
// Bumped to v6: waterways/lakes rendering (the new "waterways" layer,
// lakes folded into clipToLand, the river palette colour) and the
// place-label rank caps all landed in map.js AFTER v5 was set — v5 was
// bumped specifically to clear the drag-diagnostics removal, one
// message before waterways got built, so it never actually included
// any of this. Textbook case of exactly what these version bumps
// exist to prevent: real new code sitting unseen behind a cache that
// looks current but predates it.
//
// Bumped to v7: the river/estuary clip fix in map.js (rivers were
// drawing out into the sea at estuary mouths — clipToLand now applied
// to the waterways layer) and the iOS status-bar relayout fix in
// app.js (forceIOSStatusBarRelayout, replacing the scroll-only nudge
// that was confirmed on a real device NOT to clear the grey strip).
// Both are files already in SHELL_FILES, so both would otherwise be
// served from the v6 cache indefinitely — the exact failure mode the
// v6 note below describes, one deploy later. The status-bar fix in
// particular would be impossible to evaluate from behind a stale
// cache: it'd look like the fix simply didn't work.
//
// Bumped to v8: the same river/estuary clip fix now applied to
// map-strip.js as well. v7 covered map.js's own waterways layer, but
// the front-page strip draws rivers through its own separate code
// path and was missed — confirmed on a real device, where the
// expanded map came out correct and the strip still showed rivers
// running into the sea. map-strip.js is in SHELL_FILES, so without
// this bump the strip would keep being served from the v7 cache and
// the fix would look like it hadn't worked.
//
// Bumped to v9: tide sheet now opens scrolled to the last past tide
// event instead of the raw left edge of the 24h-past/72h-future
// window — previously every open started a full day back, showing
// tides that had already happened before you could see what's still
// ahead. tide-ui.js is in SHELL_FILES, so without this bump it would
// keep being served from the v8 cache and the fix would look like it
// hadn't worked.
// Bumped to v10: apple-mobile-web-app-status-bar-style changed from
// "default" to "black-translucent" on every page (index/compare/
// settings/help/map .html) — "default" was iOS painting its own solid
// grey bar behind the status-bar icons on every launch, unrelated to
// the sheet-close grey-strip issue noted in v7 above. All five .html
// files are in SHELL_FILES, so without this bump they'd keep being
// served from the v9 cache and the fix would look like it hadn't
// worked.
// Bumped to v16: map.js now persists its weather grid to localStorage
// (same MAP_STALE_MS window its in-memory checks already use, keyed on
// rounded centre + radius, values rounded to 1dp to keep the worst-case
// 150km grid under ~0.9MB). map.html is its own document, so every
// arrival previously started with an empty grid and refetched 81-361
// locations — the same per-location billing that caused the daily-limit
// error, now closed on the map page as well as the strip.
//
// Bumped to v15: the title strip overlapping the status bar, now with
// a cause. viewport-fit=cover lets the page draw under the status bar,
// and .app relied on env(safe-area-inset-top) to clear it — but in
// standalone (installed PWA) mode iOS does not reliably report that
// inset, and when it resolves to 0 the calc collapsed to 2px, putting
// the title and chips straight on top of the clock. style.css now uses
// max(calc(2px + env(...)), 44px) under a display-mode: standalone
// query, so a real inset still wins and a missing one gets a floor.
//
// Bumped to v14: map-strip.js now caches its grid fetch (localStorage,
// 60 min, keyed on the rounded centre). That one call asks Open-Meteo
// for 256 locations and Open-Meteo bills per location, so every
// uncached front-page load spent ~256 of the 10,000/day free-tier
// allowance — about 39 launches — which is what produced the "Daily API
// request limit exceeded" error on device.
//
// Bumped to v13: the grey status-bar strip, now diagnosed properly —
// iOS samples the page colour under the status bar WHILE the sheet
// backdrop is open (the blend computes to exactly the reported grey)
// and never re-samples on close. forceIOSStatusBarRelayout in app.js
// now toggles theme-color, which is the meta iOS actually re-reads,
// instead of the viewport meta the v11 attempt toggled; .sheet-backdrop
// in style.css also now goes visibility:hidden when closed.
//
// Bumped to v12: the black-translucent status-bar experiment from v10
// reverted on all five .html files (it fixed the grey strip but pushed
// the title under the notch — the spacing under "default" was already
// right), plus the real map-strip fix in style.css: .app-home had
// min-height: 100svh with no matching max-height, so flex-shrink never
// engaged and the strip could grow into spare space but never give it
// back. style.css and all five .html files are in SHELL_FILES.
//
// Bumped to v11: closeHourlySheet's grey-status-bar-strip workaround
// replaced — a no-op scroll (v6-era) was confirmed on a real device to
// NOT clear it; forceIOSStatusBarRelayout() (a viewport-meta toggle)
// replaces it in app.js. app.js is in SHELL_FILES, so without this bump
// it would keep being served from the v10 cache and the fix would look
// like it hadn't worked.
//
// Bumped to v17: adding a tide/fishing location now checks it against
// the same elevation-uk.json and coastline-50m.json data map.js already
// uses, and warns (doesn't block) when a location is BOTH far from the
// sea AND well above it — genuinely inland/upland spots like Snowdon,
// not high-but-coastal ones like a clifftop path, which stay unflagged
// on purpose. tide.js and tide-ui.js are both in SHELL_FILES, so
// without this bump they'd keep being served from the v16 cache and the
// warning would never appear.
// Bumped to v18: a batch of front-page/map/tide fixes — (1) the map
// strip's rain grid no longer leaves blank rectangles either side (the
// projection was scaling to the strip's shorter dimension, so the
// wider one showed more real distance than the fetched grid covered —
// now scales to the longer dimension instead); (2) the coastline
// outline is bolder (1 -> 1.5px) and, on the strip, now gets a
// stroke-only redraw AFTER the rain layer the same way the full map
// already does, so rain can no longer bury it entirely; (3) the map's
// time/conditions pill moved from bottom-right to top-right and no
// longer shows the zoom-distance figure or the word "Now"; (4)
// map.html's header now matches the front page's own icon/title/
// back-link layout instead of a separate stacked arrangement, and its
// now-redundant bottom Settings link is gone; (5) the divider between
// the headline grid and the Hour slider is bolder (1 -> 2px); (6) the
// tide sheet's scrollable window widened from 24h-past/72h-future to a
// full 7 days each way — no technical or licensing reason was ever
// found for the old, narrower figure; (7) the map's zoom buttons no
// longer stay visually "pressed" after a tap (blur() plus tap-
// highlight suppression); (8) the temperature legend now previews the
// SAME partial-opacity blend the layer itself actually paints with,
// instead of a full-strength colour nothing on the map ever shows —
// the mismatch between those two was the real cause of a reported
// reading looking like it belonged to a noticeably warmer swatch than
// its own true value. map.js, map-strip.js, style.css, map.html and
// tide-ui.js are all in SHELL_FILES, so without this bump every one of
// these would keep being served from the v17 cache and look like none
// of it had worked.
// Bumped to v19: the real fix for rivers drawing out into the sea at
// estuary mouths (#17) — a previous session's handover notes claimed
// this was already done (clipToLand applied to the waterways layer),
// but the actual code never called it for that layer at all, on either
// map.js or map-strip.js; confirmed still broken even after a full
// Safari "delete website data" wipe ruled out a stale cache as the
// explanation. Both files' waterways layers now clip to land the same
// way their terrain layers already did. Cross-checked the other two
// "already fixed" items (#2's forceIOSStatusBarRelayout, #3's
// .app-home max-height) against the real files while here — both
// genuinely exist in the code, unlike waterways' clip, so if either is
// still misbehaving it's a real remaining edge case, not another
// phantom fix.
const CACHE_NAME = "cloude-shell-v19";
const SHELL_FILES = [
  "index.html",
  "compare.html",
  "settings.html",
  "help.html",
  "solar.html",
  // map.html/map.js/map-strip.js added to the precache list. They were
  // always cached anyway (the fetch handler applies to every
  // same-origin request, not just this list), but only lazily, on first
  // visit — so the map page alone didn't work offline until it had been
  // opened once online. No reason for it to be the one page that
  // doesn't, especially now it's a main destination rather than an
  // afterthought.
  "map.html",
  "map.js",
  "map-strip.js",
  "app.js",
  "settings.js",
  "solar.js",
  "solar-ui.js",
  "tide.js",
  "tide-ui.js",
  "fishing.js",
  "fishing-ui.js",
  "style.css",
  "manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Only this app's own GET requests are handled here. Everything else —
  // Open-Meteo, postcodes.io, any cross-origin call — passes straight
  // through untouched, so live weather data behaves exactly as it
  // already does: works online, fails with the app's own status message
  // offline. This service worker is deliberately never in that path.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null); // offline — fall back to whatever's cached below

      return cached || (await network) || Response.error();
    })
  );
});
