import { CARRIER_LABEL, tierLabel, simLabel } from "../lib/format.js";

const CARRIER_CLASS = {
  vodafone: "bg-vf-red/15 text-vf-red ring-vf-red/30 dark:text-red-300",
  etisalat: "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  we: "bg-purple-500/15 text-purple-700 ring-purple-500/30 dark:text-purple-300",
};

const PILL = "rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1";

/** Carrier, its own tier/grade marker, SIM type, and whether it arrived today. */
export default function Badges({ row }) {
  const carrier = row.carrier || "";
  const tier = tierLabel(row.tier);
  const sim = simLabel(row.sim_type);

  return (
    <>
      {row.is_new ? (
        <span className={`${PILL} bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300`}>
          New
        </span>
      ) : null}
      {row.available === false ? (
        <span className={`${PILL} bg-zinc-400/15 text-zinc-500 ring-zinc-400/30 dark:text-zinc-400`}>Gone</span>
      ) : null}
      {carrier ? (
        <span className={`${PILL} ${CARRIER_CLASS[carrier] || "bg-zinc-400/15 text-zinc-500 ring-zinc-400/30"}`}>
          {CARRIER_LABEL[carrier] || carrier}
        </span>
      ) : null}
      {tier ? (
        <span className={`${PILL} bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300`}>{tier}</span>
      ) : null}
      {sim ? (
        <span className={`${PILL} bg-indigo-500/15 text-indigo-700 ring-indigo-500/30 dark:text-indigo-300`}>
          {sim}
        </span>
      ) : null}
    </>
  );
}
