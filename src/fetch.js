import { randomUUID } from "node:crypto";
import {
  ENDPOINT,
  X_CONTEXT_REQUEST,
  USER_AGENT,
  REFERER,
} from "./config.js";

/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[] }} Record */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export async function fetchCatalog(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const maxPages = opts.maxPages ?? MAX_PAGES;

  // Fetch a single page (with retry/backoff); throws on persistent failure.
  async function fetchPage(page) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(pageUrl(page), {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "accept-language": "en_US",
            "user-agent": USER_AGENT,
            referer: REFERER,
            traceid: randomUUID(),
            "x-context-request": X_CONTEXT_REQUEST,
          },
        });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          // 4xx (other than 429) won't fix themselves on retry — fail fast.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            throw lastErr;
          }
          continue;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`fetchCatalog page ${page} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
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

  const records = raw.map(parseRecord).filter((r) => /^01[0125]\d{8}$/.test(r.msisdn));
  if (!totalElements) totalElements = records.length;
  // `returned` reflects how many the server actually handed us (pre-msisdn-filter),
  // so the caller's truncation check fires only on genuine pagination shortfall.
  return { records, totalElements, returned: raw.length };
}
