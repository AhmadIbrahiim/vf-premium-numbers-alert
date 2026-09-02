import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHANGE_LIST_LIMIT } from "./config.js";

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
 * Load persisted state from the data directory. Only the change-event log lives here
 * now — number state is in Postgres (src/db.js).
 * @returns {Promise<{ events: any[] }>}
 */
export async function readState(dir) {
  const events = await readJson(join(dir, "events.jsonl.json"), []);
  return { events: Array.isArray(events) ? events : [] };
}

/**
 * Build the dashboard-facing latest.json payload from rows already ranked by Postgres.
 *
 * @param {object} p
 * @param {string} p.generatedAt
 * @param {number} p.total                 numbers the carriers reported
 * @param {{available_total:number, by_carrier:Record<string,number>}} p.counts
 * @param {Array<{msisdn:string,grade:number,reason:string,score?:number,tags?:string[]}>} p.bestThirty
 * @param {Array<object>} p.publishRows    from db.readPublishRows (already shaped + ranked)
 * @param {{newMsisdns:string[],disappearedMsisdns:string[],newSet:Set<string>}} p.diff
 * @param {string} p.today
 * @returns {object}
 */
export function buildLatest({ generatedAt, total, counts, bestThirty = [], publishRows = [], diff, today, changeListLimit = CHANGE_LIST_LIMIT }) {
  const byMsisdn = new Map(publishRows.map((r) => [r.msisdn, r]));

  const best_thirty = bestThirty.map((c) => {
    const r = byMsisdn.get(c.msisdn) || {};
    return {
      msisdn: c.msisdn,
      score: c.score ?? r.score ?? 0,
      grade: c.grade,
      reason: c.reason,
      tags: c.tags || r.tags || [],
      sim_type: r.sim_type || "",
      carrier: r.carrier || "",
      tier: r.tier || "",
      is_new: diff.newSet.has(c.msisdn),
      first_seen: r.first_seen || today,
      age_days: r.age_days ?? 0,
    };
  });

  const gradedSet = new Set(best_thirty.map((c) => c.msisdn));
  const all_available = publishRows
    .filter((r) => !gradedSet.has(r.msisdn))
    .map((r) => ({
      msisdn: r.msisdn,
      score: r.score,
      tags: r.tags || [],
      sim_type: r.sim_type || "",
      carrier: r.carrier || "",
      tier: r.tier || "",
      is_new: diff.newSet.has(r.msisdn),
      first_seen: r.first_seen || today,
      age_days: r.age_days ?? 0,
    }));

  return {
    generated_at: generatedAt,
    total,
    available_total: counts?.available_total ?? 0,
    by_carrier: counts?.by_carrier ?? {},
    published_count: best_thirty.length + all_available.length,
    new_count: diff.newMsisdns.length,
    disappeared_count: diff.disappearedMsisdns.length,
    new_msisdns: diff.newMsisdns.slice(0, changeListLimit),
    disappeared_msisdns: diff.disappearedMsisdns.slice(0, changeListLimit),
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
 * PLUS the best new numbers not already in that top set (so a fresh arrival is
 * never skipped from grading even if it scores low). Deduped, all currently
 * available. The extras are themselves capped at `count`, because a re-baseline
 * can make tens of thousands of numbers "new" at once and the whole set goes
 * into one LLM prompt.
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
  const extras = newMsisdns
    .filter((m) => availSet.has(m) && !inTop.has(m))
    .map(pick)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
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

/** Write the published dashboard data files to `dir` (creating it if needed). */
export async function writeState(dir, { latest, events, bestEver = [], searchIndex = [] }) {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "latest.json"), JSON.stringify(latest)),
    writeFile(join(dir, "best-ever.json"), JSON.stringify(bestEver)),
    // Fixed-width "<msisdn><carrier initial><score, 3 digits>" records so the dashboard
    // can search every available number (~160k) for ~2.5MB instead of ~25MB of objects.
    writeFile(join(dir, "index.json"), JSON.stringify(searchIndex)),
    writeFile(join(dir, "events.jsonl.json"), JSON.stringify(events)),
  ]);
}
