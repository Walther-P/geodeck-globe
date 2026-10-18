// GeoDeck Globe service worker. BUILD is stamped by scripts/stamp-sw.mjs so
// every deploy installs a new worker and the page can offer "更新".
const BUILD = "__BUILD__";
const SHELL = `shell-${BUILD}`;
const DATA = "data-v1";
const TILES = "tiles-v1";
const TILE_LIMIT = 1500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon.svg", "./data/land-110m.json"])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

async function trim(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Basemap tiles and fonts from OpenFreeMap: keep what the user has seen so
  // places they visited still draw offline.
  if (url.hostname === "tiles.openfreemap.org") {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((r) => {
            if (r.ok) cache.put(req, r.clone()).then(() => trim(TILES, TILE_LIMIT));
            return r;
          })
          .catch(() => hit || Response.error());
        return hit || net;
      }),
    );
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith("/relay")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put("./", copy));
          return r;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }
  // Hashed build assets never change; bundled datasets change rarely.
  const cacheName = url.pathname.includes("/assets/") ? SHELL : url.pathname.includes("/data/") ? DATA : null;
  if (!cacheName) return;
  e.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((r) => {
        if (r.ok) cache.put(req, r.clone());
        return r;
      });
      if (hit) {
        if (cacheName === DATA) net.catch(() => {});
        return hit;
      }
      return net;
    }),
  );
});
