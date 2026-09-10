import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scoreMsisdn } from "../src/score.js";

const fixtureUrl = new URL("./fixtures/catalog-sample.json", import.meta.url);

test("all-same digit scores near 100 with all-same tag", () => {
  const { score, tags } = scoreMsisdn("01000000000");
  assert.ok(score >= 90, `expected >=90, got ${score}`);
  assert.ok(tags.includes("all-same"));
});

test("ascending 8-run scores high with ascending tag", () => {
  const { score, tags } = scoreMsisdn("01012345678");
  assert.ok(score >= 80, `expected >=80, got ${score}`);
  assert.ok(tags.includes("ascending"));
});

test("descending 8-run scores high with descending tag", () => {
  const { score, tags } = scoreMsisdn("01087654321");
  assert.ok(score >= 80, `expected >=80, got ${score}`);
  assert.ok(tags.includes("descending"));
});

test("partial ascending run is detected and scaled", () => {
  const { score, tags } = scoreMsisdn("01091234599");
  assert.ok(tags.some((t) => t.startsWith("ascending-run")));
  assert.ok(score > 0);
});

test("AABB paired pattern scores high with paired tag", () => {
  const { score, tags } = scoreMsisdn("01055449900");
  assert.ok(score >= 60, `expected >=60, got ${score}`);
  assert.ok(tags.includes("paired-AABB"));
});

test("ABAB alternating pattern scores high with alternating tag", () => {
  const { score, tags } = scoreMsisdn("01054545454");
  assert.ok(score >= 60, `expected >=60, got ${score}`);
  assert.ok(tags.includes("alternating-ABAB"));
});

test("palindrome of last 8 digits is detected", () => {
  const { score, tags } = scoreMsisdn("01012344321");
  assert.ok(tags.includes("palindrome"));
  assert.ok(score >= 40, `expected >=40, got ${score}`);
});

test("repeating block is detected", () => {
  const { tags } = scoreMsisdn("01045454545");
  assert.ok(
    tags.includes("alternating-ABAB") ||
      tags.some((t) => t.startsWith("repeating-block")),
  );
});

test("heavy trailing zeros scores high with ending tag", () => {
  const { score, tags } = scoreMsisdn("01012340000");
  assert.ok(score >= 40, `expected >=40, got ${score}`);
  assert.ok(tags.some((t) => t.startsWith("ending-0000")));
});

test("low distinct-digit count earns a tag", () => {
  const { tags } = scoreMsisdn("01055225522");
  assert.ok(
    tags.includes("two-distinct-digits") || tags.includes("alternating-ABAB"),
  );
});

test("plain random-looking number scores low", () => {
  const { score } = scoreMsisdn("01055455833");
  assert.ok(score < 35, `expected plain number < 35, got ${score}`);
});

test("monotonic sanity: stronger patterns score >= weaker ones", () => {
  const allSame = scoreMsisdn("01000000000").score;
  const ascending = scoreMsisdn("01012345678").score;
  const partial = scoreMsisdn("01091234599").score;
  const plain = scoreMsisdn("01055455833").score;

  assert.ok(allSame >= ascending, `${allSame} >= ${ascending}`);
  assert.ok(ascending >= partial, `${ascending} >= ${partial}`);
  assert.ok(partial >= plain, `${partial} >= ${plain}`);

  const fourZeros = scoreMsisdn("01012340000").score;
  const twoZeros = scoreMsisdn("01012345600").score;
  assert.ok(fourZeros >= twoZeros, `${fourZeros} >= ${twoZeros}`);
});

test("every fixture number scores within [0,100]", async () => {
  const raw = await readFile(fileURLToPath(fixtureUrl), "utf8");
  const catalog = JSON.parse(raw);
  assert.ok(Array.isArray(catalog.content) && catalog.content.length > 0);
  for (const rec of catalog.content) {
    const { score, tags } = scoreMsisdn(rec.msisdn);
    assert.ok(
      Number.isFinite(score) && score >= 0 && score <= 100,
      `msisdn ${rec.msisdn} produced out-of-range score ${score}`,
    );
    assert.ok(Array.isArray(tags));
  }
});

test("defensive cases return {score:0, tags:[]}", () => {
  assert.deepEqual(scoreMsisdn(null), { score: 0, tags: [] });
  assert.deepEqual(scoreMsisdn(undefined), { score: 0, tags: [] });
  assert.deepEqual(scoreMsisdn(""), { score: 0, tags: [] });
  assert.deepEqual(scoreMsisdn("123"), { score: 0, tags: [] });
  assert.deepEqual(scoreMsisdn(1055455833), { score: 0, tags: [] });
  assert.deepEqual(scoreMsisdn("0105545583"), { score: 0, tags: [] }); // 10 digits
  assert.deepEqual(scoreMsisdn("01355455833"), { score: 0, tags: [] }); // bad prefix
});

// --- new "unique / easy to remember" pattern families ---

test("arithmetic ladder with step 2 scores via ladder tag", () => {
  const { score, tags } = scoreMsisdn("01213579753"); // sub 13579753 -> 1,3,5,7,9 step2
  // Threshold lowered from 40 when the ladders were recalibrated: a step-2 run has to
  // sit below the consecutive run of the same length (see the ordering test below).
  assert.ok(score >= 25, `expected >=25, got ${score}`);
  assert.ok(tags.some((t) => t.startsWith("ladder-step")), `tags: ${tags}`);
});

test("a consecutive run beats a step-2 ladder of the same length", () => {
  // 56789 is easier to say than 13579, so it must score higher. The old weights had
  // this backwards (28 against 50), which is why step-2 ladders filled the top.
  const consecutive = scoreMsisdn("01015678923"); // 5,6,7,8,9
  const stepTwo = scoreMsisdn("01013579246"); // 1,3,5,7,9
  const runTag = consecutive.tags.find((t) => /-run-x5/.test(t));
  const ladderTag = stepTwo.tags.find((t) => /ladder-step-?2-x5/.test(t));
  assert.ok(runTag, `expected a 5-run tag, got: ${consecutive.tags}`);
  assert.ok(ladderTag, `expected a step-2 x5 tag, got: ${stepTwo.tags}`);
  assert.ok(
    consecutive.score > stepTwo.score,
    `consecutive (${consecutive.score}) must beat step-2 (${stepTwo.score})`
  );
});

test("pair ladder 01 02 03 04 detected", () => {
  const { score, tags } = scoreMsisdn("01001020304"); // sub 01020304
  assert.ok(tags.includes("pair-ladder"), `tags: ${tags}`);
  assert.ok(score >= 50, `expected >=50, got ${score}`);
});

test("pair ladder of equal-step pairs 00 11 22 33", () => {
  const { score, tags } = scoreMsisdn("01000112233"); // sub 00112233
  assert.ok(tags.includes("pair-ladder"), `tags: ${tags}`);
  assert.ok(score >= 90, `expected >=90, got ${score}`);
});

test("grouped triples 444 555 .. tagged grouped", () => {
  const { tags } = scoreMsisdn("01044455566"); // sub 44455566 -> groups 3,3,2
  assert.ok(tags.includes("grouped"), `tags: ${tags}`);
});

test("mostly-zeros scattered number tagged", () => {
  const { tags } = scoreMsisdn("01005005000"); // sub 05005000 -> 6 zeros
  assert.ok(tags.includes("mostly-zeros"), `tags: ${tags}`);
});

test("memorable ladder outscores a plain number", () => {
  const ladder = scoreMsisdn("01213579753").score;
  const plain = scoreMsisdn("01055455833").score;
  assert.ok(ladder > plain, `ladder ${ladder} should beat plain ${plain}`);
});

/* --- ladders must only fire on steps a human can actually see --- */

test("a pair ladder with an imperceptible step scores nothing for it", () => {
  // 01·17·33·49 is arithmetic with step 16 — technically a sequence, visually noise.
  // This was the single biggest scoring defect: it put random numbers at the top of
  // the list, ahead of genuinely memorable ones.
  for (const m of ["01101173349", "01101183552", "01101193755"]) {
    const { tags } = scoreMsisdn(m);
    assert.ok(!tags.includes("pair-ladder"), `${m} must not count as a pair ladder`);
    assert.ok(!tags.includes("pair-ladder-partial"), `${m} must not count as a partial pair ladder`);
  }
});

test("a pair ladder with a perceptible step still scores", () => {
  // These are the patterns the heuristic was written for and they must survive.
  for (const m of ["01001020304", "01010203040", "01011223344"]) {
    const { tags } = scoreMsisdn(m);
    assert.ok(
      tags.some((t) => t.startsWith("pair-ladder")),
      `${m} should read as a pair ladder`
    );
  }
});

test("a visible ascending run outranks an invisible arithmetic ladder", () => {
  // 656789 is a run anyone would notice; 01·17·33·49 is not. The old weights had
  // this backwards, 28 against 59.
  const visible = scoreMsisdn("01555656789");
  const noise = scoreMsisdn("01101173349");
  assert.ok(
    visible.score > noise.score,
    `01555656789 (${visible.score}) must outrank 01101173349 (${noise.score})`
  );
});

test("digit ladders only count for steps of 2, not arbitrary ones", () => {
  // Step 2 (13579, 24680) reads as counting. Step 3+ does not.
  assert.ok(scoreMsisdn("01013579135").tags.some((t) => /ladder-step-?2/.test(t)));
  for (const m of ["01014703692", "01011593705"]) {
    const { tags } = scoreMsisdn(m);
    assert.ok(
      !tags.some((t) => /ladder-step-?[3-9]/.test(t)),
      `${m} must not score a step-3+ ladder`
    );
  }
});

test("zeros are worth more than any other digit, and rising with count", () => {
  // The market rule, from a dealer: "the more zeros the more premium". The old scorer
  // paid for zeros only when TRAILING or when there were at least five, so counts 1-4
  // earned nothing at all for their zeros.
  const scoreOf = (sub) => scoreMsisdn("010" + sub).score;
  const zeroCredit = [];
  for (let z = 2; z <= 7; z++) {
    // Same shape throughout: one run of zeros, one run of sevens.
    zeroCredit.push(scoreOf("0".repeat(z) + "7".repeat(8 - z)));
  }
  // Not asserting strict monotonicity — swapping a digit also changes which shape
  // bonuses fire — but a number with six zeros must beat the same shape with two.
  assert.ok(
    scoreOf("00000077") > scoreOf("00777777"),
    "six zeros must beat two zeros in the same two-run shape"
  );
  assert.ok(zeroCredit.every((s) => s > 0), "every zero count must earn something");
});

test("a zero-heavy number outranks the same shape built from another digit", () => {
  for (const [zeros, others] of [
    ["00000777", "77777777"],
    ["00012345", "77712345"],
    ["01000000", "01777777"],
  ]) {
    const z = scoreMsisdn("010" + zeros).score;
    const o = scoreMsisdn("010" + others).score;
    assert.ok(z >= o, `${zeros} (${z}) should be at least ${others} (${o})`);
  }
});

test("all-same numbers do not collect bonuses that are vacuously true of them", () => {
  // 77777777 is trivially AABB, trivially a palindrome and trivially two-groups. Letting
  // those fire stacked 95 + 52 + 28 = 175, hitting the cap on its own, so all-fours tied
  // with all-zeros — which the market prices far higher.
  const { tags } = scoreMsisdn("01077777777");
  assert.ok(tags.includes("all-same"));
  assert.ok(!tags.includes("paired-AABB"), "AABB is vacuous for an all-same number");
  assert.ok(!tags.includes("palindrome"), "palindrome is vacuous for an all-same number");
  assert.ok(
    scoreMsisdn("01000000000").score > scoreMsisdn("01077777777").score,
    "all zeros must outrank all sevens"
  );
});

test("ones rank above ordinary digits but below zeros", () => {
  const zero = scoreMsisdn("01000000123").score;
  const one = scoreMsisdn("01011111123").score;
  const four = scoreMsisdn("01044444123").score;
  assert.ok(one > four, `ones (${one}) should beat fours (${four})`);
  assert.ok(zero >= one, `zeros (${zero}) should be at least ones (${one})`);
});
