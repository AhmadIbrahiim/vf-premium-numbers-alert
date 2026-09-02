/**
 * email.js — premium-number alerts over Resend.
 *
 * Best-effort, like src/notify.js: a mail failure must never fail a poll or lose data,
 * so everything here returns a status string instead of throwing. Zero dependencies —
 * Resend is a plain JSON POST.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function formatMsisdn(m) {
  return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
}

function carrierLabel(carrier) {
  if (carrier === "etisalat") return "Etisalat";
  if (carrier === "we") return "WE";
  if (carrier === "vodafone") return "Vodafone";
  return "—";
}

const TIER_LABEL = {
  silver: "Silver",
  golden: "Golden",
  golden_plus: "Golden+",
  platinum: "Platinum",
  platinum_plus: "Platinum+",
};

/** Human label for a carrier's own tier/grade marker, if it has one. */
function tierLabel(row) {
  if (!row.tier) return "";
  if (TIER_LABEL[row.tier]) return TIER_LABEL[row.tier];
  const m = /^GRADE_0*(\d+)$/.exec(row.tier);
  return m ? `Grade ${m[1]}` : row.tier;
}

/** Escape for interpolation into the HTML body. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** The best score among the alerted rows. */
export function topScore(rows) {
  return rows.reduce((m, r) => Math.max(m, r.grade ?? r.score ?? 0), 0);
}

/** Subject line: leads with the count and the best score, so it reads in a notification. */
export function buildSubject(rows) {
  const best = topScore(rows);
  if (rows.length === 1) {
    return `New premium number: ${formatMsisdn(rows[0].msisdn)} (score ${best})`;
  }
  return `${rows.length} new premium numbers (best score ${best})`;
}

/**
 * Build the alert email. Plain text carries the same information as the HTML, since
 * that is what a phone's notification preview and any text-only client will show.
 *
 * @param {object} p
 * @param {Array<object>} p.rows        alerted numbers (msisdn, score, grade, tags, carrier, tier, reason)
 * @param {string} [p.dashboardUrl]
 * @param {number} [p.threshold]        the score that triggered the alert
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildEmail({ rows, dashboardUrl = "", threshold }) {
  const line = (r) => {
    const bits = [
      formatMsisdn(r.msisdn),
      `score ${r.grade ?? r.score ?? 0}`,
      carrierLabel(r.carrier),
      tierLabel(r),
      r.reason || (r.tags || []).filter(Boolean).join(", "),
    ].filter(Boolean);
    return bits.join(" · ");
  };

  const text = [
    rows.length === 1
      ? "A new premium number just appeared:"
      : `${rows.length} new premium numbers just appeared:`,
    "",
    ...rows.map((r, i) => `${i + 1}. ${line(r)}`),
    "",
    threshold != null ? `Alerting on score >= ${threshold}.` : "",
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
  ].filter(Boolean).join("\n");

  const rowsHtml = rows.map((r) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;font-weight:700;white-space:nowrap">${esc(formatMsisdn(r.msisdn))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;text-align:center">${esc(r.grade ?? r.score ?? 0)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${esc(carrierLabel(r.carrier))}${r.tier ? ` · ${esc(tierLabel(r))}` : ""}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#4b5563;font-size:13px">${esc(r.reason || (r.tags || []).filter(Boolean).join(", "))}</td>
      </tr>`).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb">
      <h1 style="margin:0;font-size:18px">${rows.length === 1 ? "A new premium number just appeared" : `${rows.length} new premium numbers just appeared`}</h1>
      ${threshold != null ? `<p style="margin:6px 0 0;color:#6b7280;font-size:13px">Alerting on score &ge; ${esc(threshold)}.</p>` : ""}
    </div>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="text-align:left;color:#6b7280;font-size:12px;text-transform:uppercase">
          <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb">Number</th>
          <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:center">Score</th>
          <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb">Carrier</th>
          <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb">Why</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}
      </tbody>
    </table>
    ${dashboardUrl ? `<div style="padding:18px 24px;border-top:1px solid #e5e7eb"><a href="${esc(dashboardUrl)}" style="color:#0b5fff;font-weight:600;text-decoration:none">Open the dashboard &rarr;</a></div>` : ""}
  </div>
</body></html>`;

  return { subject: buildSubject(rows), text, html };
}

/**
 * Default sender. Resend's shared `onboarding@resend.dev` only delivers to the Resend
 * account owner's own address; anywhere else needs a domain verified at
 * resend.com/domains and a `from` on that domain.
 */
const DEFAULT_FROM = "VF Premium Numbers <onboarding@resend.dev>";

/**
 * Email the alerted numbers via Resend. Never throws.
 *
 * Credentials are read from the environment at call time (not captured at import), so
 * the value in effect when the poll runs is the one used.
 *
 * @param {Array<object>} rows - alerted numbers; no mail is sent when empty
 * @param {object} opts - { apiKey, to, from, dashboardUrl, threshold, fetchImpl }
 * @returns {Promise<string>} status string for the run summary
 */
export async function sendPremiumEmail(rows, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY ?? "";
  const to = opts.to ?? process.env.ALERT_EMAIL_TO ?? "";
  const from = opts.from ?? process.env.ALERT_EMAIL_FROM ?? DEFAULT_FROM;
  if (!rows || rows.length === 0) return "no-new-premium";
  if (!apiKey || !to) {
    console.warn("[email] RESEND_API_KEY / ALERT_EMAIL_TO not set — skipping email");
    return "skipped-no-credentials";
  }

  const { subject, text, html } = buildEmail({
    rows,
    dashboardUrl: opts.dashboardUrl,
    threshold: opts.threshold,
  });

  try {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      // Resend wants `to` as a string here, not a one-element array.
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      // Surface the reason (unverified domain, bad key) without echoing the API key.
      console.warn(`[email] Resend ${res.status}: ${detail?.message || detail?.name || "unknown error"}`);
      return `send-failed-${res.status}`;
    }
    const body = await res.json().catch(() => null);
    return body?.id ? `emailed-${body.id}` : "emailed";
  } catch (err) {
    console.warn(`[email] error: ${err?.message || err}`);
    return "error";
  }
}
