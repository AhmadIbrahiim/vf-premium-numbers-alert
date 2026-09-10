# VF Premium Numbers Alert

**▶ Live demo: https://ahmadibrahiim.github.io/vf-premium-numbers-alert/**

Monitors the public phone-number catalogs of all three Egyptian carriers —
**Vodafone** (010), **Etisalat** (011) and **WE** (015) — on a schedule, scores every
number for how **premium** its digit pattern is, surfaces the best 30 currently-available
numbers (refined by an LLM), tracks new arrivals and how long each has been available,
and shows it all on a dashboard that queries the database live. Everything is in **Neon
Postgres**; the poller runs on a **GitLab CI schedule** and the dashboard is a
**Next.js app on Vercel**.

The carriers list **~206k** numbers between them, and every one of them silently caps
how much it will hand over — in a different way. Each cap was verified against the live
API, and each is worked around:

| Carrier | Its limit | How we get past it | Collected |
|---|---|---|---|
| Vodafone | a separate catalog path per line type | pages `red` **and** `flex`, without the `simFamilyType==OWNER` filter | 5.2k |
| Etisalat | ~1000 numbers per response, whatever you ask for | `searchPattern` takes a fixed-width mask, so each pool is split into 100 disjoint buckets by its last two digits (`011******52`), each well under the cap | 96.3k |
| WE | 51 numbers per page, 20,000 per query, **and short pages under load** | `fitmod` is a digit mask, so a query that hits the cap is split by fixing one more leading digit (`150???????`), recursively. A short page is re-checked before it is believed | 104.8k |

The caps are the whole story here: queried naively the same three APIs report only
2.7k / 5.0k / 6.3k — under 7% of what they actually hold.

Completeness is checked by cross-measuring, not assumed. Vodafone: `red` + `flex` are
the only line types that exist and 3183 + 2019 is exactly what we store. Etisalat: pool
135 counted 69,141 via suffix buckets (100 requests) and 69,142 via an exhaustive prefix
tree-walk (~10,000) — two unrelated methods agreeing. WE: the same grade fetched twice
must return the same set (it now differs by ~0.01%, real churn; before the short-page
fix it swung 21.9%, which is how that bug was caught).

## How it works

A scheduled GitLab CI pipeline (`.gitlab-ci.yml`, every 30 min) runs `src/run.js`,
which:

1. **fetch** — pulls all three catalogs concurrently (static gating headers, no
   cookie/token needed), retrying with backoff on 5xx. A carrier that fails or comes
   back suspiciously small is *carried over*: its rows keep their state and the other
   carriers still update. Only an all-carrier failure skips the run.
2. **score** — `src/score.js` rates every number 0–100 on digit-pattern heuristics
   (repeats, runs, palindromes, repeating blocks, round endings, low digit variety…).
3. **store** — `src/db.js` upserts **every** number into Postgres (`first_seen` set
   once, `best_grade` only ever climbs), then flags the rows this run didn't see as
   gone. One statement per step, `unnest`-batched 5000 rows at a time.
4. **diff** — `src/diff.js` compares the fetched set against what Postgres last had
   available: NEW, DISAPPEARED, first-seen age. Guards against bad fetches (silent
   first-run baseline, skips when the count drops >50%).
5. **grade** — `src/grade.js` sends the top candidates to any OpenAI-compatible API
   (`LLM_BASE_URL` + `LLM_API_KEY`) for a best-30 ranking with reasons. Unconfigured or
   failing, it falls back to the deterministic ranking and says so in the run summary.
   *(This used to use GitHub Models, which GitHub retired on 2026-07-30.)*
6. **record** — writes the NEW/GONE events and the per-carrier poll telemetry, then
   deletes rows gone longer than `HISTORY_KEEP_DAYS`.
7. **alert** — when a NEW number scores ≥ `ALERT_THRESHOLD` it opens/comments a GitHub
   Issue and, if `RESEND_API_KEY` + `ALERT_EMAIL_TO` are set, emails the details. Both
   are best-effort: a failed alert is logged and never fails the poll or loses data.

A poll writes to Postgres and nothing else — no files, no branches, no snapshots.

### Why Postgres, and why no JSON

The state used to be a `history.json` blob, read and rewritten whole every run. At ~206k
numbers that would be 30MB+ committed every poll, which is what forced the poller to
track only a slice — so `first_seen` was wrong for most numbers and the per-run diff was
mostly sampling noise (~370 "new" and ~460 "gone" every run, against a real churn of
~30). And a published snapshot is stale the moment it is written.

So there are no data files at all now. Numbers, the LLM grade cache, the run signature,
the change log and the per-poll provider telemetry are all rows in Postgres, and the
dashboard reads them live:

| Table | Holds |
|---|---|
| `numbers` | one row per number ever seen: score, tags, carrier, tier, `first_seen`, `best_grade`, availability |
| `provider_runs` | one row per carrier per poll: ok/trusted, records, requests, duration, error |
| `number_events` | recent NEW / GONE events, for the change timeline |
| `meta` | pipeline internals (grade cache, signature). **Not** exposed to the dashboard |

### How the dashboard reads Postgres

The dashboard is a Next.js app on Vercel, at the repo root. Pages and route handlers run on the
server, so `DATABASE_URL` stays a private environment variable and no database
credential reaches the browser. Filtering, sorting and paging happen in Postgres, so a
search covers the entire ~206k catalogue and "Load more" is a real query.

This is why it is not on GitHub Pages any more. A static host has no server, which left
only bad options: publish the database behind a public read-only endpoint, or publish a
JSON snapshot that is stale the moment it is written. Both were built and both were
worse. One server-side render removes the whole problem.

`lib/queries.js` is the only place SQL is written. Route handlers hand request
params to `buildQuery`, which validates them against a whitelist and binds them, so
request input never reaches the SQL text and row limits are always clamped. It is pure,
so the repo-root test suite covers it without booting Next.

The poller cannot run on Vercel: a full poll takes 3-5 minutes, past the function
ceiling. It runs on a GitLab CI schedule and talks to the same database.

### Provider status

`/status` is a live health view per carrier: state (live / carried over / failing),
numbers collected, requests used, poll duration, success rate over the recent window, a
sparkline of inventory, the last error, and a table of recent polls. Server-rendered on
every request from `provider_runs`, because the point of the page is telling you whether
a carrier is failing right now.

## One-time setup

1. Push the repo to GitLab.
2. **Create a Neon project** and add its connection string as a CI/CD variable:
   **Settings → CI/CD → Variables → `DATABASE_URL`** (masked). The pipeline refuses to
   run without it rather than silently losing history. The schema is created on the
   first run (`db.migrate()`).
3. *(optional)* For email alerts add `RESEND_API_KEY` and `ALERT_EMAIL_TO`, plus
   `DASHBOARD_URL` so the emails link somewhere. Without a verified domain Resend only
   delivers to the Resend account owner's own address; to reach any other inbox verify a
   domain at resend.com/domains and set `ALERT_EMAIL_FROM`.
4. *(optional)* For LLM grading add `LLM_BASE_URL` and `LLM_API_KEY` for any
   OpenAI-compatible provider. Without them the deterministic scorer is used, which is a
   designed fallback — the run summary reports `grading=heuristic:no-provider`.
5. **Create the schedule:** *Settings → CI/CD → Schedules → New schedule*, cron
   `7,37 * * * *`, target branch `main`. `.gitlab-ci.yml` defines the job but not when
   it runs — without a schedule the poller never fires.
6. Run it once from *CI/CD → Pipelines → Run pipeline* to seed the baseline (no alerts
   on the first run).
7. **Deploy the dashboard:** see [`docs/dashboard.md`](docs/dashboard.md). The Next app
   is at the repo root, so Vercel auto-detects it — just add `DATABASE_URL`.

Leave CI/CD variables **unprotected** unless `main` is a protected branch — a protected
variable is invisible to pipelines on unprotected branches, which looks identical to the
variable not existing.

## Configuration

Set as GitLab CI/CD variables or in `.gitlab-ci.yml` (all optional):

| Var | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | — | OpenAI-compatible API root; empty disables LLM grading |
| `LLM_API_KEY` | — | Key for `LLM_BASE_URL` |
| `MODEL` | `gpt-4o-mini` | Model id, in the provider's own naming |
| `ALERT_THRESHOLD` | `70` | Min score for a NEW number to raise an alert. **Not 90:** that could never fire — the old scorer topped out at 59 across all ~206k published numbers. **And no longer 50:** the zero-weighting rework raised scores, taking a 206k pool from 88 numbers at 50+ to 395, so 50 now fires ~4.5x too often. 70 restores the previous volume — confirm against the real catalogue |
| `RESEND_API_KEY` | — | Resend key; unset disables email alerts |
| `ALERT_EMAIL_TO` | — | Alert recipient; unset disables email alerts |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` | Sender. Resend's shared sender only delivers to the Resend account owner — to email anyone else, verify a domain at resend.com/domains and set this to an address on it |
| `CANDIDATE_COUNT` | `150` | How many top-scored numbers the LLM ranks |
| `BEST_COUNT` | `30` | How many to surface |
| `HISTORY_KEEP_DAYS` | `30` | Delete rows gone longer than this |
| `DASHBOARD_URL` | — | Vercel URL, used for the link in alert emails |
| `PROVIDER_RUNS_KEEP` | `500` | Poll history kept per carrier for the status page |
| `EVENTS_KEEP` | `2000` | NEW/GONE events kept for the change timeline |

| `VF_TYPES` | `red,flex` | Vodafone line-type catalog paths to page |
| `ETISALAT_SUFFIX_DIGITS` | `2` | Trailing digits fixed per bucket (2 → 100 buckets/pool) |
| `ETISALAT_MAX_SUFFIX_DIGITS` | `6` | Most digits fixed when splitting a capped bucket |
| `WE_QUERY_CAP` | `20000` | WE's per-query result cap; reaching it triggers a mask split |
| `WE_MAX_PREFIX_DIGITS` | `6` | Most leading digits fixed when splitting (6 ⇒ ≤10⁴ per query, provably under the cap) |
| `WE_MAX_PAGES` | `800` | Safety bound on pages per query |
| `WE_CONCURRENCY` | `4` | WE pages in parallel (kept low; 8 got our IP throttled) |
| `WE_MIN_REQUEST_MS` | `60` | Minimum gap between WE requests per worker |
| `WE_MAX_HICCUPS` | `25` | Spurious short pages to ride out per branch before reporting it incomplete |
| `CARRIER_SHRINK_TOLERANCE` | `0.9` | A carrier returning less than this fraction of what the DB holds is treated as partial: refreshed, but nothing retired |

## Local development

```bash
node --test                        # poller + query tests; needs no npm install at all

# live dry run: no GITHUB_TOKEN -> deterministic grading instead of the LLM.
# Point DATABASE_URL at a scratch Neon branch, not the one the pipeline writes to.
DATABASE_URL=postgres://... npm run poll

npm install && npm run dev         # the dashboard, against the same database
```

One `package.json` covers both, because Vercel only auto-detects a Next app at the repo
root. The poller's own code still imports nothing outside `node:` builtins, so
`node --test` and `npm run poll` work with no install.

The test suite needs no database: `test/helpers/fake-db.js` is an in-memory stand-in
for Neon's SQL-over-HTTP endpoint.

## Notes

- Polls every 30 min (cron is best-effort). Not more often: a full poll is ~4,000
  requests — WE alone needs ~3,500, since it yields 51 numbers per request — and a
  10-minute cadence throttled our IP twice during development. A poll takes ~4–5 min.
- If WE starts timing out on connect, that is the throttle. Back off to hourly.
- A carrier that fails or comes back short is **carried over**, not retired: its rows
  keep their state and the poll still updates the others. Only an all-carrier failure
  skips the run.
- The numbers are already publicly listed on each carrier's shop; the dashboard just
  organizes that public data.
- If a carrier rotates its gating tokens and fetches start failing, the run skips
  safely without corrupting data.

## Zeros are the market's currency

A dealer's rule, plainly: **the more zeros the more premium**. `010 00000000` is the top of
the tree, `11111111` close behind, and a zero is worth more than any other digit wherever
it sits. The scorer used to contradict that in three ways:

1. **Zeros only paid when trailing**, or when there were at least five of them. Counts 1-4
   earned nothing at all, so the score could *fall* as zeros were added.
2. **All-same was digit-blind.** `44444444` and `00000000` both scored 100.
3. **The hard cap destroyed the ordering above it.** Nine distinct patterns tied at exactly
   100, including `77777777` against `00000077`.

Fixed by a monotonic zero ladder (with a smaller one for ones), by suppressing bonuses that
are *vacuously* true of an all-same number — `77777777` was collecting `paired-AABB` and
`palindrome` for 80 points it had not earned — and by replacing the hard cap with a soft
knee above 85. The knee leaves the 0-85 band untouched, which is where every real number
lives: the highest score ever observed across ~206k published numbers is 59.

Resulting order: all-zeros 99, all-ones 95, `11223344` 92, all-fours 89, ascending 85.

**This shifts `ALERT_THRESHOLD`**, now defaulted to 70. On a 206k synthetic pool the old
scorer put 88 numbers at or above 50; the new one puts 395 there, and 66 at or above 70 —
so 50 would fire about 4.5x too often.

That figure is an estimate: a uniform synthetic pool is not what the carriers publish,
whose catalogue is far more skewed toward low scores. To replace the estimate with the real
number, against the real catalogue:

```sh
DATABASE_URL='postgresql://...' npm run calibrate
```

It runs one SELECT, writes nothing, and prints the number count at every threshold plus
the threshold that reproduces the historical alert volume (~215 numbers, which is what the
old scorer cleared at 50). If that differs from 70, set `ALERT_THRESHOLD` to it.
