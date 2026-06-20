/**
 * Central configuration. Environment variables override defaults so the same
 * code runs locally and in GitHub Actions.
 */

export const ENDPOINT =
  "https://eshop.vodafone.com.eg/ecommerce/api/catalog/commerce/phone-numbers/type/red" +
  "?cq=(simType==ESIM,simType==PHYSICAL);simFamilyType==OWNER&query=in&size=5555&page=0&shuffle=0&tariffName=";

/** Static context header that gates the API (no cookie/token required). */
export const X_CONTEXT_REQUEST = JSON.stringify({
  applicationId: "01H5FECVAV4YWT0NGQKXEN1T51",
  tenantId: "5DF1363059675161A85F576D",
});

export const USER_AGENT =
  process.env.VF_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export const REFERER = "https://eshop.vodafone.com.eg/en/lines/red/numbers";

/** Where JSON state is read from / written to (the gh-pages working copy in CI). */
export const DATA_DIR = process.env.DATA_DIR || "data";

/** GitHub Models. */
export const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

/** How many candidates we hand the LLM, and how many we surface. */
export const CANDIDATE_COUNT = Number(process.env.CANDIDATE_COUNT || 150);
export const BEST_COUNT = Number(process.env.BEST_COUNT || 30);

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
