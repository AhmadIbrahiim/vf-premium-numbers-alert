import { getCounts, getNumbers } from "../lib/db.js";
import { CARRIER_LABEL, formatInt } from "../lib/format.js";
import NumbersBrowser from "../components/numbers-browser.jsx";

/**
 * Rendered on the server so the first paint already has numbers in it — no spinner, and
 * the page is useful before any JavaScript runs.
 */
export const dynamic = "force-dynamic";

const CARRIER_DOT = {
  vodafone: "bg-carrier-vodafone",
  etisalat: "bg-carrier-etisalat",
  we: "bg-carrier-we",
};

export default async function Home() {
  let counts = null;
  let numbers = { rows: [], total: 0 };
  let error = null;

  try {
    [counts, numbers] = await Promise.all([
      getCounts(),
      getNumbers({ view: "now", sort: "score", limit: 60, offset: 0 }),
    ]);
  } catch (err) {
    error = err.message || String(err);
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
        <h1 className="text-base font-semibold text-red-600 dark:text-red-400">Couldn&apos;t reach the database</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
        <p className="mt-2 text-xs text-zinc-500">
          Check that <code className="rounded bg-zinc-500/15 px-1">DATABASE_URL</code> is set for this deployment.
        </p>
      </div>
    );
  }

  return (
    <main>
      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-white/5 dark:bg-ink-850">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Available now</div>
          <div className="num-tnum mt-1 text-2xl font-bold">{formatInt(counts.available_total)}</div>
        </div>
        {(counts.per_carrier || []).map((c) => (
          <div
            key={c.carrier}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-white/5 dark:bg-ink-850"
          >
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
              <span className={`h-2 w-2 rounded-full ${CARRIER_DOT[c.carrier] || "bg-zinc-400"}`} />
              {CARRIER_LABEL[c.carrier] || c.carrier}
            </div>
            <div className="num-tnum mt-1 text-2xl font-bold">{formatInt(c.available)}</div>
            <div className="text-[11px] text-zinc-400">top score {c.top_score ?? 0}</div>
          </div>
        ))}
      </section>

      <NumbersBrowser initialRows={numbers.rows} initialTotal={numbers.total} />
    </main>
  );
}
