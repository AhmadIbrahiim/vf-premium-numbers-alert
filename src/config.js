/**
 * Central configuration. Environment variables override defaults so the same
 * code runs locally and in GitHub Actions.
 */

/**
 * Vodafone lists numbers under several line types, each its own catalog path.
 * `red` alone (and only with `simFamilyType==OWNER`) saw ~2.7k of the ~5.2k
 * numbers actually on the shop; `flex` adds ~2.0k and dropping the family
 * filter adds ~0.45k more.
 */
export const VF_TYPES = (process.env.VF_TYPES || "red,flex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Catalog URL for one Vodafone line type (size/page are set by the pager). */
export function vodafoneEndpoint(type) {
  return (
    `https://eshop.vodafone.com.eg/ecommerce/api/catalog/commerce/phone-numbers/type/${type}` +
    "?cq=(simType==ESIM,simType==PHYSICAL)&query=in&size=2000&page=0&shuffle=0&tariffName="
  );
}

/** Static context header that gates the API (no cookie/token required). */
export const X_CONTEXT_REQUEST = JSON.stringify({
  applicationId: "01H5FECVAV4YWT0NGQKXEN1T51",
  tenantId: "5DF1363059675161A85F576D",
});

export const USER_AGENT =
  process.env.VF_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export const REFERER = "https://eshop.vodafone.com.eg/en/lines/red/numbers";

/** Where the published dashboard JSON is written (the gh-pages working copy in CI). */
export const DATA_DIR = process.env.DATA_DIR || "data";

// NOTE: the Neon connection string (DATABASE_URL) is deliberately NOT re-exported
// here — src/db.js reads it from the environment at call time so it is never
// captured at import, and so it stays in exactly one place.

/** GitHub Models. */
export const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

/** How many candidates we hand the LLM, and how many we surface. */
export const CANDIDATE_COUNT = Number(process.env.CANDIDATE_COUNT || 150);
export const BEST_COUNT = Number(process.env.BEST_COUNT || 30);

/**
 * Dashboard payload bounds. Postgres holds every number the carriers list (~160k),
 * but the ranked rows the dashboard renders are published as JSON, so they stay
 * bounded: `PUBLISH_PER_CARRIER` rich rows per carrier — per carrier rather than a
 * global top-N, because Etisalat's tier bonus would otherwise crowd out Vodafone's
 * whole 5.2k catalog. Every available number is still searchable in the app via the
 * compact `index.json` (~15 bytes each).
 */
export const PUBLISH_PER_CARRIER = intEnv("PUBLISH_PER_CARRIER", 7000);
/** Rows in best-ever.json (top by best_grade, available or not). */
export const BEST_EVER_LIMIT = intEnv("BEST_EVER_LIMIT", 20000);
/** Cap on the new/disappeared msisdn lists in latest.json (the counts stay exact). */
export const CHANGE_LIST_LIMIT = intEnv("CHANGE_LIST_LIMIT", 2000);
/** Delete rows gone for longer than this, so the table doesn't grow without bound. */
export const HISTORY_KEEP_DAYS = intEnv("HISTORY_KEEP_DAYS", 30);

/** A NEW number must grade >= this to trigger an alert Issue. */
export const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 90);

/** GitHub repo "owner/name", provided by Actions as GITHUB_REPOSITORY. */
export const REPO = process.env.GITHUB_REPOSITORY || "";

/** Timezone for first_seen / last_seen / age calculations. */
export const TZ = "Africa/Cairo";

/** Today's date as YYYY-MM-DD in the configured timezone. */
export function todayInTz(date = new Date()) {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Whole-day difference between two YYYY-MM-DD strings. */
export function dayDiff(fromYmd, toYmd) {
  const a = Date.parse(fromYmd + "T00:00:00Z");
  const b = Date.parse(toYmd + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Etisalat Egypt reserved-number pools API (no cookie/JSESSIONID required). */
export const ETISALAT_ENDPOINT =
  "https://www.etisalat.eg/Saytar/rest/dialReservationWS/getDials?type=GetPoolDialsRequest";
export const ETISALAT_REFERER = "https://www.etisalat.eg/eshop2/";
export const ETISALAT_APP_NAME = process.env.ETISALAT_APP_NAME || "MAB";
// NOTE: applicationName/applicationPassword are STATIC client-side gating headers
// shipped in Etisalat's public web app (etisalat.eg/eshop2) — extractable by anyone
// from browser devtools, not a private secret. Same class as the hardcoded Vodafone
// X_CONTEXT_REQUEST above. Kept as a literal default so the poller runs out-of-the-box;
// override via the ETISALAT_APP_PASSWORD env var if Etisalat rotates it.
export const ETISALAT_APP_PASSWORD =
  process.env.ETISALAT_APP_PASSWORD || "ZFZyqUpqeO9TMhXg4R/9qs0Igwg=";

/**
 * Etisalat premium pools, ordered low→high tier. `bonus` is added to a number's
 * heuristic score (capped at 100); higher bonus also wins cross-pool dedupe.
 */
export const ETISALAT_POOLS = [
  { poolId: 135, tier: "silver", bonus: 0 },
  { poolId: 136, tier: "golden", bonus: 4 },
  { poolId: 137, tier: "golden_plus", bonus: 8 },
  { poolId: 138, tier: "platinum", bonus: 12 },
  { poolId: 139, tier: "platinum_plus", bonus: 16 },
];

/**
 * Etisalat enumeration. A single `searchPattern=*` response is server-capped at
 * ~1000 numbers, so a pool of 3k+ silently looked like 1k. We walk prefixes
 * instead: query `<prefix>*`, and when a response comes back at the cap, split
 * it into ten `<prefix><digit>*` queries and recurse.
 */
export const ETISALAT_PREFIX = process.env.ETISALAT_PREFIX || "011";
/** A response at/above this length is assumed truncated (observed cap ~1000-1010). */
export const ETISALAT_RESPONSE_CAP = intEnv("ETISALAT_RESPONSE_CAP", 990);
/** Max prefix digits to append before giving up on splitting (011 + 8 = full msisdn). */
export const ETISALAT_MAX_DEPTH = intEnv("ETISALAT_MAX_DEPTH", 5);

/** Score bonus for an Etisalat operator tier slug; 0 for unknown/empty. */
export function tierBonus(tier) {
  const p = ETISALAT_POOLS.find((x) => x.tier === tier);
  return p ? p.bonus : 0;
}

/** Read a positive-integer env var, falling back to `def`; throws on invalid input. */
function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** WE Egypt (Telecom Egypt) reserved-number search API. */
export const WE_ENDPOINT =
  "https://numbers.te.eg/echannel/service/besapp/base/rest/busiservice/cz/v1/offering/queryAvailabeNumbers";

// NOTE: channelId / deviceId / whiteReqHeaderSign / whiteReqBodySign / x-init-time are STATIC
// client-side gating tokens shipped in WE's public number-booking web app (numbers.te.eg) —
// extractable by anyone from browser devtools, not private secrets. Verified: the signatures
// are constant, are NOT validated against the request body, and no cookies are required — i.e.
// gating tokens of the same class as the Vodafone X_CONTEXT_REQUEST header above. Kept as
// literal defaults so the poller runs out-of-the-box; override via env if WE rotates them
// (the poller fails closed — skips the run, preserving data — if the tokens are rejected).
export const WE_CHANNEL_ID = process.env.WE_CHANNEL_ID || "713";
export const WE_DEVICE_ID =
  process.env.WE_DEVICE_ID || "20c6209549c92db184dd5dd9e3a5156fb0d548bcb64e0a60493476bf66ce61ae";
export const WE_HEADER_SIGN =
  process.env.WE_HEADER_SIGN ||
  "885bf9e277ee3ef0bbc59126bcf484e908a07bcfe5cfd22bd3a422000118fadb43dd92863357a9b317e3f57cd8169a1824e8125cc8a3b862c2390dc2d0286d67";
export const WE_BODY_SIGN =
  process.env.WE_BODY_SIGN ||
  "a4acd02196c9ebaec68e60a5c4429c573672c9b5665ca13e87d80ce9051804991b6c78625ef4df46833fc56dcbccb25e7a96e2e981e8abc8c878e5bc21ab201a";
export const WE_INIT_TIME = process.env.WE_INIT_TIME || "1782066349291";

/** WE grade-enumeration + pagination bounds (validated positive integers). */
export const WE_GRADE_MIN = intEnv("WE_GRADE_MIN", 1);
export const WE_GRADE_MAX = intEnv("WE_GRADE_MAX", 30);
export const WE_PAGE_SIZE = intEnv("WE_PAGE_SIZE", 51);
// Observed: the deepest grade runs ~392 pages (~20k numbers); the old cap of 20
// pages (1020 numbers) truncated it by 95%. maxCount is server-pinned at 51, so
// depth is the only lever.
export const WE_MAX_PAGES = intEnv("WE_MAX_PAGES", 800);
/** Pages fetched in parallel per grade (~1150 pages total; 8 keeps a run under a minute). */
export const WE_CONCURRENCY = intEnv("WE_CONCURRENCY", 8);
if (WE_GRADE_MIN > WE_GRADE_MAX) {
  throw new Error("WE_GRADE_MIN must be <= WE_GRADE_MAX");
}

/** WE numberlevel grade slug for an integer grade, e.g. 17 -> "GRADE_017". */
export function weGradeSlug(n) {
  return "GRADE_" + String(n).padStart(3, "0");
}
