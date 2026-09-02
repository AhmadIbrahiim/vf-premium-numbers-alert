/**
 * db.js — server-only database access.
 *
 * Runs on Vercel's server side, so `DATABASE_URL` stays a private environment variable
 * and never reaches the browser. This is the whole reason the app moved off GitHub
 * Pages: a static host has no server, which forced either a public database endpoint or
 * a published JSON snapshot. Neither is needed now.
 *
 * Neon speaks SQL over HTTPS, so `fetch` is the entire driver — no `pg`, no connection
 * pooling to reason about in a serverless runtime.
 */

import { buildQuery } from "./queries.js";

/** Fail loudly at the call site rather than serving a confusing empty page. */
function connectionString() {
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is not set");
  return conn;
}

/**
 * Run one whitelisted query.
 *
 * @param {string} route - a route name known to `buildQuery`
 * @param {URLSearchParams|object} [params] - request params, validated by `buildQuery`
 * @returns {Promise<{rows: any[], maxAge: number}>}
 */
export async function query(route, params = {}) {
  const conn = connectionString();
  const { sql, params: bound, maxAge } = buildQuery(route, params);

  const res = await fetch(`https://${new URL(conn).host}/sql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "neon-connection-string": conn,
    },
    body: JSON.stringify({ query: sql, params: bound }),
    cache: "no-store",
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Log the upstream detail server-side; never return it, since it can echo the
    // connection string back to the caller.
    console.error("neon query failed", res.status, body?.message);
    throw new Error("database query failed");
  }

  const rows = Array.isArray(body?.rows) ? body.rows : [];
  // Neon's HTTP layer decodes an empty text[] as [""]; a blank tag would render as an
  // empty pill, so normalise it here rather than in every component.
  return {
    rows: rows.map((r) => (Array.isArray(r.tags) ? { ...r, tags: r.tags.filter(Boolean) } : r)),
    maxAge,
  };
}

/** Available numbers per carrier, plus the total. */
export async function getCounts() {
  const { rows } = await query("counts");
  const by_carrier = {};
  let available_total = 0;
  let new_today = 0;
  for (const r of rows) {
    by_carrier[r.carrier] = r.available;
    available_total += r.available;
    new_today += r.new_today || 0;
  }
  return { by_carrier, available_total, new_today, per_carrier: rows };
}

/** A page of numbers, filtered and sorted by Postgres. */
export async function getNumbers(params) {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query("numbers", params),
    query("numbers_count", params),
  ]);
  return { rows, total: countRows[0]?.total ?? rows.length };
}

/** Per-carrier provider health, most recent poll first. */
export async function getProviderRuns({ window = 48 } = {}) {
  const { rows } = await query("history", { window });
  // `history` returns oldest-first for charting; the status page wants both orders.
  return rows;
}

/** Recent NEW/GONE events. */
export async function getEvents({ limit = 100 } = {}) {
  const { rows } = await query("events", { limit });
  return rows;
}
