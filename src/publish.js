/**
 * publish.js — the offline fallback snapshot.
 *
 * The dashboard reads Postgres live through the Data API. That needs a one-time console
 * toggle on the Neon project, and until it happens a static page has nothing at all to
 * query — the site goes dark. So the poller also writes two small files that the pages
 * fall back to when `web/config.js` has no endpoint set.
 *
 * This is a cache, not state: it is derived from Postgres on every poll and nothing
 * reads it back. It is deliberately far smaller than the snapshots this project used to
 * publish (~1MB against 10MB+), because it only has to cover browsing and the status
 * view — once the Data API is configured the pages stop fetching it entirely.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as db from "./db.js";

/** Rows per carrier in the fallback snapshot. Enough to browse; not the whole table. */
export const FALLBACK_PER_CARRIER = Number(process.env.FALLBACK_PER_CARRIER || 3000);

/**
 * Build the fallback payloads from the database.
 * @returns {Promise<{snapshot: object, status: object}>}
 */
export async function buildFallback({ today, generatedAt, perCarrier = FALLBACK_PER_CARRIER }, opts = {}) {
  const [counts, rows, runs, events] = await Promise.all([
    db.readCounts(opts),
    db.readTopPerCarrier({ perCarrier, today }, opts),
    db.readProviderHistory({ window: 48 }, opts),
    db.readEvents({ limit: 300 }, opts),
  ]);
  return {
    snapshot: {
      generated_at: generatedAt,
      available_total: counts.available_total,
      by_carrier: counts.by_carrier,
      // What the page can browse offline; `available_total` is the real figure.
      rows_per_carrier: perCarrier,
      rows,
      events,
    },
    status: { generated_at: generatedAt, runs },
  };
}

/** Write the fallback payloads into `dir`. */
export async function writeFallback(dir, { snapshot, status }) {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "snapshot.json"), JSON.stringify(snapshot)),
    writeFile(join(dir, "status.json"), JSON.stringify(status)),
  ]);
}
