import { getProviderRuns } from "../../lib/db.js";
import { CARRIER_LABEL, formatDuration, formatInt, relTime } from "../../lib/format.js";
import Sparkline from "../../components/sparkline.jsx";

/**
 * Provider health, read straight from `provider_runs`.
 *
 * Server-rendered on every request rather than cached, because the whole point of the
 * page is telling you whether a carrier is failing right now.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Provider status — Egypt Premium Numbers",
  description: "Live health of the Vodafone, Etisalat and WE number APIs.",
};

const CARRIER_DOT = {
  vodafone: "bg-carrier-vodafone",
  etisalat: "bg-carrier-etisalat",
  we: "bg-carrier-we",
};
const CARRIER_STROKE = { vodafone: "#e60000", etisalat: "#10b981", we: "#8b5cf6" };

const BADGE = {
  live: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  carried: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failing: "bg-red-500/15 text-red-600 dark:text-red-400",
  idle: "bg-zinc-400/15 text-zinc-500",
};

/** A carrier's state, from its most recent poll. */
function stateOf(latest) {
  if (!latest) return { key: "idle", label: "No data" };
  if (!latest.ok) return { key: "failing", label: "Failing" };
  if (!latest.trusted) return { key: "carried", label: "Carried over" };
  const ageMin = (Date.now() - Date.parse(latest.run_at)) / 60000;
  if (ageMin > 90) return { key: "carried", label: "Stale" };
  return { key: "live", label: "Live" };
}

export default async function StatusPage() {
  let runs = [];
  let error = null;
  try {
    runs = await getProviderRuns({ window: 48 });
  } catch (err) {
    error = err.message || String(err);
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
        <h1 className="text-base font-semibold text-red-600 dark:text-red-400">Couldn&apos;t reach the database</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
      </div>
    );
  }

  // `history` comes back oldest-first for charting; cards want the newest poll.
  const byCarrier = new Map();
  for (const r of runs) {
    if (!byCarrier.has(r.carrier)) byCarrier.set(r.carrier, []);
    byCarrier.get(r.carrier).push(r);
  }
  const carriers = [...byCarrier.keys()].sort();
  const newestFirst = [...runs].sort((a, b) => String(b.run_at).localeCompare(String(a.run_at)));
  const latestPoll = newestFirst[0];
  const failing = carriers.filter((c) => {
    const l = byCarrier.get(c).at(-1);
    return l && !l.ok;
  });

  if (!runs.length) {
    return (
      <main>
        <h1 className="text-xl font-bold">Provider status</h1>
        <div className="mt-4 rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-5 py-10 text-center dark:border-white/10 dark:bg-ink-900/50">
          <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">No polls recorded yet</p>
          <p className="mt-1 text-xs text-zinc-500">The next scheduled poll will fill this in.</p>
        </div>
      </main>
    );
  }

  const summary = [
    ["Providers healthy", `${carriers.length - failing.length} / ${carriers.length}`],
    [
      "Numbers last collected",
      formatInt(carriers.reduce((a, c) => a + (Number(byCarrier.get(c).at(-1)?.records) || 0), 0)),
    ],
    ["Last poll", latestPoll ? relTime(latestPoll.run_at) : "—"],
    ["Polls recorded", formatInt(runs.length)],
  ];

  return (
    <main>
      <h1 className="text-xl font-bold">Provider status</h1>
      <p className="mb-5 mt-1 text-[13px] text-zinc-500">
        Read live from Postgres · last poll {latestPoll ? relTime(latestPoll.run_at) : "unknown"}
      </p>

      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summary.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-white/5 dark:bg-ink-850">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{k}</div>
            <div className="num-tnum mt-1 text-2xl font-bold">{v}</div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        {carriers.map((carrier) => {
          const list = byCarrier.get(carrier);
          const latest = list.at(-1);
          const st = stateOf(latest);
          const okCount = list.filter((r) => r.ok).length;
          // Failed polls collected nothing; plotting them as zero would read as the
          // carrier's inventory vanishing rather than a fetch failing.
          const series = list.filter((r) => r.ok).map((r) => Number(r.records) || 0);

          return (
            <div
              key={carrier}
              className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/5 dark:bg-ink-900/60"
            >
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${CARRIER_DOT[carrier] || "bg-zinc-400"}`} />
                <h2 className="text-[15px] font-semibold">{CARRIER_LABEL[carrier] || carrier}</h2>
                <span
                  className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${BADGE[st.key]}`}
                >
                  {st.label}
                </span>
              </div>

              <dl className="mt-3.5 space-y-1.5 text-[13px]">
                {[
                  ["Numbers collected", formatInt(latest?.records)],
                  ["Requests used", formatInt(latest?.requests)],
                  ["Poll duration", formatDuration(latest?.duration_ms)],
                  ["Last poll", latest ? relTime(latest.run_at) : "—"],
                  ["Succeeded", `${okCount} of last ${list.length}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="num-tnum font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>

              {series.length > 1 ? (
                <>
                  <Sparkline values={series} stroke={CARRIER_STROKE[carrier] || "#888"} />
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Numbers collected over the last {series.length} successful polls
                  </p>
                </>
              ) : null}

              {latest && !latest.ok && latest.error ? (
                <p className="mt-3 max-h-24 overflow-auto break-words rounded-lg border border-red-500/25 bg-red-500/5 px-2.5 py-2 text-[12px] text-red-600 dark:text-red-400">
                  {latest.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </section>

      <h3 className="mb-2.5 mt-8 text-[13px] font-semibold uppercase tracking-wide text-zinc-500">Recent polls</h3>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-white/5 dark:bg-ink-900/60">
        <table className="w-full min-w-[620px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="border-b border-zinc-200 px-3.5 py-2.5 font-semibold dark:border-white/5">When</th>
              <th className="border-b border-zinc-200 px-3.5 py-2.5 font-semibold dark:border-white/5">Provider</th>
              <th className="border-b border-zinc-200 px-3.5 py-2.5 font-semibold dark:border-white/5">Result</th>
              <th className="border-b border-zinc-200 px-3.5 py-2.5 text-right font-semibold dark:border-white/5">Numbers</th>
              <th className="border-b border-zinc-200 px-3.5 py-2.5 text-right font-semibold dark:border-white/5">Requests</th>
              <th className="border-b border-zinc-200 px-3.5 py-2.5 text-right font-semibold dark:border-white/5">Took</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.slice(0, 36).map((r, i) => (
              <tr key={`${r.carrier}-${r.run_at}-${i}`}>
                <td className="whitespace-nowrap border-b border-zinc-100 px-3.5 py-2.5 dark:border-white/5">
                  {relTime(r.run_at)}
                </td>
                <td className="whitespace-nowrap border-b border-zinc-100 px-3.5 py-2.5 dark:border-white/5">
                  {CARRIER_LABEL[r.carrier] || r.carrier}
                </td>
                <td className="border-b border-zinc-100 px-3.5 py-2.5 dark:border-white/5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      !r.ok ? BADGE.failing : r.trusted ? BADGE.live : BADGE.carried
                    }`}
                  >
                    {!r.ok ? "failed" : r.trusted ? "ok" : "carried over"}
                  </span>
                </td>
                <td className="num-tnum whitespace-nowrap border-b border-zinc-100 px-3.5 py-2.5 text-right dark:border-white/5">
                  {formatInt(r.records)}
                </td>
                <td className="num-tnum whitespace-nowrap border-b border-zinc-100 px-3.5 py-2.5 text-right dark:border-white/5">
                  {formatInt(r.requests)}
                </td>
                <td className="num-tnum whitespace-nowrap border-b border-zinc-100 px-3.5 py-2.5 text-right dark:border-white/5">
                  {formatDuration(r.duration_ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-[12px] text-zinc-500">
        &ldquo;Carried over&rdquo; means the provider answered but with too little to trust, so its numbers were
        refreshed and none were retired.
      </p>
    </main>
  );
}
