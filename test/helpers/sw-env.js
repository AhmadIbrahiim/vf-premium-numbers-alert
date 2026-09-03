import { readFile } from "node:fs/promises";
import vm from "node:vm";

/**
 * Runs public/sw.js for real, in a fake ServiceWorkerGlobalScope.
 *
 * Asserting on the worker's source text is close to worthless — a grep for "/api/"
 * passes whether or not API requests are actually bypassed. This executes the file
 * instead, so the tests exercise the same code the browser runs.
 *
 * The fake Cache Storage is a Map of Maps keyed by request URL. That is a simplification
 * of the real thing (no Vary handling, no ignoreSearch) but matches how the worker uses
 * it: whole-URL lookups only.
 */

const ORIGIN = "https://numbers.test";

class FakeCache {
  constructor(fetchImpl) {
    this.entries = new Map();
    this.fetchImpl = fetchImpl;
  }

  #key(request) {
    return typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
  }

  async match(request) {
    return this.entries.get(this.#key(request));
  }

  async put(request, response) {
    this.entries.set(this.#key(request), response);
  }

  /** Like the real add(): fetches, and rejects if the response is not ok. */
  async add(request) {
    const res = await this.fetchImpl(request);
    if (!res || !res.ok) throw new TypeError("cache.add failed to fetch");
    this.entries.set(this.#key(request), res);
  }
}

/**
 * @param {object} opts
 * @param {(request: Request|string) => Promise<Response>} opts.fetchImpl network stand-in
 * @param {Record<string, string[]>} [opts.existingCaches] cache name -> URLs already in it
 */
export async function loadServiceWorker({ fetchImpl, existingCaches = {} } = {}) {
  const source = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");

  const storage = new Map();
  for (const [name, urls] of Object.entries(existingCaches)) {
    const cache = new FakeCache(fetchImpl);
    for (const url of urls) cache.entries.set(new URL(url, ORIGIN).href, new Response("old"));
    storage.set(name, cache);
  }

  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new FakeCache(fetchImpl));
      return storage.get(name);
    },
    async keys() {
      return [...storage.keys()];
    },
    async delete(name) {
      return storage.delete(name);
    },
  };

  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, navigationPreloadEnabled: 0 };

  const self = {
    location: new URL(`${ORIGIN}/`),
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    async skipWaiting() {
      calls.skipWaiting++;
    },
    clients: {
      async claim() {
        calls.claim++;
      },
    },
    registration: {
      navigationPreload: {
        async enable() {
          calls.navigationPreloadEnabled++;
        },
      },
    },
  };

  // In a real worker a relative URL resolves against the worker's own location;
  // Node's Request requires an absolute one, so do that resolution here.
  class ScopedRequest extends Request {
    constructor(input, init) {
      super(typeof input === "string" ? new URL(input, `${ORIGIN}/`).href : input, init);
    }
  }

  vm.runInNewContext(
    source,
    { self, caches, fetch: fetchImpl, Request: ScopedRequest, Response, URL, console },
    { filename: "sw.js" }
  );

  /** Fire install/activate and wait for whatever the worker passed to waitUntil. */
  async function lifecycle(type) {
    const pending = [];
    await listeners.get(type)({ waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  }

  /**
   * Fire a fetch event. Resolves to `{ handled: false }` when the worker declined to
   * intercept — which is the assertion that matters for /api and for stable URLs.
   */
  async function dispatchFetch(request, { preloadResponse } = {}) {
    const handler = listeners.get("fetch");
    let responsePromise = null;
    const extended = [];
    await handler({
      request,
      preloadResponse: Promise.resolve(preloadResponse),
      respondWith: (p) => {
        responsePromise = p;
      },
      waitUntil: (p) => extended.push(p),
    });
    if (!responsePromise) return { handled: false };
    const response = await responsePromise;
    await Promise.all(extended);
    return { handled: true, response, extendedCount: extended.length };
  }

  return { install: () => lifecycle("install"), activate: () => lifecycle("activate"), dispatchFetch, caches: storage, calls, ORIGIN };
}

/**
 * A GET the worker will treat as a page navigation.
 *
 * `mode: "navigate"` is not constructible — the browser sets it itself and rejects it
 * as an init option — so the getter is shadowed to produce what a real navigation looks
 * like to a fetch handler.
 */
export function navigation(path) {
  const request = new Request(new URL(path, ORIGIN));
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

export { ORIGIN };
