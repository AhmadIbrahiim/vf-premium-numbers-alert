/**
 * db.js — the dashboard's data access layer.
 *
 * Preferred path: read Postgres live through Neon's Data API (PostgREST), so filtering,
 * sorting and paging happen in the database and a search covers the whole ~206k
 * catalogue. Only reads happen here; the anonymous role is granted SELECT on
 * `numbers`, `provider_runs` and `number_events` and nothing else.
 *
 * Fallback path: until the Data API is switched on (a one-time toggle on the Neon
 * project), `web/config.js` has no endpoint and there is nothing a static page can
 * query — so these same functions serve from `snapshot.json` / `status.json`, which the
 * poller derives from Postgres on every run. That covers browsing and the status view;
 * search is limited to the snapshot rather than the full table, and the UI says so.
 * Setting `base` in config.js switches everything to live queries with no other change.
 */

const CFG = () => window.VF_CONFIG || {};

/** True when the Data API has been pointed at (see web/config.js). */
export function isConfigured() {
  return Boolean(CFG().base);
}

/** True when we are serving the published snapshot rather than live queries. */
export function isFallback() {
  return !isConfigured();
}

/** Thrown so callers can tell "no data source at all" from "the query failed". */
export class NotConfiguredError extends Error {
  constructor() {
    super("No data source available.");
    this.name = "NotConfiguredError";
  }
}

/* ------------------------- fallback snapshot ------------------------- */

let snapshotPromise = null;
let statusPromise = null;

/** Fetch (once) the snapshot the poller published from Postgres. */
function loadSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = fetch("./snapshot.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("snapshot unavailable"))))
      .catch((err) => {
        snapshotPromise = null; // let a later call retry
        throw err;
      });
  }
  return snapshotPromise;
}

function loadStatusSnapshot() {
  if (!statusPromise) {
    statusPromise = fetch("./status.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("status unavailable"))))
      .catch((err) => {
        statusPromise = null;
        throw err;
      });
  }
  return statusPromise;
}

/** Apply the same filters/sort the database would, over the snapshot rows. */
function querySnapshot(rows, { view, carrier, digits, sort, limit, offset }) {
  let out = rows;
  if (view === "now") out = out.filter((r) => r.available !== false);
  if (carrier !== "all") out = out.filter((r) => r.carrier === carrier);
  if (digits) out = out.filter((r) => String(r.msisdn).includes(digits));
  const cmp = {
    score: (a, b) => (b.score || 0) - (a.score || 0) || String(a.msisdn).localeCompare(b.msisdn),
    grade: (a, b) => (b.best_grade || 0) - (a.best_grade || 0) || (b.score || 0) - (a.score || 0),
    new: (a, b) => String(b.first_seen || "").localeCompare(a.first_seen || "") || (b.score || 0) - (a.score || 0),
    msisdn: (a, b) => String(a.msisdn).localeCompare(b.msisdn),
  };
  out = [...out].sort(cmp[sort] || cmp.score);
  return { rows: out.slice(offset, offset + limit), total: out.length };
}

function headers(extra = {}) {
  const h = { accept: "application/json", ...extra };
  const token = CFG().token;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * One PostgREST request.
 * @param {string} table
 * @param {Record<string,string|number>} query - PostgREST params (select, order, limit…)
 * @param {object} [opts] - { count: true } to also return the total via Content-Range
 * @returns {Promise<{rows: any[], total: number|null}>}
 */
export async function select(table, query = {}, opts = {}) {
  if (!isConfigured()) throw new NotConfiguredError();
  const url = new URL(`${CFG().base.replace(/\/+$/, "")}/${table}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // `count=exact` makes PostgREST report the unpaged total in Content-Range.
  const extra = opts.count ? { prefer: "count=exact" } : {};
  const res = await fetch(url, { headers: headers(extra), cache: "no-store" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Data API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const rows = await res.json();
  const range = res.headers.get("content-range");
  const total = range && range.includes("/") ? Number(range.split("/")[1]) : null;
  return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) ? total : null };
}

/** Escape a value for a PostgREST `like` filter. */
function likePattern(digits) {
  return `*${digits}*`;
}

/**
 * A page of numbers, filtered and sorted in Postgres.
 *
 * @param {object} p - { view, carrier, digits, sort, limit, offset }
 * @returns {Promise<{rows:any[], total:number|null}>}
 */
export async function fetchNumbers({ view = "now", carrier = "all", digits = "", sort = "score", limit = 100, offset = 0 } = {}) {
  if (isFallback()) {
    const snap = await loadSnapshot();
    return querySnapshot(snap.rows || [], { view, carrier, digits, sort, limit, offset });
  }
  const ORDER = {
    score: "score.desc,msisdn.asc",
    grade: "best_grade.desc,score.desc,msisdn.asc",
    new: "first_seen.desc,score.desc,msisdn.asc",
    msisdn: "msisdn.asc",
  };
  const query = {
    select: "msisdn,score,best_grade,tags,sim_type,carrier,tier,available,first_seen",
    order: ORDER[sort] || ORDER.score,
    limit,
    offset,
  };
  if (view === "now") query.available = "is.true";
  if (carrier !== "all") query.carrier = `eq.${carrier}`;
  if (digits) query.msisdn = `like.${likePattern(digits)}`;
  return select("numbers", query, { count: true });
}

/** How many numbers the current data source can actually see, for the count line. */
export async function fetchScope() {
  if (isFallback()) {
    const snap = await loadSnapshot();
    return { live: false, searchable: (snap.rows || []).length, total: snap.available_total ?? 0 };
  }
  return { live: true, searchable: null, total: null };
}

/** Available numbers per carrier. */
export async function fetchCounts() {
  if (isFallback()) {
    const snap = await loadSnapshot();
    return { by_carrier: snap.by_carrier || {}, available_total: snap.available_total ?? 0 };
  }
  // PostgREST has no GROUP BY, so ask for each carrier's count with a head-style request.
  const carriers = ["vodafone", "etisalat", "we"];
  const results = await Promise.all(
    carriers.map((c) =>
      select("numbers", { select: "msisdn", available: "is.true", carrier: `eq.${c}`, limit: 1 }, { count: true })
        .then((r) => [c, r.total ?? 0])
    )
  );
  const by_carrier = Object.fromEntries(results);
  return { by_carrier, available_total: results.reduce((a, [, n]) => a + n, 0) };
}

/** Per-carrier provider health for the status page. */
export async function fetchProviderRuns(window = 48) {
  if (isFallback()) {
    const snap = await loadStatusSnapshot();
    return snap.runs || [];
  }
  const { rows } = await select("provider_runs", {
    select: "run_at,carrier,ok,trusted,records,requests,duration_ms,error",
    order: "run_at.desc",
    // Three carriers per poll, so this covers roughly `window` polls.
    limit: Math.max(3, window * 3),
  });
  return rows;
}

/** Recent NEW/GONE events for the change timeline. */
export async function fetchEvents(limit = 200) {
  if (isFallback()) {
    const snap = await loadSnapshot();
    return (snap.events || []).slice(0, limit);
  }
  const { rows } = await select("number_events", {
    select: "ts,day,type,msisdn,carrier,score",
    order: "ts.desc",
    limit,
  });
  return rows;
}
