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
  ETISALAT_SUFFIX_DIGITS,
  ETISALAT_MAX_SUFFIX_DIGITS,
  ETISALAT_CONCURRENCY,
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
  WE_QUERY_CAP,
  WE_MIN_REQUEST_MS,
  WE_MAX_HICCUPS,
  WE_PREFIX,
  WE_MAX_PREFIX_DIGITS,
  weGradeSlug,
} from "./config.js";

/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[], carrier: string, tier: string }} Record */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Total digits in an Egyptian mobile number. */
const MSISDN_LENGTH = 11;
/** WE works in `telnum`: the msisdn without its leading zero. */
const TELNUM_LENGTH = 10;

/**
 * Run `fn` over `items` with at most `limit` in flight. Keeps us a polite client of
 * live carrier APIs instead of firing hundreds of requests at once.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

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
 * A response is capped at ~1000 numbers, so each pool is partitioned by the last
 * `suffixDigits` digits using the API's fixed-width mask ("011******52"): 100 disjoint
 * buckets per pool, each well under the cap, split further only where one still caps.
 * See the ETISALAT_* block in config.js for why this beats walking prefixes.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000,
 *   pools, prefix, responseCap, suffixDigits, maxSuffixDigits, concurrency }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchEtisalat(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const pools = opts.pools || ETISALAT_POOLS;
  const prefix = opts.prefix ?? ETISALAT_PREFIX;
  const cap = opts.responseCap ?? ETISALAT_RESPONSE_CAP;
  const suffixDigits = opts.suffixDigits ?? ETISALAT_SUFFIX_DIGITS;
  const maxSuffixDigits = opts.maxSuffixDigits ?? ETISALAT_MAX_SUFFIX_DIGITS;
  const concurrency = opts.concurrency ?? ETISALAT_CONCURRENCY;

  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer: ETISALAT_REFERER,
    "user-agent": USER_AGENT,
    applicationName: ETISALAT_APP_NAME,
    applicationPassword: ETISALAT_APP_PASSWORD,
  };

  /**
   * Mask matching every number in `prefix` whose last digits are `suffix`, e.g.
   * prefix "011" + suffix "52" -> "011******52". An 8-digit suffix is an exact number.
   */
  function mask(suffix) {
    const wildcards = MSISDN_LENGTH - prefix.length - suffix.length;
    return prefix + "*".repeat(Math.max(0, wildcards)) + suffix;
  }

  /** One pool+pattern query -> the numbers array. */
  async function query(poolId, pattern) {
    const url = `${ETISALAT_ENDPOINT}&poolId=${poolId}&searchPattern=${encodeURIComponent(pattern)}`;
    const body = await fetchJsonWithRetry({
      doFetch, url, headers, retries, baseDelayMs, timeoutMs,
      label: `fetchEtisalat pool ${poolId} pattern ${pattern}`,
    });
    return Array.isArray(body?.numbers) ? body.numbers : [];
  }

  const byMsisdn = new Map(); // msisdn -> { tier, bonus }
  let returned = 0;
  const truncated = [];

  /**
   * Collect one bucket. A response at the cap means the server withheld some, so fix
   * one more trailing digit and split the bucket ten ways.
   */
  async function collect(pool, suffix) {
    const numbers = await query(pool.poolId, mask(suffix));
    returned += numbers.length;
    for (const n of numbers) {
      const msisdn = String(n);
      if (!MSISDN_RE.test(msisdn)) continue;
      const prev = byMsisdn.get(msisdn);
      if (!prev || pool.bonus > prev.bonus) byMsisdn.set(msisdn, { tier: pool.tier, bonus: pool.bonus });
    }
    if (numbers.length < cap) return;
    if (suffix.length >= maxSuffixDigits) { truncated.push(`${pool.poolId}:${mask(suffix)}`); return; }
    await mapLimit("0123456789".split(""), concurrency, (d) => collect(pool, d + suffix));
  }

  // Every suffix of `suffixDigits` digits: disjoint buckets whose union is the pool.
  const buckets = Array.from({ length: 10 ** suffixDigits }, (_, i) =>
    String(i).padStart(suffixDigits, "0")
  );
  for (const pool of pools) {
    await mapLimit(buckets, concurrency, (suffix) => collect(pool, suffix));
  }

  if (truncated.length) {
    console.warn(
      `[fetchEtisalat] still at the response cap with ${maxSuffixDigits} digits fixed for ` +
      `${truncated.join(", ")} (raise ETISALAT_MAX_SUFFIX_DIGITS)`
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
 * WE truncates any single query at WE_QUERY_CAP (20,000) results, so a big grade is split
 * by fixing more leading digits of the `fitmod` mask until each query fits under the cap —
 * GRADE_006 alone holds 47k+. Anything still incomplete is logged rather than failing the
 * whole run.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000, gradeMin, gradeMax }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchWe(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  // Thousands of requests per run means a transient connection refusal is likely at
  // least once; ride it out rather than failing the whole poll.
  const retries = opts.retries ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const gradeMin = opts.gradeMin ?? WE_GRADE_MIN;
  const gradeMax = opts.gradeMax ?? WE_GRADE_MAX;
  const maxPages = opts.maxPages ?? WE_MAX_PAGES;
  const pageSize = opts.pageSize ?? WE_PAGE_SIZE;
  const concurrency = Math.max(1, opts.concurrency ?? WE_CONCURRENCY);
  const queryCap = opts.queryCap ?? WE_QUERY_CAP;
  const prefix = opts.prefix ?? WE_PREFIX;
  const maxPrefixDigits = opts.maxPrefixDigits ?? WE_MAX_PREFIX_DIGITS;
  const minRequestMs = opts.minRequestMs ?? WE_MIN_REQUEST_MS;
  const maxHiccups = opts.maxHiccups ?? WE_MAX_HICCUPS;

  /** The digit mask for a telnum prefix, e.g. "150" -> "150???????". */
  function fitmodFor(pfx) {
    return pfx + "?".repeat(Math.max(0, TELNUM_LENGTH - pfx.length));
  }

  /** One page of one (grade, fitmod) -> the telnumlist. Throws if WE rejects the query. */
  async function fetchPage(grade, fitmod, page) {
    if (minRequestMs) await sleep(minRequestMs);
    const body = await fetchJsonWithRetry({
      doFetch,
      url: WE_ENDPOINT,
      method: "POST",
      headers: weHeaders(),
      body: JSON.stringify({ fitmod, maxCount: String(pageSize), pageindex: String(page), numberlevel: grade }),
      retries, baseDelayMs, timeoutMs,
      label: `fetchWe ${grade} ${fitmod} p${page}`,
    });
    const retCode = String(body?.header?.retCode ?? "");
    if (retCode !== "0") throw new Error(`fetchWe ${grade} rejected: retCode ${retCode}`);
    return Array.isArray(body?.body?.telnumlist) ? body.body.telnumlist : [];
  }

  const byMsisdn = new Map(); // msisdn -> grade slug (first grade wins)
  let returned = 0;
  const cappedBranches = [];

  /** `count: false` for a page we are re-reading, so `returned` is not double-counted. */
  function absorb(list, grade, { count = true } = {}) {
    if (count) returned += list.length;
    for (const item of list) {
      const msisdn = "0" + String(item?.telnum ?? "");
      if (!MSISDN_RE.test(msisdn)) continue;
      if (!byMsisdn.has(msisdn)) byMsisdn.set(msisdn, grade);
    }
  }

  /**
   * Is this query going to be truncated? Page `floor(cap/pageSize)+1` only has rows when
   * the result set reaches the cap, so one request answers it — far cheaper than
   * enumerating 20,000 rows and then discovering they were incomplete.
   */
  async function isCapped(grade, fitmod) {
    const probe = Math.floor(queryCap / pageSize) + 1;
    if (probe > maxPages) return false;
    const list = await fetchPage(grade, fitmod, probe);
    absorb(list, grade); // it is real inventory, keep it
    return list.length > 0;
  }

  /**
   * Page one (grade, fitmod) to exhaustion, `concurrency` pages at a time.
   *
   * A short page normally means end-of-data, but under load WE also returns short and
   * empty pages spuriously — trusting them silently truncated a branch and made the
   * same grade return 61k, then 56k, then 53k across consecutive runs. So a short page
   * is only believed once confirmed: if a LATER page in the same batch has rows the
   * short one was definitely a hiccup, and otherwise it is re-requested once before we
   * accept it as the end.
   *
   * @returns {Promise<boolean>} true if the branch was genuinely exhausted
   */
  async function enumerate(grade, fitmod) {
    let page = 1;
    let hiccups = 0;
    while (page <= maxPages) {
      const batch = [];
      for (let i = 0; i < concurrency && page + i <= maxPages; i++) batch.push(page + i);
      const lists = await Promise.all(batch.map((p) => fetchPage(grade, fitmod, p)));
      for (const list of lists) absorb(list, grade);

      const shortIdx = lists.findIndex((list) => list.length < pageSize);
      if (shortIdx === -1) {
        page += batch.length;
        continue;
      }

      // Rows after a short page prove the gap was the server's, not the data's.
      if (lists.slice(shortIdx + 1).some((list) => list.length > 0)) {
        if (++hiccups > maxHiccups) return false;
        page = batch[shortIdx];
        continue;
      }

      const confirm = await fetchPage(grade, fitmod, batch[shortIdx]);
      absorb(confirm, grade, { count: false }); // a re-read of a page already counted
      if (confirm.length < pageSize) return true; // short twice: really the end
      if (++hiccups > maxHiccups) return false;
      page = batch[shortIdx] + 1;
    }
    return false;
  }

  /** Collect one branch, splitting the mask when the server would truncate it. */
  async function collect(grade, pfx) {
    const fitmod = fitmodFor(pfx);
    if (await isCapped(grade, fitmod)) {
      if (pfx.length < maxPrefixDigits) {
        await mapLimit("0123456789".split(""), concurrency, (d) => collect(grade, pfx + d));
        return;
      }
      cappedBranches.push(`${grade}:${fitmod}`);
    }
    const exhausted = await enumerate(grade, fitmod);
    if (!exhausted) cappedBranches.push(`${grade}:${fitmod} (hit maxPages)`);
  }

  for (let g = gradeMin; g <= gradeMax; g++) {
    await collect(weGradeSlug(g), prefix);
  }

  if (cappedBranches.length) {
    console.warn(
      `[fetchWe] could not fully enumerate ${cappedBranches.join(", ")} ` +
      `(raise WE_MAX_PREFIX_DIGITS / WE_MAX_PAGES to pull deeper)`
    );
  }

  const records = [...byMsisdn.entries()].map(([msisdn, grade]) => ({
    id: msisdn, msisdn, available: true, price: 0, simType: "", tariffs: [], carrier: "we", tier: grade,
  }));
  return { records, totalElements: records.length, returned };
}

/**
 * Fetch all carriers (Vodafone + Etisalat + WE) and merge.
 *
 * Partial success is reported, not thrown: WE needs thousands of requests a poll and
 * will occasionally throttle us into connect timeouts. Losing every carrier's update
 * because one refused is worse than carrying that one over — state is per-row in
 * Postgres, so the caller updates the carriers in `ok` and leaves the others exactly as
 * they were. Rejects only if EVERY source fails.
 *
 * Each carrier is also timed and its requests counted, which is what feeds the provider
 * status dashboard (`provider_runs`).
 *
 * @param {object} [opts] - forwarded to each fetcher (e.g. fetchImpl, retries, gradeMin/gradeMax)
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number,
 *   ok: string[], failed: Array<{carrier:string, error:string}>,
 *   stats: Array<{carrier:string, ok:boolean, records:number, requests:number, durationMs:number, error:string|null}> }>}
 */
export async function fetchAll(opts = {}) {
  const sources = [
    ["vodafone", fetchVodafone],
    ["etisalat", fetchEtisalat],
    ["we", fetchWe],
  ];
  const baseFetch = opts.fetchImpl || globalThis.fetch;

  const settled = await Promise.allSettled(
    sources.map(async ([carrier, fn]) => {
      let requests = 0;
      const startedAt = Date.now();
      // Count this carrier's HTTP calls without each fetcher having to know about it.
      const counting = (...args) => {
        requests++;
        return baseFetch(...args);
      };
      try {
        const value = await fn({ ...opts, fetchImpl: counting });
        return { carrier, value, requests, durationMs: Date.now() - startedAt };
      } catch (err) {
        // Preserve the telemetry for a failed carrier too — that is the interesting case.
        throw Object.assign(new Error(err?.message || String(err)), {
          carrier, requests, durationMs: Date.now() - startedAt,
        });
      }
    })
  );

  const perCarrier = [];
  const ok = [];
  const failed = [];
  const stats = [];
  let totalElements = 0;
  let returned = 0;

  settled.forEach((result, i) => {
    const carrier = sources[i][0];
    if (result.status === "fulfilled") {
      const { value, requests, durationMs } = result.value;
      ok.push(carrier);
      // Collected and flattened below: `push(...records)` passes every element as an
      // argument, which blows the call stack once a carrier returns ~100k of them.
      perCarrier.push(value.records);
      totalElements += value.totalElements;
      returned += value.returned;
      stats.push({ carrier, ok: true, records: value.records.length, requests, durationMs, error: null });
    } else {
      const err = result.reason || {};
      const message = err.message || String(result.reason);
      failed.push({ carrier, error: message });
      stats.push({
        carrier, ok: false, records: 0,
        requests: err.requests ?? 0, durationMs: err.durationMs ?? 0, error: message,
      });
    }
  });

  if (!ok.length) {
    throw new Error(`every carrier failed: ${failed.map((f) => `${f.carrier}: ${f.error}`).join(" | ")}`);
  }
  return { records: perCarrier.flat(), totalElements, returned, ok, failed, stats };
}
