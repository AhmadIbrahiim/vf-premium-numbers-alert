import { randomUUID } from "node:crypto";
import {
  ENDPOINT,
  X_CONTEXT_REQUEST,
  USER_AGENT,
  REFERER,
} from "./config.js";

/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, tariffs: string[] }} Record */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    tariffs: Array.isArray(r.tariffs)
      ? r.tariffs.filter((t) => t && t.applicable !== false).map((t) => String(t.id))
      : [],
  };
}

/**
 * Fetch the full catalog with retry/backoff. Throws on persistent failure so the
 * caller can skip the run WITHOUT overwriting good data.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000 }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchCatalog(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(ENDPOINT, {
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
      const body = await res.json();
      const content = Array.isArray(body?.content) ? body.content : [];
      const records = content.map(parseRecord).filter((r) => /^01[0125]\d{8}$/.test(r.msisdn));
      const totalElements = Number(body?.totalElements ?? records.length);
      return { records, totalElements, returned: records.length };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetchCatalog failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}
