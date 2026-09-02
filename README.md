# VF Premium Numbers Alert

**▶ Live demo: https://ahmadibrahiim.github.io/vf-premium-numbers-alert/**

Monitors the public phone-number catalogs of all three Egyptian carriers —
**Vodafone** (010), **Etisalat** (011) and **WE** (015) — on a schedule, scores every
number for how **premium** its digit pattern is, surfaces the best 30 currently-available
numbers (refined by an LLM), tracks new arrivals and how long each has been available,
and shows it all on a static dashboard. State lives in **Neon Postgres**; the poller
runs in GitHub Actions and publishes the dashboard to GitHub Pages — no servers.

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

A scheduled GitHub Actions workflow (`.github/workflows/poll.yml`, best-effort every
~10 min) runs `src/run.js`, which:

1. **fetch** — pulls all three catalogs concurrently (static gating headers, no
   cookie/token needed), retrying with backoff on 5xx. Any source failing hard skips
   the whole run rather than overwriting good data with a partial set.
2. **score** — `src/score.js` rates every number 0–100 on digit-pattern heuristics
   (repeats, runs, palindromes, repeating blocks, round endings, low digit variety…).
3. **store** — `src/db.js` upserts **every** number into Postgres (`first_seen` set
   once, `best_grade` only ever climbs), then flags the rows this run didn't see as
   gone. One statement per step, `unnest`-batched 5000 rows at a time.
4. **diff** — `src/diff.js` compares the fetched set against what Postgres last had
   available: NEW, DISAPPEARED, first-seen age. Guards against bad fetches (silent
   first-run baseline, skips when the count drops >50%).
5. **grade** — `src/grade.js` sends the top ~80 candidates to **GitHub Models**
   (free, authed by the built-in `GITHUB_TOKEN`) for a best-30 ranking with reasons.
   On any failure it falls back to the deterministic ranking.
6. **publish** — Postgres does the ranking; the run just writes what the dashboard
   reads: `latest.json` (top `PUBLISH_PER_CARRIER` rich rows *per carrier*),
   `best-ever.json` (top by `best_grade`) and `index.json` (every available number in
   ~15 bytes each, for full-catalog search). Rows gone longer than
   `HISTORY_KEEP_DAYS` are deleted.
7. **alert** — when a NEW number scores ≥ `ALERT_THRESHOLD` it opens/comments a GitHub
   Issue and, if `RESEND_API_KEY` + `ALERT_EMAIL_TO` are set, emails the details. Both
   are best-effort: a failed alert is logged and never fails the poll or loses data.
8. **commit** — pushes data + dashboard to the `gh-pages` branch **only when the
   meaningful state changed** (no timestamp-only commits).

### Why Postgres

The state used to be a `history.json` blob, read and rewritten whole every run. At
~206k numbers that would be 30MB+ committed every poll, which forced the poller to
track only a slice — so `first_seen` was wrong for most numbers and the per-run diff
was mostly sampling noise (~370 "new" and ~460 "gone" every run, against a real churn
of ~30). Postgres tracks every number exactly, with no rewrite churn.

### What the dashboard loads

Served from `gh-pages`, same-origin:

| File | When | Size | What |
|---|---|---|---|
| `latest.json` | on load | ~3.2MB | ranked rows for browsing + the LLM's best 30 |
| `index.json` | first search | ~3.5MB | **every** available number (`<msisdn><carrier initial><score>`) |
| `best-ever.json` | "best ever" tab | ~3.9MB | top by `best_grade`, available or not |
| `events.jsonl.json` | on load | ~45KB | recent change timeline |

So browsing shows the top-ranked numbers, and searching digits reaches all ~206k.

## One-time setup

1. Push this repo to GitHub (public).
2. **Create a Neon project** and set its connection string as a repo secret:
   `gh secret set DATABASE_URL`. The pipeline refuses to run without it rather than
   silently losing history. The schema is created on the first run (`db.migrate()`).
5. **Settings → Actions → General → Workflow permissions:** "Read and write
   permissions" (lets the workflow push to `gh-pages` and open issues).
6. Run the workflow once: **Actions → poll-vf-numbers → Run workflow**. This seeds the
   baseline (no alerts on the first run) and creates the `gh-pages` branch.
7. **Settings → Pages:** source = branch `gh-pages`, folder `/ (root)`.
8. Visit `https://<you>.github.io/<repo>/`.

`GITHUB_TOKEN` is provided automatically. `DATABASE_URL` is the only required secret.

## Configuration

Set as workflow `env:` or repo variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `MODEL` | `openai/gpt-4o-mini` | GitHub Models model (keep a low tier for daily caps) |
| `ALERT_THRESHOLD` | `50` | Min score for a NEW number to raise an alert. **Not 90:** the public catalogs top out at 59 across all ~206k numbers (~215 clear 50, ~20 clear 60), so 90 could never fire |
| `RESEND_API_KEY` | — | Resend key; unset disables email alerts |
| `ALERT_EMAIL_TO` | — | Alert recipient; unset disables email alerts |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` | Sender. Resend's shared sender only delivers to the Resend account owner — to email anyone else, verify a domain at resend.com/domains and set this to an address on it |
| `CANDIDATE_COUNT` | `150` | How many top-scored numbers the LLM ranks |
| `BEST_COUNT` | `30` | How many to surface |
| `PUBLISH_PER_CARRIER` | `7000` | Rich ranked rows per carrier in `latest.json` — per carrier, so Etisalat's tier bonus can't crowd out Vodafone's whole 5.2k catalog |
| `BEST_EVER_LIMIT` | `20000` | Rows in `best-ever.json` |
| `CHANGE_LIST_LIMIT` | `2000` | Cap on the new/disappeared lists in `latest.json` (the counts stay exact) |
| `HISTORY_KEEP_DAYS` | `30` | Delete rows gone longer than this |
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

## Dashboard CSS

The dashboard uses a **precompiled** Tailwind stylesheet (`web/tailwind.css`, committed) —
no runtime CDN. Rebuild it after changing classes in `web/index.html` or `web/app.js`:

```bash
# one-off: grab the standalone CLI (no npm needed)
curl -sL -o /tmp/tw https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-macos-arm64 && chmod +x /tmp/tw
/tmp/tw -c tailwind.config.js -i web/input.css -o web/tailwind.css --minify
```

## Local development

```bash
node --test                        # all unit tests (zero dependencies, Node 20+)

# live dry run: no GITHUB_TOKEN -> deterministic grading instead of the LLM.
# Point DATABASE_URL at a scratch Neon branch, not the one the workflow writes to.
DATABASE_URL=postgres://... DATA_DIR=/tmp/vf node src/run.js

cd web && python3 -m http.server   # preview dashboard (copy the generated JSON in)
```

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
