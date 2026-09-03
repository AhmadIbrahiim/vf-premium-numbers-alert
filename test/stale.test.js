import { test } from "node:test";
import assert from "node:assert/strict";
import {
  staleness,
  shouldAlert,
  formatAge,
  buildStaleEmail,
  DEFAULT_STALE_AFTER_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
} from "../src/stale.js";

/**
 * The staleness check is the one thing that reports the poller being dead, so its own
 * failure modes are all "stayed quiet when it should have spoken". Every test below is
 * a case where silence would be wrong.
 */

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

test("a recent poll is not stale", () => {
  const s = staleness({ lastRunAt: minutesAgo(20), now: NOW, maxAgeMinutes: 90 });
  assert.equal(s.stale, false);
  assert.equal(s.ageMinutes, 20);
  assert.equal(s.reason, "fresh");
});

test("one missed poll at the 30-minute cadence is tolerated", () => {
  // A poll takes up to ~5.5 minutes and resource_group makes a late one wait rather
  // than overlap, so ~35-60 minutes is normal operation, not an outage.
  const s = staleness({ lastRunAt: minutesAgo(65), now: NOW, maxAgeMinutes: DEFAULT_STALE_AFTER_MINUTES });
  assert.equal(s.stale, false, "should not cry outage over a single skipped poll");
});

test("two missed polls is stale", () => {
  const s = staleness({ lastRunAt: minutesAgo(95), now: NOW, maxAgeMinutes: DEFAULT_STALE_AFTER_MINUTES });
  assert.equal(s.stale, true);
  assert.equal(s.reason, "no-recent-poll");
});

test("having never polled at all is stale", () => {
  // This is the state the project was actually in: the schedule did not exist, so
  // nothing had ever run on its own. It must not read as healthy.
  const s = staleness({ lastRunAt: null, now: NOW, maxAgeMinutes: 90 });
  assert.equal(s.stale, true);
  assert.equal(s.reason, "no-polls-recorded");
  assert.equal(s.ageMinutes, null);
});

test("an unreadable timestamp is treated as stale, not as fresh", () => {
  const s = staleness({ lastRunAt: "not a date", now: NOW, maxAgeMinutes: 90 });
  assert.equal(s.stale, true);
  assert.equal(s.reason, "unreadable-timestamp");
});

test("a future-dated run reports clock skew rather than a negative age", () => {
  const s = staleness({ lastRunAt: minutesAgo(-30), now: NOW, maxAgeMinutes: 90 });
  assert.equal(s.stale, false);
  assert.equal(s.reason, "clock-skew");
  assert.ok(s.ageMinutes < 0, "the skew should be visible, not hidden");
});

test("exactly at the threshold is not yet stale", () => {
  const s = staleness({ lastRunAt: minutesAgo(90), now: NOW, maxAgeMinutes: 90 });
  assert.equal(s.stale, false, "the boundary should not alert");
});

test("a fresh poll never alerts, whatever the cooldown says", () => {
  assert.equal(shouldAlert({ stale: false, lastAlertAt: null, now: NOW, cooldown: 360 }), false);
});

test("the first staleness alert always goes out", () => {
  assert.equal(shouldAlert({ stale: true, lastAlertAt: null, now: NOW, cooldown: 360 }), true);
});

test("a second alert inside the cooldown is suppressed", () => {
  // An outage lasting a day would otherwise mail hourly, and a stream of identical
  // alerts is what gets a mail rule written to hide them.
  assert.equal(
    shouldAlert({ stale: true, lastAlertAt: minutesAgo(30), now: NOW, cooldown: DEFAULT_COOLDOWN_MINUTES }),
    false
  );
});

test("the alert repeats once the cooldown has passed", () => {
  assert.equal(
    shouldAlert({ stale: true, lastAlertAt: minutesAgo(DEFAULT_COOLDOWN_MINUTES + 1), now: NOW, cooldown: DEFAULT_COOLDOWN_MINUTES }),
    true
  );
});

test("a corrupt cooldown marker fails open and still alerts", () => {
  // Failing open is the right direction for the one thing that reports an outage.
  assert.equal(shouldAlert({ stale: true, lastAlertAt: "garbage", now: NOW, cooldown: 360 }), true);
  assert.equal(shouldAlert({ stale: true, lastAlertAt: minutesAgo(-500), now: NOW, cooldown: 360 }), true);
});

test("formatAge reads as a notification, not as a number of minutes", () => {
  assert.equal(formatAge(45), "45 min");
  assert.equal(formatAge(60), "1 hr");
  assert.equal(formatAge(100), "1 hr 40 min");
  assert.equal(formatAge(null), "never");
});

test("the email names the missing schedule as the first cause", () => {
  // The real outage was a pipeline schedule that had never been created. Nobody
  // guesses that, so the mail has to say it.
  const { subject, text, html } = buildStaleEmail({
    ageMinutes: 100,
    lastRunAt: minutesAgo(100),
    maxAgeMinutes: 90,
    reason: "no-recent-poll",
    dashboardUrl: "https://example.test",
  });
  assert.match(subject, /no poll in 1 hr 40 min/i);
  assert.match(text, /Schedules/, "should point at the GitLab schedule");
  assert.match(text, /7,37/, "should give the actual cron");
  assert.match(text, /looks healthy/, "should say the dashboard hides this");
  assert.match(html, /example\.test/);
});

test("the never-polled email says so instead of claiming an age", () => {
  const { subject, text } = buildStaleEmail({
    ageMinutes: null,
    lastRunAt: null,
    maxAgeMinutes: 90,
    reason: "no-polls-recorded",
  });
  assert.match(subject, /no poll has ever run/i);
  assert.doesNotMatch(text, /NaN|Invalid Date/, "must not leak a broken date into the mail");
});

test("the email body never contains an unresolved template or NaN", () => {
  for (const ageMinutes of [0, 1, 59, 60, 61, 1440, null]) {
    const { subject, text, html } = buildStaleEmail({
      ageMinutes,
      lastRunAt: ageMinutes == null ? null : minutesAgo(ageMinutes),
      maxAgeMinutes: 90,
      reason: ageMinutes == null ? "no-polls-recorded" : "no-recent-poll",
    });
    for (const [name, body] of [["subject", subject], ["text", text], ["html", html]]) {
      assert.doesNotMatch(body, /NaN/, `${name} contains NaN at age ${ageMinutes}`);
      assert.doesNotMatch(body, /undefined/, `${name} contains undefined at age ${ageMinutes}`);
      assert.doesNotMatch(body, /Invalid Date/, `${name} contains Invalid Date at age ${ageMinutes}`);
    }
  }
});

/**
 * The wiring: reading the newest poll, honouring the cooldown, and sending. Uses two
 * separate fakes — one standing in for Neon's /sql endpoint, one for Resend — because
 * the interesting bug is a Resend failure being mistaken for a delivered alert.
 */

import { checkStaleness } from "../src/stale.js";

const CONN = "postgresql://u:p@ep-x-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require";

/** Answers the two queries checkStaleness makes, and records writes to `meta`. */
function fakeDatabase({ lastRunAt, lastAlertAt = null, failReads = false }) {
  const writes = [];
  const fetchImpl = async (_url, init) => {
    if (failReads) return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
    const { query, params } = JSON.parse(init.body);
    if (/^\s*select value from meta/i.test(query)) {
      return { ok: true, status: 200, json: async () => ({ rows: lastAlertAt ? [{ value: { lastAlertAt } }] : [] }) };
    }
    if (/insert into meta/i.test(query)) {
      writes.push({ key: params[0], value: JSON.parse(params[1]) });
      return { ok: true, status: 200, json: async () => ({ rows: [] }) };
    }
    // The provider-status reader.
    return {
      ok: true,
      status: 200,
      json: async () => ({ rows: lastRunAt ? [{ carrier: "we", last_run_at: lastRunAt }] : [] }),
    };
  };
  return { fetchImpl, writes, dbOpts: { fetchImpl, connectionString: CONN } };
}

function fakeResend({ ok = true, status = 200 } = {}) {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return ok
      ? { ok: true, status, json: async () => ({ id: "re_test_1" }) }
      : { ok: false, status, json: async () => ({ message: "not allowed" }) };
  };
  return { fetchImpl, sent };
}

const withCredentials = (fn) => async () => {
  const prev = { key: process.env.RESEND_API_KEY, to: process.env.ALERT_EMAIL_TO };
  process.env.RESEND_API_KEY = "re_test";
  process.env.ALERT_EMAIL_TO = "someone@example.test";
  try {
    await fn();
  } finally {
    if (prev.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev.key;
    if (prev.to === undefined) delete process.env.ALERT_EMAIL_TO; else process.env.ALERT_EMAIL_TO = prev.to;
  }
};

test("a stale poller sends one email and starts the cooldown", withCredentials(async () => {
  const db = fakeDatabase({ lastRunAt: minutesAgo(200) });
  const mail = fakeResend();
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.stale, true);
  assert.equal(r.ageMinutes, 200);
  assert.match(r.email, /^emailed/);
  assert.equal(mail.sent.length, 1, "exactly one message");
  assert.match(mail.sent[0].subject, /no poll in 3 hr 20 min/i);
  assert.equal(db.writes.length, 1, "the cooldown marker should be written");
  assert.equal(db.writes[0].key, "stale_alert");
}));

test("a failed send does not start the cooldown", withCredentials(async () => {
  // Resend 403s when the recipient is not the account owner. If that wrote the marker,
  // the next six hours would be silent about a real outage.
  const db = fakeDatabase({ lastRunAt: minutesAgo(200) });
  const mail = fakeResend({ ok: false, status: 403 });
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.email, "send-failed-403");
  assert.equal(db.writes.length, 0, "a failed send must leave the cooldown untouched");
}));

test("a healthy poller sends nothing", withCredentials(async () => {
  const db = fakeDatabase({ lastRunAt: minutesAgo(25) });
  const mail = fakeResend();
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.stale, false);
  assert.equal(r.email, "not-needed");
  assert.equal(mail.sent.length, 0);
  assert.equal(db.writes.length, 0);
}));

test("a recent alert suppresses the next one", withCredentials(async () => {
  const db = fakeDatabase({ lastRunAt: minutesAgo(200), lastAlertAt: minutesAgo(30) });
  const mail = fakeResend();
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.stale, true, "still stale — just not mailed again");
  assert.equal(r.email, "suppressed-cooldown");
  assert.equal(mail.sent.length, 0);
}));

test("an unreachable database reports stale rather than passing silently", withCredentials(async () => {
  // If we cannot even read when the last poll was, something is wrong; reporting
  // healthy would be the worst possible answer.
  const db = fakeDatabase({ lastRunAt: minutesAgo(10), failReads: true });
  const mail = fakeResend();
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.stale, true);
  assert.match(r.reason, /^db-error/);
  assert.equal(r.email, "not-attempted");
}));

test("having never polled sends the never-run alert", withCredentials(async () => {
  const db = fakeDatabase({ lastRunAt: null });
  const mail = fakeResend();
  const r = await checkStaleness({ now: NOW, dbOpts: db.dbOpts, fetchImpl: mail.fetchImpl });

  assert.equal(r.reason, "no-polls-recorded");
  assert.match(mail.sent[0].subject, /has ever run/i);
}));
