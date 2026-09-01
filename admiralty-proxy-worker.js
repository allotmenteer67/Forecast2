// Cloudflare Worker — a thin, generic CORS relay for the Admiralty
// Discovery Tidal API. It stores nothing and doesn't care whose key
// it's forwarding: whatever Ocp-Apim-Subscription-Key header the
// browser sends in gets passed straight through to Admiralty on
// every request, unchanged. This is what lets each Cloude user keep
// using their own free key rather than sharing one.
//
// Why this exists at all: Admiralty's own developer docs confirm their
// API isn't set up for direct browser calls (no CORS header on their
// side), and their own recommendation is to put the API-calling code
// on a server instead. This Worker IS that server — the smallest
// version of one that does nothing except add the missing header.
//
// Deploy: paste this whole file as the Worker's code in the Cloudflare
// dashboard (Workers & Pages → Create → an empty Worker → edit code),
// then Deploy. Cloudflare will give you a URL like
// https://<your-worker-name>.<your-subdomain>.workers.dev — paste
// THAT into Cloude's Settings → "Discovery proxy URL" field.

const ADMIRALTY_HOST = "https://admiraltyapi.azure-api.net";

export default {
  async fetch(request) {
    // Browsers send a CORS "preflight" OPTIONS request before the real
    // one whenever a custom header (like the subscription key) is
    // involved — this has to be answered on its own, with no body,
    // before the browser will even attempt the real request.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Ocp-Apim-Subscription-Key, Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);
    // Whatever path/query came in after the Worker's own domain gets
    // forwarded to Admiralty verbatim — e.g. a request to
    // https://<worker>/uktidalapi/api/V1/Stations/ becomes
    // https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/.
    const target = ADMIRALTY_HOST + url.pathname + url.search;

    const subscriptionKey = request.headers.get("Ocp-Apim-Subscription-Key");
    if (!subscriptionKey) {
      return new Response(JSON.stringify({ error: "Missing Ocp-Apim-Subscription-Key header" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": subscriptionKey }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Couldn't reach Admiralty", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
