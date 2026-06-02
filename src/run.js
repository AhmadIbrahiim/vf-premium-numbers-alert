import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { fetchCatalog } from "./fetch.js";
import { scoreMsisdn } from "./score.js";
import { computeDiff } from "./diff.js";
import { gradeCandidates } from "./grade.js";
import { readState, updateHistory, buildLatest, appendEvents, writeState } from "./store.js";
import { notify } from "./notify.js";
import {
  DATA_DIR, MODEL, GITHUB_TOKEN, REPO,
  CANDIDATE_COUNT, BEST_COUNT, ALERT_THRESHOLD,
  todayInTz,
} from "./config.js";

/** Stable signature of the *meaningful* state, so we only commit on real change. */
function signature(available, bestThirty) {
  const payload = {
    a: [...available].sort(),
    b: bestThirty.map((c) => `${c.msisdn}:${c.grade}`),
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
    catalog = await fetchCatalog({ fetchImpl });
  } catch (err) {
    await summary(`⚠️ fetch failed, skipping run: ${err.message}`);
    await emitOutput("changed", "false");
    return { skipped: "fetch-failed" };
  }

  const { records, totalElements, returned } = catalog;
  if (totalElements > returned) {
    await summary(`⚠️ truncation: returned ${returned} < totalElements ${totalElements}. Increase size=.`);
  }

  // 2. score + available set
  const scoreMap = new Map();
  for (const r of records) scoreMap.set(r.msisdn, scoreMsisdn(r.msisdn));
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
  const candidates = [...available]
    .map((m) => ({ msisdn: m, ...scoreMap.get(m) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_COUNT);
  const graded = await gradeCandidates(candidates, {
    token: GITHUB_TOKEN, model: MODEL, count: BEST_COUNT,
  });
  // attach tags/score back onto graded entries for the dashboard
  const bestThirty = graded.map((g) => ({ ...scoreMap.get(g.msisdn), ...g }));
  const gradeMap = new Map(bestThirty.map((c) => [c.msisdn, c.grade]));

  // 5. persist
  const nextHistory = updateHistory({ history, available, scoreMap, gradeMap, today });
  const diffWithSet = { ...diff, newSet: new Set(diff.isBaseline ? [] : diff.newMsisdns) };
  const latest = buildLatest({
    total: totalElements, bestThirty, history: nextHistory, diff: diffWithSet, today, generatedAt,
  });
  const nextEvents = appendEvents(events, { today, generatedAt, diff: diffWithSet });
  await writeState(DATA_DIR, { history: nextHistory, latest, events: nextEvents });

  // 6. alerts: NEW numbers that are highly graded (suppressed on baseline)
  const newPremium = diff.isBaseline
    ? []
    : latest.best_thirty.filter((c) => c.is_new && c.grade >= ALERT_THRESHOLD);
  const notifyResult = await notify(newPremium, { token: GITHUB_TOKEN, repo: REPO });

  // 7. change detection for commit gating
  const sig = signature(available, bestThirty);
  let prevSig = "";
  try { prevSig = (await readFile(join(DATA_DIR, "signature.txt"), "utf8")).trim(); } catch {}
  const changed = sig !== prevSig;
  await writeFile(join(DATA_DIR, "signature.txt"), sig);
  await emitOutput("changed", String(changed));

  await summary(
    `✅ run ok | total=${totalElements} available=${available.length} ` +
    `new=${diff.newMsisdns.length} gone=${diff.disappearedMsisdns.length} ` +
    `baseline=${diff.isBaseline} alerts=${newPremium.length} (${notifyResult}) changed=${changed}`
  );
  return { changed, diff, newPremium, notifyResult };
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
