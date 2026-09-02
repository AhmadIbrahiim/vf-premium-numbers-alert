import { formatMsisdn } from "../lib/format.js";
import Badges from "./badges.jsx";
import ScoreRing from "./score-ring.jsx";
import CopyButton from "./copy-button.jsx";

/** Classic podium: 2nd left, 1st centred and raised, 3rd right. */
const ORDER = ["sm:order-2 sm:-translate-y-3", "sm:order-1", "sm:order-3"];
const MEDAL = [
  "bg-gradient-to-br from-amber-300 to-yellow-600 text-black",
  "bg-gradient-to-br from-zinc-200 to-zinc-400 text-black",
  "bg-gradient-to-br from-amber-600 to-amber-800 text-white",
];

export default function PodiumCard({ row, rank }) {
  const emphasis = rank === 0 ? "ring-2 ring-vf-red/40 dark:ring-vf-red/50" : "ring-1 ring-zinc-200 dark:ring-white/5";
  const tags = (row.tags || []).filter(Boolean).slice(0, 3);

  return (
    <div
      className={`group relative flex flex-col items-center gap-3 rounded-2xl border border-transparent bg-white p-5 text-center shadow-sm transition hover:shadow-md dark:bg-ink-900/70 ${emphasis} ${ORDER[rank]}`}
    >
      <div className={`grid h-8 w-8 place-items-center rounded-full text-sm font-extrabold num-tnum ${MEDAL[rank]}`}>
        {rank + 1}
      </div>
      <ScoreRing score={row.score} size={rank === 0 ? 80 : 68} />
      <div className="font-mono text-lg font-bold tracking-wide text-zinc-900 num-tnum dark:text-white">
        {formatMsisdn(row.msisdn)}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Badges row={row} />
      </div>
      {tags.length ? (
        <div className="flex flex-wrap justify-center gap-1.5">
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
      <CopyButton value={row.msisdn} />
    </div>
  );
}
