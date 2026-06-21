import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreMsisdn } from "../src/score.js";

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

test("run merges all three carriers into latest.json/history.json; WE gets no bonus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vf-run-"));
  const prev = {
    d: process.env.DATA_DIR, t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY,
    gmin: process.env.WE_GRADE_MIN, gmax: process.env.WE_GRADE_MAX,
  };
  process.env.DATA_DIR = dir;
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
    await run({ fetchImpl });

    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
    const history = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
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

    assert.equal(history["01555027138"].carrier, "we");
    assert.equal(history["01555027138"].tier, "GRADE_017");
  } finally {
    await rm(dir, { recursive: true, force: true });
    prev.d === undefined ? delete process.env.DATA_DIR : (process.env.DATA_DIR = prev.d);
    if (prev.t !== undefined) process.env.GITHUB_TOKEN = prev.t;
    if (prev.r !== undefined) process.env.GITHUB_REPOSITORY = prev.r;
    prev.gmin === undefined ? delete process.env.WE_GRADE_MIN : (process.env.WE_GRADE_MIN = prev.gmin);
    prev.gmax === undefined ? delete process.env.WE_GRADE_MAX : (process.env.WE_GRADE_MAX = prev.gmax);
  }
});
