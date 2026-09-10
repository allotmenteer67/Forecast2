// Cloudflare Worker — a thin, generic CORS relay for aviationweather.gov's
// METAR API. Same shape as admiralty-proxy-worker.js: stores nothing,
// just forwards whatever path/query it receives on to the real host and
// adds the CORS header that lets a browser read the response.
//
// Why this exists: aviationweather.gov's API is free and needs no key,
// but there are repeated reports of it not sending an
// Access-Control-Allow-Origin header, which blocks a direct browser
// fetch even though curl/server-side calls work fine. This Worker is
// the smallest possible fix for that — it changes nothing about the
// request or response except adding the missing header.
//
// Deploy: same as admiralty-proxy-worker.js — paste this whole file as
// a new Worker's code in the Cloudflare dashboard, Deploy, then paste
// the resulting workers.dev URL into Cloude's Settings → "Aviation
// proxy URL" field.
//
// Unlike Admiralty, this API needs no subscription key at all, so
// there's no header to check for or forward here — genuinely just a
// CORS pass-through.

const AVIATIONWEATHER_HOST = "https://aviationweather.gov";

// Only ever relay the one path this app actually needs. Aviationweather.gov
// is a real government host with more than just METAR behind it — no
// reason for an open Worker to forward arbitrary paths to it.
const ALLOWED_PATH_PREFIX = "/api/data/metar";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
      return new Response(JSON.stringify({ error: "This proxy only relays " + ALLOWED_PATH_PREFIX }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const target = AVIATIONWEATHER_HOST + url.pathname + url.search;

    let upstream;
    try {
      // METAR observations update roughly every 20-60 minutes per
      // station — no-store keeps this Worker from ever handing back
      // something older than what aviationweather.gov itself has.
      upstream = await fetch(target, { method: "GET", cache: "no-store" });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Couldn't reach aviationweather.gov", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    });
  }
};
