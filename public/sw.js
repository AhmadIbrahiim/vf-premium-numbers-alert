/**
 * sw.js — service worker.
 *
 * Deliberately conservative. Every page here is server-rendered from live Postgres, so
 * caching HTML would show stale numbers, which is worse than showing nothing. The
 * strategies are picked per request type:
 *
 *   - Navigations: network-first, falling back to a cached offline page. Never serve a
 *     cached page as if it were current data.
 *   - Static build assets (/_next/static, icons): cache-first. They are content-hashed
 *     or stable, so they can never go stale.
 *   - Everything else, including /api: not touched. API responses are live data and
 *     already carry their own Cache-Control headers.
 *
 * Bumping CACHE deploys a new cache and drops the old one in `activate`.
 */

const CACHE = "eg-numbers-v1";
const OFFLINE_URL = "/offline.html";

// Only what is needed to render the offline fallback.
const PRECACHE = [OFFLINE_URL, "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one failed asset cannot abort the whole install.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      // Take over without waiting for every existing tab to close.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Enable navigation preload where supported: lets the browser start the network
      // request in parallel with booting this worker, so the SW adds no latency.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

/** Build assets are content-addressed, so a cache hit is always correct. */
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)
  );
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

  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        // Opaque/error responses are not worth storing.
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      })()
    );
  }
});

// Lets the page trigger an immediate update instead of waiting for a navigation.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
