import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { fetchAll } from "./fetch.js";
import { scoreMsisdn } from "./score.js";
import { computeDiff } from "./diff.js";
import { gradeCandidates } from "./grade.js";
import {
  readState, updateHistory, buildLatest, appendEvents, writeState,
  buildCandidates, candidateSignature, gradeCacheValid, readGrades, writeGrades,
} from "./store.js";
import { notify } from "./notify.js";
import {
  DATA_DIR, MODEL, GITHUB_TOKEN, REPO,
  CANDIDATE_COUNT, BEST_COUNT, ALERT_THRESHOLD,
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

export async function run({ fetchImpl } = {}) {
  const today = todayInTz();
  const generatedAt = new Date().toISOString();

  // 1. fetch (skip the run on failure — never overwrite good data)
  let catalog;
  try {
    catalog = await fetchAll({ fetchImpl });
  } catch (err) {
    await summary(`⚠️ fetch failed, skipping run: ${err.message}`);
    await emitOutput("changed", "false");
    return { skipped: "fetch-failed" };
  }

  const { records, totalElements, returned } = catalog;
  if (totalElements > returned) {
    await summary(`⚠️ truncation: returned ${returned} < totalElements ${totalElements}. Increase size=.`);
  }

  // 2. score (+ Etisalat tier bonus) + available set
  const scoreMap = new Map();
  const simTypeMap = new Map(); // msisdn -> "ESIM" | "PHYSICAL" (Vodafone line source)
  const carrierMap = new Map(); // msisdn -> "vodafone" | "etisalat" | "we"
  const tierMap = new Map();    // msisdn -> Etisalat tier slug / WE grade code ("" for Vodafone)
  for (const r of records) {
    const base = scoreMsisdn(r.msisdn);
    const tier = r.tier || "";
    const isEtisalat = r.carrier === "etisalat";
    // Only Etisalat's operator tier feeds scoring. WE's `tier` is an opaque grade code:
    // display metadata only — no bonus, no LLM tag (the digit-pattern scorer ranks it).
    const bonus = isEtisalat ? tierBonus(tier) : 0;
    const tags = isEtisalat && tier ? [...base.tags, `etisalat-${tier}`] : base.tags;
    scoreMap.set(r.msisdn, { score: Math.min(100, base.score + bonus), tags });
    simTypeMap.set(r.msisdn, r.simType);
    carrierMap.set(r.msisdn, r.carrier || "vodafone");
    tierMap.set(r.msisdn, tier);
  }
  const available = records.filter((r) => r.available).map((r) => r.msisdn);

  // 3. read prior state + diff
  const { history, events } = await readState(DATA_DIR);
  const diff = computeDiff({ current: available, history });

  if (diff.suspicious) {
    await summary(`⚠️ suspicious shrink (now ${available.length}); skipping write/alerts this run.`);
    await emitOutput("changed", "false");
    return { skipped: "suspicious" };
  }

  // 4. candidates -> LLM grade -> best thirty
  // Candidates = top-N by deterministic score, plus all NEW numbers (never skip a
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

  // 5. persist
  const nextHistory = updateHistory({ history, available, scoreMap, gradeMap, simTypeMap, carrierMap, tierMap, today });
  const diffWithSet = { ...diff, newSet: new Set(diff.isBaseline ? [] : diff.newMsisdns) };
  const latest = buildLatest({
    total: totalElements, bestThirty, history: nextHistory, diff: diffWithSet, today, generatedAt,
    available, scoreMap, simTypeMap, carrierMap, tierMap,
  });
  const nextEvents = appendEvents(events, { today, generatedAt, diff: diffWithSet });
  await writeState(DATA_DIR, { history: nextHistory, latest, events: nextEvents });

  // 6. alerts: NEW numbers that are highly graded (suppressed on baseline)
  const newPremium = diff.isBaseline
    ? []
    : latest.best_thirty.filter((c) => c.is_new && c.grade >= ALERT_THRESHOLD);
  const notifyResult = await notify(newPremium, { token: GITHUB_TOKEN, repo: REPO });

  // 7. change detection for commit gating
  const sig = signature(available, bestThirty, tierMap);
  let prevSig = "";
  try { prevSig = (await readFile(join(DATA_DIR, "signature.txt"), "utf8")).trim(); } catch {}
  const changed = sig !== prevSig;
  await writeFile(join(DATA_DIR, "signature.txt"), sig);
  await emitOutput("changed", String(changed));

  await summary(
    `✅ run ok | total=${totalElements} available=${available.length} ` +
    `new=${diff.newMsisdns.length} gone=${diff.disappearedMsisdns.length} ` +
    `baseline=${diff.isBaseline} llm=${regraded ? "graded" : "cached"} ` +
    `alerts=${newPremium.length} (${notifyResult}) changed=${changed}`
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
