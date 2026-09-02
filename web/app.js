/**
 * app.js — VF Premium Numbers Dashboard (Tailwind, light/dark, podium)
 *
 * Reads Postgres live through Neon's Data API (see web/db.js and web/config.js) rather
 * than published JSON snapshots: filtering, sorting and paging all happen in the
 * database, so a search covers the whole ~206k catalogue instead of a pre-computed
 * slice, and nothing on the page can be stale.
 *
 * Top 3 show as a podium; the rest as a list. Views: "best available now", "best ever
 * seen", and the recent change timeline.
 * XSS-safe: all dynamic text goes through textContent; innerHTML only for static SVG.
 */

import { fetchNumbers, fetchCounts, fetchEvents, fetchScope, isFallback, NotConfiguredError } from "./db.js";

const state = {
  rows: [],          // the page of numbers currently rendered
  total: null,       // matching rows in the database, for the count line
  counts: null,      // available-per-carrier headline
  scope: null,       // whether we are reading live or from the snapshot
  events: null,      // recent NEW/GONE events
  view: "now",       // "now" | "ever" | "changes"
  filter: "",
  sort: "grade",
  carrier: "all",    // "all" | "vodafone" | "etisalat" | "we"
  error: null,
  loading: false,
  notConfigured: false,
  shown: 0,          // how many rows have been fetched so far
};

const PAGE_SIZE = 300;
/** Debounce for the search box, so typing does not fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

/* ----------------------------- helpers ----------------------------- */

const $ = (id) => document.getElementById(id);

function normalizedMsisdn(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return "";
}

function fmt(m) {
  const msisdn = normalizedMsisdn(m);
  if (!msisdn) return "—";
  if (msisdn.length < 8) return msisdn;
  return `${msisdn.slice(0, 4)} ${msisdn.slice(4, 7)} ${msisdn.slice(7)}`;
}

const TIER_LABEL = {
  silver: "Silver",
  golden: "Golden",
  golden_plus: "Golden+",
  platinum: "Platinum",
  platinum_plus: "Platinum+",
};

/** Carrier of a row, inferring from the msisdn prefix for older data without the field. */
function carrierOf(r) {
  if (r.carrier) return r.carrier;
  const m = normalizedMsisdn(r?.msisdn);
  if (m.startsWith("015")) return "we";
  if (m.startsWith("011")) return "etisalat";
  return "vodafone";
}

/** Short label for a WE grade code, e.g. "GRADE_017" -> "G17". */
function gradeLabel(tier) {
  const m = /^GRADE_0*(\d+)$/.exec(tier || "");
  return m ? "G" + m[1] : "";
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Grade -> { ring hex, text classes (light+dark) }. */
function gradeStyle(g) {
  if (g >= 95) return { ring: "#10b981", text: "text-emerald-600 dark:text-emerald-300" };
  if (g >= 90) return { ring: "#22c55e", text: "text-green-600 dark:text-green-300" };
  if (g >= 85) return { ring: "#65a30d", text: "text-lime-600 dark:text-lime-300" };
  if (g >= 80) return { ring: "#d97706", text: "text-amber-600 dark:text-amber-300" };
  return { ring: "#ea580c", text: "text-orange-600 dark:text-orange-300" };
}

const RANK_BADGE = [
  "bg-gradient-to-br from-amber-300 to-yellow-600 text-black",
  "bg-gradient-to-br from-zinc-200 to-zinc-400 text-black",
  "bg-gradient-to-br from-amber-600 to-amber-800 text-white",
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Circular grade ring (SVG). `size` in px. Neutral track works on both themes. */
function gradeRing(grade, size = 56) {
  const { ring, text } = gradeStyle(grade);
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, grade)) / 100);
  const fs = size >= 72 ? "text-xl" : "text-base";
  const wrap = el("div", "relative grid shrink-0 place-items-center");
  wrap.style.height = wrap.style.width = `${size}px`;
  wrap.innerHTML =
    `<svg class="-rotate-90" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(125,125,125,.22)" stroke-width="4"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${ring}" stroke-width="4" stroke-linecap="round" ` +
    `stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
  wrap.appendChild(el("span", `absolute num-tnum font-bold ${fs} ${text}`, String(grade)));
  wrap.setAttribute("aria-label", `grade ${grade} of 100`);
  return wrap;
}

function copyButton(msisdn) {
  const idle = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
  const ok = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>`;
  const b = el(
    "button",
    "grid h-9 w-9 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-400 transition hover:border-zinc-300 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-vf-red/40 dark:border-white/5 dark:bg-ink-850 dark:text-zinc-400 dark:hover:border-white/15 dark:hover:text-white"
  );
  b.setAttribute("aria-label", `Copy ${msisdn}`);
  b.innerHTML = idle;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const done = () => {
      b.classList.add("text-emerald-500", "border-emerald-500/40");
      b.innerHTML = ok;
      setTimeout(() => {
        b.classList.remove("text-emerald-500", "border-emerald-500/40");
        b.innerHTML = idle;
      }, 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(msisdn).then(done, done);
    else done();
  });
  return b;
}

/** Carrier pill (Vodafone red / Etisalat green / WE purple), tier/grade pill, SIM pill (Vodafone). */
function carrierBadges(parent, row) {
  const carrier = carrierOf(row);
  if (carrier === "we") {
    parent.appendChild(el("span", "rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-700 ring-1 ring-purple-500/30 dark:text-purple-300", "WE"));
    const g = gradeLabel(row.tier);
    if (g) {
      parent.appendChild(el("span", "rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300", g));
    }
  } else if (carrier === "etisalat") {
    parent.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300", "Etisalat"));
    if (row.tier && TIER_LABEL[row.tier]) {
      parent.appendChild(el("span", "rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300", TIER_LABEL[row.tier]));
    }
  } else {
    parent.appendChild(el("span", "rounded-md bg-vf-red/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-vf-red ring-1 ring-vf-red/30 dark:text-red-300", "Vodafone"));
    if (row.sim_type === "ESIM") parent.appendChild(el("span", "rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-500/30 dark:text-indigo-300", "eSIM"));
    else if (row.sim_type === "PHYSICAL") parent.appendChild(el("span", "rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700 ring-1 ring-sky-500/30 dark:text-sky-300", "Physical"));
  }
}

function badges(parent, row) {
  if (row.is_new) parent.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300", "New"));
  if (row.status === "gone") parent.appendChild(el("span", "rounded-md bg-zinc-400/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 ring-1 ring-zinc-400/30 dark:text-zinc-400", "Gone"));
  else if (state.view === "ever") parent.appendChild(el("span", "rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700/80 ring-1 ring-emerald-500/20 dark:text-emerald-300/80", "Live"));
  carrierBadges(parent, row);
}

function tagPills(row, max) {
  const tags = el("div", "flex flex-wrap gap-1.5");
  for (const t of (row.tags || []).slice(0, max)) {
    tags.appendChild(el("span", "rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 ring-1 ring-zinc-200 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/5", t));
  }
  return tags;
}

/* ----------------------------- data ----------------------------- */

/** Map a database row onto the shape the renderers expect. */
function toRow(r) {
  const score = Number(r.score) || 0;
  const bestGrade = Number(r.best_grade) || 0;
  return {
    msisdn: normalizedMsisdn(r.msisdn),
    // "Best ever" ranks by the highest grade ever recorded; "now" by today's score.
    grade: state.view === "ever" ? bestGrade : Math.max(score, 0),
    score,
    best_grade: bestGrade,
    reason: "",
    tags: Array.isArray(r.tags) ? r.tags.filter(Boolean) : [],
    sim_type: r.sim_type || "",
    carrier: r.carrier || "",
    tier: r.tier || "",
    is_new: Boolean(r.is_new),
    first_seen: r.first_seen || "",
    age_days: Number(r.age_days) || 0,
    status: r.available === false ? "gone" : "available",
  };
}

/** Digits the user is searching for, if any. */
function searchDigits() {
  return state.filter.replace(/\D/g, "");
}

/**
 * Load a page of numbers from the database, replacing or extending the list.
 * @param {object} [opts] - { append: true } to fetch the next page
 */
async function loadNumbers({ append = false } = {}) {
  state.loading = true;
  if (!append) {
    state.rows = [];
    state.shown = 0;
    state.total = null;
  }
  render();
  try {
    const { rows, total } = await fetchNumbers({
      view: state.view,
      carrier: state.carrier,
      digits: searchDigits(),
      sort: state.sort === "grade" && state.view === "now" ? "score" : state.sort,
      limit: PAGE_SIZE,
      offset: state.shown,
    });
    const mapped = rows.map(toRow).filter((r) => r.msisdn);
    state.rows = append ? [...state.rows, ...mapped] : mapped;
    state.shown = state.rows.length;
    if (total !== null) state.total = total;
    state.error = null;
    state.notConfigured = false;
  } catch (err) {
    if (err instanceof NotConfiguredError) state.notConfigured = true;
    else state.error = err.message || String(err);
  } finally {
    state.loading = false;
    renderHeader();
    render();
  }
}

/** Whether we are reading the database live or the published snapshot. */
async function loadScope() {
  try {
    state.scope = await fetchScope();
  } catch {
    state.scope = null;
  }
  renderHeader();
  render();
}

/** Headline per-carrier counts, shown in the header. */
async function loadCounts() {
  try {
    state.counts = await fetchCounts();
  } catch (err) {
    if (err instanceof NotConfiguredError) state.notConfigured = true;
  }
  renderHeader();
}

/** The change timeline, straight from number_events. */
async function loadEvents() {
  try {
    state.events = await fetchEvents(300);
  } catch (err) {
    if (err instanceof NotConfiguredError) state.notConfigured = true;
    state.events = state.events || [];
  }
  if (state.view === "changes") render();
}

function currentRows() {
  return state.rows;
}

/** Build a renderable row from a number_events entry. */
function eventRow(e) {
  const score = Number(e.score) || 0;
  return {
    msisdn: normalizedMsisdn(e.msisdn),
    grade: score,
    score,
    reason: e.type === "new" ? "newly added" : "no longer available",
    tags: [],
    sim_type: "",
    carrier: e.carrier || "",
    tier: "",
    is_new: e.type === "new",
    status: e.type === "gone" ? "gone" : "available",
    first_seen: e.day || "",
    age_days: 0,
  };
}

/**
 * Group events by the poll that produced them, most recent first.
 * Returns null while the events have not loaded.
 */
function changesTimeline() {
  if (!state.events) return null;
  if (!state.events.length) return [];
  const runs = new Map();
  for (const e of state.events) {
    const ts = e.ts;
    if (!runs.has(ts)) runs.set(ts, { ts, newRows: [], goneRows: [] });
    const bucket = runs.get(ts);
    (e.type === "new" ? bucket.newRows : bucket.goneRows).push(eventRow(e));
  }
  for (const r of runs.values()) {
    r.newRows.sort((a, b) => b.score - a.score);
    r.goneRows.sort((a, b) => b.score - a.score);
  }
  return [...runs.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/* ----------------------------- render ----------------------------- */

function renderHeader() {
  if (state.notConfigured) { $("updated").textContent = "not connected"; return; }
  if (state.error) { $("updated").textContent = "data unavailable"; return; }
  $("updated").textContent = state.loading && !state.counts
    ? "loading…"
    : (state.scope?.live === false ? "from the latest poll" : "live from the database");
  if (state.counts) {
    $("stat-total").textContent = (state.counts.available_total ?? 0).toLocaleString();
    const byCarrier = state.counts.by_carrier || {};
    // The two smaller header stats now carry the per-carrier split, which is the thing
    // worth seeing at a glance when three catalogues of very different sizes are merged.
    $("stat-new").textContent = "VF " + (byCarrier.vodafone ?? 0).toLocaleString();
    $("stat-gone").textContent = "ET " + (byCarrier.etisalat ?? 0).toLocaleString();
  }
}

/** Full-width ranked row. */
function row(r, i) {
  const isGone = r.status === "gone";
  const root = el(
    "div",
    "group animate-fadeUp relative flex items-center gap-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-white/5 dark:bg-ink-900/60 dark:shadow-none dark:hover:border-white/10 dark:hover:bg-ink-850" +
      (isGone ? " opacity-60" : "")
  );
  root.style.animationDelay = `${Math.min(i * 24, 360)}ms`;
  root.setAttribute("role", "listitem");

  const rank = el(
    "div",
    "grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold num-tnum " +
      (i < 3 ? RANK_BADGE[i] : "bg-zinc-200 text-zinc-500 dark:bg-ink-700 dark:text-zinc-400"),
    String(i + 1)
  );

  const mid = el("div", "min-w-0 flex-1");
  const top = el("div", "flex flex-wrap items-center gap-2");
  top.appendChild(el("span", "font-mono text-lg font-bold tracking-wide text-zinc-900 num-tnum dark:text-white", fmt(r.msisdn)));
  badges(top, r);
  mid.appendChild(top);
  if (r.reason) mid.appendChild(el("p", "mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400", r.reason));
  const tags = tagPills(r, 5);
  if (tags.childElementCount) { tags.classList.add("mt-2"); mid.appendChild(tags); }

  const right = el("div", "flex shrink-0 items-center gap-3");
  const meta = el("div", "hidden text-right sm:block");
  meta.appendChild(el("div", "num-tnum text-xs text-zinc-400 dark:text-zinc-500", "score " + (r.score ?? "—")));
  if (state.view === "now") meta.appendChild(el("div", "text-[11px] text-zinc-400 dark:text-zinc-600", r.age_days === 0 ? "today" : `${r.age_days}d old`));
  right.append(meta, gradeRing(r.grade, 56), copyButton(r.msisdn));

  root.append(rank, mid, right);
  return root;
}

/** Elevated podium card for the top 3. */
function podiumCard(r, i) {
  // Classic podium: 2nd left, 1st centered + elevated, 3rd right.
  const order = ["sm:order-2 sm:-translate-y-3", "sm:order-1", "sm:order-3"][i];
  const emphasis = i === 0 ? "ring-2 ring-vf-red/40 dark:ring-vf-red/50" : "ring-1 ring-zinc-200 dark:ring-white/5";
  const root = el(
    "div",
    `group animate-fadeUp relative flex flex-col items-center gap-3 rounded-2xl border border-transparent bg-white p-5 text-center shadow-sm transition hover:shadow-md dark:bg-ink-900/70 ${emphasis} ${order}`
  );
  root.style.animationDelay = `${i * 60}ms`;

  const medal = el(
    "div",
    "grid h-8 w-8 place-items-center rounded-full text-sm font-extrabold num-tnum " + RANK_BADGE[i],
    String(i + 1)
  );
  root.appendChild(medal);
  root.appendChild(gradeRing(r.grade, i === 0 ? 80 : 68));
  root.appendChild(el("div", "font-mono text-lg font-bold tracking-wide text-zinc-900 num-tnum dark:text-white", fmt(r.msisdn)));

  const flags = el("div", "flex flex-wrap items-center justify-center gap-1.5");
  badges(flags, r);
  if (flags.childElementCount) root.appendChild(flags);

  if (r.reason) root.appendChild(el("p", "text-xs text-zinc-500 dark:text-zinc-400", r.reason));
  const tags = tagPills(r, 3);
  if (tags.childElementCount) { tags.classList.add("justify-center"); root.appendChild(tags); }
  root.appendChild(copyButton(r.msisdn));
  return root;
}

function skeleton() {
  const list = $("list");
  list.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    list.appendChild(el("div", "shimmer relative h-[78px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-white/5 dark:bg-ink-900/60"));
  }
}

function showEmpty(title, sub) {
  $("list").innerHTML = "";
  $("podium").classList.add("hidden");
  const e = $("empty");
  e.innerHTML = "";
  e.classList.remove("hidden");
  e.appendChild(el("p", "text-sm font-semibold text-zinc-700 dark:text-zinc-300", title));
  if (sub) e.appendChild(el("p", "mt-1 text-xs text-zinc-500", sub));
}

function renderCount(total, filtered, rendered = total) {
  if (state.notConfigured) { $("count").textContent = ""; return; }
  const dbTotal = state.total;
  const base = dbTotal !== null && dbTotal > rendered
    ? `${rendered.toLocaleString()} of ${dbTotal.toLocaleString()} number${dbTotal === 1 ? "" : "s"}`
    : `${rendered.toLocaleString()} number${rendered === 1 ? "" : "s"}`;
  // Be explicit about what a search actually covered: the whole table when reading the
  // database live, or only the published rows when falling back to the snapshot.
  let scope = "";
  if (filtered) {
    scope = state.scope?.live === false
      ? ` · searched the top ${(state.scope.searchable ?? 0).toLocaleString()} of ${(state.scope.total ?? 0).toLocaleString()}`
      : " · searched the whole catalogue";
  } else if (state.scope?.live === false) {
    scope = ` · top ${(state.scope.searchable ?? 0).toLocaleString()} of ${(state.scope.total ?? 0).toLocaleString()}`;
  }
  $("count").textContent = base + scope + (state.loading ? " · loading…" : "");
}

function appendLoadMore(parent, remaining) {
  if (remaining <= 0) return;
  const wrap = el("div", "mt-3 flex justify-center");
  const btn = el(
    "button",
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-white/10 dark:bg-ink-900/70 dark:text-zinc-300 dark:hover:border-white/20 dark:hover:bg-ink-850",
    state.loading ? "Loading…" : `Load ${Math.min(PAGE_SIZE, remaining).toLocaleString()} more`
  );
  btn.disabled = state.loading;
  // Each click fetches the next page from Postgres rather than revealing pre-loaded rows.
  btn.addEventListener("click", () => loadNumbers({ append: true }));
  wrap.appendChild(btn);
  parent.appendChild(wrap);
}

function renderChanges() {
  const listEl = $("list");
  const podiumEl = $("podium");
  podiumEl.classList.add("hidden");
  $("empty").classList.add("hidden");
  listEl.innerHTML = "";

  const filterDigits = searchDigits();
  const applyFilter = (rows) => {
    let out = state.carrier === "all" ? rows : rows.filter((r) => carrierOf(r) === state.carrier);
    if (filterDigits) out = out.filter((r) => r.msisdn.includes(filterDigits));
    return out;
  };

  const timeline = changesTimeline();
  if (!timeline) { skeleton(); $("count").textContent = ""; return; }

  let total = 0;
  let rendered = 0;
  const frag = document.createDocumentFragment();

  for (const run of timeline) {
    const newRows = applyFilter(run.newRows);
    const goneRows = applyFilter(run.goneRows);
    if (!newRows.length && !goneRows.length) continue;
    total += newRows.length + goneRows.length;
    rendered += newRows.length + goneRows.length;

    const runEl = el("div", "space-y-3 border-t border-zinc-100 pt-4 first:border-0 first:pt-0 dark:border-white/5");
    const header = el("div", "flex flex-wrap items-center gap-2");
    header.appendChild(el("span", "text-xs font-semibold text-zinc-400 dark:text-zinc-500", relTime(run.ts)));
    if (newRows.length) header.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300", `+${newRows.length} new`));
    if (goneRows.length) header.appendChild(el("span", "rounded-md bg-zinc-400/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 ring-1 ring-zinc-400/30 dark:text-zinc-400", `-${goneRows.length} gone`));
    runEl.appendChild(header);

    [...newRows, ...goneRows].forEach((r, i) => runEl.appendChild(row(r, i)));
    frag.appendChild(runEl);
  }

  if (!total) {
    // Clear the count too, or the previous view's total lingers beside an empty list.
    $("count").textContent = "";
    showEmpty(
      "No recent changes",
      filterDigits ? "Try a different digit sequence." : "Nothing has appeared or disappeared in the recorded window."
    );
    return;
  }

  listEl.appendChild(frag);
  renderCount(total, Boolean(filterDigits), rendered);
}

function render() {
  const listEl = $("list");
  const podiumEl = $("podium");
  $("empty").classList.add("hidden");

  if (state.notConfigured) {
    podiumEl.classList.add("hidden");
    showEmpty(
      "No data available",
      "Neither the published snapshot nor the Data API could be reached. The next poll republishes the snapshot."
    );
    $("count").textContent = "";
    return;
  }
  if (state.error) {
    podiumEl.classList.add("hidden");
    showEmpty("Couldn't load data", state.error);
    $("count").textContent = "";
    return;
  }
  if (state.view === "changes") { renderChanges(); return; }

  const rows = currentRows();
  const filtered = Boolean(searchDigits());

  if (state.loading && !rows.length) { podiumEl.classList.add("hidden"); skeleton(); $("count").textContent = "loading…"; return; }

  renderCount(state.total ?? rows.length, filtered, rows.length);

  if (!rows.length) {
    podiumEl.classList.add("hidden");
    showEmpty("No matches", filtered ? "Try a different digit sequence." : "Nothing to show yet.");
    return;
  }

  // Podium for the top 3 when not searching; the list holds the remainder.
  const usePodium = !filtered && rows.length >= 3;
  podiumEl.innerHTML = "";
  if (usePodium) {
    podiumEl.className = "mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end";
    const frag = document.createDocumentFragment();
    rows.slice(0, 3).forEach((r, i) => frag.appendChild(podiumCard(r, i)));
    podiumEl.appendChild(frag);
  } else {
    podiumEl.classList.add("hidden");
  }

  const rest = usePodium ? rows.slice(3) : rows;
  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  rest.forEach((r, idx) => frag.appendChild(row(r, usePodium ? idx + 3 : idx)));
  listEl.appendChild(frag);
  appendLoadMore(listEl, (state.total ?? rows.length) - rows.length);
}

/* ----------------------------- controls ----------------------------- */

function setView(v) {
  state.view = v;
  const now = v === "now";
  const ever = v === "ever";
  const changes = v === "changes";
  const on = "bg-vf-red text-white shadow";
  const off = "text-zinc-500 dark:text-zinc-400";
  $("tab-now").setAttribute("aria-selected", String(now));
  $("tab-ever").setAttribute("aria-selected", String(ever));
  $("tab-changes").setAttribute("aria-selected", String(changes));
  $("tab-now").className = `rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${now ? on : off}`;
  $("tab-ever").className = `rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${ever ? on : off}`;
  $("tab-changes").className = `rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${changes ? on : off}`;
  if (changes) {
    if (!state.events) loadEvents();
    render();
  } else {
    loadNumbers();
  }
}

function toggleTheme() {
  const dark = !document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch {}
}

function wire() {
  $("tab-now").addEventListener("click", () => setView("now"));
  $("tab-ever").addEventListener("click", () => setView("ever"));
  $("tab-changes").addEventListener("click", () => setView("changes"));

  // Debounced: each keystroke would otherwise be a database query.
  let searchTimer;
  $("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    clearTimeout(searchTimer);
    if (state.view === "changes") { render(); return; }
    searchTimer = setTimeout(() => loadNumbers(), SEARCH_DEBOUNCE_MS);
  });

  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; loadNumbers(); });
  $("carrier").addEventListener("change", (e) => {
    state.carrier = e.target.value;
    if (state.view === "changes") render(); else loadNumbers();
  });
  $("theme").addEventListener("click", toggleTheme);

  skeleton();
  setView("now");
  loadScope();
  loadCounts();
  loadEvents();
  // Re-read the headline periodically; the poller writes every 30 min.
  setInterval(loadCounts, 120000);
}

wire();
