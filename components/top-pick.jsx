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
  vodafone: "text-carrier-vodafone",
  etisalat: "text-carrier-etisalat",
  we: "text-carrier-we",
};

export default function TopPick({ row }) {
  if (!row) return null;
  const reasons = patternLabels(row.tags, 3);
  const tier = scoreTier(row.score);
  const carrierTier = tierLabel(row.tier);

  return (
    <section className="mb-5 rounded-xl border border-zinc-200 bg-white p-5 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
            Best available now
          </p>
          <p className="mt-2 font-mono text-[34px] font-bold leading-none tracking-tight text-zinc-900 num-tnum dark:text-white sm:text-[42px]">
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
            <div className="num-tnum mt-1 text-[11px] text-zinc-400 dark:text-zinc-600">
              scores {row.score}
            </div>
          </div>
          <CopyButton value={row.msisdn} />
        </div>
      </div>
    </section>
  );
}
