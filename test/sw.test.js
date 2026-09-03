import { test } from "node:test";
import assert from "node:assert/strict";
import { loadServiceWorker, navigation, ORIGIN } from "./helpers/sw-env.js";

/**
 * Behavioural tests for public/sw.js — the worker is executed, not grepped.
 *
 * A service worker is the one thing here that can break the site for a user who then
 * cannot get the fix, because it keeps serving until it is replaced. So the cases below
 * are all about what it must never do: cache a page, cache a URL that can change, touch
 * the API, or install without the offline page it promises.
 */

const ok = (body = "live") => new Response(body, { status: 200 });

/** Network that serves everything. */
const online = async () => ok();

test("install caches the offline page", async () => {
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  const cache = sw.caches.get("eg-numbers-v2");
  assert.ok(cache, "the versioned cache should exist after install");
  assert.ok(await cache.match("/offline.html"), "offline.html must be precached");
  assert.equal(sw.calls.skipWaiting, 1, "should activate without waiting for open tabs");
});

test("install fails when the offline page cannot be cached", async () => {
  // The whole point of this worker when offline is to serve that page. A version that
  // installed without it would control every tab and answer outages with an error, so
  // failing install — which leaves the previous worker in place — is the safe outcome.
  const sw = await loadServiceWorker({
    fetchImpl: async () => new Response("nope", { status: 404 }),
  });
  await assert.rejects(sw.install(), "install must reject rather than half-work");
});

test("activate removes our old caches", async () => {
  const sw = await loadServiceWorker({
    fetchImpl: online,
    existingCaches: { "eg-numbers-v1": ["/_next/static/old.js"] },
  });
  await sw.activate();

  assert.ok(!sw.caches.has("eg-numbers-v1"), "the superseded cache should be dropped");
});

test("activate leaves caches belonging to anything else alone", async () => {
  // caches.keys() returns every cache on the origin, so an unfiltered delete would wipe
  // storage this worker has no business touching.
  const sw = await loadServiceWorker({
    fetchImpl: online,
    existingCaches: { "some-other-app": ["/other.js"], "eg-numbers-v1": ["/old.js"] },
  });
  await sw.activate();

  assert.ok(sw.caches.has("some-other-app"), "a foreign cache must survive activation");
  assert.ok(!sw.caches.has("eg-numbers-v1"));
});

test("activate enables navigation preload and claims open tabs", async () => {
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.activate();

  assert.equal(sw.calls.navigationPreloadEnabled, 1, "preload keeps the SW off the critical path");
  assert.equal(sw.calls.claim, 1);
});

test("a navigation goes to the network, not the cache", async () => {
  const sw = await loadServiceWorker({ fetchImpl: async () => ok("fresh page") });
  await sw.install();

  const { response } = await sw.dispatchFetch(navigation("/changes"));
  assert.equal(await response.text(), "fresh page");
});

test("a navigation is never written to the cache", async () => {
  // Pages render live Postgres data. A cached page would later be served as if current,
  // showing numbers that are no longer available — the exact failure this app cannot have.
  const sw = await loadServiceWorker({ fetchImpl: async () => ok("page one") });
  await sw.install();
  await sw.dispatchFetch(navigation("/"));

  const cache = sw.caches.get("eg-numbers-v2");
  assert.equal(await cache.match("/"), undefined, "the page must not be in the cache");
});

test("a navigation falls back to the offline page when the network is down", async () => {
  let down = false;
  const sw = await loadServiceWorker({
    fetchImpl: async (req) => {
      if (down) throw new TypeError("Failed to fetch");
      return ok("offline page body");
    },
  });
  await sw.install(); // precache while still online
  down = true;

  const { response } = await sw.dispatchFetch(navigation("/changes"));
  assert.equal(await response.text(), "offline page body", "should serve the precached page");
});

test("a navigation uses the preloaded response when one is available", async () => {
  const sw = await loadServiceWorker({
    fetchImpl: async () => ok("from fetch"),
  });
  await sw.install();

  const { response } = await sw.dispatchFetch(navigation("/"), {
    preloadResponse: ok("from preload"),
  });
  assert.equal(await response.text(), "from preload", "must not refetch what preload already got");
});

test("API requests are not intercepted at all", async () => {
  // /api/numbers is live data behind its own Cache-Control. The worker must stay out of
  // the way entirely rather than cache or proxy it.
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  const result = await sw.dispatchFetch(new Request(`${ORIGIN}/api/numbers?view=now`));
  assert.equal(result.handled, false, "respondWith must not be called for /api");
});

test("opening an API URL in the address bar is not answered with the offline page", async () => {
  // This is the case the /api guard actually exists for. Typing an API URL is a
  // navigation, so without the guard the navigation branch claims it and, offline,
  // hands back an HTML page for a JSON endpoint.
  let down = false;
  const sw = await loadServiceWorker({
    fetchImpl: async () => {
      if (down) throw new TypeError("Failed to fetch");
      return ok("offline page body");
    },
  });
  await sw.install();
  down = true;

  const result = await sw.dispatchFetch(navigation("/api/numbers"));
  assert.equal(result.handled, false, "an /api navigation must be left to the network");
});

test("hashed build assets are served from cache on the second request", async () => {
  let hits = 0;
  const sw = await loadServiceWorker({
    fetchImpl: async () => {
      hits++;
      return ok("chunk");
    },
  });
  await sw.install();

  const url = `${ORIGIN}/_next/static/chunks/main-abc123.js`;
  await sw.dispatchFetch(new Request(url));
  const networkAfterFirst = hits;
  await sw.dispatchFetch(new Request(url));

  assert.equal(hits, networkAfterFirst, "the second request must not touch the network");
});

test("the cache write is tied to the event lifetime", async () => {
  // cache.put() started and forgotten can be cut short when the browser kills the
  // worker, leaving assets half-cached. It has to be handed to waitUntil.
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  const { extendedCount } = await sw.dispatchFetch(
    new Request(`${ORIGIN}/_next/static/chunks/page-def456.js`)
  );
  assert.ok(extendedCount > 0, "the put must be passed to event.waitUntil");
});

test("a failed asset response is not cached", async () => {
  // Only the asset fails; the precache has to succeed or install rejects.
  const sw = await loadServiceWorker({
    fetchImpl: async (req) => {
      const href = typeof req === "string" ? req : req.url;
      return href.includes("broken.js") ? new Response("boom", { status: 500 }) : ok();
    },
  });
  await sw.install();

  const url = `${ORIGIN}/_next/static/chunks/broken.js`;
  await sw.dispatchFetch(new Request(url));

  const cache = sw.caches.get("eg-numbers-v2");
  assert.equal(await cache.match(url), undefined, "a 500 must not be stored and replayed");
});

test("stable, non-hashed URLs are left to the browser's own cache", async () => {
  // /icon-192.png and /manifest.webmanifest keep the same URL when their content
  // changes, so caching them here would pin the old bytes indefinitely.
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  for (const path of ["/icon-192.png", "/manifest.webmanifest", "/apple-touch-icon.png"]) {
    const result = await sw.dispatchFetch(new Request(`${ORIGIN}${path}`));
    assert.equal(result.handled, false, `${path} must not be intercepted`);
  }
});

test("non-GET requests are not intercepted", async () => {
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  const result = await sw.dispatchFetch(new Request(`${ORIGIN}/`, { method: "POST" }));
  assert.equal(result.handled, false);
});

test("cross-origin requests are not intercepted", async () => {
  const sw = await loadServiceWorker({ fetchImpl: online });
  await sw.install();

  const result = await sw.dispatchFetch(new Request("https://fonts.googleapis.com/css2?x=1"));
  assert.equal(result.handled, false);
});
