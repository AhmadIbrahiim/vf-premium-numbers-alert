# Build conventions (read before writing any module)

The **poller** (`src/`, `test/`) is a **zero-dependency Node.js 20+ project using ES
modules** — that constraint still holds and should be defended. The **dashboard**
(`web/`) is a separate package: a Next.js app with React, deployed to Vercel. Installing
one never affects the other.

## Hard rules
- ES modules only: `import`/`export`, never `require`. Files end in `.js`.
- **No external npm dependencies.** Use only Node built-ins:
  - HTTP: global `fetch` (Node 20+). Do NOT add axios/node-fetch.
  - UUID: `import { randomUUID } from "node:crypto"`.
  - FS: `import { readFile, writeFile, mkdir } from "node:fs/promises"`.
  - Tests: built-in `node:test` + `node:assert/strict`. Run with `node --test`.
- Keep each module a small, pure-where-possible unit with a single responsibility.
- Export named functions (not default exports) matching the contracts below exactly.
- Use `const`/`let`, async/await, early returns. No classes unless natural.
- Add concise JSDoc on each exported function.

## Shared data shapes

A parsed catalog record (produced by `src/fetch.js`):
```js
/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[], carrier: string, tier: string }} Record */
```

`msisdn` is an 11-digit Egyptian mobile string like `"01055455833"` (prefix `01[0125]` + 8 digits).
"Premium" is judged purely on the digit pattern; price is flat (350 EGP) for all numbers.

Number state (one row per msisdn in Neon Postgres — see `src/db.js`):
```sql
numbers(msisdn text primary key, carrier text, tier text, sim_type text,
        score int, tags text[], best_grade int,
        first_seen date, last_seen date, available boolean, run_seq bigint)
```
`first_seen` is set on insert and never overwritten; `best_grade` only ever climbs;
`run_seq` marks the run that last saw the row, which is how disappearances are found.
Dates are `YYYY-MM-DD` in Africa/Cairo time.

## Module contracts (implement EXACTLY these signatures)

`src/score.js`:
```js
/** Pure. Score how premium a number's pattern is. @param {string} msisdn @returns {{score:number, tags:string[]}} score 0-100 */
export function scoreMsisdn(msisdn) { ... }
```

`src/diff.js`:
```js
/**
 * Pure. Compare the current available set against prior history.
 * @param {object} p
 * @param {string[]} p.current  - available msisdns this run
 * @param {Record<string, HistoryEntry>} p.history - prior history map (may be {})
 * @returns {{ isBaseline:boolean, newMsisdns:string[], disappearedMsisdns:string[], suspicious:boolean }}
 *   isBaseline: true when history is empty (first run) -> caller suppresses alerts
 *   suspicious: true when current count dropped >50% vs prior available count -> caller skips diff/alerts
 */
export function computeDiff({ current, history }) { ... }
```

`src/grade.js`:
```js
/**
 * Rank candidates into the best 30 with reasons via GitHub Models; deterministic fallback on any error.
 * @param {Array<{msisdn:string, score:number, tags:string[]}>} candidates - already pattern-ranked, top ~80
 * @param {object} [opts] - { token, model, count=30, fetchImpl }
 * @returns {Promise<Array<{msisdn:string, grade:number, reason:string}>>}  length <= count
 */
export async function gradeCandidates(candidates, opts = {}) { ... }
```
GitHub Models: `POST https://models.github.ai/inference/chat/completions`,
header `Authorization: Bearer <token>` (the Actions `GITHUB_TOKEN`), JSON body
`{ model, messages:[...], temperature:0.2, response_format:{type:"json_object"} }`.
Default model: a low-tier one (e.g. `"openai/gpt-4o-mini"`). On non-200, timeout, or
unparseable output, return the top `count` candidates with `grade = score` and
`reason = tags.join(", ")`. Inject `opts.fetchImpl || globalThis.fetch` so it is testable.

## Testing
- Put tests in `test/*.test.js`, run via `node --test`.
- Pure modules (`score`, `diff`) get thorough unit tests with real-looking msisdns.
- A real-data sample lives at `test/fixtures/catalog-sample.json` (Spring page object with `content[]`).
