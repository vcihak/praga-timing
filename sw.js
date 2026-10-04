/* The app shell, kept so the page opens at the track without waiting on a
 * signal. Nothing from the timing API is ever cached: those answers are the
 * whole point of being online, and a stale leaderboard would be worse than no
 * leaderboard.
 *
 * Kept as one set. Every file of a page comes out of the same complete copy of
 * the shell, so a deploy can never pair a new app.js with an old index.html.
 * It once did: files were refreshed one by one, the new script reached for a
 * button the old page did not have, and the page sat on "Načítám" for good —
 * everywhere but a private tab, which has no worker.
 *
 * A visit is answered from the newest complete copy at once. Once the page has
 * long finished loading, a whole new copy is fetched behind it, and it only
 * replaces the old one if every file arrived. A deploy is therefore live on the
 * next visit, with nothing to bump by hand. */

const PREFIX = "praga-shell-";
// A copy is a cache named by when it was taken; anything else is from before.
const COPY = /^praga-shell-\d+$/;

// Relative to this file, so the same worker serves a project page at
// /praga-timing/ and a site at a domain root without being told which.
const BASE = new URL("./", self.location).href;
const SHELL = ["index.html", "style.css", "app.js", "manifest.json", "icon-192.png", "icon-512.png"]
  .map((p) => new URL(p, BASE).href);
const PAGE = SHELL[0];

/** Long after a page has loaded every file it asks for at the start. */
const SETTLE_MS = 15_000;

async function copies() {
  return (await caches.keys()).filter((k) => COPY.test(k)).sort();
}

/** Fetches the whole shell into a new copy; keeps it only if every file came. */
let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    const responses = await Promise.all(SHELL.map((u) => fetch(u, { cache: "no-cache" })));
    if (!responses.every((r) => r.ok)) return;
    const name = PREFIX + Date.now();
    const cache = await caches.open(name);
    await Promise.all(responses.map((r, i) => cache.put(SHELL[i], r)));
    // Complete; everything older goes, including caches from before copies.
    const stale = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== name);
    await Promise.all(stale.map((k) => caches.delete(k)));
  })().catch(() => { /* offline or a failed file: the current copy stays */ })
    .finally(() => { refreshing = null; });
  return refreshing;
}

self.addEventListener("install", (e) => {
  e.waitUntil(refresh().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !COPY.test(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Which shell file a request is, or null: the page under any address the app gives it (?tab=…). */
function shellFile(req) {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return null;
  if (req.mode === "navigate") return PAGE;
  const plain = url.origin + url.pathname;
  return SHELL.includes(plain) ? plain : null;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const file = shellFile(req);
  // Anything that is not this app's own shell — the timing API above all —
  // goes straight to the network and is never stored.
  if (!file) return;

  e.respondWith((async () => {
    const all = await copies();
    const hit = all.length ? await (await caches.open(all[all.length - 1])).match(file) : null;
    return hit || fetch(req).catch(() => new Response("Offline", { status: 503, statusText: "Offline" }));
  })());

  // A new copy for the next visit, once this one has everything it asked for.
  if (req.mode === "navigate") {
    e.waitUntil(new Promise((r) => setTimeout(r, SETTLE_MS)).then(refresh));
  }
});
