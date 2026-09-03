import { getEvents } from "../../lib/db.js";
import { CARRIER_LABEL, formatInt, formatMsisdn, relTime, scoreTier } from "../../lib/format.js";

/**
 * What changed since the last poll: which numbers became available and which went.
 *
 * Grouped by poll rather than shown as a flat feed, because "since last run" is the
 * question being asked — a single list of 2,000 events cannot answer it.
 *
 * Only the highest-scoring events of each type are recorded per poll (see
 * recordNumberEvents), so this shows arrivals and departures worth caring about rather
 * than a thousand plain numbers churning.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Changes — Egypt Premium Numbers",
  description: "Numbers that became available or disappeared on each poll.",
};

const CARRIER_DOT = {
  vodafone: "bg-carrier-vodafone",
  etisalat: "bg-carrier-etisalat",
  we: "bg-carrier-we",
};

function EventRow({ e }) {
  const tier = scoreTier(e.score);
  return (
    <li className="flex items-center gap-2 py-1.5 sm:gap-3">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${CARRIER_DOT[e.carrier] || "bg-zinc-400"}`}
      />
      {/* shrink-0 + nowrap: as a shrinkable flex item the spaced number broke
          across two lines on a phone. */}
      <span className="shrink-0 whitespace-nowrap font-mono text-[14px] font-semibold num-tnum sm:text-[15px]">
        {formatMsisdn(e.msisdn)}
      </span>
      <span className="truncate text-[12px] text-zinc-500 dark:text-zinc-400">
        {CARRIER_LABEL[e.carrier] || e.carrier}
      </span>
      <span className={`ml-auto shrink-0 text-[12px] font-semibold ${tier.tone}`}>{tier.label}</span>
      <span className="num-tnum w-7 shrink-0 text-right text-[11px] text-zinc-400 dark:text-zinc-600">
        {e.score}
      </span>
    </li>
  );
}

export default async function ChangesPage() {
  let events = [];
  let error = null;
  try {
    // Enough to cover several polls at the per-poll retention limit.
    events = await getEvents({ limit: 500 });
  } catch (err) {
    error = err.message || String(err);
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
        <h1 className="text-base font-semibold text-red-600 dark:text-red-400">
          Couldn&apos;t reach the database
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
      </div>
    );
  }

  // Group by poll timestamp, newest first.
  const polls = new Map();
  for (const e of events) {
    const key = String(e.ts);
    if (!polls.has(key)) polls.set(key, { ts: e.ts, arrived: [], left: [] });
    (e.type === "new" ? polls.get(key).arrived : polls.get(key).left).push(e);
  }
  const ordered = [...polls.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const p of ordered) {
    p.arrived.sort((a, b) => b.score - a.score);
    p.left.sort((a, b) => b.score - a.score);
  }

  if (!ordered.length) {
    return (
      <main>
        <h1 className="text-xl font-bold">Changes</h1>
        <div className="mt-4 rounded-lg border border-dashed border-zinc-300 px-5 py-12 text-center dark:border-white/10">
          <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
            No changes recorded yet
          </p>
          <p className="mt-1 text-[12px] text-zinc-500">
            The next poll will record what arrived and what went.
          </p>
        </div>
      </main>
    );
  }

  const latest = ordered[0];

  return (
    <main>
      <header className="mb-5">
        <h1 className="text-xl font-bold">Changes</h1>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Last poll {relTime(latest.ts)} · {formatInt(latest.arrived.length)} arrived,{" "}
          {formatInt(latest.left.length)} went
        </p>
      </header>

      <div className="space-y-5">
        {ordered.map((poll) => (
          <section
            key={String(poll.ts)}
            className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.02]"
          >
            <h2 className="mb-3 flex flex-wrap items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
              {relTime(poll.ts)}
              <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-bold tracking-wider text-emerald-700 dark:text-emerald-400">
                +{poll.arrived.length}
              </span>
              <span className="rounded bg-zinc-400/15 px-1.5 py-px text-[10px] font-bold tracking-wider text-zinc-500">
                −{poll.left.length}
              </span>
            </h2>

            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
              <div>
                <h3 className="mb-1 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">
                  Became available
                </h3>
                {poll.arrived.length ? (
                  <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                    {poll.arrived.slice(0, 12).map((e) => (
                      <EventRow key={`n-${e.msisdn}`} e={e} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-1.5 text-[12px] text-zinc-400">Nothing new</p>
                )}
                {poll.arrived.length > 12 ? (
                  <p className="pt-1.5 text-[11px] text-zinc-400">
                    and {formatInt(poll.arrived.length - 12)} more
                  </p>
                ) : null}
              </div>

              <div>
                <h3 className="mb-1 text-[12px] font-semibold text-zinc-500">Went</h3>
                {poll.left.length ? (
                  <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                    {poll.left.slice(0, 12).map((e) => (
                      <EventRow key={`g-${e.msisdn}`} e={e} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-1.5 text-[12px] text-zinc-400">Nothing gone</p>
                )}
                {poll.left.length > 12 ? (
                  <p className="pt-1.5 text-[11px] text-zinc-400">
                    and {formatInt(poll.left.length - 12)} more
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
