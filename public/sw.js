/**
 * sw.js — service worker.
 *
 * Deliberately conservative. Every page here is server-rendered from live Postgres, so
 * caching HTML would show stale numbers, which is worse than showing nothing. The
 * strategies are picked per request type:
 *
 *   - Navigations: network-first, falling back to a cached offline page. Never serve a
 *     cached page as if it were current data.
 *   - /_next/static: cache-first. These URLs contain a content hash, so a cache hit is
 *     correct by construction.
 *   - Everything else — icons, the manifest, /api: not intercepted at all. Those URLs
 *     are stable rather than content-hashed, so caching them here would pin a stale
 *     icon or manifest indefinitely; the browser's own HTTP cache handles them.
 *
 * Only caches whose name starts with CACHE_PREFIX are ever deleted, so this worker
 * cannot disturb a cache belonging to anything else on the origin.
 */

const CACHE_PREFIX = "eg-numbers-";
const CACHE = `${CACHE_PREFIX}v2`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Not allSettled: this worker's only job when offline is to serve this page, so a
      // version that failed to cache it must not install. A rejection here leaves the
      // previous worker in place, which is the safe outcome.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      // Take over without waiting for every existing tab to close.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      );
      // Enable navigation preload where supported: lets the browser start the network
      // request in parallel with booting this worker, so the SW adds no latency.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

/** Content-hashed build output, and nothing else — a hit is always the right bytes. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never interfere with anything but plain GETs from our own origin.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API responses are live data; let them go straight to the network.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
          return await fetch(request);
        } catch {
          // Offline: an honest offline page, not a stale copy of the numbers.
          const cache = await caches.open(CACHE);
          return (await cache.match(OFFLINE_URL)) || Response.error();
        }
      })()
    );
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        // Hold the event open until the write finishes: the browser is free to kill the
        // worker as soon as the response resolves, which would drop a pending put().
        if (res && res.ok) event.waitUntil(cache.put(request, res.clone()));
        return res;
      })()
    );
  }
});
