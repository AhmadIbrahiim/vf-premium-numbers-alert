import { formatMsisdn, patternLabels, scoreTier, tierLabel, CARRIER_LABEL } from "../lib/format.js";
import CopyButton from "./copy-button.jsx";

/**
 * The single best number, given real prominence.
 *
 * This replaces a three-card podium. The podium spent ~350px of the most valuable
 * screen space showing #1, #2 and #3 — which, because carriers list numbers in blocks,
 * were usually near-identical (0110 123 2101 / 2102 / 2103, all scoring 56). One hero
 * plus a dense list says the same thing and leaves room to actually scan.
 */

const CARRIER_ACCENT = {
  vodafone: "text-carrier-vodafone dark:text-vf-redsoft",
  etisalat: "text-emerald-700 dark:text-carrier-etisalat",
  we: "text-violet-700 dark:text-carrier-we",
};

export default function TopPick({ row }) {
  if (!row) return null;
  const reasons = patternLabels(row.tags, 3);
  const tier = scoreTier(row.score);
  const carrierTier = tierLabel(row.tier);

  return (
    <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.03] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            Best available now
          </p>
          {/* 34px left ~2px of slack inside the card at 320px. Stepped by width, and
              never allowed to wrap: this number is the whole point of the card. */}
          <p className="mt-2 whitespace-nowrap font-mono text-[26px] font-bold leading-none tracking-tight text-zinc-900 num-tnum dark:text-white min-[360px]:text-[32px] sm:text-[42px]">
            {formatMsisdn(row.msisdn)}
          </p>
          <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            <span className={`font-semibold ${CARRIER_ACCENT[row.carrier] || ""}`}>
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
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className={`text-[15px] font-bold leading-none ${tier.tone}`}>{tier.label}</div>
            <div className="num-tnum mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              scores {row.score}
            </div>
          </div>
          <CopyButton value={row.msisdn} />
        </div>
      </div>
    </section>
  );
}
