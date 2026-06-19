# Design: Add Etisalat numbers to the premium-numbers tracker

**Date:** 2026-06-20
**Status:** Approved (design phase)

## Goal

Extend the existing Vodafone-only premium-number tracker to also collect, grade,
and alert on **Etisalat Egypt** premium numbers, surfaced in a **single unified
dashboard** with a carrier filter. Etisalat's operator tier is shown as a badge
and also boosts a number's score.

## Background

The current pipeline (`src/`) monitors Vodafone Egypt "Red" numbers:

1. `fetchCatalog()` pages the Vodafone catalog → records `{id, msisdn, available, price, simType, tariffs}`.
2. `scoreMsisdn()` scores each msisdn 0–100 on digit patterns (pure, digit-only).
3. `computeDiff()` compares the available set vs persisted history.
4. Top-N by score + all new numbers → LLM grader (`gradeCandidates`) → best thirty.
5. State persisted to `history.json` / `latest.json` / `events.jsonl.json`.
6. New high-grade numbers open/comment a GitHub alert issue.

The scorer's msisdn regex is already `^01[0125]\d{8}$`, which **already accepts the
`011` Etisalat prefix** — no scorer change needed for validity. Vodafone (`010`) and
Etisalat (`011`) MSISDNs never collide, so the entire msisdn-keyed pipeline (history,
diff, grade cache) works unchanged on a merged set.

## Data source

- Endpoint: `https://www.etisalat.eg/Saytar/rest/dialReservationWS/getDials?type=GetPoolDialsRequest&poolId={id}&searchPattern=*`
- Required headers only: `Content-type: application/json`, `Referer: https://www.etisalat.eg/eshop2/`,
  `applicationName: MAB`, `applicationPassword: <token>`. **No cookies / JSESSIONID required** (verified).
- Response shape: `{"status": true, "numbers": ["01101027915", ...]}` — a flat list of
  available MSISDNs (the API only returns available numbers).
- Pools → operator tier:

  | poolId | tier            | score bonus |
  |--------|-----------------|-------------|
  | 135    | `silver`        | 0           |
  | 136    | `golden`        | 4           |
  | 137    | `golden_plus`   | 8           |
  | 138    | `platinum`      | 12          |
  | 139    | `platinum_plus` | 16          |

- **Known limitation:** `searchPattern=*` caps each pool at ~1000 results (~5000 total).
  Accepted for v1 — these are already the premium pools. Not full enumeration; documented
  so the cap is not mistaken for the complete catalog.

## Data model changes (additive, backward-compatible)

Every record, history entry, and `latest.json` row gains:

- `carrier`: `"vodafone"` | `"etisalat"`
- `tier`: Etisalat only (`"silver" | "golden" | "golden_plus" | "platinum" | "platinum_plus"`);
  empty string for Vodafone.

Existing fields are untouched. Old history without these fields degrades gracefully
(treated as `carrier: "vodafone"`, `tier: ""` on read where needed for display).

## Tier → score bonus

`scoreMsisdn()` stays pure and digit-only. The tier bonus is applied in `run.js` when
building the score map, where carrier/tier is known:

```
score = min(100, baseScore + tierBonus(tier))
```

and a tag (e.g. `etisalat-platinum+`) is appended to the number's tags. That tag flows
into the LLM candidate payload; one line is added to the grader system prompt so the LLM
knows the operator tier is a positive signal. Vodafone numbers get no bonus and no tier tag.

## Module changes

### `src/config.js`
- `ETISALAT_ENDPOINT` base URL.
- `ETISALAT_POOLS`: ordered map `poolId -> { tier, bonus }`.
- `ETISALAT_APP_NAME` (default `"MAB"`) and `ETISALAT_APP_PASSWORD` — env-overridable,
  defaulting to the verified working values.
- A `tierBonus(tier)` helper (or derive from `ETISALAT_POOLS`).

### `src/fetch.js`
- Rename the current `fetchCatalog` body to `fetchVodafone()`; tag each record `carrier: "vodafone"`.
- Add `fetchEtisalat()`: loops the 5 pools, GET each with the same retry/backoff/timeout
  machinery, parses `numbers[]`, maps each to `{id: msisdn, msisdn, available: true,
  carrier: "etisalat", tier, simType: "", price: 0, tariffs: []}`, filters via the msisdn
  regex, and dedupes by msisdn keeping the **highest** tier if a number appears in multiple pools.
- Add `fetchAll()` that runs both and returns merged `{ records, totalElements, returned }`.
  **Failure semantics:** if *either* carrier hard-fails after retries, `fetchAll` throws so
  `run.js` skips the run and preserves good data (matches today's "never overwrite" rule and
  avoids falsely marking an entire carrier as "gone").

### `src/run.js`
- Call `fetchAll()` instead of `fetchCatalog()`.
- Build `carrierMap` and `tierMap` alongside `scoreMap`/`simTypeMap`.
- Apply the tier bonus when populating `scoreMap` (and the tier tag).
- Thread `carrierMap`/`tierMap` through `updateHistory`, `buildLatest`, and the alert payload.

### `src/store.js`
- `updateHistory`: persist `carrier` and `tier` per entry (carry forward on "gone").
- `buildLatest`: include `carrier` and `tier` on `best_thirty` and `all_available` rows.

### `src/notify.js`
- Add a "Carrier" column to the alert issue table.

### `web/index.html` + `web/app.js`
- Add an All / Vodafone / Etisalat filter (segmented control or select) wired into `state`
  and `currentRows()`.
- Render a **carrier badge** (e.g. Vodafone red, Etisalat green) and a **tier badge** for
  Etisalat rows, reusing the existing pill component pattern. The existing eSIM/Physical pill
  remains for Vodafone rows.

## Error handling

- Per-pool and per-page fetches retry with exponential backoff (reuse existing helper).
- Any carrier hard-failure after retries → `fetchAll` throws → run skipped, no data overwrite.
- `computeDiff`'s existing >50% suspicious-shrink guard still protects against a silent
  total Etisalat outage that somehow returns empty rather than throwing.

## Testing

- `fetch.test.js` (new or extended): Etisalat response parsing, msisdn filtering, cross-pool
  dedupe keeping highest tier, and `fetchAll` merge.
- Tier-bonus scoring: base score + bonus capped at 100, correct tier tag.
- `store.test.js`: `carrier`/`tier` persisted in history and present on latest rows.
- Existing `score`/`diff`/`grade`/`store` tests remain green (all changes additive).

## Out of scope (YAGNI)

- Full enumeration beyond the ~1000/pool cap (pattern-splitting).
- Per-carrier separate dashboards/tabs (explicitly rejected in favor of unified).
- Lowering alert thresholds by tier (only the additive score bonus was chosen).
