import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, candidateSignature, gradeCacheValid } from "../src/store.js";

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
