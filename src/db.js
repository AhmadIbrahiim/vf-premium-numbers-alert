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
    ["numbers_msisdn_trgm", "(msisdn text_pattern_ops)"],
  ]) {
    await sql(`create index if not exists ${name} on numbers ${cols}`, [], opts);
  }
  // One row per carrier per poll — the provider status dashboard reads this.
  await sql(
    `create table if not exists provider_runs (
       id          bigserial primary key,
       run_at      timestamptz not null default now(),
       carrier     text not null,
       ok          boolean not null,
       trusted     boolean not null,
       records     integer not null default 0,
       requests    integer not null default 0,
       duration_ms integer not null default 0,
       error       text
     )`,
    [],
    opts
  );
  await sql(
    "create index if not exists provider_runs_recent on provider_runs (carrier, run_at desc)",
    [],
    opts
  );
  // NEW / GONE events, for the dashboard's change timeline.
  await sql(
    `create table if not exists number_events (
       id      bigserial primary key,
       ts      timestamptz not null default now(),
       day     date not null,
       type    text not null,
       msisdn  text not null,
       carrier text not null default '',
       score   integer not null default 0
     )`,
    [],
    opts
  );
  await sql("create index if not exists number_events_ts on number_events (ts desc)", [], opts);
  // Small key/value store for pipeline state that is not a number: the LLM grade cache
  // and the change signature. Keeps the poller entirely free of state files.
  await sql(
    `create table if not exists meta (
       key        text primary key,
       value      jsonb not null,
       updated_at timestamptz not null default now()
     )`,
    [],
    opts
  );
}

/** Read a JSON value from the `meta` store, or null. */
export async function readMeta(key, opts = {}) {
  const rows = await sql("select value from meta where key = $1", [key], opts);
  return rows.length ? rows[0].value : null;
}

/** Write a JSON value to the `meta` store. */
export async function writeMeta(key, value, opts = {}) {
  await sql(
    `insert into meta (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
    opts
  );
}

/**
 * Append this run's NEW/GONE events, then trim to the most recent `keep`.
 * @param {object} p - { newMsisdns, disappearedMsisdns, today, ts, scoreMap, carrierMap, keep }
 */
export async function recordNumberEvents({ newMsisdns = [], disappearedMsisdns = [], today, ts, scoreMap = new Map(), carrierMap = new Map(), keep = 2000 }, opts = {}) {
  const entries = [
    ...newMsisdns.map((m) => ["new", m]),
    ...disappearedMsisdns.map((m) => ["gone", m]),
  ];
  if (entries.length) {
    // Cap what one run can append, so a re-baseline cannot write 100k events.
    const capped = entries.slice(0, keep);
    await sql(
      `insert into number_events (ts, day, type, msisdn, carrier, score)
       select $1::timestamptz, $2::date, * from unnest($3::text[], $4::text[], $5::text[], $6::int[])`,
      [
        ts || new Date().toISOString(),
        today,
        capped.map(([type]) => type),
        capped.map(([, m]) => m),
        capped.map(([, m]) => carrierMap.get(m) || ""),
        capped.map(([, m]) => scoreMap.get(m)?.score ?? 0),
      ],
      opts
    );
  }
  await sql(
    `delete from number_events where id in (
       select id from (select id, row_number() over (order by ts desc, id desc) rn from number_events) t
       where rn > $1
     )`,
    [keep],
    opts
  );
}

/**
 * Record this poll's per-carrier outcome. `trusted` is false when the carrier failed or
 * came back too small to be believed (so nothing of its was retired).
 *
 * @param {object} p - { stats: Array<{carrier,ok,records,requests,durationMs,error}>, trusted: string[] }
 */
export async function recordProviderRuns({ stats, trusted = [], runAt }, opts = {}) {
  if (!stats?.length) return;
  const trustedSet = new Set(trusted);
  await sql(
    `insert into provider_runs (run_at, carrier, ok, trusted, records, requests, duration_ms, error)
     select $1::timestamptz, * from unnest(
       $2::text[], $3::bool[], $4::bool[], $5::int[], $6::int[], $7::int[], $8::text[]
     )`,
    [
      runAt || new Date().toISOString(),
      stats.map((s) => s.carrier),
      stats.map((s) => Boolean(s.ok)),
      stats.map((s) => trustedSet.has(s.carrier)),
      stats.map((s) => s.records ?? 0),
      stats.map((s) => s.requests ?? 0),
      stats.map((s) => s.durationMs ?? 0),
      stats.map((s) => s.error ?? null),
    ],
    opts
  );
}

/** Trim provider_runs to the most recent `keep` rows per carrier. */
export async function pruneProviderRuns({ keep = 500 }, opts = {}) {
  await sql(
    `delete from provider_runs where id in (
       select id from (
         select id, row_number() over (partition by carrier order by run_at desc) rn
         from provider_runs
       ) t where rn > $1
     )`,
    [keep],
    opts
  );
}

/**
 * Normalise a text[] coming back over Neon's HTTP API: an empty Postgres array (`{}`)
 * decodes to `[""]` rather than `[]`, which would render as a blank tag pill.
 */
function tagList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean);
}

/**
 * The msisdns currently marked available — the "prior available set" for diffing.
 * Pass `carriers` to scope it to the carriers this run fetched, so a carrier that
 * failed does not show up as a mass disappearance.
 */
export async function readAvailable(opts = {}, { carriers } = {}) {
  const rows = carriers?.length
    ? await sql("select msisdn from numbers where available and carrier = any($1::text[])", [carriers], opts)
    : await sql("select msisdn from numbers where available", [], opts);
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

/**
 * Flag every still-available row this run didn't touch as gone, restricted to the
 * carriers we actually fetched. A carrier that failed (throttled, down) keeps its rows
 * untouched rather than having its whole inventory declared gone.
 *
 * @param {object} p - { runSeq, carriers: string[] }
 * @returns {Promise<string[]>} the msisdns marked gone
 */
export async function markGone({ runSeq, carriers }, opts = {}) {
  if (!carriers || !carriers.length) return [];
  const rows = await sql(
    `update numbers set available = false
     where available and run_seq <> $1 and carrier = any($2::text[]) returning msisdn`,
    [runSeq, carriers],
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
 * Provider status: for each carrier, its latest poll plus a rollup over the recent ones.
 * This is what the status dashboard renders.
 */
export async function readProviderStatus({ window = 48 } = {}, opts = {}) {
  return sql(
    `with recent as (
       select *, row_number() over (partition by carrier order by run_at desc) rn
       from provider_runs
     ),
     windowed as (select * from recent where rn <= $1)
     select
       w.carrier,
       max(w.run_at) filter (where w.rn = 1)               as last_run_at,
       bool_or(w.ok)  filter (where w.rn = 1)              as last_ok,
       bool_or(w.trusted) filter (where w.rn = 1)          as last_trusted,
       max(w.records) filter (where w.rn = 1)              as last_records,
       max(w.requests) filter (where w.rn = 1)             as last_requests,
       max(w.duration_ms) filter (where w.rn = 1)          as last_duration_ms,
       max(w.error) filter (where w.rn = 1)                as last_error,
       max(w.run_at) filter (where w.ok)                   as last_success_at,
       count(*)::int                                       as polls,
       count(*) filter (where w.ok)::int                   as polls_ok,
       round(avg(w.duration_ms))::int                      as avg_duration_ms,
       round(avg(w.requests))::int                         as avg_requests,
       (select count(*)::int from numbers n where n.available and n.carrier = w.carrier) as available_now
     from windowed w
     group by w.carrier
     order by w.carrier`,
    [window],
    opts
  );
}

/** Recent per-carrier poll history, oldest-first, for the status page sparklines. */
export async function readProviderHistory({ window = 48 } = {}, opts = {}) {
  return sql(
    `select carrier, run_at, ok, trusted, records, requests, duration_ms
     from (
       select *, row_number() over (partition by carrier order by run_at desc) rn
       from provider_runs
     ) t
     where rn <= $1
     order by run_at asc`,
    [window],
    opts
  );
}

/**
 * Top `perCarrier` available numbers for each carrier, best score first.
 *
 * Only used to build the offline fallback snapshot (see src/publish.js). Per carrier,
 * not a global top-N, because Etisalat's tier bonus would otherwise crowd Vodafone out.
 */
export async function readTopPerCarrier({ perCarrier, today }, opts = {}) {
  const rows = await sql(
    `select msisdn, score, best_grade, tags, sim_type, carrier, tier, available,
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

/** Recent NEW/GONE events, newest first. */
export async function readEvents({ limit = 300 } = {}, opts = {}) {
  return sql(
    `select ts, day, type, msisdn, carrier, score
     from number_events order by ts desc, id desc limit $1`,
    [limit],
    opts
  );
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
