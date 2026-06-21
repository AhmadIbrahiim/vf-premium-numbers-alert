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
 * @param {Map<string,string>} [p.simTypeMap] msisdn -> "ESIM"|"PHYSICAL" (line source)
 * @param {Map<string,string>} [p.carrierMap] msisdn -> carrier
 * @param {Map<string,string>} [p.tierMap] msisdn -> tier
 * @param {string} p.today                YYYY-MM-DD
 * @returns {Record<string,any>}
 */
export function updateHistory({ history, available, scoreMap, gradeMap, simTypeMap = new Map(), carrierMap = new Map(), tierMap = new Map(), today }) {
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
      sim_type: simTypeMap.get(msisdn) || prev?.sim_type || "",
      carrier: carrierMap.get(msisdn) || prev?.carrier || "vodafone",
      tier: tierMap.get(msisdn) || prev?.tier || "",
      status: "available",
    };
  }
  return next;
}

/**
 * Build the dashboard-facing latest.json payload.
 * @returns {object}
 */
export function buildLatest({ total, bestThirty, history, diff, today, generatedAt, available = [], scoreMap = new Map(), simTypeMap = new Map(), carrierMap = new Map(), tierMap = new Map() }) {
  const best_thirty = bestThirty.map((c) => {
    const h = history[c.msisdn] || {};
    return {
      msisdn: c.msisdn,
      score: c.score,
      grade: c.grade,
      reason: c.reason,
      tags: c.tags || h.tags || [],
      sim_type: simTypeMap.get(c.msisdn) || h.sim_type || "",
      carrier: carrierMap.get(c.msisdn) || h.carrier || "vodafone",
      tier: tierMap.get(c.msisdn) || h.tier || "",
      is_new: diff.newSet.has(c.msisdn),
      first_seen: h.first_seen || today,
      age_days: dayDiff(h.first_seen || today, today),
    };
  });

  // All available numbers not already in best_thirty, sorted by heuristic score.
  const gradedSet = new Set(best_thirty.map((c) => c.msisdn));
  const all_available = available
    .filter((msisdn) => !gradedSet.has(msisdn))
    .map((msisdn) => {
      const s = scoreMap.get(msisdn) || { score: 0, tags: [] };
      const h = history[msisdn] || {};
      return {
        msisdn,
        score: s.score,
        tags: s.tags,
        sim_type: simTypeMap.get(msisdn) || h.sim_type || "",
        carrier: carrierMap.get(msisdn) || h.carrier || "vodafone",
        tier: tierMap.get(msisdn) || h.tier || "",
        is_new: diff.newSet.has(msisdn),
        first_seen: h.first_seen || today,
        age_days: dayDiff(h.first_seen || today, today),
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    generated_at: generatedAt,
    total,
    new_count: diff.newMsisdns.length,
    disappeared_count: diff.disappearedMsisdns.length,
    new_msisdns: diff.newMsisdns,
    disappeared_msisdns: diff.disappearedMsisdns,
    best_thirty,
    all_available,
  };
}

/** Append run events, capped to the most recent MAX_EVENTS. */
export function appendEvents(events, { today, generatedAt, diff }) {
  const additions = [];
  for (const m of diff.newMsisdns) additions.push({ ts: generatedAt, day: today, type: "new", msisdn: m });
  for (const m of diff.disappearedMsisdns) additions.push({ ts: generatedAt, day: today, type: "gone", msisdn: m });
  return [...events, ...additions].slice(-MAX_EVENTS);
}

/**
 * Pure. Build the LLM candidate set: the top `count` by deterministic score,
 * PLUS any new numbers not already in that top set (so a new arrival is never
 * skipped from grading even if it scores low). Deduped, all currently available.
 *
 * @param {object} p
 * @param {string[]} p.available           available msisdns this run
 * @param {Map<string,{score:number,tags:string[]}>} p.scoreMap
 * @param {string[]} [p.newMsisdns]        new-this-run msisdns (always included)
 * @param {number} p.count                 size of the top-by-score slice
 * @returns {Array<{msisdn:string, score:number, tags:string[]}>}
 */
export function buildCandidates({ available, scoreMap, newMsisdns = [], count }) {
  const availSet = new Set(available);
  const pick = (m) => ({ msisdn: m, ...(scoreMap.get(m) || { score: 0, tags: [] }) });
  const top = available
    .map(pick)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
  const inTop = new Set(top.map((c) => c.msisdn));
  const extras = newMsisdns.filter((m) => availSet.has(m) && !inTop.has(m)).map(pick);
  return [...top, ...extras];
}

/** A stable signature of a candidate set: its msisdns, order-independent. */
export function candidateSignature(candidates) {
  return candidates
    .map((c) => c.msisdn)
    .sort()
    .join(",");
}

/**
 * Whether cached LLM grades can be reused: same candidate signature and a
 * non-empty cached result. Lets idle runs skip the LLM call entirely.
 */
export function gradeCacheValid(prev, sig) {
  return Boolean(prev && prev.sig === sig && Array.isArray(prev.graded) && prev.graded.length);
}

/** Read the cached grades blob ({ sig, graded }) or null. */
export async function readGrades(dir) {
  return readJson(join(dir, "grades.json"), null);
}

/** Persist the cached grades blob. */
export async function writeGrades(dir, blob) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "grades.json"), JSON.stringify(blob));
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
