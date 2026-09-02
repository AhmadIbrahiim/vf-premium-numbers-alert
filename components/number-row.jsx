import { formatMsisdn } from "../lib/format.js";
import Badges from "./badges.jsx";
import ScoreRing from "./score-ring.jsx";
import CopyButton from "./copy-button.jsx";

const RANK_BADGE = [
  "bg-gradient-to-br from-amber-300 to-yellow-600 text-black",
  "bg-gradient-to-br from-zinc-200 to-zinc-400 text-black",
  "bg-gradient-to-br from-amber-600 to-amber-800 text-white",
];

/** One number in the ranked list. */
export default function NumberRow({ row, rank }) {
  const gone = row.available === false;
  const tags = (row.tags || []).filter(Boolean).slice(0, 5);

  return (
    <div
      role="listitem"
      className={`group relative flex items-center gap-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-white/5 dark:bg-ink-900/60 dark:shadow-none dark:hover:border-white/10 ${
        gone ? "opacity-60" : ""
      }`}
    >
      <div
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold num-tnum ${
          rank < 3 ? RANK_BADGE[rank] : "bg-zinc-200 text-zinc-500 dark:bg-ink-700 dark:text-zinc-400"
        }`}
      >
        {rank + 1}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-lg font-bold tracking-wide text-zinc-900 num-tnum dark:text-white">
            {formatMsisdn(row.msisdn)}
          </span>
          <Badges row={row} />
        </div>
        {tags.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-ink-800 dark:text-zinc-400"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden text-right sm:block">
          <div className="num-tnum text-xs text-zinc-400 dark:text-zinc-500">
            {row.first_seen ? `first seen ${row.first_seen}` : ""}
          </div>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-600">
            {Number(row.age_days) === 0 ? "today" : `${row.age_days}d old`}
          </div>
        </div>
        <ScoreRing score={row.score} size={56} />
        <CopyButton value={row.msisdn} />
      </div>
    </div>
  );
}
