#!/usr/bin/env node
/**
 * calibrate.js — pick ALERT_THRESHOLD from the real catalogue instead of guessing.
 *
 * The current default of 70 was derived from a UNIFORM SYNTHETIC pool, because the
 * database was not reachable when the scorer was reweighted. A synthetic pool is not what
 * the carriers publish — theirs is far more skewed toward low scores — so 70 is an
 * estimate. This scores every number actually in the database and reports what threshold
 * produces which alert volume, so the choice comes from the distribution.
 *
 * It reads and writes nothing: one SELECT, no updates.
 *
 * Usage:  DATABASE_URL=... npm run calibrate
 */

import { scoreMsisdn } from "./score.js";
import * as db from "./db.js";
import { ALERT_THRESHOLD } from "./config.js";

/**
 * Alerts fire on NEW numbers only, so what matters is not how many numbers clear the bar
 * in total but how many would clear it per run. The historical figure to match: with the
 * old scorer and a threshold of 50, ~215 of ~206k numbers cleared it.
 */
const HISTORICAL_VOLUME = Number(process.env.CALIBRATE_TARGET || 215);

async function main() {
  if (!db.hasDb()) {
    console.error("DATABASE_URL is not set. Run: DATABASE_URL=... npm run calibrate");
    process.exit(1);
  }

  const rows = await db.sql("select msisdn from numbers where available");
  if (!rows.length) {
    console.error("No available numbers in the database — nothing to calibrate against.");
    process.exit(1);
  }

  const scores = rows.map((r) => scoreMsisdn(r.msisdn).score).sort((a, b) => b - a);
  const total = scores.length;
  const over = (t) => {
    // Sorted descending, so the count at or above t is the first index below it.
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (scores[mid] >= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  console.log(`\n  ${total.toLocaleString()} available numbers scored with the CURRENT scorer\n`);
  console.log("  band        numbers      share");
  for (const t of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    const n = over(t);
    console.log(
      `  >= ${String(t).padEnd(3)}  ${String(n).padStart(10)}   ${((n / total) * 100).toFixed(3)}%` +
        (t === ALERT_THRESHOLD ? "   <- current ALERT_THRESHOLD" : "")
    );
  }

  console.log(`\n  highest score present: ${scores[0]}`);
  console.log(`  to match the historical volume of ~${HISTORICAL_VOLUME} numbers, the`);
  console.log(`  threshold is ${scores[Math.min(HISTORICAL_VOLUME, total) - 1]}`);
  console.log(
    `\n  If that differs much from ${ALERT_THRESHOLD}, set ALERT_THRESHOLD to it —` +
      `\n  the default was estimated from synthetic data, not this.\n`
  );
}

main().catch((err) => {
  console.error(`[calibrate] failed: ${err?.stack || err}`);
  process.exit(1);
});
