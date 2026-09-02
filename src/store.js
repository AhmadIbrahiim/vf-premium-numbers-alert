/**
 * store.js — the pure, testable pieces of the pipeline that are not database access.
 *
 * Everything stateful now lives in Postgres (src/db.js): numbers, the LLM grade cache,
 * change events and the run signature. Nothing is written to disk, and the dashboard
 * reads the database live through the Worker API rather than published JSON, so there
 * are no snapshot files left to build.
 */

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
