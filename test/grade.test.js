import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCandidates } from "../src/grade.js";

/** Build a candidate list with N entries. */
function makeCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      msisdn: "0105545580" + (i % 10),
      score: 90 - i,
      tags: ["tag" + i],
    });
  }
  return out;
}

/** A fake fetch that returns an OpenAI-style chat completion with the given content. */
function fakeOkFetch(content) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

test("happy path: grades/reasons come through, order preserved, foreign filtered", async () => {
  const candidates = [
    { msisdn: "01055455801", score: 80, tags: ["repeat"] },
    { msisdn: "01055455802", score: 70, tags: ["seq"] },
    { msisdn: "01055455803", score: 60, tags: [] },
  ];
  const content = JSON.stringify({
    ranked: [
      { msisdn: "01055455802", grade: 95, reason: "great sequence" },
      { msisdn: "09999999999", grade: 99, reason: "not in list" }, // foreign
      { msisdn: "01055455801", grade: 88, reason: "nice repeat" },
    ],
  });

  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: fakeOkFetch(content),
  });

  assert.deepEqual(out, [
    { msisdn: "01055455802", grade: 95, reason: "great sequence" },
    { msisdn: "01055455801", grade: 88, reason: "nice repeat" },
  ]);
  // foreign msisdn filtered out
  assert.ok(!out.some((r) => r.msisdn === "09999999999"));
});

test("grades are clamped to 0-100 int", async () => {
  const candidates = [
    { msisdn: "01055455801", score: 80, tags: ["a"] },
    { msisdn: "01055455802", score: 70, tags: ["b"] },
  ];
  const content = JSON.stringify({
    ranked: [
      { msisdn: "01055455801", grade: 150.7, reason: "x" },
      { msisdn: "01055455802", grade: -10, reason: "y" },
    ],
  });
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: fakeOkFetch(content),
  });
  assert.equal(out[0].grade, 100);
  assert.equal(out[1].grade, 0);
});

test("non-200 -> deterministic fallback, grade === score, length <= count", async () => {
  const candidates = makeCandidates(40);
  const out = await gradeCandidates(candidates, {
    token: "t",
    count: 30,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(out.length, 30);
  assert.equal(out[0].grade, candidates[0].score);
  assert.equal(out[0].reason, "tag0");
});

test("network throw -> fallback", async () => {
  const candidates = makeCandidates(5);
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(out.length, 5);
  assert.equal(out[0].grade, candidates[0].score);
});

test("timeout/abort -> fallback", async () => {
  const candidates = makeCandidates(5);
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  });
  assert.equal(out.length, 5);
  assert.equal(out[0].grade, candidates[0].score);
});

test("malformed JSON content -> fallback", async () => {
  const candidates = makeCandidates(5);
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: fakeOkFetch("{not valid json"),
  });
  assert.equal(out.length, 5);
  assert.equal(out[0].grade, candidates[0].score);
});

test("empty content -> fallback", async () => {
  const candidates = makeCandidates(3);
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    }),
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].grade, candidates[0].score);
});

test("ranked present but no valid items -> fallback", async () => {
  const candidates = makeCandidates(4);
  const content = JSON.stringify({ ranked: [{ msisdn: "00000000000", grade: 50 }] });
  const out = await gradeCandidates(candidates, {
    token: "t",
    fetchImpl: fakeOkFetch(content),
  });
  assert.equal(out.length, 4);
  assert.equal(out[0].grade, candidates[0].score);
});

test("no token -> fallback WITHOUT calling fetch", async () => {
  const candidates = makeCandidates(3);
  let called = false;
  const out = await gradeCandidates(candidates, {
    fetchImpl: async () => {
      called = true;
      return fakeOkFetch("{}")();
    },
  });
  assert.equal(called, false);
  assert.equal(out.length, 3);
  assert.equal(out[0].grade, candidates[0].score);
  assert.equal(out[0].reason, "tag0");
});

test("fallback reason defaults to 'pattern match' when no tags", async () => {
  const candidates = [{ msisdn: "01055455801", score: 50, tags: [] }];
  const out = await gradeCandidates(candidates, {}); // no token
  assert.equal(out[0].reason, "pattern match");
});

test("count truncation respected on model output", async () => {
  const candidates = makeCandidates(50);
  const ranked = candidates.map((c) => ({
    msisdn: c.msisdn,
    grade: 50,
    reason: "ok",
  }));
  // Note: candidates reuse msisdns mod 10; allowed set dedupes but ranked still
  // contains many entries — truncation to count must apply.
  const out = await gradeCandidates(candidates, {
    token: "t",
    count: 7,
    fetchImpl: fakeOkFetch(JSON.stringify({ ranked })),
  });
  assert.ok(out.length <= 7);
  assert.equal(out.length, 7);
});

test("request shape: correct url, headers, and body", async () => {
  const candidates = [{ msisdn: "01055455801", score: 80, tags: ["repeat"] }];
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return fakeOkFetch(
      JSON.stringify({ ranked: [{ msisdn: "01055455801", grade: 80, reason: "r" }] }),
    )();
  };
  await gradeCandidates(candidates, {
    token: "abc",
    model: "openai/gpt-4o-mini",
    fetchImpl,
  });
  assert.equal(captured.url, "https://models.github.ai/inference/chat/completions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer abc");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.equal(captured.init.headers.Accept, "application/json");
  const sentBody = JSON.parse(captured.init.body);
  assert.equal(sentBody.model, "openai/gpt-4o-mini");
  assert.equal(sentBody.temperature, 0.2);
  assert.deepEqual(sentBody.response_format, { type: "json_object" });
  assert.equal(sentBody.messages.length, 2);
  assert.equal(sentBody.messages[0].role, "system");
  assert.equal(sentBody.messages[1].role, "user");
  assert.ok(captured.init.signal); // AbortController signal present
});
