/**
 * format.js — presentation helpers shared by the server and client components.
 *
 * Pure functions only, so both runtimes can use them and they are trivially testable.
 */

export const CARRIERS = [
  { id: "all", label: "All carriers" },
  { id: "vodafone", label: "Vodafone" },
  { id: "etisalat", label: "Etisalat" },
  { id: "we", label: "WE" },
];

export const CARRIER_LABEL = { vodafone: "Vodafone", etisalat: "Etisalat", we: "WE" };

const TIER_LABEL = {
  silver: "Silver",
  golden: "Golden",
  golden_plus: "Golden+",
  platinum: "Platinum",
  platinum_plus: "Platinum+",
};

/** Group an Egyptian msisdn for reading: 0110 117 3349. */
export function formatMsisdn(value) {
  const m = String(value ?? "").trim();
  if (!m) return "—";
  if (m.length < 8) return m;
  return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
}

/** Human label for a carrier's own tier marker: Etisalat pools, WE grade codes. */
export function tierLabel(tier) {
  if (!tier) return "";
  if (TIER_LABEL[tier]) return TIER_LABEL[tier];
  const m = /^GRADE_0*(\d+)$/.exec(tier);
  if (m) return `WE grade ${m[1]}`;
  // Unknown pool name: title-case it rather than print the identifier. Add it to
  // TIER_LABEL when one shows up — this is a floor, not a substitute.
  return tier
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function simLabel(simType) {
  if (simType === "ESIM") return "eSIM";
  if (simType === "PHYSICAL") return "Physical";
  return "";
}

/** "3 min ago" for an ISO timestamp or a date string. */
export function relTime(value) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "2m 38s" for a millisecond duration. */
export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

export function formatInt(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

/** Digits only — what a number search is allowed to contain. */
export function digitsOnly(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

/**
 * Turn a scorer tag into something a buyer understands.
 *
 * The tags are engineering identifiers — `ascending-run-x4`,
 * `etisalat-platinum_plus`, `repeating-block-2`. Showing them raw was the single most
 * unpolished thing on the page: they read as debug output, and a buyer cannot tell
 * whether `ladder-step-2-x5` is good.
 *
 * Returns null for tags not worth surfacing (carrier tiers, which already have their
 * own badge, and internal weak signals), so callers can filter.
 */
export function patternLabel(tag) {
  if (!tag) return null;

  // Carrier tier duplicates the tier badge.
  if (tag.startsWith("etisalat-")) return null;

  const runs = /^(ascending|descending)-run-x(\d+)$/.exec(tag);
  if (runs) return `${runs[2]} in a row ${runs[1] === "ascending" ? "up" : "down"}`;
  if (tag === "ascending") return "counts all the way up";
  if (tag === "descending") return "counts all the way down";

  const same = /^repeated-digit-x(\d+)$/.exec(tag);
  if (same) return `same digit ${same[1]}×`;
  if (tag === "all-same") return "every digit the same";
  if (tag === "triple-digit") return "a digit three times";

  const zeros = /^ending-(0+)$/.exec(tag);
  if (zeros) return `ends in ${zeros[1].length} zeros`;
  if (tag === "many-zeros") return "lots of zeros";
  if (tag === "mostly-zeros") return "almost all zeros";

  if (tag === "palindrome") return "reads the same backwards";
  if (tag === "mirror-halves") return "mirrored halves";
  if (tag === "alternating-ABAB") return "two digits alternating";
  if (tag === "paired-AABB") return "doubled pairs";
  if (tag === "grouped") return "repeating groups";
  if (tag.startsWith("repeating-block")) return "a repeating block";

  if (tag === "pair-ladder") return "pairs stepping evenly";
  if (tag === "two-distinct-digits") return "only two digits";
  if (tag === "three-distinct-digits") return "only three digits";

  const ladder = /^ladder-step-?\d+(-x(\d+))?$/.exec(tag);
  if (ladder) return ladder[2] ? `${ladder[2]} digits stepping evenly` : "digits stepping evenly";

  // Weak partial signals: real but not worth a pill of their own.
  if (tag.endsWith("-partial")) return null;

  return null;
}

/** The labels worth showing for a row, best-first, deduped. */
export function patternLabels(tags, limit = 2) {
  const seen = new Set();
  const out = [];
  for (const t of tags || []) {
    const label = patternLabel(t);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A plain-word tier for a score, so the number means something without the reader
 * knowing the scale. The bands come from the real distribution: across ~205k numbers
 * the maximum is 56 and only ~170 clear 50, so these are percentile-shaped rather
 * than an even split of 0-100.
 */
export function scoreTier(score) {
  const n = Number(score) || 0;
  // Cut against the real distribution, not an even split of 0-100. The best number in
  // the catalogue scores 56 and only ~170 of 202k clear 50, so wide bands made every
  // row in a best-first list read "Exceptional" and the label carried no information.
  if (n >= 54) return { label: "Exceptional", tone: "text-emerald-700 dark:text-emerald-400" };
  if (n >= 46) return { label: "Excellent", tone: "text-emerald-700 dark:text-emerald-400" };
  if (n >= 36) return { label: "Strong", tone: "text-lime-700 dark:text-lime-400" };
  if (n >= 26) return { label: "Decent", tone: "text-amber-700 dark:text-amber-400" };
  if (n >= 14) return { label: "Modest", tone: "text-zinc-500 dark:text-zinc-400" };
  return { label: "Plain", tone: "text-zinc-500 dark:text-zinc-400" };
}
