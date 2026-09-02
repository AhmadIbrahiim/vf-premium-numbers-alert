import { randomUUID } from "node:crypto";
import {
  VF_TYPES,
  vodafoneEndpoint,
  X_CONTEXT_REQUEST,
  USER_AGENT,
  REFERER,
  ETISALAT_ENDPOINT,
  ETISALAT_REFERER,
  ETISALAT_APP_NAME,
  ETISALAT_APP_PASSWORD,
  ETISALAT_POOLS,
  ETISALAT_PREFIX,
  ETISALAT_RESPONSE_CAP,
  ETISALAT_MAX_DEPTH,
  WE_ENDPOINT,
  WE_CHANNEL_ID,
  WE_DEVICE_ID,
  WE_HEADER_SIGN,
  WE_BODY_SIGN,
  WE_INIT_TIME,
  WE_GRADE_MIN,
  WE_GRADE_MAX,
  WE_PAGE_SIZE,
  WE_MAX_PAGES,
  WE_CONCURRENCY,
  weGradeSlug,
} from "./config.js";

/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[], carrier: string, tier: string }} Record */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MSISDN_RE = /^01[0125]\d{8}$/;

/**
 * Issue `url` (GET by default, or POST with `body`) and return parsed JSON, with
 * retry/backoff. Fails fast on non-429 4xx (breaks out of the retry loop immediately).
 * Throws (with `label` in the message) on persistent failure.
 */
async function fetchJsonWithRetry({ doFetch, url, method = "GET", headers, body, retries, baseDelayMs, timeoutMs, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method, signal: controller.signal, headers, ...(body != null ? { body } : {}) });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        // 4xx (other than 429) won't fix themselves on retry — stop retrying immediately.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
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

/** Catalog URL for one line type with size/page forced for the pager. */
function pageUrl(type, page) {
  const url = new URL(vodafoneEndpoint(type));
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
  const types = opts.types || VF_TYPES;

  // Fetch a single page of one line type (with retry/backoff); throws on persistent failure.
  async function fetchPage(type, page) {
    return fetchJsonWithRetry({
      doFetch,
      url: pageUrl(type, page),
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
      label: `fetchVodafone ${type} page ${page}`,
    });
  }

  const byMsisdn = new Map(); // msisdn -> Record (first line type wins)
  let totalElements = 0;
  let returned = 0;
  for (const type of types) {
    let seen = 0;
    let typeTotal = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = await fetchPage(type, page);
      const content = Array.isArray(body?.content) ? body.content : [];
      if (page === 0) typeTotal = Number(body?.totalElements ?? 0);
      seen += content.length;
      for (const raw of content) {
        const r = parseRecord(raw);
        if (!MSISDN_RE.test(r.msisdn)) continue;
        if (!byMsisdn.has(r.msisdn)) byMsisdn.set(r.msisdn, r);
      }
      // Stop when the catalog is exhausted: a short/empty page is the last one, or
      // we've already collected everything the server says exists.
      if (content.length < PAGE_SIZE) break;
      if (typeTotal && seen >= typeTotal) break;
    }
    totalElements += typeTotal || seen;
    returned += seen;
  }

  const records = [...byMsisdn.values()];
  if (!totalElements) totalElements = records.length;
  // `returned` reflects how many the server actually handed us (pre-msisdn-filter,
  // pre-dedupe), so the caller's truncation check fires only on genuine shortfall.
  return { records, totalElements, returned };
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
  const rootPrefix = opts.prefix ?? ETISALAT_PREFIX;
  const cap = opts.responseCap ?? ETISALAT_RESPONSE_CAP;
  const maxDepth = opts.maxDepth ?? ETISALAT_MAX_DEPTH;

  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer: ETISALAT_REFERER,
    "user-agent": USER_AGENT,
    applicationName: ETISALAT_APP_NAME,
    applicationPassword: ETISALAT_APP_PASSWORD,
  };

  /** One pool+pattern query -> the numbers array. */
  async function query(poolId, pattern) {
    const url = `${ETISALAT_ENDPOINT}&poolId=${poolId}&searchPattern=${encodeURIComponent(pattern + "*")}`;
    const body = await fetchJsonWithRetry({
      doFetch, url, headers, retries, baseDelayMs, timeoutMs,
      label: `fetchEtisalat pool ${poolId} pattern ${pattern}*`,
    });
    return Array.isArray(body?.numbers) ? body.numbers : [];
  }

  const byMsisdn = new Map(); // msisdn -> { tier, bonus }
  let returned = 0;
  const truncated = [];

  /**
   * Collect one pool under `prefix`. A response at the server cap means there are
   * more numbers than it will hand over, so split into `<prefix><digit>` and recurse.
   */
  async function collect(pool, prefix, depth) {
    const numbers = await query(pool.poolId, prefix);
    returned += numbers.length;
    for (const n of numbers) {
      const msisdn = String(n);
      if (!MSISDN_RE.test(msisdn)) continue;
      const prev = byMsisdn.get(msisdn);
      if (!prev || pool.bonus > prev.bonus) byMsisdn.set(msisdn, { tier: pool.tier, bonus: pool.bonus });
    }
    if (numbers.length < cap) return; // complete for this prefix
    if (depth >= maxDepth) { truncated.push(`${pool.poolId}:${prefix}*`); return; }
    // Digits are independent sub-ranges; fetch the ten of them together.
    await Promise.all(
      "0123456789".split("").map((d) => collect(pool, prefix + d, depth + 1))
    );
  }

  for (const pool of pools) await collect(pool, rootPrefix, 0);

  if (truncated.length) {
    console.warn(
      `[fetchEtisalat] still at the response cap at max depth for ${truncated.join(", ")} ` +
      `(raise ETISALAT_MAX_DEPTH to split further)`
    );
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

/** Build the WE static gating headers (x-client-time is per-request but not signed). */
function weHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    csrftoken: "",
    languageCode: "en-US",
    isMobile: "false",
    isCoporate: "true",
    isSelfcare: "true",
    channelId: WE_CHANNEL_ID,
    isOperator: "false",
    isRetail: "false",
    isDealer: "false",
    isDealerCust: "N",
    deviceId: WE_DEVICE_ID,
    "x-client-time": String(Date.now()),
    "x-init-time": WE_INIT_TIME,
    whiteReqHeaderSign: WE_HEADER_SIGN,
    whiteReqBodySign: WE_BODY_SIGN,
  };
}

/**
 * Fetch WE premium numbers across all inventory grades. For each grade GRADE_min..max,
 * page through results (all-wildcard pattern) until a short/empty page or the WE_MAX_PAGES
 * cap. Maps each telnum (integer, no leading 0) to an msisdn. Dedupes by msisdn (first grade
 * wins). Throws on a rejected query (retCode != "0") or transport failure.
 *
 * WE grades can hold many thousands of numbers (the deepest observed runs ~392 pages),
 * returned in a STABLE ascending numeric order. WE_MAX_PAGES is a safety bound well above
 * real inventory; if a grade somehow still fills it, that is expected sampling rather than
 * unknown truncation (the first N pages are the same set run-to-run, so a cap does not cause
 * false "gone" churn). We log such grades rather than failing the whole run.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000, gradeMin, gradeMax }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchWe(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const gradeMin = opts.gradeMin ?? WE_GRADE_MIN;
  const gradeMax = opts.gradeMax ?? WE_GRADE_MAX;
  const maxPages = opts.maxPages ?? WE_MAX_PAGES;
  const concurrency = Math.max(1, opts.concurrency ?? WE_CONCURRENCY);

  /** One page of one grade -> the telnumlist. Throws if WE rejects the query. */
  async function fetchPage(grade, page) {
    const body = await fetchJsonWithRetry({
      doFetch,
      url: WE_ENDPOINT,
      method: "POST",
      headers: weHeaders(),
      body: JSON.stringify({ fitmod: "15????????", maxCount: String(WE_PAGE_SIZE), pageindex: String(page), numberlevel: grade }),
      retries, baseDelayMs, timeoutMs,
      label: `fetchWe ${grade} p${page}`,
    });
    const retCode = String(body?.header?.retCode ?? "");
    if (retCode !== "0") throw new Error(`fetchWe ${grade} rejected: retCode ${retCode}`);
    return Array.isArray(body?.body?.telnumlist) ? body.body.telnumlist : [];
  }

  const byMsisdn = new Map(); // msisdn -> grade slug (first grade wins)
  let returned = 0;
  const cappedGrades = [];

  for (let g = gradeMin; g <= gradeMax; g++) {
    const grade = weGradeSlug(g);
    let exhausted = false;
    // Pages are independent, so pull them `concurrency` at a time; a short page in
    // the batch is the end of this grade's inventory.
    for (let page = 1; page <= maxPages && !exhausted; page += concurrency) {
      const batch = [];
      for (let i = 0; i < concurrency && page + i <= maxPages; i++) batch.push(page + i);
      const lists = await Promise.all(batch.map((p) => fetchPage(grade, p)));
      for (const list of lists) {
        returned += list.length;
        for (const item of list) {
          const msisdn = "0" + String(item?.telnum ?? "");
          if (!MSISDN_RE.test(msisdn)) continue;
          if (!byMsisdn.has(msisdn)) byMsisdn.set(msisdn, grade);
        }
        if (list.length < WE_PAGE_SIZE) exhausted = true;
      }
    }
    // Best-effort: a grade still full at the cap is sampled (stable numeric order), not failed.
    if (!exhausted) cappedGrades.push(grade);
  }
  if (cappedGrades.length) {
    console.warn(
      `[fetchWe] sampled first ${maxPages} pages for ${cappedGrades.join(", ")} ` +
      `(inventory exceeds the cap; raise WE_MAX_PAGES to pull deeper)`
    );
  }

  const records = [...byMsisdn.entries()].map(([msisdn, grade]) => ({
    id: msisdn, msisdn, available: true, price: 0, simType: "", tariffs: [], carrier: "we", tier: grade,
  }));
  return { records, totalElements: records.length, returned };
}

/**
 * Fetch all carriers (Vodafone + Etisalat + WE) and merge. Rejects if ANY source rejects,
 * so the caller skips the run and never overwrites good data with a partial set.
 *
 * @param {object} [opts] - forwarded to each fetcher (e.g. fetchImpl, retries, gradeMin/gradeMax)
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchAll(opts = {}) {
  const [vf, et, we] = await Promise.all([fetchVodafone(opts), fetchEtisalat(opts), fetchWe(opts)]);
  return {
    records: [...vf.records, ...et.records, ...we.records],
    totalElements: vf.totalElements + et.totalElements + we.totalElements,
    returned: vf.returned + et.returned + we.returned,
  };
}
