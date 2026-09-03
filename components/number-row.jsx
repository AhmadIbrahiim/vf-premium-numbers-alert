import { formatMsisdn, patternLabels, scoreTier, tierLabel, CARRIER_LABEL } from "../lib/format.js";
import CopyButton from "./copy-button.jsx";

/**
 * One number in the list.
 *
 * The number is the hero: it is the product, so it is the largest thing in the row and
 * the only monospace element. Everything else is deliberately quiet — the previous
 * version set it at 18px among five competing pills, a score ring and two date lines,
 * which left nothing to scan.
 *
 * The carrier shows as a 3px edge stripe rather than a shouting pill, and the score
 * appears as a word ("Excellent") plus a small number, because a bare "56" means
 * nothing without knowing the scale.
 *
 * On a phone the row has to stay one line of number plus one line of detail. The
 * formatted number contains spaces, so without `whitespace-nowrap` it broke across two
 * or three lines and rows grew to 113px — the hero of the row, hyphenated by the
 * layout. The rank and the second pattern label are dropped on narrow screens to buy
 * that width rather than shrink the number.
 */

const CARRIER_STRIPE = {
  vodafone: "bg-carrier-vodafone",
  etisalat: "bg-carrier-etisalat",
  we: "bg-carrier-we",
};

export default function NumberRow({ row, rank }) {
  const gone = row.available === false;
  const reasons = patternLabels(row.tags, 2);
  const tier = scoreTier(row.score);
  const carrierTier = tierLabel(row.tier);

  return (
    <div
      role="listitem"
      className={`group relative flex items-center gap-2.5 overflow-hidden rounded-lg border border-zinc-200/80 bg-white pl-4 pr-2.5 py-2.5 transition hover:border-zinc-300 dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-white/15 sm:gap-3 sm:pr-3 ${
        gone ? "opacity-50" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[3px] ${CARRIER_STRIPE[row.carrier] || "bg-zinc-300"}`}
      />

      {typeof rank === "number" ? (
        <span className="num-tnum hidden w-6 shrink-0 text-right text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400 sm:block">
          {rank + 1}
        </span>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="whitespace-nowrap font-mono text-[17px] font-semibold leading-none tracking-tight text-zinc-900 num-tnum dark:text-white min-[400px]:text-[19px]">
            {formatMsisdn(row.msisdn)}
          </span>
          {row.is_new ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              New
            </span>
          ) : null}
          {gone ? (
            <span className="rounded bg-zinc-400/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Gone
            </span>
          ) : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-tight text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">
            {CARRIER_LABEL[row.carrier] || row.carrier}
          </span>
          {carrierTier ? (
            <>
              <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="whitespace-nowrap">{carrierTier}</span>
            </>
          ) : null}
          {reasons.map((r, i) => (
            // Only the first reason survives on a phone; two of them wrapped the detail
            // line onto five lines at 320px.
            <span key={r} className={`items-center gap-2 ${i === 0 ? "flex" : "hidden sm:flex"}`}>
              <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="whitespace-nowrap">{r}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className={`whitespace-nowrap text-[12px] font-semibold leading-none sm:text-[13px] ${tier.tone}`}>
          {tier.label}
        </div>
        <div className="num-tnum mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{row.score}</div>
      </div>

      <CopyButton value={row.msisdn} />
    </div>
  );
}
