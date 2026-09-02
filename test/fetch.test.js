import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEtisalat, fetchVodafone, fetchWe, fetchAll } from "../src/fetch.js";
import { WE_PAGE_SIZE } from "../src/config.js";

/** Fake WE fetch: `pagesByGrade` maps "GRADE_0NN" -> array of pages, each page an array of telnum ints. */
function weFetch(pagesByGrade) {
  return async (url, init) => {
    const b = JSON.parse(init.body);
    const pages = pagesByGrade[b.numberlevel] || [];
    const telnums = pages[Number(b.pageindex) - 1] || [];
    return {
      ok: true, status: 200,
      json: async () => ({ header: { retCode: "0" }, body: { telnumlist: telnums.map((t) => ({ telnum: t, telprice: 0 })) } }),
    };
  };
}

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

test("fetchEtisalat splits the prefix when a response comes back at the cap", async () => {
  // Pool holds 3 numbers under 0110x; a cap of 2 forces the "0110*" query to split
  // into "01100*".."01109*". Without splitting we would only ever see 2 of the 3.
  const pool = ["01100000001", "01101000002", "01102000003"];
  const seen = [];
  const fetchImpl = async (url) => {
    const pattern = new URL(url).searchParams.get("searchPattern");
    seen.push(pattern);
    const prefix = pattern.replace("*", "");
    const hits = pool.filter((n) => n.startsWith(prefix));
    return { ok: true, status: 200, json: async () => ({ status: true, numbers: hits.slice(0, 2) }) };
  };
  const { records } = await fetchEtisalat({
    fetchImpl,
    pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
    prefix: "0110",
    responseCap: 2,
    maxDepth: 2,
  });
  assert.deepEqual(records.map((r) => r.msisdn).sort(), pool);
  assert.ok(seen.includes("01100*"), "expected the capped prefix to be split by digit");
});

test("fetchEtisalat does not split a response below the cap", async () => {
  const fetchImpl = etisalatFetch({ 135: ["01100000001"] });
  let calls = 0;
  const counting = async (u) => { calls++; return fetchImpl(u); };
  await fetchEtisalat({ fetchImpl: counting, pools: [{ poolId: 135, tier: "silver", bonus: 0 }] });
  assert.equal(calls, 1);
});

test("fetchWe pages past the old 20-page cap", async () => {
  // 25 full pages then a short one: the whole grade must come back, not the first 20 pages.
  const pages = Array.from({ length: 25 }, (_, p) =>
    Array.from({ length: WE_PAGE_SIZE }, (_, i) => 1500000000 + p * WE_PAGE_SIZE + i)
  );
  pages.push([1599999999]);
  const { records } = await fetchWe({ fetchImpl: weFetch({ GRADE_017: pages }), gradeMin: 17, gradeMax: 17 });
  assert.equal(records.length, 25 * WE_PAGE_SIZE + 1);
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

test("fetchWe maps telnum to msisdn with leading 0 and tags carrier/grade", async () => {
  const fetchImpl = weFetch({ GRADE_017: [[1555027138, 1555028165]] });
  const { records } = await fetchWe({ fetchImpl, gradeMin: 17, gradeMax: 17 });
  assert.equal(records.length, 2);
  assert.equal(records[0].msisdn, "01555027138");
  assert.equal(records[0].carrier, "we");
  assert.equal(records[0].tier, "GRADE_017");
  assert.equal(records[0].available, true);
});

test("fetchWe paginates until a short page", async () => {
  const full = Array.from({ length: WE_PAGE_SIZE }, (_, i) => 1500000000 + i);
  const fetchImpl = weFetch({ GRADE_017: [full, [1599999998, 1599999999]] });
  const { records } = await fetchWe({ fetchImpl, gradeMin: 17, gradeMax: 17 });
  assert.equal(records.length, WE_PAGE_SIZE + 2);
});

test("fetchWe skips empty grades and merges across grades", async () => {
  const fetchImpl = weFetch({ GRADE_015: [[1500666004]], GRADE_017: [[1555027138]] });
  const { records } = await fetchWe({ fetchImpl, gradeMin: 15, gradeMax: 17 }); // 16 empty
  assert.deepEqual(records.map((r) => r.msisdn).sort(), ["01500666004", "01555027138"]);
});

test("fetchWe dedupes a msisdn seen in multiple grades (first grade wins)", async () => {
  const fetchImpl = weFetch({ GRADE_015: [[1500666004]], GRADE_016: [[1500666004]] });
  const { records } = await fetchWe({ fetchImpl, gradeMin: 15, gradeMax: 16 });
  assert.equal(records.length, 1);
  assert.equal(records[0].tier, "GRADE_015");
});

test("fetchWe throws when the API rejects (retCode != 0)", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ header: { retCode: "1010" } }) });
  await assert.rejects(() => fetchWe({ fetchImpl, gradeMin: 17, gradeMax: 17 }), /retCode/);
});

test("fetchWe throws on persistent HTTP failure", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => fetchWe({ fetchImpl, retries: 0, gradeMin: 17, gradeMax: 17 }));
});

test("fetchWe samples (does not throw) when a grade exceeds WE_MAX_PAGES", async () => {
  // Same full page every call -> never a short page -> hits the cap. Best-effort: no throw,
  // returns what was sampled (WE inventory is large + stable numeric order, so a cap is fine).
  const full = Array.from({ length: WE_PAGE_SIZE }, (_, i) => 1500000000 + i);
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ header: { retCode: "0" }, body: { telnumlist: full.map((t) => ({ telnum: t })) } }),
  });
  const origWarn = console.warn;
  console.warn = () => {}; // suppress the expected "sampled first N pages" notice (pristine output)
  try {
    const { records } = await fetchWe({ fetchImpl, gradeMin: 17, gradeMax: 17 });
    assert.equal(records.length, WE_PAGE_SIZE); // same page repeated -> deduped to one page
    assert.ok(records.every((r) => r.tier === "GRADE_017"));
  } finally {
    console.warn = origWarn;
  }
});

/** Route a single fake fetch to VF, Etisalat, or WE by URL. */
function routedFetch({ vf, etByPool, weByGrade = {} }) {
  return async (url, init) => {
    if (url.includes("eshop.vodafone")) {
      return { ok: true, status: 200, json: async () => vf };
    }
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

test("fetchAll merges Vodafone, Etisalat, and WE records", async () => {
  const fetchImpl = routedFetch({
    vf: {
      content: [{ id: "1", msisdn: "01055455833", available: true, defaultPrice: { amount: 5 }, simType: "ESIM", tariffs: [] }],
      totalElements: 1,
    },
    etByPool: { 135: ["01100000001"], 139: ["01199999999"] },
    weByGrade: { GRADE_017: [[1555027138]] },
  });
  const { records, totalElements, returned } = await fetchAll({ fetchImpl, gradeMin: 17, gradeMax: 17 });
  const carriers = [...new Set(records.map((r) => r.carrier))].sort();
  assert.deepEqual(carriers, ["etisalat", "vodafone", "we"]);
  assert.ok(records.some((r) => r.msisdn === "01555027138" && r.carrier === "we"));
  // The fake serves the same single VF record for every line type, so both VF_TYPES
  // (red, flex) return it: 1 deduped record, but 2 counted as fetched/reported.
  assert.equal(records.length, 1 + 2 + 1);
  assert.equal(totalElements, 2 + 2 + 1);
  assert.equal(returned, 2 + 2 + 1);
});

test("fetchAll rejects when Etisalat hard-fails", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("eshop.vodafone")) {
      return { ok: true, status: 200, json: async () => ({ content: [], totalElements: 0 }) };
    }
    if (url.includes("numbers.te.eg")) {
      return { ok: true, status: 200, json: async () => ({ header: { retCode: "0" }, body: { telnumlist: [] } }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  await assert.rejects(() => fetchAll({ fetchImpl, retries: 0, gradeMin: 17, gradeMax: 17 }));
});
