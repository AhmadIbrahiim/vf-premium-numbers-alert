/**
 * app.js — VF Premium Numbers Dashboard
 *
 * Fetches ./latest.json and ./history.json (same-origin, no-store cache),
 * then renders a ranked list of premium Egyptian mobile numbers.
 *
 * Two views:
 *   "best-now"   → latest.best_thirty, available numbers only
 *   "best-ever"  → history.json top-30 by best_grade, any status
 *
 * No frameworks, no build step, no external network requests.
 */

"use strict";

/* ================================================================
   STATE
   ================================================================ */

/** @type {{ latest: LatestData|null, history: HistoryMap|null, error: string|null, loading: boolean }} */
const state = {
  latest:  null,
  history: null,
  error:   null,
  loading: true,
};

/** @type {{ view: "best-now"|"best-ever", filter: string, sort: "grade"|"score"|"newest" }} */
const ui = {
  view:   "best-now",
  filter: "",
  sort:   "grade",
};

/* ================================================================
   TYPE DOCUMENTATION (JSDoc only — no runtime impact)
   ================================================================

   @typedef {{
     generated_at: string,
     total: number,
     new_count: number,
     disappeared_count: number,
     best_thirty: BestEntry[]
   }} LatestData

   @typedef {{
     msisdn: string,
     score: number,
     grade: number,
     reason: string,
     is_new: boolean,
     first_seen: string,
     age_days: number,
     tags: string[]
   }} BestEntry

   @typedef {Record<string, HistoryEntry>} HistoryMap

   @typedef {{
     first_seen: string,
     last_seen: string,
     score: number,
     tags: string[],
     best_grade: number,
     status: "available"|"gone"
   }} HistoryEntry
*/

/* ================================================================
   DATA LOADING
   ================================================================ */

/**
 * Fetch a JSON file with cache bypassed.
 * Returns the parsed object or throws on non-200 / network error.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Load both data files concurrently and populate state.
 * Never throws — sets state.error on failure.
 */
async function loadData() {
  state.loading = true;
  state.error   = null;
  render();

  try {
    const [latest, history] = await Promise.all([
      fetchJSON("./latest.json"),
      fetchJSON("./history.json"),
    ]);

    // Basic shape validation so downstream code can trust the data
    if (!latest || typeof latest !== "object") throw new Error("latest.json has unexpected shape");
    if (!history || typeof history !== "object") throw new Error("history.json has unexpected shape");

    state.latest  = /** @type {LatestData} */ (latest);
    state.history = /** @type {HistoryMap} */ (history);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  state.loading = false;
  render();
}

/* ================================================================
   DATA HELPERS
   ================================================================ */

/**
 * Format an 11-digit Egyptian MSISDN as "0100 000 0000".
 * Falls back to the raw string for unexpected formats.
 * @param {string} msisdn
 * @returns {string}
 */
function formatMsisdn(msisdn) {
  // Standard Egyptian mobile: 01X + 8 digits → "01X0 XXX XXXX"
  const m = String(msisdn).replace(/\D/g, "");
  if (m.length === 11) {
    return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
  }
  return msisdn;
}

/**
 * Return a human-readable relative time string from an ISO timestamp.
 * e.g. "3 min ago", "2 h ago", "just now"
 * @param {string} isoStr
 * @returns {string}
 */
function relativeTime(isoStr) {
  const diffMs  = Date.now() - new Date(isoStr).getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60)   return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60)   return `${diffMin} min ago`;
  const diffH   = Math.round(diffMin / 60);
  if (diffH < 24)     return `${diffH} h ago`;
  const diffD   = Math.round(diffH / 24);
  return `${diffD} d ago`;
}

/**
 * Map a numeric grade (0–100) to a CSS class suffix for colour coding.
 * @param {number} grade
 * @returns {string}
 */
function gradeClass(grade) {
  if (grade >= 90) return "grade-90";
  if (grade >= 75) return "grade-75";
  if (grade >= 60) return "grade-60";
  if (grade >= 45) return "grade-45";
  return "grade-lo";
}

/**
 * Return age description: "Xd old" or "today".
 * @param {number|undefined} ageDays
 * @param {string|undefined} firstSeen
 * @returns {string}
 */
function ageLabel(ageDays, firstSeen) {
  if (ageDays !== undefined && ageDays !== null) {
    return ageDays === 0 ? "today" : `${ageDays}d old`;
  }
  if (firstSeen) {
    const days = Math.round((Date.now() - new Date(firstSeen).getTime()) / 86400000);
    return days === 0 ? "today" : `${days}d old`;
  }
  return "";
}

/**
 * Compute the "best ever" list from history.json:
 * Top 30 entries sorted by best_grade desc.
 * @param {HistoryMap} history
 * @returns {Array<{ msisdn: string, best_grade: number, score: number, tags: string[], status: string, first_seen: string }>}
 */
function computeBestEver(history) {
  return Object.entries(history)
    .map(([msisdn, entry]) => ({ msisdn, ...entry }))
    .sort((a, b) => b.best_grade - a.best_grade)
    .slice(0, 30);
}

/**
 * Apply the current filter + sort to an array of best_thirty entries.
 * @param {BestEntry[]} entries
 * @returns {BestEntry[]}
 */
function filterAndSortBestNow(entries) {
  let result = entries;

  if (ui.filter.trim()) {
    // Filter by raw digits only — strip spaces so "0100 000" matches "01000001234"
    const needle = ui.filter.replace(/\D/g, "");
    result = result.filter(e => String(e.msisdn).includes(needle));
  }

  if (ui.sort === "score") {
    result = [...result].sort((a, b) => b.score - a.score);
  } else if (ui.sort === "newest") {
    result = [...result].sort((a, b) => (a.age_days ?? 999) - (b.age_days ?? 999));
  }
  // "grade" (default) keeps the server-ranked order unless filtered

  return result;
}

/**
 * Apply the current filter + sort to the best-ever list.
 * @param {ReturnType<typeof computeBestEver>} entries
 * @returns {ReturnType<typeof computeBestEver>}
 */
function filterAndSortBestEver(entries) {
  let result = entries;

  if (ui.filter.trim()) {
    const needle = ui.filter.replace(/\D/g, "");
    result = result.filter(e => String(e.msisdn).includes(needle));
  }

  if (ui.sort === "score") {
    result = [...result].sort((a, b) => b.score - a.score);
  } else if (ui.sort === "newest") {
    result = [...result].sort((a, b) =>
      new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime()
    );
  }
  // "grade" keeps best_grade desc order

  return result;
}

/* ================================================================
   CLIPBOARD
   ================================================================ */

/**
 * Copy text to clipboard and briefly flash the button as "Copied".
 * @param {string} text
 * @param {HTMLButtonElement} btn
 */
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1800);
  }).catch(() => {
    // Fallback for environments without clipboard API
    btn.textContent = "Error";
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  });
}

/* ================================================================
   RENDER HELPERS — return DOM nodes, never strings (XSS safe)
   ================================================================ */

/**
 * Create a DOM element with optional properties.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build a single number card DOM node for the "best now" view.
 * @param {BestEntry} entry
 * @param {number} rank  1-based
 * @returns {HTMLElement}
 */
function buildBestNowCard(entry, rank) {
  const card = el("article", {
    className: "number-card",
    role: "listitem",
    "aria-label": `Rank ${rank}: ${formatMsisdn(entry.msisdn)}, grade ${entry.grade}`,
  });

  // --- Rank
  const rankEl = el("div", { className: `card-rank${rank <= 3 ? " rank-top" : ""}` }, `#${rank}`);
  card.appendChild(rankEl);

  // --- Body
  const body = el("div", { className: "card-body" });

  const topRow = el("div", { className: "card-top-row" });

  const msisdnEl = el("span", { className: "card-msisdn" }, formatMsisdn(entry.msisdn));
  topRow.appendChild(msisdnEl);

  if (entry.is_new) {
    topRow.appendChild(el("span", { className: "badge-new", role: "status" }, "NEW"));
  }

  const age = ageLabel(entry.age_days, entry.first_seen);
  if (age) {
    topRow.appendChild(el("span", { className: "card-age" }, age));
  }

  body.appendChild(topRow);

  if (entry.reason) {
    body.appendChild(el("p", { className: "card-reason" }, entry.reason));
  }

  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    const tagsEl = el("div", { className: "card-tags", role: "list", "aria-label": "Pattern tags" });
    for (const tag of entry.tags) {
      tagsEl.appendChild(el("span", { className: "tag-pill", role: "listitem" }, tag));
    }
    body.appendChild(tagsEl);
  }

  card.appendChild(body);

  // --- Right column
  const right = el("div", { className: "card-right" });

  const badge = el("div", {
    className: `grade-badge ${gradeClass(entry.grade)}`,
    role: "img",
    "aria-label": `Grade ${entry.grade}`,
  }, String(entry.grade));
  right.appendChild(badge);

  right.appendChild(el("div", { className: "grade-sub" }, `score ${entry.score}`));

  const copyBtn = /** @type {HTMLButtonElement} */ (el("button", {
    className: "copy-btn",
    type: "button",
    "aria-label": `Copy number ${formatMsisdn(entry.msisdn)}`,
    title: "Copy to clipboard",
  }, "Copy"));
  copyBtn.addEventListener("click", () => copyToClipboard(entry.msisdn, copyBtn));
  right.appendChild(copyBtn);

  card.appendChild(right);
  return card;
}

/**
 * Build a single number card DOM node for the "best ever" view.
 * @param {{ msisdn: string, best_grade: number, score: number, tags: string[], status: string, first_seen: string }} entry
 * @param {number} rank  1-based
 * @returns {HTMLElement}
 */
function buildBestEverCard(entry, rank) {
  const isGone = entry.status === "gone";
  const card = el("article", {
    className: `number-card${isGone ? " is-gone" : ""}`,
    role: "listitem",
    "aria-label": `Rank ${rank}: ${formatMsisdn(entry.msisdn)}, best grade ${entry.best_grade}, status ${entry.status}`,
  });

  // Rank
  card.appendChild(el("div", {
    className: `card-rank${rank <= 3 ? " rank-top" : ""}`,
  }, `#${rank}`));

  // Body
  const body = el("div", { className: "card-body" });
  const topRow = el("div", { className: "card-top-row" });

  topRow.appendChild(el("span", { className: "card-msisdn" }, formatMsisdn(entry.msisdn)));

  if (isGone) {
    topRow.appendChild(el("span", { className: "badge-gone" }, "GONE"));
  } else {
    topRow.appendChild(el("span", { className: "badge-new" }, "LIVE"));
  }

  const age = ageLabel(undefined, entry.first_seen);
  if (age) {
    topRow.appendChild(el("span", { className: "card-age" }, age));
  }

  body.appendChild(topRow);

  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    const tagsEl = el("div", { className: "card-tags", role: "list", "aria-label": "Pattern tags" });
    for (const tag of entry.tags) {
      tagsEl.appendChild(el("span", { className: "tag-pill", role: "listitem" }, tag));
    }
    body.appendChild(tagsEl);
  }

  card.appendChild(body);

  // Right
  const right = el("div", { className: "card-right" });
  const badge = el("div", {
    className: `grade-badge ${gradeClass(entry.best_grade)}`,
    role: "img",
    "aria-label": `Best grade ${entry.best_grade}`,
  }, String(entry.best_grade));
  right.appendChild(badge);
  right.appendChild(el("div", { className: "grade-sub" }, `score ${entry.score}`));

  const copyBtn = /** @type {HTMLButtonElement} */ (el("button", {
    className: "copy-btn",
    type: "button",
    "aria-label": `Copy number ${formatMsisdn(entry.msisdn)}`,
  }, "Copy"));
  copyBtn.addEventListener("click", () => copyToClipboard(entry.msisdn, copyBtn));
  right.appendChild(copyBtn);

  card.appendChild(right);
  return card;
}

/**
 * Build the skeleton loading cards (3 placeholder cards).
 * @returns {DocumentFragment}
 */
function buildSkeletons() {
  const frag = document.createDocumentFragment();
  const wrap = el("div", { className: "skeleton-list", "aria-label": "Loading numbers…", role: "status" });
  for (let i = 0; i < 5; i++) {
    wrap.appendChild(el("div", { className: "skeleton-card" }));
  }
  frag.appendChild(wrap);
  return frag;
}

/**
 * Build the error state DOM node.
 * @param {string} message
 * @returns {HTMLElement}
 */
function buildErrorState(message) {
  const wrap = el("div", { className: "state-message", role: "alert" });
  wrap.appendChild(el("span", { className: "state-icon", "aria-hidden": "true" }, "⚠️"));
  wrap.appendChild(el("h2", {}, "Could not load data"));
  wrap.appendChild(el("p", {}, `${message}. The data files may not exist yet — the scraper runs every ~10–20 minutes.`));

  const btn = /** @type {HTMLButtonElement} */ (el("button", {
    className: "retry-btn",
    type: "button",
    "aria-label": "Retry loading data",
  }, "Try again"));
  btn.addEventListener("click", loadData);
  wrap.appendChild(btn);

  return wrap;
}

/**
 * Build the empty-results state DOM node.
 * @param {string} context  e.g. "best-now" or "best-ever"
 * @returns {HTMLElement}
 */
function buildEmptyState(context) {
  const wrap = el("div", { className: "state-message" });
  wrap.appendChild(el("span", { className: "state-icon", "aria-hidden": "true" }, "🔍"));
  wrap.appendChild(el("h2", {}, "No numbers found"));
  const msg = context === "filter"
    ? "No numbers match your filter. Try different digits."
    : "No data available yet. Check back shortly.";
  wrap.appendChild(el("p", {}, msg));
  return wrap;
}

/* ================================================================
   MAIN RENDER
   ================================================================ */

/**
 * Update the header stats and timestamp from latest.json data.
 */
function renderHeader() {
  const updated  = document.getElementById("last-updated");
  const total    = document.getElementById("stat-total");
  const newCount = document.getElementById("stat-new");
  const goneCount= document.getElementById("stat-gone");

  if (state.latest) {
    if (updated)  {
      const timeEl = updated.querySelector("span");
      if (timeEl) timeEl.textContent = relativeTime(state.latest.generated_at);
    }
    if (total)     total.textContent     = String(state.latest.total);
    if (newCount)  newCount.textContent  = `+${state.latest.new_count}`;
    if (goneCount) goneCount.textContent = `-${state.latest.disappeared_count}`;
  } else {
    if (updated) {
      const timeEl = updated.querySelector("span");
      if (timeEl) timeEl.textContent = "—";
    }
    if (total)     total.textContent     = "—";
    if (newCount)  newCount.textContent  = "—";
    if (goneCount) goneCount.textContent = "—";
  }
}

/**
 * Replace the content of the main list area with current view.
 */
function renderList() {
  const container = document.getElementById("list-container");
  if (!container) return;

  // Clear previous content
  while (container.firstChild) container.removeChild(container.firstChild);

  const countEl = document.getElementById("results-count");

  // Loading state
  if (state.loading) {
    container.appendChild(buildSkeletons());
    if (countEl) countEl.textContent = "";
    return;
  }

  // Error state
  if (state.error) {
    container.appendChild(buildErrorState(state.error));
    if (countEl) countEl.textContent = "";
    return;
  }

  // No data at all
  if (!state.latest && !state.history) {
    container.appendChild(buildEmptyState("data"));
    if (countEl) countEl.textContent = "";
    return;
  }

  if (ui.view === "best-now") {
    renderBestNow(container, countEl);
  } else {
    renderBestEver(container, countEl);
  }
}

/**
 * Render the "Best available now" view.
 * @param {HTMLElement} container
 * @param {HTMLElement|null} countEl
 */
function renderBestNow(container, countEl) {
  if (!state.latest) {
    container.appendChild(buildEmptyState("data"));
    if (countEl) countEl.textContent = "";
    return;
  }

  const raw     = state.latest.best_thirty || [];
  const entries = filterAndSortBestNow(raw);

  if (countEl) {
    countEl.textContent = entries.length === raw.length
      ? `${entries.length} numbers`
      : `${entries.length} of ${raw.length} numbers`;
  }

  if (entries.length === 0) {
    container.appendChild(buildEmptyState(ui.filter ? "filter" : "data"));
    return;
  }

  const list = el("div", { className: "number-list", role: "list", "aria-label": "Best available numbers" });
  entries.forEach((entry, i) => list.appendChild(buildBestNowCard(entry, i + 1)));
  container.appendChild(list);
}

/**
 * Render the "Best ever seen" view from history.json.
 * @param {HTMLElement} container
 * @param {HTMLElement|null} countEl
 */
function renderBestEver(container, countEl) {
  if (!state.history) {
    container.appendChild(buildEmptyState("data"));
    if (countEl) countEl.textContent = "";
    return;
  }

  const raw     = computeBestEver(state.history);
  const entries = filterAndSortBestEver(raw);

  if (countEl) {
    countEl.textContent = entries.length === raw.length
      ? `${entries.length} numbers`
      : `${entries.length} of ${raw.length} numbers`;
  }

  if (entries.length === 0) {
    container.appendChild(buildEmptyState(ui.filter ? "filter" : "data"));
    return;
  }

  const list = el("div", { className: "number-list", role: "list", "aria-label": "Best ever seen numbers" });
  entries.forEach((entry, i) => list.appendChild(buildBestEverCard(entry, i + 1)));
  container.appendChild(list);
}

/**
 * Full render pass — header + list.
 */
function render() {
  renderHeader();
  renderList();
}

/* ================================================================
   EVENT WIRING
   ================================================================ */

/**
 * Attach all interactive UI event listeners.
 * Called once after DOMContentLoaded.
 */
function wireEvents() {
  // Tab buttons
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view");
      if (view === "best-now" || view === "best-ever") {
        ui.view = view;
        tabBtns.forEach(b => b.setAttribute("aria-selected", "false"));
        btn.setAttribute("aria-selected", "true");
        renderList();
      }
    });
  });

  // Filter input — debounced slightly for UX
  let filterTimer = 0;
  const filterInput = document.getElementById("filter-input");
  if (filterInput) {
    filterInput.addEventListener("input", (e) => {
      clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => {
        ui.filter = /** @type {HTMLInputElement} */ (e.target).value;
        renderList();
      }, 150);
    });
  }

  // Sort select
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      if (v === "grade" || v === "score" || v === "newest") {
        ui.sort = v;
        renderList();
      }
    });
  }
}

/* ================================================================
   INIT
   ================================================================ */

/**
 * Entry point — runs once the DOM is ready.
 */
document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  loadData();

  // Refresh the "updated X min ago" timestamp every 30 seconds
  // so it stays accurate without reloading data
  setInterval(renderHeader, 30_000);
});
