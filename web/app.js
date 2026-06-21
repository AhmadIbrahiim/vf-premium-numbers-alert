/**
 * app.js — VF Premium Numbers Dashboard (Tailwind, light/dark, podium)
 *
 * Fetches ./latest.json and ./history.json (same-origin, no-store), then renders
 * a ranked, filterable, sortable view. Top 3 show as a podium; the rest as a list.
 * Two views: "best available now" and "best ever seen" (from history by best_grade).
 * XSS-safe: all dynamic text goes through textContent; innerHTML only for static SVG.
 */

const state = {
  latest: null,
  history: null,
  events: null, // accumulated change events from events.jsonl.json
  view: "now", // "now" | "ever" | "changes"
  filter: "",
  sort: "grade",
  carrier: "all", // "all" | "vodafone" | "etisalat"
  error: false,
  renderLimit: 300,
};

const INITIAL_RENDER_LIMIT = 300;
const RENDER_STEP = 300;

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
  return normalizedMsisdn(r?.msisdn).startsWith("011") ? "etisalat" : "vodafone";
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

/** Carrier pill (Vodafone red / Etisalat green), tier pill (Etisalat), and SIM pill (Vodafone). */
function carrierBadges(parent, row) {
  const carrier = carrierOf(row);
  if (carrier === "etisalat") {
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

async function load() {
  try {
    const [l, h, ev] = await Promise.all([
      fetch("./latest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("./history.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})),
      fetch("./events.jsonl.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
    ]);
    state.latest = l;
    state.history = h && typeof h === "object" ? h : {};
    state.events = Array.isArray(ev) ? ev : [];
    state.error = false;
  } catch {
    state.error = true;
  }
  renderHeader();
  render();
}

function bestEver() {
  const h = state.history || {};
  return Object.entries(h)
    .map(([msisdn, e]) => ({
      msisdn,
      grade: e.best_grade ?? e.score ?? 0,
      score: e.score ?? 0,
      reason: e.status === "gone" ? "no longer available" : "currently available",
      tags: e.tags || [],
      sim_type: e.sim_type || "",
      carrier: e.carrier || "",
      tier: e.tier || "",
      is_new: false,
      first_seen: e.first_seen || "",
      age_days: 0,
      status: e.status || "available",
    }))
    .sort((a, b) => b.grade - a.grade);
}

/** Merge LLM-graded best_thirty with the remaining available numbers (heuristic score only). */
function nowRows() {
  const best = (state.latest?.best_thirty || []).slice();
  const all = state.latest?.all_available;
  if (!all || !all.length) return best;
  const gradedSet = new Set(best.map((x) => x.msisdn));
  const rest = all
    .filter((a) => !gradedSet.has(a.msisdn))
    .map((a) => ({ ...a, grade: a.score, reason: "" }));
  return [...best, ...rest];
}

function currentRows() {
  if (state.view === "changes") return [];
  let rows = state.view === "now" ? nowRows() : bestEver();
  rows = rows
    .map((r) => ({ ...r, msisdn: normalizedMsisdn(r?.msisdn) }))
    .filter((r) => r.msisdn);
  if (state.carrier !== "all") rows = rows.filter((r) => carrierOf(r) === state.carrier);
  const f = state.filter.replace(/\D/g, "");
  if (f) rows = rows.filter((r) => r.msisdn.replace(/\D/g, "").includes(f));
  const by = state.sort;
  rows.sort((a, b) => {
    if (by === "new") return (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0) || b.grade - a.grade;
    if (by === "score") return (b.score || 0) - (a.score || 0);
    return (b.grade || 0) - (a.grade || 0);
  });
  return rows;
}

/**
 * Build a change row from an msisdn + type (for the timeline view).
 * Falls back through best_thirty → history for grade/tags.
 */
function buildChangeRow(msisdn, type) {
  const msisdnStr = normalizedMsisdn(msisdn);
  const h = state.history?.[msisdnStr] || {};
  const fromBest = (state.latest?.best_thirty || []).find((x) => x.msisdn === msisdnStr);
  const grade = fromBest?.grade ?? h.best_grade ?? h.score ?? 0;
  return {
    msisdn: msisdnStr,
    grade,
    score: fromBest?.score ?? h.score ?? 0,
    reason: fromBest?.reason || (type === "new" ? "newly added" : "no longer available"),
    tags: fromBest?.tags || h.tags || [],
    sim_type: fromBest?.sim_type || h.sim_type || "",
    carrier: fromBest?.carrier || h.carrier || "",
    tier: fromBest?.tier || h.tier || "",
    is_new: type === "new",
    status: type === "gone" ? "gone" : "available",
    age_days: fromBest?.age_days ?? 0,
  };
}

/**
 * Group accumulated events (from events.jsonl.json) by run timestamp.
 * Returns runs sorted most-recent-first, each with { ts, newMs[], goneMs[] }.
 * Returns null when the events file hasn't loaded yet / is empty.
 */
function changesTimeline() {
  const events = state.events;
  if (!events || !events.length) return null;
  const runs = new Map();
  for (const e of events) {
    if (!runs.has(e.ts)) runs.set(e.ts, { ts: e.ts, newMs: [], goneMs: [] });
    const r = runs.get(e.ts);
    if (e.type === "new") r.newMs.push(e.msisdn);
    else r.goneMs.push(e.msisdn);
  }
  return [...runs.values()].sort((a, b) => b.ts.localeCompare(a.ts));
}

function changesRows(type) {
  const list = type === "new" ? (state.latest?.new_msisdns || []) : (state.latest?.disappeared_msisdns || []);
  return list
    .map((msisdn) => buildChangeRow(msisdn, type))
    .filter((r) => r.msisdn)
    .sort((a, b) => (b.grade || 0) - (a.grade || 0));
}

/* ----------------------------- render ----------------------------- */

function renderHeader() {
  if (state.error || !state.latest) {
    $("updated").textContent = state.error ? "data unavailable" : "loading…";
    return;
  }
  $("updated").textContent = "updated " + relTime(state.latest.generated_at);
  $("stat-total").textContent = (state.latest.total ?? 0).toLocaleString();
  $("stat-new").textContent = "+" + (state.latest.new_count ?? 0);
  $("stat-gone").textContent = "-" + (state.latest.disappeared_count ?? 0);
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
  const base = rendered < total
    ? `${rendered}/${total} number${total === 1 ? "" : "s"}`
    : `${total} number${total === 1 ? "" : "s"}`;
  $("count").textContent = base + (filtered ? " · filtered" : "");
}

function appendLoadMore(parent, remaining) {
  if (remaining <= 0) return;
  const wrap = el("div", "mt-3 flex justify-center");
  const btn = el(
    "button",
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-white/10 dark:bg-ink-900/70 dark:text-zinc-300 dark:hover:border-white/20 dark:hover:bg-ink-850",
    `Load ${Math.min(RENDER_STEP, remaining)} more`
  );
  btn.addEventListener("click", () => {
    state.renderLimit += RENDER_STEP;
    render();
  });
  wrap.appendChild(btn);
  parent.appendChild(wrap);
}

function renderChanges() {
  const listEl = $("list");
  const podiumEl = $("podium");
  podiumEl.classList.add("hidden");
  $("empty").classList.add("hidden");
  listEl.innerHTML = "";

  const filterDigits = state.filter.replace(/\D/g, "");
  const applyFilter = (rows) => {
    let out = state.carrier === "all" ? rows : rows.filter((r) => carrierOf(r) === state.carrier);
    if (filterDigits) out = out.filter((r) => r.msisdn.replace(/\D/g, "").includes(filterDigits));
    return out;
  };

  const timeline = changesTimeline();

  // No events file yet — fall back to the current snapshot diff.
  if (!timeline) {
    const newRows = applyFilter(changesRows("new"));
    const goneRows = applyFilter(changesRows("gone"));
    const total = newRows.length + goneRows.length;
    const renderedNew = newRows.slice(0, state.renderLimit);
    const renderedGone = goneRows.slice(0, Math.max(0, state.renderLimit - renderedNew.length));
    const renderedTotal = renderedNew.length + renderedGone.length;
    renderCount(total, Boolean(filterDigits), renderedTotal);
    if (!total) {
      showEmpty("No changes in this snapshot", filterDigits ? "Try a different digit sequence." : "No newly added or gone numbers were detected.");
      return;
    }
    const frag = document.createDocumentFragment();
    const makeSection = (title, rows) => {
      const wrap = el("section", "space-y-2");
      wrap.appendChild(el("h2", "text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400", `${title} (${rows.length})`));
      if (!rows.length) {
        wrap.appendChild(el("p", "rounded-xl border border-dashed border-zinc-300 bg-white/60 px-4 py-3 text-sm text-zinc-500 dark:border-white/10 dark:bg-ink-900/50 dark:text-zinc-400", "None"));
        return wrap;
      }
      rows.forEach((r, i) => wrap.appendChild(row(r, i)));
      return wrap;
    };
    frag.appendChild(makeSection("Newly added", renderedNew));
    frag.appendChild(makeSection("Gone", renderedGone));
    listEl.appendChild(frag);
    appendLoadMore(listEl, total - renderedTotal);
    return;
  }

  // Timeline view: one section per run, most-recent first.
  let totalRows = 0;
  let renderedRows = 0;
  let remainingBudget = state.renderLimit;
  const frag = document.createDocumentFragment();

  for (const run of timeline) {
    const newRows = applyFilter(run.newMs.map((m) => buildChangeRow(m, "new")).sort((a, b) => b.grade - a.grade));
    const goneRows = applyFilter(run.goneMs.map((m) => buildChangeRow(m, "gone")).sort((a, b) => b.grade - a.grade));
    if (!newRows.length && !goneRows.length) continue;
    totalRows += newRows.length + goneRows.length;
    const shownNew = newRows.slice(0, Math.max(0, remainingBudget));
    remainingBudget -= shownNew.length;
    const shownGone = goneRows.slice(0, Math.max(0, remainingBudget));
    remainingBudget -= shownGone.length;
    if (!shownNew.length && !shownGone.length) continue;
    renderedRows += shownNew.length + shownGone.length;

    const runEl = el("div", "space-y-3 border-t border-zinc-100 pt-4 first:border-0 first:pt-0 dark:border-white/5");

    // Run header with timestamp + count badges
    const header = el("div", "flex flex-wrap items-center gap-2");
    header.appendChild(el("span", "text-xs font-semibold text-zinc-400 dark:text-zinc-500", relTime(run.ts)));
    if (shownNew.length) header.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300", `+${shownNew.length} new`));
    if (shownGone.length) header.appendChild(el("span", "rounded-md bg-zinc-400/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 ring-1 ring-zinc-400/30 dark:text-zinc-400", `-${shownGone.length} gone`));
    runEl.appendChild(header);

    if (shownNew.length) {
      const sec = el("section", "space-y-2");
      sec.appendChild(el("h3", "text-xs font-medium uppercase tracking-wide text-emerald-600/70 dark:text-emerald-400/70", `Newly added (${shownNew.length})`));
      shownNew.forEach((r, i) => sec.appendChild(row(r, i)));
      runEl.appendChild(sec);
    }
    if (shownGone.length) {
      const sec = el("section", "space-y-2");
      sec.appendChild(el("h3", "text-xs font-medium uppercase tracking-wide text-zinc-400/70 dark:text-zinc-500/70", `Gone (${shownGone.length})`));
      shownGone.forEach((r, i) => sec.appendChild(row(r, i)));
      runEl.appendChild(sec);
    }

    frag.appendChild(runEl);
  }

  if (!totalRows) {
    showEmpty("No changes recorded", filterDigits ? "Try a different digit sequence." : "No newly added or gone numbers have been detected yet.");
    $("count").textContent = "";
    return;
  }

  renderCount(totalRows, Boolean(filterDigits), renderedRows);
  listEl.appendChild(frag);
  appendLoadMore(listEl, totalRows - renderedRows);
}

function render() {
  const listEl = $("list");
  const podiumEl = $("podium");
  $("empty").classList.add("hidden");

  if (state.error) { showEmpty("Couldn't load data", "The dashboard data isn't published yet, or the network failed. It refreshes automatically."); $("count").textContent = ""; return; }
  if (!state.latest) { podiumEl.classList.add("hidden"); skeleton(); return; }
  if (state.view === "changes") { renderChanges(); return; }

  const rows = currentRows();
  const filtered = Boolean(state.filter.replace(/\D/g, ""));
  const visibleRows = rows.slice(0, state.renderLimit);
  renderCount(rows.length, filtered, visibleRows.length);

  if (rows.length === 0) { showEmpty("No matches", filtered ? "Try a different digit sequence." : "Nothing to show yet."); return; }

  // Podium for the top 3 when not filtering; the list holds the remainder.
  const usePodium = !filtered && visibleRows.length >= 3;
  podiumEl.innerHTML = "";
  if (usePodium) {
    podiumEl.className = "mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end";
    const frag = document.createDocumentFragment();
    visibleRows.slice(0, 3).forEach((r, i) => frag.appendChild(podiumCard(r, i)));
    podiumEl.appendChild(frag);
  } else {
    podiumEl.classList.add("hidden");
  }

  const rest = usePodium ? visibleRows.slice(3) : visibleRows;
  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  rest.forEach((r, idx) => frag.appendChild(row(r, usePodium ? idx + 3 : idx)));
  listEl.appendChild(frag);
  appendLoadMore(listEl, rows.length - visibleRows.length);
}

/* ----------------------------- controls ----------------------------- */

function setView(v) {
  state.view = v;
  state.renderLimit = INITIAL_RENDER_LIMIT;
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
  render();
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
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; state.renderLimit = INITIAL_RENDER_LIMIT; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; state.renderLimit = INITIAL_RENDER_LIMIT; render(); });
  $("carrier").addEventListener("change", (e) => { state.carrier = e.target.value; state.renderLimit = INITIAL_RENDER_LIMIT; render(); });
  $("theme").addEventListener("click", toggleTheme);
  setView("now");
  skeleton();
  load();
  setInterval(renderHeader, 30000);
}

wire();
