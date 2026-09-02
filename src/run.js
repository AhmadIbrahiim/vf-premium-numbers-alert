import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { fetchAll } from "./fetch.js";
import { scoreMsisdn } from "./score.js";
import { computeDiff } from "./diff.js";
import { gradeCandidates } from "./grade.js";
import {
  readState, buildLatest, appendEvents, writeState,
  buildCandidates, candidateSignature, gradeCacheValid, readGrades, writeGrades,
} from "./store.js";
import * as db from "./db.js";
import { notify } from "./notify.js";
import { sendPremiumEmail } from "./email.js";
import {
  DATA_DIR, MODEL, GITHUB_TOKEN, REPO,
  CANDIDATE_COUNT, BEST_COUNT, ALERT_THRESHOLD,
  PUBLISH_PER_CARRIER, BEST_EVER_PER_CARRIER, HISTORY_KEEP_DAYS, CARRIER_SHRINK_TOLERANCE,
  todayInTz, tierBonus,
} from "./config.js";

/** Stable signature of the *meaningful* state, so we only commit on real change. */
function signature(available, bestThirty, tierMap = new Map()) {
  const payload = {
    a: [...available].sort(),
    b: bestThirty.map((c) => `${c.msisdn}:${c.grade}`),
    // Include carrier tier/grade so a metadata-only change (e.g. a WE number re-graded)
    // still flips the signature and triggers a commit.
    t: [...available].sort().map((m) => `${m}:${tierMap.get(m) || ""}`),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function emitOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }
}

export async function run({ fetchImpl, dbFetch } = {}) {
  // Tests inject `dbFetch` to stand in for Neon's SQL-over-HTTP endpoint.
  const dbOpts = dbFetch ? { fetchImpl: dbFetch } : {};
  const today = todayInTz();
  const generatedAt = new Date().toISOString();
  // Monotonic marker for this run: every row we upsert carries it, so the rows left
  // holding an older one are exactly the numbers that disappeared.
  const runSeq = Date.now();

  if (!db.hasDb()) {
    await summary("⚠️ DATABASE_URL is not set — refusing to run (number state lives in Postgres).");
    await emitOutput("changed", "false");
    return { skipped: "no-database" };
  }
  await db.migrate(dbOpts);

  // 1. fetch (skip the run on failure — never overwrite good data)
  let catalog;
  try {
    catalog = await fetchAll({ fetchImpl });
  } catch (err) {
    await summary(`⚠️ fetch failed, skipping run: ${err.message}`);
    await emitOutput("changed", "false");
    return { skipped: "fetch-failed" };
  }

  const { records, totalElements, returned, ok: okCarriers, failed } = catalog;
  if (failed?.length) {
    // Those carriers keep their existing rows: not refreshed, but not wrongly retired.
    await summary(
      `⚠️ carried over ${failed.map((f) => f.carrier).join(", ")} (fetch failed: ` +
      `${failed.map((f) => f.error).join(" | ")})`
    );
  }
  if (totalElements > returned) {
    await summary(`⚠️ truncation: returned ${returned} < totalElements ${totalElements}. Increase size=.`);
  }

  // 2. score (+ Etisalat tier bonus)
  const scoreMap = new Map();
  const carrierMap = new Map(); // msisdn -> "vodafone" | "etisalat" | "we"
  const tierMap = new Map();    // msisdn -> Etisalat tier slug / WE grade code ("" for Vodafone)
  const rows = [];
  for (const r of records) {
    if (!r.available) continue;
    const base = scoreMsisdn(r.msisdn);
    const tier = r.tier || "";
    const isEtisalat = r.carrier === "etisalat";
    // Only Etisalat's operator tier feeds scoring. WE's `tier` is an opaque grade code:
    // display metadata only — no bonus, no LLM tag (the digit-pattern scorer ranks it).
    const bonus = isEtisalat ? tierBonus(tier) : 0;
    const tags = isEtisalat && tier ? [...base.tags, `etisalat-${tier}`] : base.tags;
    const score = Math.min(100, base.score + bonus);
    scoreMap.set(r.msisdn, { score, tags });
    carrierMap.set(r.msisdn, r.carrier || "vodafone");
    tierMap.set(r.msisdn, tier);
    rows.push({
      msisdn: r.msisdn,
      carrier: r.carrier || "vodafone",
      tier,
      sim_type: r.simType || "",
      score,
      tags,
    });
  }
  const available = rows.map((r) => r.msisdn);

  // 3. Per-carrier sanity gate before anything is retired. A carrier that comes back
  // far smaller than what Postgres holds was throttled or truncated mid-enumeration,
  // not emptied — keep refreshing its numbers but do not let it retire any.
  const priorCounts = (await db.readCounts(dbOpts)).by_carrier;
  const fetchedCounts = {};
  for (const r of rows) fetchedCounts[r.carrier] = (fetchedCounts[r.carrier] || 0) + 1;
  const trustedCarriers = [];
  for (const carrier of okCarriers) {
    const prior = priorCounts[carrier] || 0;
    const now = fetchedCounts[carrier] || 0;
    if (prior > 0 && now < prior * CARRIER_SHRINK_TOLERANCE) {
      await summary(
        `⚠️ ${carrier} came back ${now} vs ${prior} held (below ` +
        `${Math.round(CARRIER_SHRINK_TOLERANCE * 100)}%) — refreshing it but retiring nothing`
      );
      continue;
    }
    trustedCarriers.push(carrier);
  }

  // 4. diff against what Postgres last saw available, scoped to the trusted carriers —
  // otherwise a partial fetch reads as a mass disappearance.
  const priorAvailable = await db.readAvailable(dbOpts, { carriers: trustedCarriers });
  const priorHistory = Object.fromEntries(priorAvailable.map((m) => [m, { status: "available" }]));
  const diff = computeDiff({ current: available, history: priorHistory });

  if (diff.suspicious) {
    await summary(`⚠️ suspicious shrink (now ${available.length}); skipping write/alerts this run.`);
    await emitOutput("changed", "false");
    return { skipped: "suspicious" };
  }

  // 5. persist every number the carriers listed, then flag the ones that vanished
  await db.upsertNumbers({ rows, today, runSeq }, dbOpts);
  await db.markGone({ runSeq, carriers: trustedCarriers }, dbOpts);

  // 6. candidates -> LLM grade -> best thirty
  // Candidates = top-N by deterministic score, plus the best NEW numbers (never skip a
  // fresh arrival). The LLM only runs when this candidate set changed since last
  // run; otherwise we reuse cached grades (saves ~99% of calls on idle runs).
  const candidates = buildCandidates({
    available, scoreMap,
    newMsisdns: diff.isBaseline ? [] : diff.newMsisdns,
    count: CANDIDATE_COUNT,
  });
  const candSig = candidateSignature(candidates);
  // REGRADE=1 forces a fresh LLM evaluation of every candidate, ignoring the grade cache —
  // use it to re-evaluate all numbers after a scorer/prompt change or on demand.
  const forceRegrade = process.env.REGRADE === "1" || process.env.REGRADE === "true";
  const prevGrades = await readGrades(DATA_DIR);
  let graded, regraded;
  if (!forceRegrade && gradeCacheValid(prevGrades, candSig)) {
    graded = prevGrades.graded;
    regraded = false;
  } else {
    graded = await gradeCandidates(candidates, { token: GITHUB_TOKEN, model: MODEL, count: BEST_COUNT });
    await writeGrades(DATA_DIR, { sig: candSig, graded });
    regraded = true;
  }
  // attach tags/score back onto graded entries; drop any no longer available.
  const availableSet = new Set(available);
  const bestThirty = graded
    .filter((g) => availableSet.has(g.msisdn))
    .map((g) => ({ ...(scoreMap.get(g.msisdn) || {}), ...g }));
  const gradeMap = new Map(bestThirty.map((c) => [c.msisdn, c.grade]));
  await db.applyGrades({ grades: gradeMap }, dbOpts);

  // 7. publish: Postgres does the ranking, we just write the JSON the dashboard reads
  const pruned = await db.pruneGone({ keepDays: HISTORY_KEEP_DAYS, today }, dbOpts);
  const [counts, publishRows, bestEver, searchIndex] = await Promise.all([
    db.readCounts(dbOpts),
    db.readPublishRows({ perCarrier: PUBLISH_PER_CARRIER, today }, dbOpts),
    db.readBestEverRows({ perCarrier: BEST_EVER_PER_CARRIER, today }, dbOpts),
    db.readSearchIndex(dbOpts),
  ]);

  const { events } = await readState(DATA_DIR);
  const diffWithSet = { ...diff, newSet: new Set(diff.isBaseline ? [] : diff.newMsisdns) };
  const latest = buildLatest({
    generatedAt, total: totalElements, counts, bestThirty, publishRows, diff: diffWithSet, today,
  });
  const nextEvents = appendEvents(events, { today, generatedAt, diff: diffWithSet });
  await writeState(DATA_DIR, { latest, events: nextEvents, bestEver, searchIndex });

  // 8. alerts: NEW numbers scoring at/above the threshold (suppressed on baseline).
  // Drawn from the diff rather than best_thirty — a strong new arrival that the LLM
  // did not happen to rank in its top 30 is still worth an alert.
  // Read at call time so an env change takes effect without a fresh module import.
  const alertThreshold = Number(process.env.ALERT_THRESHOLD || ALERT_THRESHOLD);
  const gradeOf = (m) => Math.max(gradeMap.get(m) ?? 0, scoreMap.get(m)?.score ?? 0);
  const newPremium = diff.isBaseline
    ? []
    : diff.newMsisdns
        .filter((m) => gradeOf(m) >= alertThreshold)
        .map((m) => ({
          msisdn: m,
          score: scoreMap.get(m)?.score ?? 0,
          tags: scoreMap.get(m)?.tags ?? [],
          grade: gradeOf(m),
          reason: bestThirty.find((c) => c.msisdn === m)?.reason || "",
          carrier: carrierMap.get(m) || "",
          tier: tierMap.get(m) || "",
          sim_type: "",
          is_new: true,
        }))
        .sort((a, b) => b.grade - a.grade);

  const dashboardUrl = REPO ? `https://${REPO.split("/")[0]}.github.io/${REPO.split("/")[1]}/` : "";
  const [notifyResult, emailResult] = await Promise.all([
    notify(newPremium, { token: GITHUB_TOKEN, repo: REPO }),
    sendPremiumEmail(newPremium, { dashboardUrl, threshold: alertThreshold }),
  ]);

  // 9. change detection for commit gating
  const sig = signature(available, bestThirty, tierMap);
  let prevSig = "";
  try { prevSig = (await readFile(join(DATA_DIR, "signature.txt"), "utf8")).trim(); } catch {}
  const changed = sig !== prevSig;
  await writeFile(join(DATA_DIR, "signature.txt"), sig);
  await emitOutput("changed", String(changed));

  await summary(
    `✅ run ok | total=${totalElements} available=${available.length} published=${latest.published_count} ` +
    `new=${diff.newMsisdns.length} gone=${diff.disappearedMsisdns.length} pruned=${pruned} ` +
    `trusted=${trustedCarriers.join("+") || "none"}` +
    `${failed?.length ? ` failed:${failed.map((f) => f.carrier).join(",")}` : ""} ` +
    `baseline=${diff.isBaseline} llm=${regraded ? "graded" : "cached"} ` +
    `alerts=${newPremium.length} (issue:${notifyResult} email:${emailResult}) changed=${changed}`
  );
  return { changed, diff, newPremium, notifyResult, regraded };
}

// Run when invoked directly (node src/run.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((r) => {
    if (r?.skipped) process.exitCode = 0;
  }).catch((err) => {
    console.error("run.js fatal:", err);
    process.exitCode = 1;
  });
}
