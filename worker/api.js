/**
 * worker/api.js - read-only HTTP API over the numbers database.
 *
 * The dashboard is a static page on GitHub Pages, so it cannot reach Postgres directly,
 * and a database credential must never sit in a public page. This Worker is the smallest
 * thing that closes that gap: the connection string stays a server-side secret and the
 * client can only ask for one of a fixed set of queries.
 *
 * Security posture:
 *  - No SQL comes from the client. buildQuery maps a route name + validated params onto
 *    a fixed statement with bound parameters; anything unrecognised is rejected.
 *  - Reads only, and only the numbers / provider_runs / number_events tables.
 *  - Row limits are clamped, so no single request can drain the table.
 *  - The data is the carriers' own public listings, already public on their shops.
 *
 * buildQuery is exported apart from the handler so it can be unit-tested in plain Node
 * with no Cloudflare runtime (see test/api.test.js).
 *
 * STYLE NOTE: this file deliberately contains no template literals and no backslashes.
 * It is deployed by inlining its source into a Cloudflare API call that wraps it in
 * backticks, where a backtick, a dollar-brace or an escape sequence would be mangled.
 * Plain quotes, string concatenation, and character classes instead of shorthand
 * regex escapes. The test suite asserts this invariant (see test/api.test.js).
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

/** Neon's SQL-over-HTTP endpoint for a connection string. */
function sqlUrl(connectionString) {
  return "https://" + new URL(connectionString).host + "/sql";
}

/** CORS headers. The origin is echoed only when allowed, never blanket-wildcarded. */
function corsHeaders(origin, allowed) {
  const ok = allowed.indexOf("*") !== -1 || allowed.indexOf(origin) !== -1;
  return {
    "access-control-allow-origin": ok ? origin || "*" : allowed[0] || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(function (s) {
      return s.trim();
    });
    const cors = corsHeaders(request.headers.get("origin"), allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405, headers: cors });
    }

    // First non-empty path segment, so "/status", "status" and "/status/" all match.
    const route = url.pathname.split("/").filter(Boolean)[0] || "counts";
    if (route === "health") {
      return Response.json({ ok: true, routes: ["counts", "numbers", "numbers_count", "status", "history", "events"] }, { headers: cors });
    }

    let query;
    try {
      query = buildQuery(route, url.searchParams);
    } catch (err) {
      return Response.json({ error: err.message }, { status: 400, headers: cors });
    }

    if (!env.DATABASE_URL) {
      return Response.json({ error: "not configured" }, { status: 500, headers: cors });
    }

    try {
      const res = await fetch(sqlUrl(env.DATABASE_URL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "neon-connection-string": env.DATABASE_URL,
        },
        body: JSON.stringify({ query: query.sql, params: query.params }),
      });
      const body = await res.json().catch(function () {
        return null;
      });
      if (!res.ok) {
        // Never echo the upstream detail: it can carry the connection string.
        console.log("neon error", res.status, body && body.message);
        return Response.json({ error: "query failed" }, { status: 502, headers: cors });
      }
      const headers = Object.assign({}, cors, {
        "content-type": "application/json",
        "cache-control": "public, max-age=" + query.maxAge + ", stale-while-revalidate=120",
      });
      return Response.json({ rows: (body && body.rows) || [] }, { headers: headers });
    } catch (err) {
      console.log("worker error", err && err.message);
      return Response.json({ error: "upstream unavailable" }, { status: 502, headers: cors });
    }
  },
};
