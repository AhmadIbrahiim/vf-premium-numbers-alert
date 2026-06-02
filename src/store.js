import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dayDiff } from "./config.js";

const MAX_EVENTS = 500;

/** Read a JSON file, returning `fallback` if it is missing or unparseable. */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Load persisted state from the data directory.
 * @returns {Promise<{ history: Record<string, any>, events: any[] }>}
 */
export async function readState(dir) {
  const history = await readJson(join(dir, "history.json"), {});
  const events = await readJson(join(dir, "events.jsonl.json"), []);
  return {
    history: history && typeof history === "object" ? history : {},
    events: Array.isArray(events) ? events : [],
  };
}

/**
 * Produce the next history map from the current run.
 * - new/continuing available numbers: status "available", last_seen=today, first_seen preserved
 * - previously-available numbers absent now: status "gone" (kept for first-seen age + best-ever view)
 * - best_grade is the max grade ever observed
 *
 * @param {object} p
 * @param {Record<string,any>} p.history  prior history
 * @param {string[]} p.available          available msisdns this run
 * @param {Map<string,{score:number,tags:string[]}>} p.scoreMap  msisdn -> score/tags
 * @param {Map<string,number>} p.gradeMap msisdn -> grade (from best_thirty), optional
 * @param {string} p.today                YYYY-MM-DD
 * @returns {Record<string,any>}
 */
export function updateHistory({ history, available, scoreMap, gradeMap, today }) {
  const next = {};
  // Carry forward all known numbers, marking absent ones as gone.
  for (const [msisdn, entry] of Object.entries(history)) {
    next[msisdn] = { ...entry, status: "gone" };
  }
  for (const msisdn of available) {
    const prev = history[msisdn];
    const s = scoreMap.get(msisdn) || { score: prev?.score ?? 0, tags: prev?.tags ?? [] };
    const grade = gradeMap.get(msisdn);
    const bestGrade = Math.max(prev?.best_grade ?? 0, grade ?? 0, s.score);
    next[msisdn] = {
      first_seen: prev?.first_seen ?? today,
      last_seen: today,
      score: s.score,
      tags: s.tags,
      best_grade: bestGrade,
      status: "available",
    };
  }
  return next;
}

/**
 * Build the dashboard-facing latest.json payload.
 * @returns {object}
 */
export function buildLatest({ total, bestThirty, history, diff, today, generatedAt }) {
  const best_thirty = bestThirty.map((c) => {
    const h = history[c.msisdn] || {};
    return {
      msisdn: c.msisdn,
      score: c.score,
      grade: c.grade,
      reason: c.reason,
      tags: c.tags || h.tags || [],
      is_new: diff.newSet.has(c.msisdn),
      first_seen: h.first_seen || today,
      age_days: dayDiff(h.first_seen || today, today),
    };
  });
  return {
    generated_at: generatedAt,
    total,
    new_count: diff.newMsisdns.length,
    disappeared_count: diff.disappearedMsisdns.length,
    best_thirty,
  };
}

/** Append run events, capped to the most recent MAX_EVENTS. */
export function appendEvents(events, { today, generatedAt, diff }) {
  const additions = [];
  for (const m of diff.newMsisdns) additions.push({ ts: generatedAt, day: today, type: "new", msisdn: m });
  for (const m of diff.disappearedMsisdns) additions.push({ ts: generatedAt, day: today, type: "gone", msisdn: m });
  return [...events, ...additions].slice(-MAX_EVENTS);
}

/** Write all state + dashboard data files to `dir` (creating it if needed). */
export async function writeState(dir, { history, latest, events }) {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "history.json"), JSON.stringify(history)),
    writeFile(join(dir, "latest.json"), JSON.stringify(latest, null, 2)),
    writeFile(join(dir, "events.jsonl.json"), JSON.stringify(events)),
  ]);
}
