/* The app shell, cached so the page opens at the track without waiting on a
 * signal, and so a deploy cannot leave a new app.js paired with an old
 * style.css. Nothing from the timing API is ever cached: those answers are
 * the whole point of being online, and a stale leaderboard would be worse
 * than no leaderboard.
 *
 * Bump CACHE on every deploy — that is what evicts the old shell. */
const CACHE = "praga-shell-v1";

// Relative to this file, so the same worker serves a project page at
// /praga-timing/ and a site at a domain root without being told which.
const SHELL = ["./", "./index.html", "./style.css", "./app.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  // addAll is atomic: a half-cached shell is worse than none, so a single
  // failed file leaves the previous version in place.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Anything that is not this app's own files — the timing API above all —
  // goes straight to the network and is never stored.
  if (url.origin !== self.location.origin) return;

  /* Stale-while-revalidate: answer from the cache so the page paints at once,
   * and refresh in the background so the next open is current. A deploy is
   * therefore live on the second visit rather than never. */
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await fresh) || new Response("Offline", { status: 503, statusText: "Offline" });
  }));
});
