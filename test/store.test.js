import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, candidateSignature, gradeCacheValid, buildLatest } from "../src/store.js";

function scoreMap(obj) {
  return new Map(Object.entries(obj).map(([m, score]) => [m, { score, tags: [] }]));
}

test("buildCandidates takes the top N by score", () => {
  const available = ["01000000001", "01000000002", "01000000003"];
  const sm = scoreMap({ "01000000001": 10, "01000000002": 90, "01000000003": 50 });
  const c = buildCandidates({ available, scoreMap: sm, count: 2 });
  assert.deepEqual(c.map((x) => x.msisdn), ["01000000002", "01000000003"]);
});

test("buildCandidates always includes new numbers outside the top N", () => {
  const available = ["01000000001", "01000000002", "01000000003"];
  const sm = scoreMap({ "01000000001": 10, "01000000002": 90, "01000000003": 50 });
  // count=1 -> only the 90 makes the top; the low-scoring new number must still be added.
  const c = buildCandidates({ available, scoreMap: sm, newMsisdns: ["01000000001"], count: 1 });
  const ids = c.map((x) => x.msisdn);
  assert.ok(ids.includes("01000000002"), "top stays");
  assert.ok(ids.includes("01000000001"), "new number forced in");
});

test("buildCandidates does not duplicate a new number already in the top", () => {
  const available = ["01000000001", "01000000002"];
  const sm = scoreMap({ "01000000001": 90, "01000000002": 80 });
  const c = buildCandidates({ available, scoreMap: sm, newMsisdns: ["01000000001"], count: 5 });
  assert.equal(c.filter((x) => x.msisdn === "01000000001").length, 1);
});

test("buildCandidates ignores new numbers not currently available", () => {
  const available = ["01000000001"];
  const sm = scoreMap({ "01000000001": 90 });
  const c = buildCandidates({ available, scoreMap: sm, newMsisdns: ["01099999999"], count: 5 });
  assert.deepEqual(c.map((x) => x.msisdn), ["01000000001"]);
});

test("candidateSignature is order-independent", () => {
  const a = candidateSignature([{ msisdn: "b" }, { msisdn: "a" }]);
  const b = candidateSignature([{ msisdn: "a" }, { msisdn: "b" }]);
  assert.equal(a, b);
});

test("candidateSignature differs when the set differs", () => {
  const a = candidateSignature([{ msisdn: "a" }, { msisdn: "b" }]);
  const b = candidateSignature([{ msisdn: "a" }, { msisdn: "c" }]);
  assert.notEqual(a, b);
});

test("gradeCacheValid only when sig matches and grades present", () => {
  assert.equal(gradeCacheValid(null, "x"), false);
  assert.equal(gradeCacheValid({ sig: "x", graded: [] }, "x"), false);
  assert.equal(gradeCacheValid({ sig: "y", graded: [{}] }, "x"), false);
  assert.equal(gradeCacheValid({ sig: "x", graded: [{ msisdn: "a" }] }, "x"), true);
});

/* --- buildLatest: shapes DB-ranked rows into the dashboard payload --- */

const noDiff = { newMsisdns: [], disappearedMsisdns: [], newSet: new Set() };
const base = { generatedAt: "2026-09-02T00:00:00Z", today: "2026-09-02", total: 0, counts: null, diff: noDiff };

/** A row as db.readPublishRows returns it. */
function dbRow(msisdn, over = {}) {
  return {
    msisdn, score: 50, tags: ["repeat-x3"], sim_type: "", carrier: "etisalat", tier: "silver",
    best_grade: 50, first_seen: "2026-08-01", age_days: 32, is_new: false, ...over,
  };
}

test("buildLatest carries carrier, tier and age through from the DB rows", () => {
  const latest = buildLatest({
    ...base,
    publishRows: [dbRow("01100000001", { carrier: "we", tier: "GRADE_017", score: 33, age_days: 7 })],
  });
  const r = latest.all_available[0];
  assert.equal(r.carrier, "we");
  assert.equal(r.tier, "GRADE_017");
  assert.equal(r.score, 33);
  assert.equal(r.age_days, 7);
  assert.equal(r.first_seen, "2026-08-01");
  assert.deepEqual(r.tags, ["repeat-x3"]);
});

test("buildLatest merges LLM grade/reason onto the graded numbers and excludes them from all_available", () => {
  const latest = buildLatest({
    ...base,
    bestThirty: [{ msisdn: "01100000001", grade: 96, reason: "five ones" }],
    publishRows: [dbRow("01100000001"), dbRow("01100000002")],
  });
  assert.equal(latest.best_thirty.length, 1);
  assert.equal(latest.best_thirty[0].grade, 96);
  assert.equal(latest.best_thirty[0].reason, "five ones");
  assert.equal(latest.best_thirty[0].carrier, "etisalat"); // metadata from the DB row
  assert.deepEqual(latest.all_available.map((r) => r.msisdn), ["01100000002"]);
  assert.equal(latest.published_count, 2);
});

test("buildLatest reports the real totals even though the rows are capped", () => {
  const latest = buildLatest({
    ...base,
    counts: { available_total: 159977, by_carrier: { vodafone: 5202, etisalat: 96340, we: 58435 } },
    publishRows: [dbRow("01100000001")],
  });
  assert.equal(latest.available_total, 159977);
  assert.deepEqual(latest.by_carrier, { vodafone: 5202, etisalat: 96340, we: 58435 });
  assert.equal(latest.published_count, 1);
});

test("buildLatest flags new numbers from the diff set", () => {
  const latest = buildLatest({
    ...base,
    diff: { newMsisdns: ["01100000002"], disappearedMsisdns: [], newSet: new Set(["01100000002"]) },
    publishRows: [dbRow("01100000001"), dbRow("01100000002")],
  });
  const byId = Object.fromEntries(latest.all_available.map((r) => [r.msisdn, r]));
  assert.equal(byId["01100000002"].is_new, true);
  assert.equal(byId["01100000001"].is_new, false);
});

test("buildLatest caps the new/disappeared lists but not their counts", () => {
  const many = Array.from({ length: 40 }, (_, i) => `0100000${String(i).padStart(4, "0")}`);
  const latest = buildLatest({
    ...base,
    diff: { newMsisdns: many, disappearedMsisdns: many, newSet: new Set() },
    changeListLimit: 5,
  });
  assert.equal(latest.new_msisdns.length, 5);
  assert.equal(latest.disappeared_msisdns.length, 5);
  assert.equal(latest.new_count, 40); // counts reflect reality, the lists are just bounded
  assert.equal(latest.disappeared_count, 40);
});

test("buildCandidates caps the new-number extras (a re-baseline makes thousands new)", () => {
  const available = Array.from({ length: 200 }, (_, i) => `0100000${String(i).padStart(4, "0")}`);
  const sm = new Map(available.map((m, i) => [m, { score: i, tags: [] }]));
  // Everything is new; only the top `count` scorers among the extras should be graded.
  const c = buildCandidates({ available, scoreMap: sm, newMsisdns: available, count: 10 });
  assert.equal(c.length, 20); // 10 top-by-score + at most 10 extras
  assert.equal(new Set(c.map((x) => x.msisdn)).size, 20); // no duplicates
  assert.ok(c.slice(10).every((x) => x.score >= 180)); // extras are the best of the rest
});
