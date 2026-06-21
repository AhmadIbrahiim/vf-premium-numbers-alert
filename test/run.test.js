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
