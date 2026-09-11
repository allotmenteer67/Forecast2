// Cloudflare Worker — lets anyone using this specific Cloude deployment
// (you, your wife, anyone you've shared the app with) add a favourite
// place to the SHARED GitHub precache without hand-editing
// data/precache-config.json or having any GitHub access themselves.
//
// Same shape as admiralty-proxy-worker.js (a thin relay holding a
// credential the browser must never see) but the other direction: that
// one forwards each person's OWN key outward to a third party; this one
// holds ONE shared credential (a GitHub token with write access to your
// repo) and uses it on everyone's behalf to commit a small, structured
// change. The browser never sees the GitHub token — only this Worker
// does, via a Cloudflare secret.
//
// ---- What it will and won't do ----
// - Accepts only: { type: "weather"|"fishing", outcode: "TA6",
//   markType?: "coastal"|"estuary" } (markType required for fishing).
// - Validates the outcode LOOKS like a genuine UK postcode outward code
//   (1-2 letters, a digit, optionally another letter/digit — e.g. "TA6",
//   "SW1A") and rejects anything else. This is the privacy boundary
//   agreed on: never a place name, never exact coordinates, never a full
//   postcode with the inward half — just the outward code, same
//   resolution the app already uses everywhere else for FFV storage.
// - Deduplicates: if that outcode is already in the target list, this is
//   a harmless no-op (existing entry wins; it does NOT overwrite a
//   different stored markType).
// - Enforces the shared cap (8, matching precache-config.json's own
//   _readme) — once a list is full it refuses new entries rather than
//   evicting an existing one, and returns a message the app shows
//   verbatim: "List full for now — delete a favourite to add more."
// - Does NOT enforce the per-person cap of 4 — there's no account system
//   here, so that's tracked client-side in each phone's own localStorage
//   (see app.js). This Worker only protects the SHARED list, not any one
//   person's own count.
//
// ---- Honest limitation: this is not hardened against abuse ----
// Anyone who discovers this Worker's URL (visible in app.js, since it's
// a plain static site) can POST directly to it, bypassing the app's own
// UI and its 4-per-person limit entirely. The optional shared-secret
// header below raises the bar against casual/automated abuse but is NOT
// real security — it's baked into app.js in plain text, same as any
// client-side "secret" necessarily is. What actually bounds the damage
// is the shared cap: at most 8 junk entries can ever land in each list,
// each individually easy to spot and delete by hand, and worst case
// costs a bounded, small amount of extra daily budget until you notice
// and remove them. Given the app's own scale (a dozen people at most),
// this was judged an acceptable trade-off against the complexity of a
// real auth system — revisit if that ever stops being true.
//
// ---- Setup ----
// 1. Cloudflare dashboard -> Workers & Pages -> Create -> empty Worker.
// 2. Paste this whole file in, Deploy.
// 3. Settings -> Variables -> add secrets (Encrypt):
//      GITHUB_TOKEN     - a fine-grained PAT, scoped to ONLY this repo,
//                          with Contents: Read and write permission.
//                          Fine-grained tokens can be scoped to a single
//                          repo, unlike classic PATs — use that.
//      APP_SHARED_SECRET - any random string you make up (optional but
//                          recommended — see the honest limitation
//                          above). Leave unset to skip this check
//                          entirely.
// 4. Paste the Worker's own URL into FAVOURITE_RELAY_URL near the top of
//    app.js, and (if you set APP_SHARED_SECRET) the same value into
//    FAVOURITE_RELAY_SECRET right next to it.

const GITHUB_OWNER = "allotmenteer67";
const GITHUB_REPO = "Forecast2";
const CONFIG_PATH = "data/precache-config.json";
const SHARED_CAP = 8;

const OUTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]?$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Cloude-App",
    "Access-Control-Max-Age": "86400"
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// Cloudflare Workers have no Buffer/atob-for-UTF8 by design quirks — this
// pair handles UTF-8 safely in both directions, which plain atob/btoa
// does not (they're Latin1-only and corrupt anything outside it, not
// currently a risk for this file's content but worth doing correctly).
function base64ToUtf8(b64) {
  const bytes = Uint8Array.from(atob(b64.replace(/\n/g, "")), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function githubRequest(env, method, body) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CONFIG_PATH}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "cloude-favourite-relay",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    // Optional deterrent, not real access control — see the file header.
    if (env.APP_SHARED_SECRET) {
      const provided = request.headers.get("X-Cloude-App");
      if (provided !== env.APP_SHARED_SECRET) {
        return json({ error: "Not authorised" }, 403);
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const type = payload?.type;
    const outcode = String(payload?.outcode || "").trim().toUpperCase();
    const markType = payload?.markType;

    if (type !== "weather" && type !== "fishing") {
      return json({ error: "type must be \"weather\" or \"fishing\"" }, 400);
    }
    if (!OUTCODE_PATTERN.test(outcode)) {
      return json({ error: "That doesn't look like a UK postcode outward code (e.g. \"TA6\")." }, 400);
    }
    if (type === "fishing" && markType !== "coastal" && markType !== "estuary") {
      return json({ error: "markType must be \"coastal\" or \"estuary\" for a fishing favourite." }, 400);
    }

    // 1. Fetch the current file (need its sha to write back to it).
    let getRes;
    try {
      getRes = await githubRequest(env, "GET");
    } catch (err) {
      return json({ error: "Couldn't reach GitHub", detail: String(err) }, 502);
    }
    if (!getRes.ok) {
      return json({ error: `GitHub read failed (${getRes.status})` }, 502);
    }
    const fileData = await getRes.json();
    let config;
    try {
      config = JSON.parse(base64ToUtf8(fileData.content));
    } catch (err) {
      return json({ error: "Couldn't parse precache-config.json", detail: String(err) }, 500);
    }

    const listKey = type === "weather" ? "weatherFavourites" : "fishingFavourites";
    if (!Array.isArray(config[listKey])) config[listKey] = [];
    const list = config[listKey];

    // 2. Dedupe — an existing entry for this outcode wins outright, this
    // request becomes a no-op rather than a second copy or an overwrite
    // of a markType someone else already chose.
    const existing = list.find(entry => entry.outcode === outcode);
    if (existing) {
      return json({ ok: true, alreadyExists: true });
    }

    // 3. Shared cap.
    if (list.length >= SHARED_CAP) {
      return json({ error: "full", message: "List full for now — delete a favourite to add more." }, 409);
    }

    // 4. Append and write back.
    const entry = { outcode, addedAt: new Date().toISOString() };
    if (type === "fishing") entry.markType = markType;
    list.push(entry);

    const newContent = JSON.stringify(config, null, 2) + "\n";
    let putRes;
    try {
      putRes = await githubRequest(env, "PUT", {
        message: `Add favourite ${outcode} (${type})`,
        content: utf8ToBase64(newContent),
        sha: fileData.sha
      });
    } catch (err) {
      return json({ error: "Couldn't reach GitHub", detail: String(err) }, 502);
    }
    if (!putRes.ok) {
      const detail = await putRes.text();
      return json({ error: `GitHub write failed (${putRes.status})`, detail }, 502);
    }

    return json({ ok: true, outcode, type });
  }
};
