import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTier, patternLabel, formatMsisdn, tierLabel } from "../lib/format.js";

/**
 * The colour rule these tests defend, measured in a browser rather than guessed:
 *
 * Against white, the 600-level accents come in at 3.1-3.8:1 and zinc-400 at 2.56:1 —
 * all under AA's 4.5. Against the near-black ground, zinc-600 measures 2.59:1. So the
 * light theme uses the 700 step (or zinc-500) and the dark theme the 400 step, and
 * **every tone must name both**: a tone with only a light value inherits nothing usable
 * on the dark ground, which is how the score ended up unreadable in the theme the app
 * ships in by default.
 */

const TIER_SCORES = [59, 56, 50, 40, 30, 20, 5, 0];

test("every score tier names both a light and a dark colour", () => {
  for (const score of TIER_SCORES) {
    const { tone, label } = scoreTier(score);
    assert.ok(tone, `${score} has no tone`);
    assert.ok(label, `${score} has no label`);
    const classes = tone.split(/\s+/);
    const light = classes.filter((c) => !c.startsWith("dark:"));
    const dark = classes.filter((c) => c.startsWith("dark:"));
    assert.equal(light.length, 1, `${label}: expected exactly one light colour, got "${tone}"`);
    assert.equal(dark.length, 1, `${label}: expected exactly one dark colour, got "${tone}"`);
  }
});

test("light-theme tier colours use a step dark enough for white", () => {
  // 600-level greens/limes/ambers measured 3.09-3.77:1 against white. 700 clears 4.5.
  for (const score of TIER_SCORES) {
    const { tone, label } = scoreTier(score);
    const light = tone.split(/\s+/).find((c) => !c.startsWith("dark:"));
    const step = Number(light.split("-").at(-1));
    const isNeutral = light.includes("zinc");
    assert.ok(
      isNeutral ? step >= 500 : step >= 700,
      `${label}: "${light}" is too light against white (needs zinc-500+ or a 700 hue)`
    );
  }
});

test("dark-theme tier colours use a step light enough for the dark ground", () => {
  for (const score of TIER_SCORES) {
    const { tone, label } = scoreTier(score);
    const dark = tone.split(/\s+/).find((c) => c.startsWith("dark:"));
    const step = Number(dark.split("-").at(-1));
    assert.ok(step <= 400, `${label}: "${dark}" is too dark against near-black`);
  }
});

test("tier labels still separate the top of the range", () => {
  // The bands are cut against the real distribution: the best number in the catalogue
  // scores 56, so bands wide enough for 0-100 made every row read "Exceptional".
  assert.notEqual(scoreTier(56).label, scoreTier(20).label);
  assert.notEqual(scoreTier(56).label, scoreTier(40).label);
  assert.equal(scoreTier(0).label, scoreTier(5).label, "the bottom band should be one label");
});

test("formatMsisdn groups the digits and keeps them intact", () => {
  const out = formatMsisdn("01101232101");
  assert.equal(out.replace(/\s/g, ""), "01101232101", "no digit may be lost to formatting");
  assert.ok(out.includes(" "), "should be grouped for readability");
});

test("patternLabel returns null for tags not worth surfacing", () => {
  // The dashboard shows human language, never raw scorer tags, so an unmapped tag must
  // be dropped rather than rendered as an engineering identifier.
  assert.equal(patternLabel("definitely-not-a-real-tag"), null);
});

test("tierLabel maps the real pool names to human words", () => {
  // These are the values that actually reach the dashboard, straight from the carrier
  // payloads — bare pool names, not scorer tags.
  assert.equal(tierLabel("platinum_plus"), "Platinum+");
  assert.equal(tierLabel("golden"), "Golden");
  assert.equal(tierLabel("GRADE_006"), "WE grade 6");
  assert.equal(tierLabel(""), "");
});

test("an unmapped tier is title-cased, never printed as an identifier", () => {
  // The dashboard shows human language, never tags. A pool name nobody has mapped yet
  // must still not render as "diamond_plus".
  const label = tierLabel("diamond_plus");
  assert.ok(!label.includes("_"), `"${label}" still looks like an identifier`);
  assert.equal(label, "Diamond Plus");
});
