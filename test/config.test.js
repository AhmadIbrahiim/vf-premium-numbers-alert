import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETISALAT_POOLS, tierBonus,
  weGradeSlug, WE_GRADE_MIN, WE_GRADE_MAX, WE_PAGE_SIZE, WE_MAX_PAGES,
} from "../src/config.js";

test("ETISALAT_POOLS maps the five pools to tiers and bonuses", () => {
  assert.deepEqual(
    ETISALAT_POOLS.map((p) => [p.poolId, p.tier, p.bonus]),
    [
      [135, "silver", 0],
      [136, "golden", 4],
      [137, "golden_plus", 8],
      [138, "platinum", 12],
      [139, "platinum_plus", 16],
    ],
  );
});

test("tierBonus returns the bonus for a known tier", () => {
  assert.equal(tierBonus("silver"), 0);
  assert.equal(tierBonus("golden"), 4);
  assert.equal(tierBonus("platinum_plus"), 16);
});

test("tierBonus is 0 for unknown or empty tier", () => {
  assert.equal(tierBonus(""), 0);
  assert.equal(tierBonus("gold"), 0);
  assert.equal(tierBonus(undefined), 0);
});

test("weGradeSlug zero-pads to GRADE_0NN", () => {
  assert.equal(weGradeSlug(1), "GRADE_001");
  assert.equal(weGradeSlug(17), "GRADE_017");
  assert.equal(weGradeSlug(30), "GRADE_030");
});

test("WE grade bounds are valid positive integers (env-independent)", () => {
  for (const v of [WE_GRADE_MIN, WE_GRADE_MAX, WE_PAGE_SIZE, WE_MAX_PAGES]) {
    assert.ok(Number.isInteger(v) && v >= 1, `expected positive integer, got ${v}`);
  }
  assert.ok(WE_GRADE_MIN <= WE_GRADE_MAX, "WE_GRADE_MIN must be <= WE_GRADE_MAX");
});
