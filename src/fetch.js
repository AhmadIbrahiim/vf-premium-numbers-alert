import { randomUUID } from "node:crypto";
import {
  ENDPOINT,
  X_CONTEXT_REQUEST,
  USER_AGENT,
  REFERER,
  ETISALAT_ENDPOINT,
  ETISALAT_REFERER,
  ETISALAT_APP_NAME,
  ETISALAT_APP_PASSWORD,
  ETISALAT_POOLS,
} from "./config.js";

/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[], carrier: string, tier: string }} Record */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MSISDN_RE = /^01[0125]\d{8}$/;

/**
 * GET `url` and return parsed JSON, with retry/backoff. Fails fast on non-429 4xx.
 * Throws (with `label` in the message) on persistent failure.
 */
async function fetchJsonWithRetry({ doFetch, url, headers, retries, baseDelayMs, timeoutMs, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: "GET", signal: controller.signal, headers });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

/** The catalog API hard-caps a page at 2000 items regardless of the requested size. */
const PAGE_SIZE = 2000;
/** Safety bound on pagination (50k numbers) so a bad totalElements can't loop forever. */
const MAX_PAGES = 25;

/** Clone ENDPOINT with size/page forced to fetch one page of the paginated catalog. */
function pageUrl(page) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("size", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url.toString();
}

/**
 * Map one raw API record to our compact shape.
 * @param {any} r
 * @returns {Record}
 */
function parseRecord(r) {
  return {
    id: String(r.id ?? ""),
    msisdn: String(r.msisdn ?? ""),
    available: Boolean(r.available),
    price: Number(r?.defaultPrice?.amount ?? 0),
    simType: String(r.simType ?? ""),
    tariffs: Array.isArray(r.tariffs)
      ? r.tariffs.filter((t) => t && t.applicable !== false).map((t) => String(t.id))
      : [],
    carrier: "vodafone",
    tier: "",
  };
}

/**
 * Fetch the full catalog with retry/backoff, paging through every result page
 * (the API caps a page at PAGE_SIZE, so the multi-thousand catalog spans several).
 * Throws on persistent failure so the caller can skip the run WITHOUT overwriting
 * good data.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000, maxPages=25 }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchVodafone(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const maxPages = opts.maxPages ?? MAX_PAGES;

  // Fetch a single page (with retry/backoff); throws on persistent failure.
  async function fetchPage(page) {
    return fetchJsonWithRetry({
      doFetch,
      url: pageUrl(page),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": "en_US",
        "user-agent": USER_AGENT,
        referer: REFERER,
        traceid: randomUUID(),
        "x-context-request": X_CONTEXT_REQUEST,
      },
      retries,
      baseDelayMs,
      timeoutMs,
      label: `fetchVodafone page ${page}`,
    });
  }

  const raw = [];
  let totalElements = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(page);
    const content = Array.isArray(body?.content) ? body.content : [];
    if (page === 0) totalElements = Number(body?.totalElements ?? 0);
    raw.push(...content);
    // Stop when the catalog is exhausted: a short/empty page is the last one, or
    // we've already collected everything the server says exists.
    if (content.length < PAGE_SIZE) break;
    if (totalElements && raw.length >= totalElements) break;
  }

  const records = raw.map(parseRecord).filter((r) => MSISDN_RE.test(r.msisdn));
  if (!totalElements) totalElements = records.length;
  // `returned` reflects how many the server actually handed us (pre-msisdn-filter),
  // so the caller's truncation check fires only on genuine pagination shortfall.
  return { records, totalElements, returned: raw.length };
}

/**
 * Fetch all Etisalat premium pools, mapping each available number to a record.
 * Dedupes by msisdn keeping the highest-bonus tier. Throws on persistent
 * per-pool failure so the caller can skip the run without overwriting data.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000, pools }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchEtisalat(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const pools = opts.pools || ETISALAT_POOLS;

  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer: ETISALAT_REFERER,
    "user-agent": USER_AGENT,
    applicationName: ETISALAT_APP_NAME,
    applicationPassword: ETISALAT_APP_PASSWORD,
  };

  const byMsisdn = new Map(); // msisdn -> { tier, bonus }
  let returned = 0;
  for (const pool of pools) {
    const url = `${ETISALAT_ENDPOINT}&poolId=${pool.poolId}&searchPattern=*`;
    const body = await fetchJsonWithRetry({
      doFetch, url, headers, retries, baseDelayMs, timeoutMs,
      label: `fetchEtisalat pool ${pool.poolId}`,
    });
    const numbers = Array.isArray(body?.numbers) ? body.numbers : [];
    returned += numbers.length;
    for (const n of numbers) {
      const msisdn = String(n);
      if (!MSISDN_RE.test(msisdn)) continue;
      const prev = byMsisdn.get(msisdn);
      if (!prev || pool.bonus > prev.bonus) byMsisdn.set(msisdn, { tier: pool.tier, bonus: pool.bonus });
    }
  }

  const records = [...byMsisdn.entries()].map(([msisdn, { tier }]) => ({
    id: msisdn,
    msisdn,
    available: true,
    price: 0,
    simType: "",
    tariffs: [],
    carrier: "etisalat",
    tier,
  }));
  return { records, totalElements: records.length, returned };
}
