/**
 * check-stale.js — entry point for the staleness check. `npm run check-stale`.
 *
 * Deliberately tiny and deliberately separate from src/run.js: it must be runnable when
 * the poller is not running at all, which is the whole point (see src/stale.js).
 *
 * Costs one query and no carrier requests, so it is safe to schedule often.
 *
 * Exits 1 when stale, so the GitLab job goes red as well as sending mail — two
 * independent signals, and the red pipeline is visible in the UI without opening email.
 */

import { hasDb } from "./db.js";
import { checkStaleness, staleAfterMinutes, formatAge } from "./stale.js";

if (!hasDb()) {
  console.error("DATABASE_URL is not set — cannot check when the last poll ran.");
  process.exit(1);
}

const result = await checkStaleness();
const threshold = staleAfterMinutes();

const age = result.ageMinutes == null ? "never" : `${formatAge(result.ageMinutes)} ago`;
console.log(
  `last poll: ${age} · threshold: ${threshold} min · ${result.reason} · email: ${result.email}`
);

if (result.stale) {
  console.error(`STALE — nothing has polled for longer than ${threshold} minutes.`);
  process.exit(1);
}
console.log("OK — the poller is keeping up.");
