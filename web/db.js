/**
 * db.js — the dashboard's data access layer.
 *
 * Every page reads Postgres live through Neon's Data API (PostgREST). Nothing is
 * published as a JSON snapshot any more, so there is no stale copy to serve and search
 * covers the whole catalogue rather than a pre-computed slice.
 *
 * Only reads happen here. The anonymous role the Data API uses is granted SELECT on
 * `numbers`, `provider_runs` and `number_events` and nothing else.
 */

const CFG = () => window.VF_CONFIG || {};

/** True when the Data API has been pointed at (see web/config.js). */
export function isConfigured() {
  return Boolean(CFG().base);
}

/** Thrown so callers can tell "not set up yet" from "the query failed". */
export class NotConfiguredError extends Error {
  constructor() {
    super("The Data API endpoint is not configured (see web/config.js).");
    this.name = "NotConfiguredError";
  }
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
export function fetchNumbers({ view = "now", carrier = "all", digits = "", sort = "score", limit = 100, offset = 0 } = {}) {
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

/** Available numbers per carrier, straight from the database. */
export async function fetchCounts() {
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
  const { rows } = await select("number_events", {
    select: "ts,day,type,msisdn,carrier,score",
    order: "ts.desc",
    limit,
  });
  return rows;
}
