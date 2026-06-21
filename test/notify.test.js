import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueBody } from "../src/notify.js";

test("buildIssueBody includes a Carrier column and per-row carrier label", () => {
  const body = buildIssueBody({
    newPremium: [
      { msisdn: "01199999999", grade: 96, reason: "all nines", sim_type: "", carrier: "etisalat", tags: [] },
      { msisdn: "01055455833", grade: 91, reason: "repeat", sim_type: "ESIM", carrier: "vodafone", tags: [] },
    ],
    generatedAt: "2026-06-20T00:00:00Z",
    repo: "owner/name",
  });
  assert.match(body, /Carrier/);
  assert.match(body, /Etisalat/);
  assert.match(body, /Vodafone/);
});
