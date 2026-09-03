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
      className={`group relative flex items-center gap-3 overflow-hidden rounded-lg border border-zinc-200/80 bg-white pl-4 pr-3 py-2.5 transition hover:border-zinc-300 dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-white/15 ${
        gone ? "opacity-50" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[3px] ${CARRIER_STRIPE[row.carrier] || "bg-zinc-300"}`}
      />

      {typeof rank === "number" ? (
        <span className="num-tnum w-6 shrink-0 text-right text-[11px] tabular-nums text-zinc-400 dark:text-zinc-600">
          {rank + 1}
        </span>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-mono text-[19px] font-semibold leading-none tracking-tight text-zinc-900 num-tnum dark:text-white">
            {formatMsisdn(row.msisdn)}
          </span>
          {row.is_new ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              New
            </span>
          ) : null}
          {gone ? (
            <span className="rounded bg-zinc-400/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-zinc-500">
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
              <span>{carrierTier}</span>
            </>
          ) : null}
          {reasons.map((r) => (
            <span key={r} className="flex items-center gap-2">
              <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">·</span>
              {r}
            </span>
          ))}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className={`text-[13px] font-semibold leading-none ${tier.tone}`}>{tier.label}</div>
        <div className="num-tnum mt-1 text-[11px] text-zinc-400 dark:text-zinc-600">{row.score}</div>
      </div>

      <CopyButton value={row.msisdn} />
    </div>
  );
}
