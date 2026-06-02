# VF Premium Numbers Alert — Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming)

## Goal

A public GitHub repo that monitors Vodafone Egypt's "Red" eSIM phone-number catalog on a
schedule, scores each number for how "premium" its digit pattern is, surfaces the best 30
currently-available numbers, and alerts on new premium arrivals. A static dashboard on
GitHub Pages shows the results. No servers, no external secrets.

## Data source (verified working)

```
GET https://eshop.vodafone.com.eg/ecommerce/api/catalog/commerce/phone-numbers/type/red
    ?cq=simType==ESIM;simFamilyType==OWNER&query=in&size=5555&page=0&shuffle=0&tariffName=
```

Required headers (no cookie, no auth token, no session needed — verified):

- `x-context-request: {"applicationId":"01H5FECVAV4YWT0NGQKXEN1T51","tenantId":"5DF1363059675161A85F576D"}`
- `traceid: <fresh-uuid-per-request>`
- `accept: application/json`, `content-type: application/json`
- `user-agent: <browser UA>`
- `referer: https://eshop.vodafone.com.eg/en/lines/red/numbers`

Response: standard Spring page object. Today: `totalElements ≈ 1654`, all returned in one
request at `size=5555`. Each record:

```jsonc
{
  "id": "uuid",
  "msisdn": "01055455833",          // 11-digit Egyptian mobile
  "simType": "ESIM",
  "simFamilyType": "OWNER",
  "available": true,
  "defaultPrice": { "amount": 350.00, "currency": "EGP" },  // FLAT for all
  "tariffs": [ { "id": "RED_PRIME", "applicable": true }, ... ]
}
```

**Key fact:** price is uniform (350 EGP for every number), so "premium" is determined
**entirely by the digit pattern of the msisdn**, not price.

## Architecture

One public GitHub repo. Everything runs inside GitHub — no servers, no external API keys.

```
GitHub Actions (cron: "*/10 * * * *", best-effort)        concurrency: single-run group
  1. fetch    GET endpoint, fresh traceid UUID, retry w/ backoff on 5xx
  2. parse    -> records[] {msisdn, available, price, tariffs, id}
  3. score    deterministic pattern scorer, ALL numbers -> {score 0-100, tags[]}
  4. diff     compare available-set vs history -> NEW / DISAPPEARED / first-seen age
  5. grade    top ~80 candidates -> GitHub Models (1 request, low tier) -> best-30 + reasons
              (on any failure: fall back to deterministic top-30, no reasons)
  6. store    update history + write latest.json
  7. notify   if NEW premium found (above grade threshold), open/update a GitHub Issue
  8. publish  commit dashboard data to gh-pages branch ONLY if available-set or best-30 changed
        |
GitHub Pages (gh-pages branch) -> dashboard fetches ./latest.json + ./history.json same-origin
```

**Language:** Node.js (JavaScript). One language for scraper + dashboard; the pattern
scorer is a pure module shared by both if useful.

**Branch layout:** A single `gh-pages` branch holds the static dashboard **and** the JSON
data. The dashboard fetches `./latest.json` and `./history.json` same-origin (no CORS, no
raw.githubusercontent dependency). Source code lives on `main`.

**Workflow permissions:** `permissions: { contents: write, issues: write, models: read }`.
Authentication is the built-in `GITHUB_TOKEN` — no secrets to manage.

## Components (each a small, independently testable unit)

| Module | Input -> Output | Purpose |
|---|---|---|
| `src/fetch.js` | (config) -> `records[]` | Calls endpoint with static headers + fresh `traceid`; retries with backoff on 5xx; throws on persistent failure (caller skips run) |
| `src/score.js` | `msisdn` -> `{score, tags[]}` | **Pure function**, no I/O. Pattern heuristics. Fully unit-testable |
| `src/diff.js` | `(currentAvailable[], history)` -> `{new[], disappeared[], ages}` | **Pure** diff against prior state; includes sanity guards |
| `src/grade.js` | `(candidates[])` -> `bestThirty[]` | One GitHub Models call; ranked 30 + reasons; deterministic fallback on failure |
| `src/store.js` | `(results)` -> writes JSON | Reads/writes `history.json` + `latest.json` |
| `src/notify.js` | `(newPremium[])` -> GitHub Issue | Opens/updates an Issue via `GITHUB_TOKEN` |
| `src/run.js` | orchestrates steps 1–8 | Entry point the Actions workflow calls |
| `web/index.html` + `web/app.js` | reads JSON -> UI | Static dashboard: table + cards, NEW/age badges, filters, best-ever view |
| `.github/workflows/poll.yml` | cron | Schedules and runs `src/run.js`, commits to `gh-pages` |

## Pattern scoring (deterministic)

Score the **last 8 digits** of `01[0125]XXXXXXXX`. Each rule adds weighted points and a tag:

- all-same digit (e.g. `...44444444`)
- ascending / descending runs (`...12345678`)
- repeated pairs: AABB, ABAB (`...55445544`)
- palindrome
- repeating blocks (`123123`, `4545`)
- heavy zeros / round endings (`...0000`, `...10000`)
- few distinct digits (low cardinality)

Output: a 0–100 score and a list of human-readable tags. The LLM only refines the **top
~80** candidates into a final best-30 with natural-language reasons; it does not change the
underlying ranking, so an LLM outage degrades gracefully to deterministic ranking.

## Data model (on `gh-pages` branch)

`history.json` — keyed by msisdn. `last_seen` stored as a **date** (Africa/Cairo), not a
timestamp, so it only changes when a number's day-level presence changes (keeps commits rare):

```jsonc
{
  "01055455833": {
    "first_seen": "2026-06-01",
    "last_seen":  "2026-06-03",
    "score": 72,
    "tags": ["ABAB", "repeat-pair"],
    "best_grade": 88,
    "status": "available"        // or "gone"
  }
}
```

`latest.json` — what the dashboard renders each run:

```jsonc
{
  "generated_at": "2026-06-03T21:00:00Z",
  "total": 1654,
  "best_thirty": [
    { "msisdn": "...", "score": 91, "grade": 94, "reason": "mirror + triple repeat",
      "is_new": true, "first_seen": "2026-06-01", "age_days": 2 }
  ],
  "new_count": 3,
  "disappeared_count": 5
}
```

`events.jsonl` — a **capped** append log (e.g. last N events) of NEW/DISAPPEARED for the
dashboard timeline. Not a full snapshot per run.

**Git growth control:** commit to `gh-pages` only when the available-set or best-30
changed. Periodically (e.g. monthly via the workflow) orphan-reset `gh-pages` to squash
accumulated history and keep clones fast.

## Error handling & edge cases

- **Endpoint 5xx / timeout:** retry with exponential backoff; on persistent failure, skip
  the run and do **not** overwrite data. Never write "0 numbers."
- **Suspicious shrink:** if returned available count drops >50% vs the previous successful
  run, treat as a bad fetch — skip the diff and alerting for that run.
- **Truncation:** assert `returned >= totalElements` (or page) so a growing catalog past
  `size=5555` is never silently truncated.
- **First run (no history):** seed the baseline silently — populate `first_seen` for all,
  emit **no** "NEW" alerts on run #1.
- **`x-context-request` rotation:** if Vodafone changes the static context and we get
  sustained 5xx, open a "scraper broken" GitHub Issue so it's visible.
- **LLM failure / rate limit:** fall back to deterministic top-30; dashboard shows scores
  without LLM reasons.
- **Overlapping runs:** workflow `concurrency` group prevents two runs racing the
  `gh-pages` push; the push step rebases/retries on conflict.
- **`available:false`:** excluded from the available-set and best-30 (a number present but
  not purchasable is not "available").
- **Timezone:** `age_days` and `last_seen` computed in Africa/Cairo.

## Definitions

- **Best 30** = the 30 highest-graded **currently-available** numbers. A secondary
  dashboard view shows **best-ever-seen** using `best_grade` history.
- **NEW** = available this run, not available in the previous successful run.
- **DISAPPEARED** = available in the previous successful run, gone now (likely sold).
- **Alert trigger** = a NEW number whose grade is above a configurable threshold.

## Testing

- **Unit (`score.js`):** known premium patterns -> expected high scores and tags;
  ordinary numbers -> low scores. Pure function, no mocks.
- **Unit (`diff.js`):** fixtures of prev/current available-sets -> expected
  new/disappeared/ages; first-run baseline case; >50% shrink guard; empty-fetch guard.
- **Integration (dry run):** `run.js` against a saved fixture JSON (no live API) ->
  asserts `latest.json` shape and that no Issue is opened on a baseline run.
- **Manual:** one live fetch in CI smoke test (small `size`) to detect header/context
  rotation early.

## Risks / notes

- GitHub scheduled cron is best-effort; effective cadence ~10–20 min. Don't promise exact
  10-minute timing in the UI.
- GitHub Models is a preview product with per-tier daily caps; pin a low/standard-tier
  model. Deterministic fallback keeps the system working if it changes or rate-limits.
- The msisdns are already publicly listed on the Vodafone shop; publishing them on the
  dashboard is low-risk. Note this in the README.
