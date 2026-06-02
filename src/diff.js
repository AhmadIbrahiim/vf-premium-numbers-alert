/**
 * @typedef {{ first_seen: string, last_seen: string, score: number, tags: string[], best_grade: number, status: "available"|"gone" }} HistoryEntry
 */

/**
 * Pure. Compare the current available set against prior history.
 * No I/O, no Date — deterministic for given inputs.
 * @param {object} p
 * @param {string[]} p.current  - available msisdns this run
 * @param {Record<string, HistoryEntry>} [p.history] - prior history map (may be {})
 * @returns {{ isBaseline:boolean, newMsisdns:string[], disappearedMsisdns:string[], suspicious:boolean }}
 *   isBaseline: true when history is empty (first run) -> caller suppresses alerts
 *   suspicious: true when current count dropped >50% vs prior available count -> caller skips diff/alerts
 */
export function computeDiff({ current, history } = {}) {
  // Defensive: dedupe current, drop falsy entries, treat missing history as {}.
  const safeHistory = history && typeof history === "object" ? history : {};
  const currentList = Array.isArray(current) ? current : [];
  const currentSet = new Set(currentList.filter(Boolean));

  const historyKeys = Object.keys(safeHistory);
  const isBaseline = historyKeys.length === 0;

  // Prior available set = history msisdns whose status === "available".
  const priorAvailable = new Set(
    historyKeys.filter((msisdn) => safeHistory[msisdn]?.status === "available"),
  );
  const priorAvailableCount = priorAvailable.size;

  // On baseline there is nothing to be "new" against — everything is just the seed.
  const newMsisdns = isBaseline
    ? []
    : [...currentSet].filter((msisdn) => !priorAvailable.has(msisdn));

  const disappearedMsisdns = [...priorAvailable].filter(
    (msisdn) => !currentSet.has(msisdn),
  );

  // Suspicious: not baseline, had prior availability, and current dropped >50%.
  const suspicious =
    !isBaseline &&
    priorAvailableCount > 0 &&
    currentSet.size < priorAvailableCount * 0.5;

  return { isBaseline, newMsisdns, disappearedMsisdns, suspicious };
}
