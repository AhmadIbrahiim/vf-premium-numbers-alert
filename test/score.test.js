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
