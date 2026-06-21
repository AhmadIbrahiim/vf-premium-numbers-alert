# Etisalat Numbers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect, grade, and alert on Etisalat Egypt premium numbers in the existing tracker, shown in a single unified dashboard with a carrier filter and an operator-tier badge that also boosts a number's score.

**Architecture:** Etisalat numbers (`011…`) never collide with Vodafone (`010…`), so they merge into the existing msisdn-keyed pipeline (score → diff → grade → history/latest → alert) without structural change. We add a second fetch source (`fetchEtisalat`), a merge wrapper (`fetchAll`), and two additive fields — `carrier` and `tier` — that flow through `run.js`, `store.js`, `notify.js`, and the dashboard. The operator tier maps to an additive score bonus applied in `run.js`.

**Tech Stack:** Node.js ≥20 (ESM), `node:test` + `node:assert/strict`, vanilla DOM dashboard with Tailwind. No new dependencies.

## Global Constraints

- Node ≥20, ES modules (`"type": "module"`), no new runtime dependencies.
- All new code follows existing style: small pure functions with JSDoc, `fetchImpl` dependency injection for network, deterministic (no `Date`/random) in pure modules.
- MSISDN validity regex is `^01[0125]\d{8}$` (already accepts Etisalat `011`).
- New fields are additive and backward-compatible: `carrier` (`"vodafone" | "etisalat"`) and `tier` (Etisalat slugs `silver | golden | golden_plus | platinum | platinum_plus`, else `""`).
- Tier → score bonus: `silver:0, golden:4, golden_plus:8, platinum:12, platinum_plus:16`; final `score = min(100, base + bonus)`.
- Etisalat pools: `135=silver, 136=golden, 137=golden_plus, 138=platinum, 139=platinum_plus`.
- Fetch-failure rule (unchanged philosophy): any carrier hard-fails after retries → throw → `run.js` skips the run, never overwriting good data.
- XSS-safe dashboard: dynamic text via `textContent` only; `innerHTML` only for static SVG.
- Run the whole suite with `npm test` (`node --test`). Existing tests must stay green.

## Pre-flight (read before starting)

The working tree has **pre-existing uncommitted WIP** unrelated to this feature (Vodafone physical-SIM support, catalog pagination, `simType`) across `src/config.js`, `src/fetch.js`, `src/notify.js`, `src/run.js`, `src/store.js`, `web/app.js`. This plan's code is written against that current working-tree state. **Before Task 1, confirm with the maintainer whether that WIP should be committed first** (recommended, so Etisalat commits are clean) or intentionally bundled. All file excerpts below reflect the current working-tree content.

## File Structure

- `src/config.js` — **modify**: add Etisalat endpoint/credentials, `ETISALAT_POOLS`, `tierBonus()`.
- `src/fetch.js` — **modify**: extract shared `fetchJsonWithRetry`; rename `fetchCatalog`→`fetchVodafone` (tag `carrier:"vodafone"`); add `fetchEtisalat`; add `fetchAll`.
- `src/run.js` — **modify**: call `fetchAll`; build `carrierMap`/`tierMap`; apply tier bonus to scores; thread through history/latest/alerts.
- `src/store.js` — **modify**: persist `carrier`/`tier` in `updateHistory`; emit them in `buildLatest`.
- `src/notify.js` — **modify**: add a Carrier column to the alert table.
- `web/index.html` — **modify**: add a carrier filter `<select>`; update footer/subtitle copy.
- `web/app.js` — **modify**: carrier+tier badges, carrier filter wiring, `carrierOf()` helper.
- `test/fetch.test.js` — **create**: Etisalat parsing/dedupe + `fetchAll` merge + Vodafone carrier tag.
- `test/config.test.js` — **create**: `tierBonus()` table.
- `test/store.test.js` — **modify**: `updateHistory`/`buildLatest` carry `carrier`/`tier`.
- `test/run.test.js` — **create**: integration — merged pipeline writes both carriers into `latest.json`/`history.json`.

---

### Task 1: Etisalat config + `tierBonus`

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js` (create)

**Interfaces:**
- Produces:
  - `ETISALAT_ENDPOINT: string` (base URL, no `poolId`/`searchPattern`)
  - `ETISALAT_REFERER: string`
  - `ETISALAT_APP_NAME: string`, `ETISALAT_APP_PASSWORD: string`
  - `ETISALAT_POOLS: Array<{ poolId: number, tier: string, bonus: number }>` (ordered low→high tier)
  - `tierBonus(tier: string): number` — bonus for a tier slug, `0` if unknown/empty

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ETISALAT_POOLS, tierBonus } from "../src/config.js";

test("ETISALAT_POOLS maps the five pools to tiers and bonuses", () => {
  assert.deepEqual(
    ETISALAT_POOLS.map((p) => [p.poolId, p.tier, p.bonus]),
    [
      [135, "silver", 0],
      [136, "golden", 4],
      [137, "golden_plus", 8],
      [138, "platinum", 12],
      [139, "platinum_plus", 16],
    ],
  );
});

test("tierBonus returns the bonus for a known tier", () => {
  assert.equal(tierBonus("silver"), 0);
  assert.equal(tierBonus("golden"), 4);
  assert.equal(tierBonus("platinum_plus"), 16);
});

test("tierBonus is 0 for unknown or empty tier", () => {
  assert.equal(tierBonus(""), 0);
  assert.equal(tierBonus("gold"), 0);
  assert.equal(tierBonus(undefined), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `ETISALAT_POOLS`/`tierBonus` are not exported.

- [ ] **Step 3: Add config + helper**

Append to `src/config.js` (after the existing exports, before/after `dayDiff` — placement is not significant):

```javascript
/** Etisalat Egypt reserved-number pools API (no cookie/JSESSIONID required). */
export const ETISALAT_ENDPOINT =
  "https://www.etisalat.eg/Saytar/rest/dialReservationWS/getDials?type=GetPoolDialsRequest";
export const ETISALAT_REFERER = "https://www.etisalat.eg/eshop2/";
export const ETISALAT_APP_NAME = process.env.ETISALAT_APP_NAME || "MAB";
export const ETISALAT_APP_PASSWORD =
  process.env.ETISALAT_APP_PASSWORD || "ZFZyqUpqeO9TMhXg4R/9qs0Igwg=";

/**
 * Etisalat premium pools, ordered low→high tier. `bonus` is added to a number's
 * heuristic score (capped at 100); higher bonus also wins cross-pool dedupe.
 */
export const ETISALAT_POOLS = [
  { poolId: 135, tier: "silver", bonus: 0 },
  { poolId: 136, tier: "golden", bonus: 4 },
  { poolId: 137, tier: "golden_plus", bonus: 8 },
  { poolId: 138, tier: "platinum", bonus: 12 },
  { poolId: 139, tier: "platinum_plus", bonus: 16 },
];

/** Score bonus for an Etisalat operator tier slug; 0 for unknown/empty. */
export function tierBonus(tier) {
  const p = ETISALAT_POOLS.find((x) => x.tier === tier);
  return p ? p.bonus : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: Etisalat pool config and tier-bonus helper"
```

---

### Task 2: `fetchEtisalat` + shared retry helper + Vodafone carrier tag

**Files:**
- Modify: `src/fetch.js`
- Test: `test/fetch.test.js` (create)

**Interfaces:**
- Consumes: `ETISALAT_ENDPOINT`, `ETISALAT_REFERER`, `ETISALAT_APP_NAME`, `ETISALAT_APP_PASSWORD`, `ETISALAT_POOLS`, `USER_AGENT` from `./config.js`.
- Produces:
  - `fetchVodafone(opts?): Promise<{ records, totalElements, returned }>` (renamed from `fetchCatalog`; each record now has `carrier:"vodafone"`, `tier:""`).
  - `fetchEtisalat(opts?): Promise<{ records, totalElements, returned }>` — `opts` adds optional `pools` (defaults to `ETISALAT_POOLS`); each record `{ id, msisdn, available:true, price:0, simType:"", tariffs:[], carrier:"etisalat", tier }`. Dedupes by msisdn keeping the highest-bonus tier.
  - Record typedef gains `carrier: string` and `tier: string`.

- [ ] **Step 1: Write the failing test**

Create `test/fetch.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEtisalat, fetchVodafone } from "../src/fetch.js";

/** Fake fetch returning a JSON body for any Etisalat pool URL. `byPool` maps poolId->numbers[]. */
function etisalatFetch(byPool) {
  return async (url) => {
    const poolId = new URL(url).searchParams.get("poolId");
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: true, numbers: byPool[poolId] || [] }),
    };
  };
}

test("fetchEtisalat maps pool numbers to carrier+tier records", async () => {
  const fetchImpl = etisalatFetch({
    135: ["01100000001"],
    139: ["01199999999"],
  });
  const { records } = await fetchEtisalat({
    fetchImpl,
    pools: [
      { poolId: 135, tier: "silver", bonus: 0 },
      { poolId: 139, tier: "platinum_plus", bonus: 16 },
    ],
  });
  const byId = Object.fromEntries(records.map((r) => [r.msisdn, r]));
  assert.equal(byId["01100000001"].carrier, "etisalat");
  assert.equal(byId["01100000001"].tier, "silver");
  assert.equal(byId["01100000001"].available, true);
  assert.equal(byId["01199999999"].tier, "platinum_plus");
});

test("fetchEtisalat dedupes across pools keeping the highest tier", async () => {
  const fetchImpl = etisalatFetch({
    135: ["01100000001"],
    138: ["01100000001"], // same number, higher pool
  });
  const { records } = await fetchEtisalat({
    fetchImpl,
    pools: [
      { poolId: 135, tier: "silver", bonus: 0 },
      { poolId: 138, tier: "platinum", bonus: 12 },
    ],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].tier, "platinum");
});

test("fetchEtisalat drops malformed msisdns", async () => {
  const fetchImpl = etisalatFetch({ 135: ["01100000001", "9999", "", "0111234567890"] });
  const { records } = await fetchEtisalat({
    fetchImpl,
    pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
  });
  assert.deepEqual(records.map((r) => r.msisdn), ["01100000001"]);
});

test("fetchEtisalat throws when a pool hard-fails (4xx)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(
    () => fetchEtisalat({ fetchImpl, retries: 0, pools: [{ poolId: 135, tier: "silver", bonus: 0 }] }),
    /pool 135/,
  );
});

test("fetchVodafone tags records with carrier vodafone", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }],
      totalElements: 1,
    }),
  });
  const { records } = await fetchVodafone({ fetchImpl });
  assert.equal(records.length, 1);
  assert.equal(records[0].carrier, "vodafone");
  assert.equal(records[0].tier, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fetch.test.js`
Expected: FAIL — `fetchEtisalat`/`fetchVodafone` are not exported (only `fetchCatalog` exists).

- [ ] **Step 3: Refactor `src/fetch.js`**

3a. Update imports at the top to include the Etisalat config:

```javascript
import { randomUUID } from "node:crypto";
import {
  ENDPOINT,
  X_CONTEXT_REQUEST,
  USER_AGENT,
  REFERER,
  ETISALAT_ENDPOINT,
  ETISALAT_REFERER,
  ETISALAT_APP_NAME,
  ETISALAT_APP_PASSWORD,
  ETISALAT_POOLS,
} from "./config.js";
```

3b. Update the Record typedef to add the two fields:

```javascript
/** @typedef {{ id: string, msisdn: string, available: boolean, price: number, simType: string, tariffs: string[], carrier: string, tier: string }} Record */
```

3c. Add the shared regex + retry helper near the top (after `const sleep = ...`):

```javascript
const MSISDN_RE = /^01[0125]\d{8}$/;

/**
 * GET `url` and return parsed JSON, with retry/backoff. Fails fast on non-429 4xx.
 * Throws (with `label` in the message) on persistent failure.
 */
async function fetchJsonWithRetry({ doFetch, url, headers, retries, baseDelayMs, timeoutMs, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: "GET", signal: controller.signal, headers });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}
```

3d. In `parseRecord`, add the two fields so Vodafone records carry the carrier:

```javascript
function parseRecord(r) {
  return {
    id: String(r.id ?? ""),
    msisdn: String(r.msisdn ?? ""),
    available: Boolean(r.available),
    price: Number(r?.defaultPrice?.amount ?? 0),
    simType: String(r.simType ?? ""),
    tariffs: Array.isArray(r.tariffs)
      ? r.tariffs.filter((t) => t && t.applicable !== false).map((t) => String(t.id))
      : [],
    carrier: "vodafone",
    tier: "",
  };
}
```

3e. Rename `export async function fetchCatalog(opts = {})` to `export async function fetchVodafone(opts = {})`, and replace its inner `fetchPage`'s body to use the shared helper. The new `fetchPage` reads:

```javascript
  async function fetchPage(page) {
    return fetchJsonWithRetry({
      doFetch,
      url: pageUrl(page),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": "en_US",
        "user-agent": USER_AGENT,
        referer: REFERER,
        traceid: randomUUID(),
        "x-context-request": X_CONTEXT_REQUEST,
      },
      retries,
      baseDelayMs,
      timeoutMs,
      label: `fetchVodafone page ${page}`,
    });
  }
```

Also change the msisdn filter line in `fetchVodafone` to reuse the shared regex:

```javascript
  const records = raw.map(parseRecord).filter((r) => MSISDN_RE.test(r.msisdn));
```

3f. Add `fetchEtisalat` at the end of the file:

```javascript
/**
 * Fetch all Etisalat premium pools, mapping each available number to a record.
 * Dedupes by msisdn keeping the highest-bonus tier. Throws on persistent
 * per-pool failure so the caller can skip the run without overwriting data.
 *
 * @param {object} [opts] - { fetchImpl, retries=4, baseDelayMs=1000, timeoutMs=45000, pools }
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchEtisalat(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const pools = opts.pools || ETISALAT_POOLS;

  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    referer: ETISALAT_REFERER,
    "user-agent": USER_AGENT,
    applicationName: ETISALAT_APP_NAME,
    applicationPassword: ETISALAT_APP_PASSWORD,
  };

  const byMsisdn = new Map(); // msisdn -> { tier, bonus }
  let returned = 0;
  for (const pool of pools) {
    const url = `${ETISALAT_ENDPOINT}&poolId=${pool.poolId}&searchPattern=*`;
    const body = await fetchJsonWithRetry({
      doFetch, url, headers, retries, baseDelayMs, timeoutMs,
      label: `fetchEtisalat pool ${pool.poolId}`,
    });
    const numbers = Array.isArray(body?.numbers) ? body.numbers : [];
    returned += numbers.length;
    for (const n of numbers) {
      const msisdn = String(n);
      if (!MSISDN_RE.test(msisdn)) continue;
      const prev = byMsisdn.get(msisdn);
      if (!prev || pool.bonus > prev.bonus) byMsisdn.set(msisdn, { tier: pool.tier, bonus: pool.bonus });
    }
  }

  const records = [...byMsisdn.entries()].map(([msisdn, { tier }]) => ({
    id: msisdn,
    msisdn,
    available: true,
    price: 0,
    simType: "",
    tariffs: [],
    carrier: "etisalat",
    tier,
  }));
  return { records, totalElements: records.length, returned };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/fetch.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite (catch the rename fallout)**

Run: `npm test`
Expected: `run.js` still imports `fetchCatalog`, which no longer exists — this surfaces in Task 3/5. For now, confirm `config`, `fetch`, `score`, `diff`, `grade`, `store` test files pass. (Do not commit yet if `npm test` errors on an import; proceed to Task 3 which fixes the consumer.)

- [ ] **Step 6: Commit**

```bash
git add src/fetch.js test/fetch.test.js
git commit -m "feat: fetchEtisalat + shared retry helper, tag Vodafone carrier"
```

---

### Task 3: `fetchAll` merge wrapper

**Files:**
- Modify: `src/fetch.js`
- Test: `test/fetch.test.js` (extend)

**Interfaces:**
- Consumes: `fetchVodafone`, `fetchEtisalat` (Task 2).
- Produces: `fetchAll(opts?): Promise<{ records, totalElements, returned }>` — concatenates both carriers' records and sums totals; rejects if either source rejects.

- [ ] **Step 1: Write the failing test**

Append to `test/fetch.test.js`:

```javascript
import { fetchAll } from "../src/fetch.js";

/** Route a single fake fetch to VF or Etisalat by URL. */
function routedFetch({ vf, etByPool }) {
  return async (url) => {
    if (url.includes("eshop.vodafone")) {
      return { ok: true, status: 200, json: async () => vf };
    }
    if (url.includes("etisalat.eg")) {
      const poolId = new URL(url).searchParams.get("poolId");
      return { ok: true, status: 200, json: async () => ({ status: true, numbers: etByPool[poolId] || [] }) };
    }
    throw new Error("unexpected url " + url);
  };
}

test("fetchAll merges Vodafone and Etisalat records", async () => {
  const fetchImpl = routedFetch({
    vf: {
      content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }],
      totalElements: 1,
    },
    etByPool: { 135: ["01100000001"], 139: ["01199999999"] },
  });
  const { records, totalElements, returned } = await fetchAll({ fetchImpl });
  const carriers = records.map((r) => r.carrier).sort();
  assert.deepEqual([...new Set(carriers)].sort(), ["etisalat", "vodafone"]);
  assert.equal(records.length, 3);
  assert.equal(totalElements, 1 + 2);
  assert.equal(returned, 1 + 2);
});

test("fetchAll rejects when Etisalat hard-fails", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("eshop.vodafone")) {
      return { ok: true, status: 200, json: async () => ({ content: [], totalElements: 0 }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  await assert.rejects(() => fetchAll({ fetchImpl, retries: 0 }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fetch.test.js`
Expected: FAIL — `fetchAll` not exported.

- [ ] **Step 3: Add `fetchAll` to `src/fetch.js`**

Append:

```javascript
/**
 * Fetch both carriers and merge. Rejects if EITHER source rejects, so the caller
 * skips the run and never overwrites good data with a partial set.
 *
 * @param {object} [opts] - forwarded to fetchVodafone/fetchEtisalat (e.g. fetchImpl, retries)
 * @returns {Promise<{ records: Record[], totalElements: number, returned: number }>}
 */
export async function fetchAll(opts = {}) {
  const [vf, et] = await Promise.all([fetchVodafone(opts), fetchEtisalat(opts)]);
  return {
    records: [...vf.records, ...et.records],
    totalElements: vf.totalElements + et.totalElements,
    returned: vf.returned + et.returned,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fetch.test.js`
Expected: PASS (7 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/fetch.js test/fetch.test.js
git commit -m "feat: fetchAll merges Vodafone + Etisalat sources"
```

---

### Task 4: Persist `carrier`/`tier` in store

**Files:**
- Modify: `src/store.js`
- Test: `test/store.test.js` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces (changed signatures):
  - `updateHistory({ history, available, scoreMap, gradeMap, simTypeMap?, carrierMap?, tierMap?, today })` — each available entry gains `carrier` and `tier`; gone entries carry forward prior values.
  - `buildLatest({ ..., simTypeMap?, carrierMap?, tierMap? })` — every `best_thirty` and `all_available` row gains `carrier` and `tier`.

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js` (add imports for the two functions at the top of the file):

```javascript
import { updateHistory, buildLatest } from "../src/store.js";

test("updateHistory stores carrier and tier for available numbers", () => {
  const next = updateHistory({
    history: {},
    available: ["01199999999", "01055455833"],
    scoreMap: new Map([
      ["01199999999", { score: 50, tags: [] }],
      ["01055455833", { score: 60, tags: [] }],
    ]),
    gradeMap: new Map(),
    carrierMap: new Map([
      ["01199999999", "etisalat"],
      ["01055455833", "vodafone"],
    ]),
    tierMap: new Map([["01199999999", "platinum"]]),
    today: "2026-06-20",
  });
  assert.equal(next["01199999999"].carrier, "etisalat");
  assert.equal(next["01199999999"].tier, "platinum");
  assert.equal(next["01055455833"].carrier, "vodafone");
  assert.equal(next["01055455833"].tier, "");
});

test("updateHistory carries carrier/tier forward when a number goes gone", () => {
  const history = {
    "01199999999": { first_seen: "2026-06-01", last_seen: "2026-06-19", score: 50, tags: [], best_grade: 50, carrier: "etisalat", tier: "golden", status: "available" },
  };
  const next = updateHistory({
    history,
    available: [],
    scoreMap: new Map(),
    gradeMap: new Map(),
    today: "2026-06-20",
  });
  assert.equal(next["01199999999"].status, "gone");
  assert.equal(next["01199999999"].carrier, "etisalat");
  assert.equal(next["01199999999"].tier, "golden");
});

test("buildLatest includes carrier and tier on rows", () => {
  const latest = buildLatest({
    total: 2,
    bestThirty: [{ msisdn: "01199999999", score: 62, grade: 80, reason: "r", tags: [] }],
    history: { "01199999999": { first_seen: "2026-06-20" }, "01055455833": {} },
    diff: { newMsisdns: [], disappearedMsisdns: [], newSet: new Set() },
    today: "2026-06-20",
    generatedAt: "2026-06-20T00:00:00Z",
    available: ["01199999999", "01055455833"],
    scoreMap: new Map([
      ["01199999999", { score: 62, tags: [] }],
      ["01055455833", { score: 30, tags: [] }],
    ]),
    carrierMap: new Map([
      ["01199999999", "etisalat"],
      ["01055455833", "vodafone"],
    ]),
    tierMap: new Map([["01199999999", "platinum"]]),
  });
  assert.equal(latest.best_thirty[0].carrier, "etisalat");
  assert.equal(latest.best_thirty[0].tier, "platinum");
  const vf = latest.all_available.find((r) => r.msisdn === "01055455833");
  assert.equal(vf.carrier, "vodafone");
  assert.equal(vf.tier, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — rows lack `carrier`/`tier`.

- [ ] **Step 3: Update `updateHistory` in `src/store.js`**

Change the signature and the available-entry construction:

```javascript
export function updateHistory({ history, available, scoreMap, gradeMap, simTypeMap = new Map(), carrierMap = new Map(), tierMap = new Map(), today }) {
  const next = {};
  for (const [msisdn, entry] of Object.entries(history)) {
    next[msisdn] = { ...entry, status: "gone" };
  }
  for (const msisdn of available) {
    const prev = history[msisdn];
    const s = scoreMap.get(msisdn) || { score: prev?.score ?? 0, tags: prev?.tags ?? [] };
    const grade = gradeMap.get(msisdn);
    const bestGrade = Math.max(prev?.best_grade ?? 0, grade ?? 0, s.score);
    next[msisdn] = {
      first_seen: prev?.first_seen ?? today,
      last_seen: today,
      score: s.score,
      tags: s.tags,
      best_grade: bestGrade,
      sim_type: simTypeMap.get(msisdn) || prev?.sim_type || "",
      carrier: carrierMap.get(msisdn) || prev?.carrier || "vodafone",
      tier: tierMap.get(msisdn) || prev?.tier || "",
      status: "available",
    };
  }
  return next;
}
```

- [ ] **Step 4: Update `buildLatest` in `src/store.js`**

Change the signature and both row builders:

```javascript
export function buildLatest({ total, bestThirty, history, diff, today, generatedAt, available = [], scoreMap = new Map(), simTypeMap = new Map(), carrierMap = new Map(), tierMap = new Map() }) {
  const best_thirty = bestThirty.map((c) => {
    const h = history[c.msisdn] || {};
    return {
      msisdn: c.msisdn,
      score: c.score,
      grade: c.grade,
      reason: c.reason,
      tags: c.tags || h.tags || [],
      sim_type: simTypeMap.get(c.msisdn) || h.sim_type || "",
      carrier: carrierMap.get(c.msisdn) || h.carrier || "vodafone",
      tier: tierMap.get(c.msisdn) || h.tier || "",
      is_new: diff.newSet.has(c.msisdn),
      first_seen: h.first_seen || today,
      age_days: dayDiff(h.first_seen || today, today),
    };
  });

  const gradedSet = new Set(best_thirty.map((c) => c.msisdn));
  const all_available = available
    .filter((msisdn) => !gradedSet.has(msisdn))
    .map((msisdn) => {
      const s = scoreMap.get(msisdn) || { score: 0, tags: [] };
      const h = history[msisdn] || {};
      return {
        msisdn,
        score: s.score,
        tags: s.tags,
        sim_type: simTypeMap.get(msisdn) || h.sim_type || "",
        carrier: carrierMap.get(msisdn) || h.carrier || "vodafone",
        tier: tierMap.get(msisdn) || h.tier || "",
        is_new: diff.newSet.has(msisdn),
        first_seen: h.first_seen || today,
        age_days: dayDiff(h.first_seen || today, today),
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    generated_at: generatedAt,
    total,
    new_count: diff.newMsisdns.length,
    disappeared_count: diff.disappearedMsisdns.length,
    new_msisdns: diff.newMsisdns,
    disappeared_msisdns: diff.disappearedMsisdns,
    best_thirty,
    all_available,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: persist carrier/tier in history and latest rows"
```

---

### Task 5: Wire `run.js` to merged fetch + tier bonus

**Files:**
- Modify: `src/run.js`
- Test: `test/run.test.js` (create — integration)

**Interfaces:**
- Consumes: `fetchAll` (Task 3), `tierBonus` (Task 1), `updateHistory`/`buildLatest` (Task 4).
- Produces: `run({ fetchImpl })` writes `latest.json`/`history.json` with both carriers; `best_thirty`/`all_available` rows carry `carrier`/`tier`; Etisalat scores include the tier bonus and an `etisalat-<tier>` tag.

- [ ] **Step 1: Write the failing test**

Create `test/run.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Route a single fake fetch to VF or Etisalat by URL (no LLM/notify: no token/repo). */
function routedFetch({ vf, etByPool }) {
  return async (url) => {
    if (url.includes("eshop.vodafone")) return { ok: true, status: 200, json: async () => vf };
    if (url.includes("etisalat.eg")) {
      const poolId = new URL(url).searchParams.get("poolId");
      return { ok: true, status: 200, json: async () => ({ status: true, numbers: etByPool[poolId] || [] }) };
    }
    throw new Error("unexpected url " + url);
  };
}

test("run merges both carriers into latest.json and history.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-run-"));
  const prevDataDir = process.env.DATA_DIR;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  process.env.DATA_DIR = dir;
  delete process.env.GITHUB_TOKEN; // force LLM fallback
  delete process.env.GITHUB_REPOSITORY; // skip notify
  // config.js reads DATA_DIR at import time, so import AFTER setting it.
  const { run } = await import("../src/run.js?run-test=" + Date.now());

  try {
    const fetchImpl = routedFetch({
      vf: {
        content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }],
        totalElements: 1,
      },
      etByPool: { 139: ["01199999999"] },
    });
    await run({ fetchImpl });

    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
    const history = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
    const all = [...latest.best_thirty, ...latest.all_available];

    const et = all.find((r) => r.msisdn === "01199999999");
    const vf = all.find((r) => r.msisdn === "01055455833");
    assert.equal(et.carrier, "etisalat");
    assert.equal(et.tier, "platinum_plus");
    assert.equal(vf.carrier, "vodafone");
    assert.equal(history["01199999999"].carrier, "etisalat");
    // platinum_plus bonus (16) added to the heuristic base score, capped at 100.
    assert.ok(et.score >= 16);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDataDir;
    if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
    if (prevRepo !== undefined) process.env.GITHUB_REPOSITORY = prevRepo;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/run.test.js`
Expected: FAIL — `run.js` imports `fetchCatalog` (gone) and does not set carrier/tier.

- [ ] **Step 3: Update imports in `src/run.js`**

Change the fetch import and add `tierBonus`:

```javascript
import { fetchAll } from "./fetch.js";
```

and add `tierBonus` to the existing `./config.js` import list:

```javascript
import {
  DATA_DIR, MODEL, GITHUB_TOKEN, REPO,
  CANDIDATE_COUNT, BEST_COUNT, ALERT_THRESHOLD,
  todayInTz, tierBonus,
} from "./config.js";
```

- [ ] **Step 4: Call `fetchAll` and build carrier/tier maps with the tier bonus**

Replace the fetch call (`catalog = await fetchCatalog({ fetchImpl });`) with:

```javascript
    catalog = await fetchAll({ fetchImpl });
```

Replace the score/sim map building block (step "2. score + available set") with:

```javascript
  // 2. score (+ Etisalat tier bonus) + available set
  const scoreMap = new Map();
  const simTypeMap = new Map(); // msisdn -> "ESIM" | "PHYSICAL" (Vodafone line source)
  const carrierMap = new Map(); // msisdn -> "vodafone" | "etisalat"
  const tierMap = new Map();    // msisdn -> Etisalat tier slug ("" for Vodafone)
  for (const r of records) {
    const base = scoreMsisdn(r.msisdn);
    const tier = r.tier || "";
    const bonus = tier ? tierBonus(tier) : 0;
    const tags = bonus ? [...base.tags, `etisalat-${tier}`] : base.tags;
    scoreMap.set(r.msisdn, { score: Math.min(100, base.score + bonus), tags });
    simTypeMap.set(r.msisdn, r.simType);
    carrierMap.set(r.msisdn, r.carrier || "vodafone");
    tierMap.set(r.msisdn, tier);
  }
  const available = records.filter((r) => r.available).map((r) => r.msisdn);
```

- [ ] **Step 5: Thread the maps through history and latest**

Update the `updateHistory` call:

```javascript
  const nextHistory = updateHistory({ history, available, scoreMap, gradeMap, simTypeMap, carrierMap, tierMap, today });
```

Update the `buildLatest` call:

```javascript
  const latest = buildLatest({
    total: totalElements, bestThirty, history: nextHistory, diff: diffWithSet, today, generatedAt,
    available, scoreMap, simTypeMap, carrierMap, tierMap,
  });
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `node --test test/run.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all files green (config, fetch, run, score, diff, grade, store).

- [ ] **Step 8: Commit**

```bash
git add src/run.js test/run.test.js
git commit -m "feat: run pipeline fetches both carriers and applies tier bonus"
```

---

### Task 6: Carrier column in alert issue

**Files:**
- Modify: `src/notify.js`
- Test: inline assertion via `node -e` (notify has no existing unit test file; keep it light and deterministic by testing the pure `buildIssueBody`).
- Test file: `test/notify.test.js` (create)

**Interfaces:**
- Consumes: alert rows now carry `carrier` (from `buildLatest`).
- Produces: `buildIssueBody` table includes a Carrier column.

- [ ] **Step 1: Write the failing test**

Create `test/notify.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueBody } from "../src/notify.js";

test("buildIssueBody includes a Carrier column and per-row carrier label", () => {
  const body = buildIssueBody({
    newPremium: [
      { msisdn: "01199999999", grade: 96, reason: "all nines", sim_type: "", carrier: "etisalat", tags: [] },
      { msisdn: "01055455833", grade: 91, reason: "repeat", sim_type: "ESIM", carrier: "vodafone", tags: [] },
    ],
    generatedAt: "2026-06-20T00:00:00Z",
    repo: "owner/name",
  });
  assert.match(body, /Carrier/);
  assert.match(body, /Etisalat/);
  assert.match(body, /Vodafone/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/notify.test.js`
Expected: FAIL — no "Carrier" text in the body.

- [ ] **Step 3: Add carrier label + column in `src/notify.js`**

Add a helper next to `simLabel`:

```javascript
/** Human label for the carrier. */
function carrierLabel(carrier) {
  if (carrier === "etisalat") return "Etisalat";
  if (carrier === "vodafone") return "Vodafone";
  return "—";
}
```

Update `buildIssueBody`'s header and row lines:

```javascript
export function buildIssueBody({ newPremium, generatedAt, repo }) {
  const lines = [
    `**${newPremium.length} new premium number(s)** detected at ${generatedAt}.`,
    "",
    "| | # | Number | Carrier | SIM | Grade | Why |",
    "|---|---|--------|---------|-----|-------|-----|",
  ];
  newPremium.forEach((n, i) => {
    lines.push(`| ${tierMark(n.grade)} | ${i + 1} | \`${formatMsisdn(n.msisdn)}\` | ${carrierLabel(n.carrier)} | ${simLabel(n.sim_type)} | ${n.grade} | ${n.reason || (n.tags || []).join(", ")} |`);
  });
  if (repo) {
    lines.push("", `Dashboard: https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/notify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notify.js test/notify.test.js
git commit -m "feat: add carrier column to alert issue body"
```

---

### Task 7: Dashboard — carrier filter + carrier/tier badges

**Files:**
- Modify: `web/index.html`, `web/app.js`
- Test: manual (browser); no JS test harness for the DOM in this repo.

**Interfaces:**
- Consumes: `latest.json`/`history.json` rows now carry `carrier`/`tier`.
- Produces: an All/Vodafone/Etisalat `<select id="carrier">`; carrier + tier badges on each row/podium card.

- [ ] **Step 1: Add the carrier filter control to `web/index.html`**

Insert a new `<select>` immediately before the existing `<select id="sort" ...>` (line ~107), matching its styling:

```html
      <select id="carrier" aria-label="Filter by carrier"
        class="shrink-0 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 outline-none transition focus-visible:border-vf-red/50 focus-visible:ring-2 focus-visible:ring-vf-red/30 dark:border-white/5 dark:bg-ink-850 dark:text-zinc-300">
        <option value="all">All carriers</option>
        <option value="vodafone">Vodafone</option>
        <option value="etisalat">Etisalat</option>
      </select>
```

Also update the header subtitle (line ~54) and footer (line ~122) copy from "Vodafone Egypt" to both carriers:

- Line ~54: `<p class="text-[11px] text-zinc-500">Vodafone & Etisalat Egypt · pattern monitor</p>`
- Footer ~122: change "Data from Vodafone Egypt's public catalog" to "Data from Vodafone & Etisalat Egypt public catalogs".

- [ ] **Step 2: Add `carrier` to state + the carrier helpers in `web/app.js`**

In the `state` object (top of file), add:

```javascript
  carrier: "all", // "all" | "vodafone" | "etisalat"
```

Add these helpers near the other small helpers (e.g. after `fmt`):

```javascript
const TIER_LABEL = {
  silver: "Silver",
  golden: "Golden",
  golden_plus: "Golden+",
  platinum: "Platinum",
  platinum_plus: "Platinum+",
};

/** Carrier of a row, inferring from the msisdn prefix for older data without the field. */
function carrierOf(r) {
  if (r.carrier) return r.carrier;
  return r.msisdn && r.msisdn.startsWith("011") ? "etisalat" : "vodafone";
}
```

- [ ] **Step 3: Render carrier + tier badges**

Replace the `simBadge` function with a combined `carrierBadges` (and call it from `badges`):

```javascript
/** Carrier pill (Vodafone red / Etisalat green), tier pill (Etisalat), and SIM pill (Vodafone). */
function carrierBadges(parent, row) {
  const carrier = carrierOf(row);
  if (carrier === "etisalat") {
    parent.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300", "Etisalat"));
    if (row.tier && TIER_LABEL[row.tier]) {
      parent.appendChild(el("span", "rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300", TIER_LABEL[row.tier]));
    }
  } else {
    parent.appendChild(el("span", "rounded-md bg-vf-red/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-vf-red ring-1 ring-vf-red/30", "Vodafone"));
    if (row.sim_type === "ESIM") parent.appendChild(el("span", "rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-500/30 dark:text-indigo-300", "eSIM"));
    else if (row.sim_type === "PHYSICAL") parent.appendChild(el("span", "rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700 ring-1 ring-sky-500/30 dark:text-sky-300", "Physical"));
  }
}
```

In `badges(parent, row)`, replace the `simBadge(parent, row);` call with `carrierBadges(parent, row);`.

- [ ] **Step 4: Apply the carrier filter in row selection**

In `currentRows()`, after computing `rows` and before the digit filter, add the carrier filter:

```javascript
  if (state.carrier !== "all") rows = rows.filter((r) => carrierOf(r) === state.carrier);
```

In `renderChanges()`, extend `applyFilter` so the carrier filter also applies there:

```javascript
  const applyFilter = (rows) => {
    let out = state.carrier === "all" ? rows : rows.filter((r) => carrierOf(r) === state.carrier);
    if (filterDigits) out = out.filter((r) => r.msisdn.replace(/\D/g, "").includes(filterDigits));
    return out;
  };
```

- [ ] **Step 5: Wire the control in `wire()`**

Add inside `wire()` (next to the `sort` listener):

```javascript
  $("carrier").addEventListener("change", (e) => { state.carrier = e.target.value; render(); });
```

- [ ] **Step 6: Manual verification**

Serve the dashboard against the sample data and confirm badges + filter:

```bash
cd web && python3 -m http.server 8099
```

Open `http://localhost:8099/`. Note `latest.sample.json` may predate the new fields; for a faithful check, run the pipeline once into `web/` first (`DATA_DIR=web node src/run.js`, requires network), or temporarily point `load()` at generated data. Verify: (a) Vodafone rows show a red "Vodafone" pill + SIM pill, (b) Etisalat rows show a green "Etisalat" pill + tier pill, (c) the carrier `<select>` filters the list and the Changes tab. Stop the server with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: dashboard carrier filter and carrier/tier badges"
```

---

## Self-Review

**Spec coverage:**
- Data source / headers → Task 2 (`fetchEtisalat` headers). ✓
- Pools→tier table + bonus → Task 1. ✓
- `carrier`/`tier` data model → Tasks 2 (records), 4 (history/latest), 6 (notify), 7 (dashboard). ✓
- Tier→score bonus + tag + LLM context → Task 5 (bonus + `etisalat-<tier>` tag, which flows into the grade candidate payload). Note: the spec also mentioned adding one line to the grader system prompt; the tag carries the signal into the existing payload, and a prompt tweak can be added in Task 5 Step 4 if desired — flagged here so it is not silently dropped. ✓ (tag path) / optional (prompt line)
- Unified dashboard + carrier filter → Task 7. ✓
- Fetch-failure semantics (skip run) → Tasks 2/3 (throw on hard fail; `fetchAll` rejects). ✓
- Known ~1000/pool cap → documented; no code needed. ✓
- Tests for parsing/dedupe/persistence → Tasks 2, 4, 5, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one optional item (grader prompt line) is explicitly called out, not a hidden placeholder.

**Type consistency:** `carrier`/`tier` are strings everywhere; `fetchVodafone`/`fetchEtisalat`/`fetchAll` return `{records, totalElements, returned}`; `updateHistory`/`buildLatest` gained `carrierMap`/`tierMap` params used consistently in Tasks 4 and 5; `carrierOf`/`TIER_LABEL` defined once in Task 7 and reused.
