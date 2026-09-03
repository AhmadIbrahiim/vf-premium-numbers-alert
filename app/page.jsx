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
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Check that <code className="rounded bg-zinc-500/15 px-1">DATABASE_URL</code> is set for this deployment.
        </p>
      </div>
    );
  }

  return (
    <main>
      {/*
        One headline plus inline carrier counts, replacing four equal-weight stat boxes.
        Three of those boxes were carrier totals, which duplicated the carrier filter
        directly below them and gave the page nothing to lead with.
      */}
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="num-tnum text-[32px] font-bold leading-none tracking-tight sm:text-[38px]">
            {formatInt(counts.available_total)}
          </h1>
          <p className="mt-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            premium numbers available across Vodafone, Etisalat and WE
          </p>
        </div>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {(counts.per_carrier || []).map((c) => (
            <div key={c.carrier} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${CARRIER_DOT[c.carrier] || "bg-zinc-400"}`}
              />
              <dt className="text-[12px] text-zinc-500 dark:text-zinc-400">
                {CARRIER_LABEL[c.carrier] || c.carrier}
              </dt>
              <dd className="num-tnum text-[13px] font-semibold">{formatInt(c.available)}</dd>
            </div>
          ))}
        </dl>
      </header>

      <NumbersBrowser initialRows={numbers.rows} initialTotal={numbers.total} />
    </main>
  );
}
