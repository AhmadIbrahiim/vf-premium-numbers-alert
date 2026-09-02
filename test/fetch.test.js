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

/**
 * Does `msisdn` match one of Etisalat's fixed-width masks ("011******52")? `*` is a
 * single-digit wildcard; a shorter pattern ending in `*` is a prefix glob.
 */
function matchesMask(msisdn, pattern) {
  if (pattern.length !== msisdn.length) {
    return pattern.endsWith("*") && msisdn.startsWith(pattern.slice(0, -1));
  }
  return [...pattern].every((c, i) => c === "*" || c === msisdn[i]);
}

/**
 * Fake fetch for the Etisalat pool API. `byPool` maps poolId -> numbers[]; results are
 * filtered by the requested searchPattern, like the real API, so bucket partitioning is
 * actually exercised. `cap` truncates a response the way the server does.
 */
function etisalatFetch(byPool, cap = Infinity) {
  return async (url) => {
    const params = new URL(url).searchParams;
    const poolId = params.get("poolId");
    const pattern = params.get("searchPattern");
    const hits = (byPool[poolId] || []).filter((n) => matchesMask(String(n), pattern));
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: true, numbers: hits.slice(0, cap) }),
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

test("fetchEtisalat covers a pool via disjoint suffix buckets, not one capped call", async () => {
  // 30 numbers with assorted last digits. A single "*" call would be capped at 4;
  // the suffix partition must still return all 30.
  const pool = Array.from({ length: 30 }, (_, i) => "0110000" + String(i).padStart(4, "0"));
  const fetchImpl = etisalatFetch({ 135: pool }, 4);
  const { records } = await fetchEtisalat({
    fetchImpl,
    pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
    responseCap: 4,
    suffixDigits: 2,
  });
  assert.deepEqual(records.map((r) => r.msisdn).sort(), [...pool].sort());
});

test("fetchEtisalat fixes another digit when a bucket comes back at the cap", async () => {
  // 6 numbers sharing the last two digits "00" but differing in the third-from-last,
  // so the "00" bucket caps at 3 and only a 3-digit split separates them.
  const pool = Array.from({ length: 6 }, (_, i) => "01100000" + String(i) + "00");
  const fetchImpl = etisalatFetch({ 135: pool }, 3);
  const seen = [];
  const counting = async (url) => {
    seen.push(new URL(url).searchParams.get("searchPattern"));
    return fetchImpl(url);
  };
  const { records } = await fetchEtisalat({
    fetchImpl: counting,
    pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
    responseCap: 3,
    suffixDigits: 2,
    maxSuffixDigits: 6,
  });
  assert.deepEqual(records.map((r) => r.msisdn).sort(), [...pool].sort());
  assert.ok(seen.includes("011******00"), "queried the 2-digit bucket");
  assert.ok(seen.some((p) => /^011\*{5}\d00$/.test(p)), "split it into 3-digit buckets");
});

test("fetchEtisalat issues one request per suffix bucket per pool", async () => {
  const fetchImpl = etisalatFetch({ 135: ["01100000001"] });
  let calls = 0;
  const counting = async (u) => { calls++; return fetchImpl(u); };
  await fetchEtisalat({
    fetchImpl: counting,
    pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
    suffixDigits: 1, // 10 buckets
  });
  assert.equal(calls, 10);
});

test("fetchEtisalat warns instead of throwing when a bucket caps at max depth", async () => {
  // Every response is full, so no amount of splitting clears the cap.
  const full = Array.from({ length: 3 }, (_, i) => "0110000000" + i);
  const fetchImpl = async () => ({
    ok: true, status: 200, json: async () => ({ status: true, numbers: full }),
  });
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  try {
    const { records } = await fetchEtisalat({
      fetchImpl,
      pools: [{ poolId: 135, tier: "silver", bonus: 0 }],
      responseCap: 3,
      suffixDigits: 1,
      maxSuffixDigits: 2,
    });
    assert.equal(records.length, 3); // the same page repeated -> deduped
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((m) => /still at the response cap/.test(m)));
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

test("fetchWe warns instead of throwing when a branch cannot be fully enumerated", async () => {
  // Every response is a full page, so no split ever clears the cap. Bounds keep the
  // recursion tiny; the point is that it terminates with a warning, not an exception.
  const full = Array.from({ length: WE_PAGE_SIZE }, (_, i) => 1500000000 + i);
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ header: { retCode: "0" }, body: { telnumlist: full.map((t) => ({ telnum: t })) } }),
  });
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(m);
  let records;
  try {
    ({ records } = await fetchWe({
      fetchImpl, gradeMin: 17, gradeMax: 17,
      maxPages: 4, queryCap: 51, maxPrefixDigits: 3, concurrency: 2,
    }));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(records.length, WE_PAGE_SIZE); // same page repeated -> deduped to one page
  assert.ok(records.every((r) => r.tier === "GRADE_017"));
  assert.ok(warnings.some((m) => /could not fully enumerate/.test(m)));
});

test("fetchWe splits the fitmod mask when a query hits the 20k result cap", async () => {
  // Grade holds 4 numbers under three different 3rd digits. queryCap=2 forces the
  // unsplit "15????????" query to be treated as truncated and split by digit.
  const pool = ["1500000001", "1510000002", "1520000003", "1520000004"];
  const masks = [];
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    masks.push(b.fitmod);
    const re = new RegExp("^" + b.fitmod.replace(/\?/g, "\\d") + "$");
    const hits = pool.filter((n) => re.test(n));
    const size = Number(b.maxCount);
    const page = Number(b.pageindex);
    const slice = hits.slice((page - 1) * size, page * size);
    return {
      ok: true, status: 200,
      json: async () => ({ header: { retCode: "0" }, body: { telnumlist: slice.map((t) => ({ telnum: t })) } }),
    };
  };
  const { records } = await fetchWe({
    fetchImpl, gradeMin: 17, gradeMax: 17,
    pageSize: 2, queryCap: 2, maxPages: 10, maxPrefixDigits: 4, concurrency: 2,
  });
  assert.deepEqual(records.map((r) => r.msisdn).sort(), ["01500000001", "01510000002", "01520000003", "01520000004"]);
  assert.ok(masks.includes("15????????"), "probed the unsplit mask");
  assert.ok(masks.includes("150???????"), "split the mask by leading digit");
});

test("fetchWe does not split a query that is under the cap", async () => {
  const pages = [[1500000001, 1500000002], [1500000003]];
  const masks = [];
  const fetchImpl = async (_url, init) => {
    const b = JSON.parse(init.body);
    masks.push(b.fitmod);
    const list = pages[Number(b.pageindex) - 1] || [];
    return {
      ok: true, status: 200,
      json: async () => ({ header: { retCode: "0" }, body: { telnumlist: list.map((t) => ({ telnum: t })) } }),
    };
  };
  await fetchWe({ fetchImpl, gradeMin: 17, gradeMax: 17, pageSize: 2, queryCap: 1000, maxPages: 10, concurrency: 1 });
  assert.deepEqual([...new Set(masks)], ["15????????"], "only the unsplit mask was queried");
});

/** Route a single fake fetch to VF, Etisalat, or WE by URL. */
function routedFetch({ vf, etByPool, weByGrade = {} }) {
  return async (url, init) => {
    if (url.includes("eshop.vodafone")) {
      return { ok: true, status: 200, json: async () => vf };
    }
    if (url.includes("etisalat.eg")) {
      const params = new URL(url).searchParams;
      const hits = (etByPool[params.get("poolId")] || [])
        .filter((n) => matchesMask(String(n), params.get("searchPattern")));
      return { ok: true, status: 200, json: async () => ({ status: true, numbers: hits }) };
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
