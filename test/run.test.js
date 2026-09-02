import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreMsisdn } from "../src/score.js";
import { fakeDb } from "./helpers/fake-db.js";

/** Route a single fake fetch to VF, Etisalat, or WE by URL (no LLM/notify: no token/repo). */
function routedFetch({ vf, etByPool, weByGrade = {} }) {
  return async (url, init) => {
    if (url.includes("eshop.vodafone")) return { ok: true, status: 200, json: async () => vf };
    if (url.includes("etisalat.eg")) {
      const poolId = new URL(url).searchParams.get("poolId");
      return { ok: true, status: 200, json: async () => ({ status: true, numbers: etByPool[poolId] || [] }) };
    }
    if (url.includes("numbers.te.eg")) {
      const b = JSON.parse(init.body);
      const telnums = (weByGrade[b.numberlevel] || [])[Number(b.pageindex) - 1] || [];
      return { ok: true, status: 200, json: async () => ({ header: { retCode: "0" }, body: { telnumlist: telnums.map((t) => ({ telnum: t })) } }) };
    }
    throw new Error("unexpected url " + url);
  };
}

test("run merges all three carriers into latest.json + Postgres; WE gets no bonus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-run-"));
  const prev = {
    d: process.env.DATA_DIR, t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY,
    gmin: process.env.WE_GRADE_MIN, gmax: process.env.WE_GRADE_MAX, db: process.env.DATABASE_URL,
  };
  process.env.DATA_DIR = dir;
  process.env.DATABASE_URL = "postgresql://u:p@fake.neon.tech/db";
  delete process.env.GITHUB_TOKEN; // force LLM fallback
  delete process.env.GITHUB_REPOSITORY; // skip notify
  process.env.WE_GRADE_MIN = "17"; // keep WE enumeration to a single grade
  process.env.WE_GRADE_MAX = "17";
  // config.js reads DATA_DIR / WE_* at import time, so import AFTER setting them.
  const { run } = await import("../src/run.js?run-test=" + Date.now());

  try {
    const fetchImpl = routedFetch({
      vf: {
        content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }],
        totalElements: 1,
      },
      etByPool: { 139: ["01199999999"] },
      weByGrade: { GRADE_017: [[1555027138]] }, // one page, one telnum
    });
    const fake = fakeDb();
    await run({ fetchImpl, dbFetch: fake.fetch });

    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
    const all = [...latest.best_thirty, ...latest.all_available];

    const et = all.find((r) => r.msisdn === "01199999999");
    const vf = all.find((r) => r.msisdn === "01055455833");
    const we = all.find((r) => r.msisdn === "01555027138");

    assert.equal(et.carrier, "etisalat");
    assert.equal(et.tier, "platinum_plus");
    assert.ok(et.score >= 16, "etisalat platinum_plus bonus applied"); // +16 bonus

    assert.equal(vf.carrier, "vodafone");

    assert.equal(we.carrier, "we");
    assert.equal(we.tier, "GRADE_017");
    // No bonus for WE: score equals the pure digit-pattern score.
    assert.equal(we.score, scoreMsisdn("01555027138").score);

    // State lands in Postgres, not a JSON blob.
    assert.equal(fake.rows.get("01555027138").carrier, "we");
    assert.equal(fake.rows.get("01555027138").tier, "GRADE_017");
    assert.equal(fake.rows.get("01555027138").available, true);
    assert.equal(fake.rows.size, 3);

    // The full-catalog search index and the best-ever slice are published too.
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(index.length, 3);
    assert.ok(index.includes("01555027138w" + String(we.score).padStart(3, "0")));
    const bestEver = JSON.parse(await readFile(join(dir, "best-ever.json"), "utf8"));
    assert.equal(bestEver.length, 3);
    assert.equal(latest.available_total, 3);
    assert.deepEqual(latest.by_carrier, { etisalat: 1, vodafone: 1, we: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
    prev.d === undefined ? delete process.env.DATA_DIR : (process.env.DATA_DIR = prev.d);
    if (prev.t !== undefined) process.env.GITHUB_TOKEN = prev.t;
    if (prev.r !== undefined) process.env.GITHUB_REPOSITORY = prev.r;
    prev.gmin === undefined ? delete process.env.WE_GRADE_MIN : (process.env.WE_GRADE_MIN = prev.gmin);
    prev.gmax === undefined ? delete process.env.WE_GRADE_MAX : (process.env.WE_GRADE_MAX = prev.gmax);
    prev.db === undefined ? delete process.env.DATABASE_URL : (process.env.DATABASE_URL = prev.db);
  }
});

test("run refuses to write anything when DATABASE_URL is unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-nodb-"));
  const prev = { d: process.env.DATA_DIR, db: process.env.DATABASE_URL };
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const { run } = await import("../src/run.js?nodb-test=" + Date.now());
  try {
    const r = await run({ fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(r.skipped, "no-database");
    await assert.rejects(() => readFile(join(dir, "latest.json"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    prev.d === undefined ? delete process.env.DATA_DIR : (process.env.DATA_DIR = prev.d);
    if (prev.db !== undefined) process.env.DATABASE_URL = prev.db;
  }
});

test("REGRADE=1 forces re-evaluation even when the grade cache is valid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-regrade-"));
  const prev = {
    d: process.env.DATA_DIR, t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY,
    gmin: process.env.WE_GRADE_MIN, gmax: process.env.WE_GRADE_MAX, rg: process.env.REGRADE,
    db: process.env.DATABASE_URL,
  };
  process.env.DATA_DIR = dir;
  process.env.DATABASE_URL = "postgresql://u:p@fake.neon.tech/db";
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  process.env.WE_GRADE_MIN = "17";
  process.env.WE_GRADE_MAX = "17";
  delete process.env.REGRADE;
  const { run } = await import("../src/run.js?regrade-test=" + Date.now());
  const fetchImpl = routedFetch({
    vf: { content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }], totalElements: 1 },
    etByPool: {},
    weByGrade: { GRADE_017: [[1555027138]] },
  });
  const fake = fakeDb(); // one store across all three runs, like a real database
  try {
    const r1 = await run({ fetchImpl, dbFetch: fake.fetch });
    assert.equal(r1.regraded, true, "first run grades (cache empty)");
    const r2 = await run({ fetchImpl, dbFetch: fake.fetch });
    assert.equal(r2.regraded, false, "second run reuses the cache");
    process.env.REGRADE = "1"; // read at call time inside run()
    const r3 = await run({ fetchImpl, dbFetch: fake.fetch });
    assert.equal(r3.regraded, true, "REGRADE=1 bypasses the cache");
  } finally {
    await rm(dir, { recursive: true, force: true });
    prev.d === undefined ? delete process.env.DATA_DIR : (process.env.DATA_DIR = prev.d);
    if (prev.t !== undefined) process.env.GITHUB_TOKEN = prev.t;
    if (prev.r !== undefined) process.env.GITHUB_REPOSITORY = prev.r;
    prev.gmin === undefined ? delete process.env.WE_GRADE_MIN : (process.env.WE_GRADE_MIN = prev.gmin);
    prev.gmax === undefined ? delete process.env.WE_GRADE_MAX : (process.env.WE_GRADE_MAX = prev.gmax);
    prev.rg === undefined ? delete process.env.REGRADE : (process.env.REGRADE = prev.rg);
    prev.db === undefined ? delete process.env.DATABASE_URL : (process.env.DATABASE_URL = prev.db);
  }
});
