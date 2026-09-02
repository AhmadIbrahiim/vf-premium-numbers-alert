/**
 * db.js — Neon Postgres state store.
 *
 * Replaces the old history.json blob. That file had to be read, rewritten whole and
 * committed to gh-pages every run; at ~160k numbers it was 27MB a run, which forced
 * us to only track a slice. Postgres tracks every number the carriers list, exactly:
 * real first_seen for all of them, real NEW/GONE diffs, no rewrite churn.
 *
 * Zero dependencies: Neon speaks SQL over HTTPS, so `fetch` is the whole driver.
 * One statement per request, parameterised ($1, $2, …) — never string-interpolated.
 */

/** Rows per multi-row upsert. Keeps a single request body well under Neon's limit. */
const UPSERT_BATCH = 5000;

/**
 * The Neon connection string. Read from the environment on every call rather than
 * captured at import time, so a test (or a re-imported module) sees the current value.
 */
function connectionString(opts = {}) {
  return opts.connectionString || process.env.DATABASE_URL || "";
}

/** Whether a database is configured at all (the pipeline refuses to run without one). */
export function hasDb() {
  return Boolean(connectionString());
}

/** The SQL-over-HTTP endpoint derived from the connection string. */
function sqlUrl(connectionString) {
  return `https://${new URL(connectionString).host}/sql`;
}

/**
 * Run one parameterised statement and return its rows.
 * @param {string} query - SQL with $1-style placeholders
 * @param {any[]} [params]
 * @param {object} [opts] - { fetchImpl, connectionString, timeoutMs=60000 }
 * @returns {Promise<any[]>}
 */
export async function sql(query, params = [], opts = {}) {
  const conn = connectionString(opts);
  if (!conn) throw new Error("DATABASE_URL is not set");
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await doFetch(sqlUrl(conn), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "neon-connection-string": conn,
      },
      body: JSON.stringify({ query, params }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // Neon returns the Postgres error text; surface it without the connection string.
      throw new Error(`SQL HTTP ${res.status}: ${body?.message || body?.error || "unknown error"}`);
    }
    return Array.isArray(body?.rows) ? body.rows : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Create the table + indexes if they don't exist. Safe to call every run. */
export async function migrate(opts = {}) {
  await sql(
    `create table if not exists numbers (
       msisdn      text primary key,
       carrier     text not null,
       tier        text not null default '',
       sim_type    text not null default '',
       score       integer not null default 0,
       tags        text[] not null default '{}',
       best_grade  integer not null default 0,
       first_seen  date not null,
       last_seen   date not null,
       available   boolean not null default true,
       run_seq     bigint not null default 0
     )`,
    [],
    opts
  );
  for (const [name, cols] of [
    ["numbers_avail_score", "(available, score desc)"],
    ["numbers_carrier_score", "(carrier, available, score desc)"],
    ["numbers_best_grade", "(best_grade desc)"],
  ]) {
    await sql(`create index if not exists ${name} on numbers ${cols}`, [], opts);
  }
}

/**
 * Normalise a text[] coming back over Neon's HTTP API: an empty Postgres array (`{}`)
 * decodes to `[""]` rather than `[]`, which would render as a blank tag pill.
 */
function tagList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean);
}

/** The msisdns currently marked available — the "prior available set" for diffing. */
export async function readAvailable(opts = {}) {
  const rows = await sql("select msisdn from numbers where available", [], opts);
  return rows.map((r) => r.msisdn);
}

/**
 * Upsert this run's records. `first_seen` is set on insert and never overwritten;
 * `best_grade` only ever climbs. Every touched row gets `run_seq`, which is how
 * `markGone` finds the rows this run did NOT see.
 *
 * @param {object} p
 * @param {Array<{msisdn:string,carrier:string,tier:string,sim_type:string,score:number,tags:string[],grade?:number}>} p.rows
 * @param {string} p.today   YYYY-MM-DD
 * @param {number} p.runSeq  monotonic id for this run
 */
export async function upsertNumbers({ rows, today, runSeq }, opts = {}) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    await sql(
      // `unnest` takes one array per column, so per-row tag arrays can't be passed as
      // text[][] (it would flatten). They travel as one comma-joined string per row —
      // tags are slugs, never containing a comma — and split back out here.
      `insert into numbers
         (msisdn, carrier, tier, sim_type, score, tags, best_grade, first_seen, last_seen, available, run_seq)
       select t.msisdn, t.carrier, t.tier, t.sim_type, t.score,
              coalesce(string_to_array(nullif(t.tags_csv, ''), ','), '{}'),
              t.best_grade, t.first_seen, t.last_seen, t.available, t.run_seq
       from unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[],
         $7::int[], $8::date[], $9::date[], $10::bool[], $11::bigint[]
       ) as t(msisdn, carrier, tier, sim_type, score, tags_csv,
              best_grade, first_seen, last_seen, available, run_seq)
       on conflict (msisdn) do update set
         carrier    = excluded.carrier,
         tier       = excluded.tier,
         sim_type   = excluded.sim_type,
         score      = excluded.score,
         tags       = excluded.tags,
         best_grade = greatest(numbers.best_grade, excluded.best_grade),
         last_seen  = excluded.last_seen,
         available  = true,
         run_seq    = excluded.run_seq`,
      [
        batch.map((r) => r.msisdn),
        batch.map((r) => r.carrier || "vodafone"),
        batch.map((r) => r.tier || ""),
        batch.map((r) => r.sim_type || ""),
        batch.map((r) => r.score ?? 0),
        batch.map((r) => (r.tags || []).join(",")),
        batch.map((r) => Math.max(r.score ?? 0, r.grade ?? 0)),
        batch.map(() => today),
        batch.map(() => today),
        batch.map(() => true),
        batch.map(() => runSeq),
      ],
      opts
    );
  }
}

/** Flag every still-available row this run didn't touch as gone. Returns the count. */
export async function markGone({ runSeq }, opts = {}) {
  const rows = await sql(
    "update numbers set available = false where available and run_seq <> $1 returning msisdn",
    [runSeq],
    opts
  );
  return rows.map((r) => r.msisdn);
}

/** Raise best_grade for the LLM-graded numbers (their grade beats the heuristic score). */
export async function applyGrades({ grades }, opts = {}) {
  const entries = [...grades.entries()];
  if (!entries.length) return;
  await sql(
    `update numbers set best_grade = greatest(numbers.best_grade, g.grade)
     from (select * from unnest($1::text[], $2::int[]) as t(msisdn, grade)) g
     where numbers.msisdn = g.msisdn`,
    [entries.map(([m]) => m), entries.map(([, g]) => g)],
    opts
  );
}

/** Drop rows gone for longer than `keepDays`, so the table doesn't grow forever. */
export async function pruneGone({ keepDays, today }, opts = {}) {
  const rows = await sql(
    "delete from numbers where not available and last_seen < ($1::date - $2::int) returning msisdn",
    [today, keepDays],
    opts
  );
  return rows.length;
}

/**
 * The dashboard's "best available now" rows: the top `limit` available numbers per
 * carrier by score, so a small catalog isn't crowded out by a larger one. Ordering,
 * ranking and the per-carrier split all happen in Postgres.
 */
export async function readPublishRows({ perCarrier, today }, opts = {}) {
  const rows = await sql(
    `select msisdn, score, tags, sim_type, carrier, tier, best_grade,
            to_char(first_seen, 'YYYY-MM-DD') as first_seen,
            ($2::date - first_seen) as age_days,
            first_seen = $2::date as is_new
     from (
       select *, row_number() over (partition by carrier order by score desc, msisdn) as rn
       from numbers where available
     ) ranked
     where rn <= $1
     order by score desc, msisdn`,
    [perCarrier, today],
    opts
  );
  return rows.map((r) => ({ ...r, tags: tagList(r.tags) }));
}

/** The dashboard's "best ever seen" rows: top `limit` by best_grade, available or not. */
export async function readBestEverRows({ limit, today }, opts = {}) {
  const rows = await sql(
    `select msisdn, score, tags, sim_type, carrier, tier, best_grade, available,
            to_char(first_seen, 'YYYY-MM-DD') as first_seen,
            ($2::date - first_seen) as age_days
     from numbers
     order by best_grade desc, score desc, msisdn
     limit $1`,
    [limit, today],
    opts
  );
  return rows.map((r) => ({ ...r, tags: tagList(r.tags) }));
}

/**
 * Every available msisdn with its carrier + score, for the dashboard's full-catalog
 * digit search. Returned as compact fixed-width strings ("msisdn|carrierChar|score")
 * so ~160k numbers cost ~2.5MB of JSON instead of ~25MB of objects.
 */
export async function readSearchIndex(opts = {}) {
  const rows = await sql(
    `select msisdn, left(carrier, 1) as c, score from numbers where available order by msisdn`,
    [],
    opts
  );
  return rows.map((r) => `${r.msisdn}${r.c}${String(r.score).padStart(3, "0")}`);
}

/** Headline counts for the dashboard: total available, and the per-carrier split. */
export async function readCounts(opts = {}) {
  const rows = await sql(
    "select carrier, count(*)::int as n from numbers where available group by carrier order by carrier",
    [],
    opts
  );
  const by_carrier = Object.fromEntries(rows.map((r) => [r.carrier, r.n]));
  const available_total = rows.reduce((a, r) => a + r.n, 0);
  return { available_total, by_carrier };
}
