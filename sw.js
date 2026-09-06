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
// Bumped to v5: substantial further changes since v4 across map.js,
// map.html, style.css, app.js and index.html — the whole map header/
// control-row rebuild (Home and Go-to moved twice, zoom buttons, the
// merged "Forecast for here" + save-to-places prompt), saved-place
// markers, two separate crosshair-visibility fixes, the coastline-
// outline-on-top-of-rain layer, the map-strip density/interpolation
// work and its hour-slider sync, the front-page Play button, and the
// map-strip height fix. The drag diagnostics added for v4 have also
// been removed now that they'd done their job. Same reasoning as v3
// and v4 above: this much change landing on a stale cached copy is
// exactly the failure this version string exists to prevent, and it's
// already caused real confusion once this session (a resolved pan-lag
// investigation that, in hindsight, was likely just testing an old
// cached map.js the whole time).
const CACHE_NAME = "cloude-shell-v5";
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
