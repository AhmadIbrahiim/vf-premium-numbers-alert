import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmail, buildSubject, topScore, sendPremiumEmail } from "../src/email.js";

const ROW = {
  msisdn: "01101173349", score: 59, grade: 59, tags: ["pair-ladder", "etisalat-golden"],
  carrier: "etisalat", tier: "golden", reason: "",
};
const WE_ROW = {
  msisdn: "01555606570", score: 55, grade: 55, tags: ["pair-ladder"],
  carrier: "we", tier: "GRADE_017", reason: "",
};

test("topScore prefers grade but falls back to score", () => {
  assert.equal(topScore([{ score: 40 }, { score: 10, grade: 88 }]), 88);
  assert.equal(topScore([{ score: 40 }]), 40);
  assert.equal(topScore([]), 0);
});

test("subject names the number when there is exactly one", () => {
  assert.equal(buildSubject([ROW]), "New premium number: 0110 117 3349 (score 59)");
});

test("subject counts and leads with the best score when there are several", () => {
  assert.equal(buildSubject([ROW, WE_ROW]), "2 new premium numbers (best score 59)");
});

test("both bodies carry every number, its score and its carrier", () => {
  const { text, html } = buildEmail({ rows: [ROW, WE_ROW], threshold: 50 });
  for (const body of [text, html]) {
    assert.match(body, /0110 117 3349/);
    assert.match(body, /0155 560 6570/);
    assert.match(body, /Etisalat/);
    assert.match(body, /WE/);
    assert.match(body, /59/);
  }
  assert.match(text, /Alerting on score >= 50/);
});

test("carrier tier labels are humanised, including WE's grade codes", () => {
  const { html } = buildEmail({ rows: [ROW, WE_ROW] });
  assert.match(html, /Golden/);
  assert.match(html, /Grade 17/);
});

test("the dashboard link appears only when a URL is given", () => {
  const withUrl = buildEmail({ rows: [ROW], dashboardUrl: "https://example.github.io/x/" });
  assert.match(withUrl.text, /Dashboard: https:\/\/example\.github\.io\/x\//);
  assert.match(withUrl.html, /href="https:\/\/example\.github\.io\/x\/"/);
  const without = buildEmail({ rows: [ROW] });
  assert.ok(!without.text.includes("Dashboard:"));
  assert.ok(!without.html.includes("Open the dashboard"));
});

test("tags are escaped into the HTML body, never injected raw", () => {
  const { html } = buildEmail({ rows: [{ ...ROW, reason: '<img src=x onerror="alert(1)">' }] });
  assert.ok(!html.includes("<img"), "raw tag must not survive");
  assert.match(html, /&lt;img/);
});

test("sendPremiumEmail sends nothing when there are no new premium numbers", async () => {
  let called = false;
  const r = await sendPremiumEmail([], { apiKey: "k", to: "a@b.c", fetchImpl: async () => { called = true; } });
  assert.equal(r, "no-new-premium");
  assert.equal(called, false);
});

test("sendPremiumEmail skips (does not throw) when credentials are missing", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await sendPremiumEmail([ROW], { to: "a@b.c" }), "skipped-no-credentials");
    assert.equal(await sendPremiumEmail([ROW], { apiKey: "k" }), "skipped-no-credentials");
  } finally {
    console.warn = origWarn;
  }
});

test("sendPremiumEmail posts to Resend with a bearer key and a string `to`", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ id: "abc-123" }) };
  };
  const r = await sendPremiumEmail([ROW], {
    apiKey: "re_test", to: "me@example.com", from: "X <onboarding@resend.dev>",
    dashboardUrl: "https://d/", threshold: 50, fetchImpl,
  });
  assert.equal(r, "emailed-abc-123");
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.headers.authorization, "Bearer re_test");
  assert.equal(typeof seen.body.to, "string", "Resend rejects a one-element array here");
  assert.equal(seen.body.to, "me@example.com");
  assert.equal(seen.body.from, "X <onboarding@resend.dev>");
  assert.match(seen.body.subject, /0110 117 3349/);
  assert.ok(seen.body.text && seen.body.html);
});

test("sendPremiumEmail reports the failure reason without leaking the API key", async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const r = await sendPremiumEmail([ROW], {
      apiKey: "re_secret_key", to: "me@example.com",
      fetchImpl: async () => ({
        ok: false, status: 403,
        json: async () => ({ message: "You can only send testing emails to your own email address" }),
      }),
    });
    assert.equal(r, "send-failed-403");
  } finally {
    console.warn = origWarn;
  }
  assert.match(warnings.join(" "), /only send testing emails/);
  assert.ok(!warnings.join(" ").includes("re_secret_key"), "API key must not be logged");
});

test("sendPremiumEmail swallows a transport error so a poll never fails on mail", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = await sendPremiumEmail([ROW], {
      apiKey: "k", to: "me@example.com",
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
    });
    assert.equal(r, "error");
  } finally {
    console.warn = origWarn;
  }
});
