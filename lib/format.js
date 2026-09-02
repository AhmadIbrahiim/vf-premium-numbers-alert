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
  return m ? `G${m[1]}` : tier;
}

export function simLabel(simType) {
  if (simType === "ESIM") return "eSIM";
  if (simType === "PHYSICAL") return "Physical";
  return "";
}

/**
 * Score band colours. The public catalogues top out around 59, so the bands are set
 * against what actually occurs rather than spread evenly across 0-100 — otherwise every
 * number on the site would render in the same colour.
 */
export function scoreStyle(score) {
  const n = Number(score) || 0;
  if (n >= 55) return { ring: "#10b981", text: "text-emerald-600 dark:text-emerald-300" };
  if (n >= 45) return { ring: "#22c55e", text: "text-green-600 dark:text-green-300" };
  if (n >= 35) return { ring: "#65a30d", text: "text-lime-600 dark:text-lime-300" };
  if (n >= 25) return { ring: "#d97706", text: "text-amber-600 dark:text-amber-300" };
  return { ring: "#ea580c", text: "text-orange-600 dark:text-orange-300" };
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
