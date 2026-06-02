import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDiff } from "../src/diff.js";

/** Helper to build an available history entry. */
function avail(msisdn) {
  return {
    [msisdn]: {
      first_seen: "2026-01-01",
      last_seen: "2026-01-01",
      score: 50,
      tags: [],
      best_grade: 50,
      status: "available",
    },
  };
}

/** Helper to build a "gone" history entry. */
function gone(msisdn) {
  return {
    [msisdn]: {
      first_seen: "2026-01-01",
      last_seen: "2026-01-02",
      score: 50,
      tags: [],
      best_grade: 50,
      status: "gone",
    },
  };
}

test("baseline: empty history -> isBaseline, no new, no disappeared", () => {
  const result = computeDiff({
    current: ["01055455833", "01122233344"],
    history: {},
  });
  assert.equal(result.isBaseline, true);
  assert.deepEqual(result.newMsisdns, []);
  assert.deepEqual(result.disappearedMsisdns, []);
  assert.equal(result.suspicious, false);
});

test("normal: prior {A,B,C}, current {B,C,D} -> new [D], disappeared [A]", () => {
  const A = "01000000001";
  const B = "01000000002";
  const C = "01000000003";
  const D = "01000000004";
  const history = { ...avail(A), ...avail(B), ...avail(C) };

  const result = computeDiff({ current: [B, C, D], history });
  assert.equal(result.isBaseline, false);
  assert.equal(result.suspicious, false);
  assert.deepEqual(result.newMsisdns, [D]);
  assert.deepEqual(result.disappearedMsisdns, [A]);
});

test("suspicious shrink: prior 100, current 10 -> suspicious true", () => {
  const history = {};
  const current = [];
  for (let i = 0; i < 100; i++) {
    const m = `0100000${String(i).padStart(4, "0")}`;
    Object.assign(history, avail(m));
    if (i < 10) current.push(m);
  }
  const result = computeDiff({ current, history });
  assert.equal(result.suspicious, true);
  assert.equal(result.isBaseline, false);
});

test("not-suspicious boundary: current exactly 50% of prior -> suspicious false", () => {
  const history = {};
  const current = [];
  for (let i = 0; i < 100; i++) {
    const m = `0100000${String(i).padStart(4, "0")}`;
    Object.assign(history, avail(m));
    if (i < 50) current.push(m);
  }
  const result = computeDiff({ current, history });
  // 50 is NOT < 100 * 0.5, so not suspicious.
  assert.equal(result.suspicious, false);
});

test("not-suspicious boundary: just above 50% -> suspicious false", () => {
  const history = {};
  const current = [];
  for (let i = 0; i < 100; i++) {
    const m = `0100000${String(i).padStart(4, "0")}`;
    Object.assign(history, avail(m));
    if (i < 51) current.push(m);
  }
  const result = computeDiff({ current, history });
  assert.equal(result.suspicious, false);
});

test("just below 50% -> suspicious true", () => {
  const history = {};
  const current = [];
  for (let i = 0; i < 100; i++) {
    const m = `0100000${String(i).padStart(4, "0")}`;
    Object.assign(history, avail(m));
    if (i < 49) current.push(m);
  }
  const result = computeDiff({ current, history });
  assert.equal(result.suspicious, true);
});

test('history entries with status "gone" are excluded from prior available set', () => {
  const A = "01000000001"; // available
  const G = "01000000099"; // gone
  const history = { ...avail(A), ...gone(G) };

  // current re-includes the gone one -> it should count as new.
  const result = computeDiff({ current: [A, G], history });
  assert.equal(result.isBaseline, false);
  // G was gone, not in prior available -> new. A was available and present -> not new/disappeared.
  assert.deepEqual(result.newMsisdns, [G]);
  assert.deepEqual(result.disappearedMsisdns, []);
  assert.equal(result.suspicious, false);
});

test("dedup/falsy: current has duplicates and a null -> handled cleanly", () => {
  const A = "01000000001";
  const B = "01000000002";
  const history = { ...avail(A) };

  const result = computeDiff({
    current: [B, B, null, undefined, "", A, A],
    history,
  });
  assert.equal(result.isBaseline, false);
  // Deduped: B is new (once), A present.
  assert.deepEqual(result.newMsisdns, [B]);
  assert.deepEqual(result.disappearedMsisdns, []);
  assert.equal(result.suspicious, false);
});

test("missing history arg treated as {} (baseline)", () => {
  const result = computeDiff({ current: ["01000000001"] });
  assert.equal(result.isBaseline, true);
  assert.deepEqual(result.newMsisdns, []);
  assert.deepEqual(result.disappearedMsisdns, []);
});

test("all prior available disappear, current empty -> suspicious true, all disappeared", () => {
  const A = "01000000001";
  const B = "01000000002";
  const history = { ...avail(A), ...avail(B) };
  const result = computeDiff({ current: [], history });
  // 0 < 2 * 0.5 -> suspicious.
  assert.equal(result.suspicious, true);
  assert.deepEqual(result.newMsisdns, []);
  assert.deepEqual(result.disappearedMsisdns.sort(), [A, B].sort());
});
