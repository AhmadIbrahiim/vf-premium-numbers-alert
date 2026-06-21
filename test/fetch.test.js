import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEtisalat, fetchVodafone, fetchAll } from "../src/fetch.js";

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
