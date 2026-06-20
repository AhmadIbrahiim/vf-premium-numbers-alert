const api = "https://api.github.com";

/** Tier marker by grade: gold star for the very best, bell otherwise. */
function tierMark(grade) {
  return grade >= 95 ? "⭐" : "🔔";
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function formatMsisdn(m) {
  return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
}

/** Human label for the line source (simType). */
function simLabel(simType) {
  if (simType === "ESIM") return "eSIM";
  if (simType === "PHYSICAL") return "Physical";
  return "—";
}

/** Highest grade among the alerted numbers (drives the tier marker). */
export function topGrade(newPremium) {
  return newPremium.reduce((m, n) => Math.max(m, n.grade ?? 0), 0);
}

/** Tiered issue title: star when a >=95 number is present, bell otherwise. */
export function issueTitle(newPremium) {
  return `${tierMark(topGrade(newPremium))} Premium numbers tracker`;
}

/** Build the markdown body for the alert issue. */
export function buildIssueBody({ newPremium, generatedAt, repo }) {
  const lines = [
    `**${newPremium.length} new premium number(s)** detected at ${generatedAt}.`,
    "",
    "| | # | Number | SIM | Grade | Why |",
    "|---|---|--------|-----|-------|-----|",
  ];
  newPremium.forEach((n, i) => {
    lines.push(`| ${tierMark(n.grade)} | ${i + 1} | \`${formatMsisdn(n.msisdn)}\` | ${simLabel(n.sim_type)} | ${n.grade} | ${n.reason || (n.tags || []).join(", ")} |`);
  });
  if (repo) {
    lines.push("", `Dashboard: https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/`);
  }
  return lines.join("\n");
}

/**
 * Open a new alert issue (or comment on the existing open one) listing new premium numbers.
 * Best-effort: never throws — logs and returns a status string.
 *
 * @param {Array<{msisdn:string,grade:number,reason?:string,tags?:string[]}>} newPremium
 * @param {object} opts - { token, repo, fetchImpl }
 * @returns {Promise<string>}
 */
export async function notify(newPremium, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const token = opts.token;
  const repo = opts.repo;
  if (!newPremium || newPremium.length === 0) return "no-new-premium";
  if (!token || !repo) {
    console.warn("[notify] missing token/repo — skipping issue creation");
    return "skipped-no-credentials";
  }

  const body = buildIssueBody({ newPremium, generatedAt: new Date().toISOString(), repo });

  try {
    // Reuse an existing open tracker issue if present, else create one.
    const searchUrl = `${api}/repos/${repo}/issues?state=open&labels=premium-alert&per_page=1`;
    const existing = await doFetch(searchUrl, { headers: headers(token) });
    const list = existing.ok ? await existing.json() : [];
    if (Array.isArray(list) && list.length > 0) {
      const number = list[0].number;
      const res = await doFetch(`${api}/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ body }),
      });
      return res.ok ? `commented-on-#${number}` : `comment-failed-${res.status}`;
    }
    const res = await doFetch(`${api}/repos/${repo}/issues`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ title: issueTitle(newPremium), body, labels: ["premium-alert"] }),
    });
    if (!res.ok) return `create-failed-${res.status}`;
    const created = await res.json();
    return `opened-#${created.number}`;
  } catch (err) {
    console.warn(`[notify] error: ${err?.message || err}`);
    return "error";
  }
}
