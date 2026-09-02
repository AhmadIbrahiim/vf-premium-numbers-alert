/**
 * queries.js — every database query the dashboard can run, as parameterised SQL.
 *
 * The route handlers never build SQL from request input. `buildQuery` maps a route name
 * plus validated params onto a fixed statement with bound parameters, and rejects
 * anything it does not recognise. Row limits are clamped so no single request can drain
 * the table.
 *
 * Pure and runtime-free on purpose, so it is unit-tested directly in Node
 * (test/queries.test.js) without booting Next.
 */

/** Hard ceiling on rows per request, whatever the client asks for. */
export const MAX_LIMIT = 500;

/** Carriers we will filter by. Anything else is rejected rather than reaching SQL. */
export const CARRIERS = ["vodafone", "etisalat", "we"];

/** Sort keys the client may choose, mapped onto trusted ORDER BY fragments. */
const SORTS = {
  score: "score desc, msisdn",
  grade: "best_grade desc, score desc, msisdn",
  new: "first_seen desc, score desc, msisdn",
  msisdn: "msisdn",
};

const NUMBER_COLUMNS =
  "select msisdn, score, best_grade, tags, sim_type, carrier, tier, available, " +
  "to_char(first_seen, 'YYYY-MM-DD') as first_seen, " +
  "(current_date - first_seen) as age_days, " +
  "first_seen = current_date as is_new from numbers ";

/**
 * Clamp a value to an integer within [min, max], falling back to def.
 *
 * Missing means missing: Number(null) and Number("") are both 0, so without this guard
 * an absent limit clamped to the minimum and returned a single row.
 */
function clampInt(value, def, min, max) {
  if (value === null || value === undefined || value === "") return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Only digits survive - that is all a number search is allowed to contain. */
function digitsOnly(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[^0-9]/g, "");
}

/** Shared WHERE builder for the two number routes, so their totals always agree. */
function numberFilter(get) {
  const carrier = get("carrier");
  if (carrier && carrier !== "all" && CARRIERS.indexOf(carrier) === -1) {
    throw new Error("unknown carrier");
  }
  const view = get("view") === "ever" ? "ever" : "now";
  const digits = digitsOnly(get("q")).slice(0, 11);
  const where = [];
  const bound = [];
  if (view === "now") where.push("available");
  if (carrier && carrier !== "all") {
    bound.push(carrier);
    where.push("carrier = $" + bound.length);
  }
  if (digits) {
    bound.push("%" + digits + "%");
    where.push("msisdn like $" + bound.length);
  }
  return { clause: where.length ? "where " + where.join(" and ") + " " : "", bound };
}

/**
 * Map a route + query params onto a parameterised statement.
 *
 * @param {string} route
 * @param {URLSearchParams|Map|object} params
 * @returns {{ sql: string, params: any[], maxAge: number }}
 * @throws {Error} on an unknown route or an invalid parameter
 */
export function buildQuery(route, params) {
  const p = params || {};
  const get = function (k) {
    return typeof p.get === "function" ? p.get(k) : p[k];
  };

  if (route === "counts") {
    return {
      sql:
        "select carrier, count(*)::int as available, max(score)::int as top_score, " +
        "count(*) filter (where first_seen = current_date)::int as new_today " +
        "from numbers where available group by carrier order by carrier",
      params: [],
      maxAge: 60,
    };
  }

  if (route === "numbers") {
    const sortKey = get("sort") || "score";
    if (!SORTS[sortKey]) throw new Error("unknown sort");
    const f = numberFilter(get);
    const limit = clampInt(get("limit"), 100, 1, MAX_LIMIT);
    const offset = clampInt(get("offset"), 0, 0, 1000000);
    f.bound.push(limit, offset);
    return {
      sql:
        NUMBER_COLUMNS + f.clause +
        "order by " + SORTS[sortKey] +
        " limit $" + (f.bound.length - 1) + " offset $" + f.bound.length,
      params: f.bound,
      maxAge: 30,
    };
  }

  if (route === "numbers_count") {
    const f = numberFilter(get);
    return {
      sql: "select count(*)::int as total from numbers " + f.clause,
      params: f.bound,
      maxAge: 30,
    };
  }

  if (route === "status") {
    return {
      sql:
        "with recent as (select *, row_number() over " +
        "(partition by carrier order by run_at desc) rn from provider_runs), " +
        "windowed as (select * from recent where rn <= $1) select w.carrier, " +
        "max(w.run_at) filter (where w.rn = 1) as last_run_at, " +
        "bool_or(w.ok) filter (where w.rn = 1) as last_ok, " +
        "bool_or(w.trusted) filter (where w.rn = 1) as last_trusted, " +
        "max(w.records) filter (where w.rn = 1) as last_records, " +
        "max(w.requests) filter (where w.rn = 1) as last_requests, " +
        "max(w.duration_ms) filter (where w.rn = 1) as last_duration_ms, " +
        "max(w.error) filter (where w.rn = 1) as last_error, " +
        "max(w.run_at) filter (where w.ok) as last_success_at, " +
        "count(*)::int as polls, count(*) filter (where w.ok)::int as polls_ok, " +
        "count(*) filter (where w.trusted)::int as polls_trusted, " +
        "round(avg(w.duration_ms))::int as avg_duration_ms, " +
        "round(avg(w.requests))::int as avg_requests, " +
        "(select count(*)::int from numbers n where n.available and n.carrier = w.carrier) " +
        "as available_now from windowed w group by w.carrier order by w.carrier",
      params: [clampInt(get("window"), 48, 1, 500)],
      maxAge: 30,
    };
  }

  if (route === "history") {
    return {
      sql:
        "select carrier, run_at, ok, trusted, records, requests, duration_ms from " +
        "(select *, row_number() over (partition by carrier order by run_at desc) rn " +
        "from provider_runs) t where rn <= $1 order by run_at asc",
      params: [clampInt(get("window"), 48, 1, 500)],
      maxAge: 30,
    };
  }

  if (route === "events") {
    return {
      sql:
        "select ts, day, type, msisdn, carrier, score from number_events " +
        "order by ts desc, id desc limit $1",
      params: [clampInt(get("limit"), 100, 1, MAX_LIMIT)],
      maxAge: 30,
    };
  }

  throw new Error("unknown route");
}
