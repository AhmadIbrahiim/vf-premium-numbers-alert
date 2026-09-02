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

test("run merges all three carriers into Postgres; WE gets no bonus", async () => {
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

    // Nothing is published as JSON any more — the dashboard reads Postgres live, so the
    // database rows ARE the output.
    const all = [...fake.rows.values()].map((r) => ({ ...r, sim_type: r.sim_type }));

    const et = all.find((r) => r.msisdn === "01199999999");
    const vf = all.find((r) => r.msisdn === "01055455833");
    const we = all.find((r) => r.msisdn === "01555027138");

    assert.equal(et.carrier, "etisalat");
    assert.equal(et.tier, "platinum_plus");
    assert.ok(et.score >= 16, "etisalat platinum_plus bonus applied"); // +16 bonus

    assert.equal(vf.carrier, "vodafone");
    assert.equal(vf.sim_type, "ESIM");

    assert.equal(we.carrier, "we");
    assert.equal(we.tier, "GRADE_017");
    // No bonus for WE: score equals the pure digit-pattern score.
    assert.equal(we.score, scoreMsisdn("01555027138").score);

    assert.equal(fake.rows.size, 3);
    assert.equal([...fake.rows.values()].every((r) => r.available), true);

    // Per-carrier telemetry landed for the provider status dashboard.
    assert.deepEqual(fake.providerRuns.map((r) => r.carrier).sort(), ["etisalat", "vodafone", "we"]);
    assert.equal(fake.providerRuns.every((r) => r.ok && r.trusted), true);
    assert.ok(fake.providerRuns.every((r) => r.requests > 0), "requests were counted per carrier");

    // The LLM grade cache lives in the meta table, not a file.
    assert.ok(fake.meta.has("grades"));
    assert.ok(fake.meta.has("signature"));
    await assert.rejects(() => readFile(join(dir, "latest.json"), "utf8"), "no latest.json is written");
    await assert.rejects(() => readFile(join(dir, "grades.json"), "utf8"), "no grades.json is written");

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

test("a new number at/above the threshold triggers the alert email", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-email-"));
  const prev = {
    d: process.env.DATA_DIR, t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY,
    gmin: process.env.WE_GRADE_MIN, gmax: process.env.WE_GRADE_MAX, db: process.env.DATABASE_URL,
    key: process.env.RESEND_API_KEY, to: process.env.ALERT_EMAIL_TO, thr: process.env.ALERT_THRESHOLD,
  };
  process.env.DATA_DIR = dir;
  process.env.DATABASE_URL = "postgresql://u:p@fake.neon.tech/db";
  process.env.RESEND_API_KEY = "re_fake";
  process.env.ALERT_EMAIL_TO = "me@example.com";
  process.env.ALERT_THRESHOLD = "1"; // any new number qualifies
  delete process.env.GITHUB_TOKEN;      // LLM fallback
  delete process.env.GITHUB_REPOSITORY; // skip the GitHub issue
  process.env.WE_GRADE_MIN = "17";
  process.env.WE_GRADE_MAX = "17";
  const { run } = await import("../src/run.js?email-test=" + Date.now());

  const sent = [];
  const dbFetchOf = (fake) => async (url, init) => {
    if (url.includes("api.resend.com")) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: "mail-1" }) };
    }
    return fake.fetch(url, init);
  };

  try {
    const fake = fakeDb();
    const mailAwareFetch = dbFetchOf(fake);
    // globalThis.fetch is what src/email.js uses; point it at the stub.
    const origFetch = globalThis.fetch;
    globalThis.fetch = mailAwareFetch;
    try {
      // Run 1 seeds the baseline -> alerts suppressed, no mail.
      await run({
        fetchImpl: routedFetch({ vf: { content: [], totalElements: 0 }, etByPool: {}, weByGrade: { GRADE_017: [[1555027138]] } }),
        dbFetch: fake.fetch,
      });
      assert.equal(sent.length, 0, "baseline run must not email");

      // Run 2 introduces a genuinely new number -> one email.
      await run({
        fetchImpl: routedFetch({
          vf: { content: [], totalElements: 0 },
          etByPool: {},
          weByGrade: { GRADE_017: [[1555027138, 1500111222]] },
        }),
        dbFetch: fake.fetch,
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.equal(sent.length, 1, "exactly one email for the new number");
    assert.equal(sent[0].to, "me@example.com");
    assert.match(sent[0].subject, /premium number/i);
    assert.match(sent[0].text, /0150 011 1222/);
    assert.ok(!sent[0].text.includes("0155 502 7138"), "the pre-existing number is not re-alerted");
  } finally {
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of [["DATA_DIR", prev.d], ["GITHUB_TOKEN", prev.t], ["GITHUB_REPOSITORY", prev.r],
                          ["WE_GRADE_MIN", prev.gmin], ["WE_GRADE_MAX", prev.gmax], ["DATABASE_URL", prev.db],
                          ["RESEND_API_KEY", prev.key], ["ALERT_EMAIL_TO", prev.to], ["ALERT_THRESHOLD", prev.thr]]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }
});

test("a carrier that comes back suspiciously small refreshes but retires nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-shrink-"));
  const prev = {
    d: process.env.DATA_DIR, t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY,
    gmin: process.env.WE_GRADE_MIN, gmax: process.env.WE_GRADE_MAX, db: process.env.DATABASE_URL,
    key: process.env.RESEND_API_KEY,
  };
  process.env.DATA_DIR = dir;
  process.env.DATABASE_URL = "postgresql://u:p@fake.neon.tech/db";
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.RESEND_API_KEY;
  process.env.WE_GRADE_MIN = "17";
  process.env.WE_GRADE_MAX = "17";
  const { run } = await import("../src/run.js?shrink-test=" + Date.now());

  // Postgres already holds 10 WE numbers; this poll only manages to fetch 1.
  const seed = {};
  for (let i = 0; i < 10; i++) {
    seed["015000000" + String(i).padStart(2, "0")] = {
      carrier: "we", tier: "GRADE_017", sim_type: "", score: 5, tags: [], best_grade: 5,
      first_seen: "2026-08-01", last_seen: "2026-08-01", available: true, run_seq: 1,
    };
  }
  const fake = fakeDb(seed);

  try {
    await run({
      fetchImpl: routedFetch({
        vf: { content: [], totalElements: 0 },
        etByPool: {},
        weByGrade: { GRADE_017: [[1500000000]] }, // 1 of the 10
      }),
      dbFetch: fake.fetch,
    });
    const stillAvailable = [...fake.rows.values()].filter((r) => r.available).length;
    assert.equal(stillAvailable, 10, "none of the 10 WE rows may be retired on a partial fetch");
  } finally {
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of [["DATA_DIR", prev.d], ["GITHUB_TOKEN", prev.t], ["GITHUB_REPOSITORY", prev.r],
                          ["WE_GRADE_MIN", prev.gmin], ["WE_GRADE_MAX", prev.gmax],
                          ["DATABASE_URL", prev.db], ["RESEND_API_KEY", prev.key]]) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }
});
