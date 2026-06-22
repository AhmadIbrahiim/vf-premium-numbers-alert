# Design: Add WE Egypt (Telecom Egypt) numbers to the premium-numbers tracker

**Date:** 2026-06-21
**Status:** Implemented (branch `feat/we-numbers`, off `main`)

## Goal

Extend the tracker to also collect, grade, and alert on **WE Egypt** (Telecom Egypt,
prefix `015`) premium numbers, in a single unified dashboard with a carrier filter. WE's
premium "grade" is shown as a badge (informational); it does **not** affect scoring/ranking.

## Relationship to the Etisalat work

The carrier-merge architecture (a `carrier`/`tier` field, a `fetchAll` merge wrapper,
carrier badges + a dashboard carrier filter) was introduced by the earlier Etisalat PR,
which **has since been merged into `main`**. This branch was reset onto the updated `main`
and re-applies the WE feature **on top of** that architecture — adding WE as a *third*
carrier (vodafone + etisalat + we) rather than re-introducing the scaffolding. Field names
(`carrier`/`tier`) are shared; for WE, `tier` carries the opaque grade code.

## Background

The pipeline (`src/`) monitors Vodafone + Etisalat numbers: `fetchAll()` → score → diff vs
history → LLM grade → persist `history.json`/`latest.json`/`events.jsonl.json` → GitHub
alert issue. The scorer's regex is `^01[0125]\d{8}$`, which **already accepts the `015` WE
prefix**. Vodafone (`010`), Etisalat (`011`), and WE (`015`) MSISDNs never collide, so the
entire msisdn-keyed pipeline works on the merged set.

## Data source (verified live via browser)

- Endpoint: `POST https://numbers.te.eg/echannel/service/besapp/base/rest/busiservice/cz/v1/offering/queryAvailabeNumbers`
- Request body (a **pattern search**):
  ```json
  {"fitmod":"15????????","maxCount":"51","pageindex":"1","numberlevel":"GRADE_017"}
  ```
  - `fitmod`: 10-char pattern = `15` + 8 subscriber digits; `?` = wildcard. We use all
    wildcards (`15????????`) to list everything in a grade.
  - `maxCount`: page size (server caps at 51). `pageindex`: 1-based page (paginate by incrementing).
  - `numberlevel`: the premium **grade** (e.g. `GRADE_017`).
- Response:
  ```json
  {"header":{"retCode":"0","validateResults":[]},
   "body":{"telnumlist":[{"telnum":1555027138,"telprice":0,"ouid":"...","resourse_type":"..."}]}}
  ```
  - `telnum` is an **integer without the leading 0** → msisdn = `"0" + String(telnum)`.
  - `retCode: "0"` = success. **A non-zero `retCode` (e.g. `"1010"`) means the gating tokens
    were rejected and is treated as a HARD FAILURE — `fetchWe` throws, so the run is skipped
    and existing data is preserved (fail-closed). It is NOT silently skipped.**
- Required headers — a **static gating set** (verified): `Content-Type`, `Accept`,
  `channelId: 713`, `isCoporate: true`, `isSelfcare: true`, `isMobile: false`,
  `isOperator/isRetail/isDealer: false`, `isDealerCust: N`, `languageCode: en-US`,
  `csrftoken:` (empty), `deviceId`, `x-init-time`, `x-client-time`, `whiteReqHeaderSign`,
  `whiteReqBodySign`.

### What was verified (so a plain Node fetch suffices — no anti-bot bypass)
- The `whiteReqHeaderSign`/`whiteReqBodySign` are **static** (identical across a 19-minute
  gap and a changed `x-client-time`) and are **not validated against the request body** — the
  pattern, grade, and page were all varied with the same signs and every call returned
  `retCode 0`. They behave as static gating tokens, the same class as Vodafone's
  `X_CONTEXT_REQUEST` and Etisalat's `applicationPassword`.
- **No cookies required** (`credentials:"omit"` still returns numbers).
- We replicate the request with a static captured header set (env-overridable); we do **not**
  compute or forge per-request signatures. If WE invalidates the captured `deviceId`/sign
  tuple, the poller fails closed (run skipped, data preserved) until the env values are refreshed.

### Grades (tiers)
Active grades observed: `GRADE_006–009, 012–015, 017–019` (others empty). The active set
shifts with inventory, so the fetcher **enumerates grades dynamically each run** (probe
`GRADE_001`..`GRADE_030`, keep those returning numbers) rather than hardcoding the list.
Grades are **opaque codes** with no labeled premium ordering, so they are displayed as a
badge only and do not influence scoring.

## Data model (additive, backward-compatible)

`carrier` gains a `"we"` value; `tier` carries the WE grade code (e.g. `"GRADE_017"`) for WE
rows, empty for Vodafone. Old history without these fields degrades gracefully (carrier
inferred from the `010`/`011`/`015` prefix; fallbacks in store/dashboard).

## Module changes (deltas on top of main's carrier architecture)

- **`src/config.js`** — WE endpoint + static gating tokens (env-overridable, documented);
  validated positive-integer bounds (`WE_GRADE_MIN/MAX`, `WE_PAGE_SIZE`, `WE_MAX_PAGES`) via
  an `intEnv` helper; `weGradeSlug(n)`.
- **`src/fetch.js`** — shared `fetchJsonWithRetry` extended to POST+body and corrected to
  **truly fail-fast on non-429 4xx** (previously the throw was caught and retried); new
  `fetchWe` (grade enumeration + pagination, dedupe first-grade-wins, fail-closed on
  `retCode != "0"`); `fetchAll` now merges all three carriers.
  - **WE inventory is large and returned in a STABLE ascending numeric order.** Each grade is
    paged to a best-effort cap (`WE_MAX_PAGES`, default 20 → ~1020/grade); reaching the cap is
    expected *sampling*, not unknown truncation (the first N pages are the same set each run,
    so no false "gone" churn), and is logged — not thrown. Raise `WE_MAX_PAGES` to pull deeper.
    Whole-run abort is reserved for genuine auth/transport failures (`retCode != "0"`).
- **`src/run.js`** — tier bonus/LLM-tag are **Etisalat-only** (carrier-aware): WE numbers get
  no bonus and no `etisalat-` tag. The commit-gating signature now includes `tier` so a
  metadata-only change still triggers a commit.
- **Re-evaluate on demand** — `REGRADE=1` (env, or the `regrade` input on the manual
  "Run workflow" dispatch) bypasses the LLM grade cache and re-grades every candidate. Breadth
  is governed by `CANDIDATE_COUNT` (env, default 150).
- **`src/store.js`** — carrier/tier resolution uses key-presence checks (not `||`) so an
  explicit empty value isn't masked by stale history.
- **`src/notify.js`** — `carrierLabel` adds `we → "WE"`.
- **`web/index.html` + `web/app.js`** — WE option in the carrier filter; `carrierOf` infers
  `015 → we`; `gradeLabel` ("GRADE_017" → "G17"); a purple WE pill + amber grade pill in
  `carrierBadges`; copy updated to all three carriers. Copilot dashboard hardening preserved.

## Error handling
- Per-grade/page and Vodafone/Etisalat fetches retry with backoff; non-429 4xx fails fast.
- Any carrier hard-failure (incl. WE `retCode != "0"` or page-cap overrun) → `fetchAll`
  throws → run skipped, no overwrite.
- A WE grade with no inventory (`retCode 0`, empty list) is simply skipped — not an error.
- The existing `computeDiff` >50% suspicious-shrink guard still protects against a silent
  total WE outage that returns empty instead of throwing.

## Testing
- `config.test.js`: `weGradeSlug`; env-independent bound assertions.
- `fetch.test.js`: WE parsing (`telnum`→msisdn), pagination stop, grade enumeration +
  skip-empty + merge, dedupe first-grade-wins, throw on `retCode != 0`, throw on HTTP
  failure, fail-closed on page-cap overrun; `fetchAll` 3-carrier merge.
- `notify.test.js`: WE carrier label.
- `run.test.js`: integration — all three carriers in `latest.json`/`history.json`; WE grade
  in `tier`; **WE score == base digit score (no bonus)**.
- All existing Vodafone + Etisalat tests stay green (74 total).

## Out of scope (YAGNI)
- Per-grade score bonus / tier ordering (grades are opaque → badge only, decided).
- Reverse-engineering / computing the WE request signatures (declined; static tokens reused).
- Reserving/purchasing numbers (read-only listing only).
