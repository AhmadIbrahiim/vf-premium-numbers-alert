/**
 * stale.js — the dead-man's switch for the poller.
 *
 * The poller not running is invisible: the dashboard keeps serving the last numbers it
 * collected, every page still works, and nothing anywhere says the data stopped moving.
 * That is not hypothetical — the GitLab pipeline schedule was never created, so for the
 * project's whole life `poll` only ever ran when somebody triggered it by hand, and the
 * only way to notice was to go read timestamps.
 *
 * **This must not run inside the poll job.** A check that ships with the thing it
 * watches reports nothing when that thing is dead, which is the one case that matters.
 * It runs from its own GitLab schedule (see .gitlab-ci.yml) so a missing, broken, or
 * disabled poll schedule is exactly what it can still catch.
 *
 * Thresholds are read from the environment at call time, never captured at import —
 * see the configuration note in CLAUDE.md.
 */

import { readMeta, writeMeta, readProviderStatus } from "./db.js";
import { sendViaResend } from "./email.js";

/** `meta` key holding the last time we alerted, so an outage does not mail hourly. */
const ALERT_STATE_KEY = "stale_alert";

/**
 * Two missed polls at the 30-minute cadence, which also matches the 90-minute mark the
 * status page already calls "Stale". A single skipped poll is not worth an email: a
 * carrier can be slow and `resource_group: poll` will delay rather than overlap.
 */
export const DEFAULT_STALE_AFTER_MINUTES = 90;

/** While the poller is down, mail at most this often. Alert fatigue defeats alerting. */
export const DEFAULT_COOLDOWN_MINUTES = 360;

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export function staleAfterMinutes() {
  return intFromEnv("STALE_AFTER_MINUTES", DEFAULT_STALE_AFTER_MINUTES);
}

export function cooldownMinutes() {
  return intFromEnv("STALE_ALERT_COOLDOWN_MINUTES", DEFAULT_COOLDOWN_MINUTES);
}

/**
 * How stale is the newest poll? Pure, so the interesting cases are testable without a
 * database or a clock.
 *
 * @param {object} p
 * @param {string|Date|null} p.lastRunAt newest `provider_runs.run_at`, or null if none
 * @param {number} p.now                 epoch ms
 * @param {number} p.maxAgeMinutes
 * @returns {{ stale: boolean, ageMinutes: number|null, reason: string }}
 */
export function staleness({ lastRunAt, now, maxAgeMinutes }) {
  if (!lastRunAt) {
    // No poll has ever landed. Stale by definition — this is the state a brand new
    // deployment is in, and also the state a wiped database is in.
    return { stale: true, ageMinutes: null, reason: "no-polls-recorded" };
  }
  const t = lastRunAt instanceof Date ? lastRunAt.getTime() : Date.parse(lastRunAt);
  if (Number.isNaN(t)) return { stale: true, ageMinutes: null, reason: "unreadable-timestamp" };

  const ageMinutes = Math.round((now - t) / 60000);
  if (ageMinutes < 0) {
    // A run timestamped in the future means clock skew between the runner and the
    // database. Not stale, but say so rather than silently reporting a negative age.
    return { stale: false, ageMinutes, reason: "clock-skew" };
  }
  return {
    stale: ageMinutes > maxAgeMinutes,
    ageMinutes,
    reason: ageMinutes > maxAgeMinutes ? "no-recent-poll" : "fresh",
  };
}

/**
 * Should this staleness alert actually be mailed, or has one gone out recently?
 *
 * @returns {boolean}
 */
export function shouldAlert({ stale, lastAlertAt, now, cooldown }) {
  if (!stale) return false;
  if (!lastAlertAt) return true;
  const t = lastAlertAt instanceof Date ? lastAlertAt.getTime() : Date.parse(lastAlertAt);
  // An unreadable or future-dated marker must not suppress the alert — failing open is
  // the right direction for something whose whole job is to tell you about an outage.
  if (Number.isNaN(t)) return true;
  const sinceMinutes = (now - t) / 60000;
  if (sinceMinutes < 0) return true;
  return sinceMinutes >= cooldown;
}

/** "1 hr 40 min", "45 min" — for a subject line, so it reads in a notification. */
export function formatAge(minutes) {
  if (minutes == null) return "never";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Build the staleness email. It names the likeliest cause first, because the failure
 * that actually happened here was a missing pipeline schedule and that is not a thing
 * anyone guesses at 7am.
 */
export function buildStaleEmail({ ageMinutes, lastRunAt, maxAgeMinutes, reason, dashboardUrl = "" }) {
  const never = reason === "no-polls-recorded";
  const subject = never
    ? "Egypt Premium Numbers: no poll has ever run"
    : `Egypt Premium Numbers: no poll in ${formatAge(ageMinutes)}`;

  const lastLine = never
    ? "No poll has ever been recorded."
    : `Last successful poll: ${new Date(lastRunAt).toISOString()} (${formatAge(ageMinutes)} ago).`;

  const causes = [
    "The GitLab pipeline schedule is missing, disabled, or pointed at the wrong branch (Settings -> CI/CD -> Schedules; cron 7,37 * * * *, target main).",
    "The poll job is failing — check the most recent scheduled pipeline.",
    "DATABASE_URL expired or was rotated, so runs cannot be recorded.",
  ];

  const text = [
    lastLine,
    `Alerting because nothing has landed for more than ${maxAgeMinutes} minutes.`,
    "",
    "Most likely causes, in order:",
    ...causes.map((c, i) => `${i + 1}. ${c}`),
    "",
    "The dashboard keeps serving the last numbers it collected, so it looks healthy while this is happening.",
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
  ].filter(Boolean).join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;background:#fef2f2">
      <h1 style="margin:0;font-size:18px;color:#b91c1c">${esc(subject.replace("Egypt Premium Numbers: ", ""))}</h1>
      <p style="margin:6px 0 0;color:#6b7280;font-size:13px">${esc(lastLine)}</p>
    </div>
    <div style="padding:18px 24px;font-size:14px;line-height:1.6">
      <p style="margin:0 0 12px">Alerting because nothing has landed for more than ${esc(maxAgeMinutes)} minutes.</p>
      <p style="margin:0 0 6px;font-weight:600">Most likely causes, in order:</p>
      <ol style="margin:0;padding-left:20px;color:#374151">
        ${causes.map((c) => `<li style="margin-bottom:6px">${esc(c)}</li>`).join("")}
      </ol>
      <p style="margin:14px 0 0;color:#6b7280;font-size:13px">
        The dashboard keeps serving the last numbers it collected, so it looks healthy while this is happening.
      </p>
    </div>
    ${dashboardUrl ? `<div style="padding:18px 24px;border-top:1px solid #e5e7eb"><a href="${esc(dashboardUrl)}" style="color:#0b5fff;font-weight:600;text-decoration:none">Open the dashboard &rarr;</a></div>` : ""}
  </div>
</body></html>`;

  return { subject, text, html };
}

/**
 * Read the newest poll time, decide whether to alert, and mail if so.
 *
 * Never throws: a monitoring path that crashes is worse than one that reports a
 * problem, because a crash in CI reads as "the check is broken" rather than "the
 * poller is down".
 *
 * @param {object} opts - { now, maxAgeMinutes, cooldown, dashboardUrl, fetchImpl, dbOpts }
 * @returns {Promise<{ stale: boolean, ageMinutes: number|null, reason: string, email: string }>}
 */
export async function checkStaleness(opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMinutes = opts.maxAgeMinutes ?? staleAfterMinutes();
  const cooldown = opts.cooldown ?? cooldownMinutes();
  const dbOpts = opts.dbOpts ?? {};

  let lastRunAt = null;
  try {
    // Reuse the status reader rather than writing fresh SQL: the newest run per carrier
    // is already exactly what it returns.
    const rows = await readProviderStatus({ window: 1 }, dbOpts);
    for (const r of rows) {
      const t = Date.parse(r.last_run_at);
      if (!Number.isNaN(t) && (lastRunAt === null || t > lastRunAt)) lastRunAt = t;
    }
  } catch (err) {
    return { stale: true, ageMinutes: null, reason: `db-error: ${err?.message || err}`, email: "not-attempted" };
  }

  const state = staleness({
    lastRunAt: lastRunAt === null ? null : new Date(lastRunAt),
    now,
    maxAgeMinutes,
  });

  if (!state.stale) return { ...state, email: "not-needed" };

  let lastAlertAt = null;
  try {
    const stored = await readMeta(ALERT_STATE_KEY, dbOpts);
    lastAlertAt = stored?.lastAlertAt ?? null;
  } catch {
    // Can't read the cooldown marker: alert anyway rather than stay silent.
  }

  if (!shouldAlert({ stale: true, lastAlertAt, now, cooldown })) {
    return { ...state, email: "suppressed-cooldown" };
  }

  const message = buildStaleEmail({
    ageMinutes: state.ageMinutes,
    lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
    maxAgeMinutes,
    reason: state.reason,
    dashboardUrl: opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? "",
  });

  const email = await sendViaResend(message, { fetchImpl: opts.fetchImpl });

  // Only start the cooldown once a message actually went out, or a failed send would
  // buy six hours of silence.
  if (email.startsWith("emailed")) {
    try {
      await writeMeta(ALERT_STATE_KEY, { lastAlertAt: new Date(now).toISOString() }, dbOpts);
    } catch {
      // A missed marker means one extra email later. Harmless.
    }
  }

  return { ...state, email };
}
