# VF Premium Numbers Alert

**▶ Live demo: https://ahmadibrahiim.github.io/vf-premium-numbers-alert/**

Monitors the public phone-number catalogs of all three Egyptian carriers —
**Vodafone** (010), **Etisalat** (011) and **WE** (015) — on a schedule, scores every
number for how **premium** its digit pattern is, surfaces the best 30 currently-available
numbers (refined by an LLM), tracks new arrivals and how long each has been available,
and shows it all on a static dashboard. State lives in **Neon Postgres**; the poller
runs in GitHub Actions and publishes the dashboard to GitHub Pages — no servers.

The carriers list ~160k numbers between them. Each one caps how much it will hand
over per request in a different way, so the fetchers work around all three:

| Carrier | Its limit | How we get past it | Collected |
|---|---|---|---|
| Vodafone | one catalog path per line type | pages `red` **and** `flex`, without the `simFamilyType==OWNER` filter | ~5.2k |
| Etisalat | ~1000 numbers per `searchPattern` response | walks number prefixes, splitting `<prefix>*` into ten `<prefix><digit>*` queries whenever a response comes back at the cap | ~96k |
| WE | `maxCount` pinned at 51 server-side | pages each grade to exhaustion (the deepest runs ~392 pages), 8 pages at a time | ~58k |

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
7. **notify** — opens/comments a GitHub Issue when a NEW number grades ≥ threshold.
8. **commit** — pushes data + dashboard to the `gh-pages` branch **only when the
   meaningful state changed** (no timestamp-only commits).

### Why Postgres

The state used to be a `history.json` blob, read and rewritten whole every run. At
~160k numbers that was 27MB committed every 10 minutes, which forced the poller to
track only a slice — so `first_seen` was wrong for most numbers and the per-run diff
was mostly sampling noise (~370 "new" and ~460 "gone" every run, against a real churn
of ~30). Postgres tracks every number exactly, with no rewrite churn.

### What the dashboard loads

Served from `gh-pages`, same-origin:

| File | When | Size | What |
|---|---|---|---|
| `latest.json` | on load | ~3.2MB | ranked rows for browsing + the LLM's best 30 |
| `index.json` | first search | ~2.8MB | **every** available number (`<msisdn><carrier initial><score>`) |
| `best-ever.json` | "best ever" tab | ~3.9MB | top by `best_grade`, available or not |
| `events.jsonl.json` | on load | ~45KB | recent change timeline |

So browsing shows the top-ranked numbers, and searching digits reaches all ~160k.

## One-time setup

1. Push this repo to GitHub (public).
2. **Create a Neon project** and set its connection string as a repo secret:
   `gh secret set DATABASE_URL`. The pipeline refuses to run without it rather than
   silently losing history. The schema is created on the first run (`db.migrate()`).
3. **Settings → Actions → General → Workflow permissions:** "Read and write
   permissions" (lets the workflow push to `gh-pages` and open issues).
4. Run the workflow once: **Actions → poll-vf-numbers → Run workflow**. This seeds the
   baseline (no alerts on the first run) and creates the `gh-pages` branch.
5. **Settings → Pages:** source = branch `gh-pages`, folder `/ (root)`.
6. Visit `https://<you>.github.io/<repo>/`.

`GITHUB_TOKEN` is provided automatically; `DATABASE_URL` is the only secret to set.

## Configuration

Set as workflow `env:` or repo variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `MODEL` | `openai/gpt-4o-mini` | GitHub Models model (keep a low tier for daily caps) |
| `ALERT_THRESHOLD` | `90` | Min grade for a NEW number to open an Issue |
| `CANDIDATE_COUNT` | `150` | How many top-scored numbers the LLM ranks |
| `BEST_COUNT` | `30` | How many to surface |
| `PUBLISH_PER_CARRIER` | `7000` | Rich ranked rows per carrier in `latest.json` — per carrier, so Etisalat's tier bonus can't crowd out Vodafone's whole 5.2k catalog |
| `BEST_EVER_LIMIT` | `20000` | Rows in `best-ever.json` |
| `CHANGE_LIST_LIMIT` | `2000` | Cap on the new/disappeared lists in `latest.json` (the counts stay exact) |
| `HISTORY_KEEP_DAYS` | `30` | Delete rows gone longer than this |
| `VF_TYPES` | `red,flex` | Vodafone line-type catalog paths to page |
| `ETISALAT_MAX_DEPTH` | `5` | Max prefix digits appended when splitting a capped response |
| `WE_MAX_PAGES` | `800` | Safety bound on pages per WE grade (~392 observed) |
| `WE_CONCURRENCY` | `8` | WE pages fetched in parallel |

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

- GitHub scheduled cron is best-effort; effective cadence is ~10–20 min.
- A full poll takes ~2–3 min, almost all of it WE pagination (~1150 requests).
- The numbers are already publicly listed on each carrier's shop; the dashboard just
  organizes that public data.
- If a carrier rotates its gating tokens and fetches start failing, the run skips
  safely without corrupting data.
