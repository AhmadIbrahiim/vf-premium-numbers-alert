/**
 * app.js — VF Premium Numbers Dashboard (Tailwind)
 *
 * Fetches ./latest.json and ./history.json (same-origin, no-store), then renders
 * a ranked, filterable, sortable view of premium Egyptian mobile numbers.
 * Two views: "best available now" (latest.best_thirty) and "best ever seen"
 * (computed from history.json by best_grade). XSS-safe: text via textContent only.
 */

const state = {
  latest: null,
  history: null,
  view: "now", // "now" | "ever"
  filter: "",
  sort: "grade",
  error: false,
};

/* ----------------------------- helpers ----------------------------- */

const $ = (id) => document.getElementById(id);

/** Format an MSISDN as 0100 000 0000 for readability. */
function fmt(m) {
  return `${m.slice(0, 4)} ${m.slice(4, 7)} ${m.slice(7)}`;
}

/** Relative time like "4 min ago". */
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

/** Grade -> Tailwind color classes {ring, text, chipBg, chipText}. */
function gradeStyle(g) {
  if (g >= 95) return { ring: "#10b981", text: "text-emerald-300", chip: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20" };
  if (g >= 90) return { ring: "#22c55e", text: "text-green-300", chip: "bg-green-500/10 text-green-300 ring-green-500/20" };
  if (g >= 85) return { ring: "#84cc16", text: "text-lime-300", chip: "bg-lime-500/10 text-lime-300 ring-lime-500/20" };
  if (g >= 80) return { ring: "#eab308", text: "text-amber-300", chip: "bg-amber-500/10 text-amber-300 ring-amber-500/20" };
  return { ring: "#f97316", text: "text-orange-300", chip: "bg-orange-500/10 text-orange-300 ring-orange-500/20" };
}

const RANK_BADGE = [
  "bg-gradient-to-br from-amber-300 to-yellow-600 text-black", // 1
  "bg-gradient-to-br from-zinc-200 to-zinc-400 text-black", // 2
  "bg-gradient-to-br from-amber-600 to-amber-800 text-white", // 3
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Circular grade ring (SVG), 0-100. */
function gradeRing(grade) {
  const { ring, text } = gradeStyle(grade);
  const r = 22, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, grade)) / 100);
  const wrap = el("div", "relative grid h-14 w-14 shrink-0 place-items-center");
  wrap.innerHTML =
    `<svg class="h-14 w-14 -rotate-90" viewBox="0 0 52 52" aria-hidden="true">` +
    `<circle cx="26" cy="26" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4"/>` +
    `<circle cx="26" cy="26" r="${r}" fill="none" stroke="${ring}" stroke-width="4" stroke-linecap="round" ` +
    `stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
  const lbl = el("span", `absolute num-tnum text-base font-bold ${text}`, String(grade));
  wrap.appendChild(lbl);
  wrap.setAttribute("aria-label", `grade ${grade} of 100`);
  return wrap;
}

/* ----------------------------- data ----------------------------- */

async function load() {
  try {
    const [l, h] = await Promise.all([
      fetch("./latest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("./history.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})),
    ]);
    state.latest = l;
    state.history = h && typeof h === "object" ? h : {};
    state.error = false;
  } catch (e) {
    state.error = true;
  }
  renderHeader();
  renderList();
}

/** Build "best ever seen" rows from history, sorted by best_grade. */
function bestEver() {
  const h = state.history || {};
  return Object.entries(h)
    .map(([msisdn, e]) => ({
      msisdn,
      grade: e.best_grade ?? e.score ?? 0,
      score: e.score ?? 0,
      reason: e.status === "gone" ? "no longer available" : "currently available",
      tags: e.tags || [],
      is_new: false,
      first_seen: e.first_seen || "",
      age_days: 0,
      status: e.status || "available",
    }))
    .sort((a, b) => b.grade - a.grade)
    .slice(0, 30);
}

function currentRows() {
  let rows = state.view === "now" ? (state.latest?.best_thirty || []).slice() : bestEver();

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

function card(row, i) {
  const gs = gradeStyle(row.grade);
  const isGone = row.status === "gone";

  const root = el(
    "div",
    "group animate-fadeUp relative flex items-center gap-4 rounded-2xl border border-white/5 bg-ink-900/60 p-4 " +
      "transition hover:border-white/10 hover:bg-ink-850 " +
      (isGone ? "opacity-60" : "")
  );
  root.style.animationDelay = `${Math.min(i * 28, 400)}ms`;
  root.setAttribute("role", "listitem");

  // rank
  const rank = el(
    "div",
    "grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold num-tnum " +
      (i < 3 ? RANK_BADGE[i] : "bg-ink-700 text-zinc-400"),
    String(i + 1)
  );

  // middle
  const mid = el("div", "min-w-0 flex-1");
  const top = el("div", "flex flex-wrap items-center gap-2");
  const number = el("span", "font-mono text-lg font-bold tracking-wide text-white num-tnum", fmt(row.msisdn));
  top.appendChild(number);

  if (row.is_new) {
    top.appendChild(el("span", "rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-500/30", "New"));
  }
  if (isGone) {
    top.appendChild(el("span", "rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400 ring-1 ring-zinc-500/30", "Gone"));
  } else if (state.view === "ever") {
    top.appendChild(el("span", "rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300/80 ring-1 ring-emerald-500/20", "Live"));
  }
  mid.appendChild(top);

  if (row.reason) mid.appendChild(el("p", "mt-0.5 truncate text-sm text-zinc-400", row.reason));

  const tags = el("div", "mt-2 flex flex-wrap gap-1.5");
  for (const t of (row.tags || []).slice(0, 5)) {
    tags.appendChild(el("span", "rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-white/5", t));
  }
  if (tags.childElementCount) mid.appendChild(tags);

  // right: meta + grade ring + copy
  const right = el("div", "flex shrink-0 items-center gap-3");
  const meta = el("div", "hidden text-right sm:block");
  meta.appendChild(el("div", "num-tnum text-xs text-zinc-500", "score " + (row.score ?? "—")));
  if (state.view === "now") {
    const age = row.age_days === 0 ? "today" : `${row.age_days}d old`;
    meta.appendChild(el("div", "text-[11px] text-zinc-600", age));
  }
  right.appendChild(meta);
  right.appendChild(gradeRing(row.grade));

  const copy = el(
    "button",
    "grid h-9 w-9 place-items-center rounded-lg border border-white/5 bg-ink-850 text-zinc-400 transition hover:text-white hover:border-white/15 focus-visible:ring-2 focus-visible:ring-vf-red/40"
  );
  copy.setAttribute("aria-label", `Copy ${row.msisdn}`);
  copy.innerHTML = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
  copy.addEventListener("click", () => {
    const done = () => {
      copy.classList.add("text-emerald-400", "border-emerald-500/40");
      copy.innerHTML = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>`;
      setTimeout(() => {
        copy.classList.remove("text-emerald-400", "border-emerald-500/40");
        copy.innerHTML = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
      }, 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(row.msisdn).then(done, done);
    else done();
  });
  right.appendChild(copy);

  root.append(rank, mid, right);
  return root;
}

function skeleton() {
  const list = $("list");
  list.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const s = el("div", "shimmer relative h-[78px] overflow-hidden rounded-2xl border border-white/5 bg-ink-900/60");
    list.appendChild(s);
  }
}

function showEmpty(title, sub) {
  $("list").innerHTML = "";
  const e = $("empty");
  e.innerHTML = "";
  e.classList.remove("hidden");
  e.appendChild(el("p", "text-sm font-semibold text-zinc-300", title));
  if (sub) e.appendChild(el("p", "mt-1 text-xs text-zinc-500", sub));
}

function renderList() {
  const list = $("list");
  const empty = $("empty");
  empty.classList.add("hidden");

  if (state.error) {
    showEmpty("Couldn't load data", "The dashboard data isn't published yet, or the network failed. It refreshes automatically.");
    $("count").textContent = "";
    return;
  }
  if (!state.latest) {
    skeleton();
    return;
  }

  const rows = currentRows();
  $("count").textContent = `${rows.length} number${rows.length === 1 ? "" : "s"}` +
    (state.filter.replace(/\D/g, "") ? " · filtered" : "");

  if (rows.length === 0) {
    showEmpty("No matches", state.filter ? "Try a different digit sequence." : "Nothing to show yet.");
    return;
  }

  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => frag.appendChild(card(r, i)));
  list.appendChild(frag);
}

/* ----------------------------- tabs / controls ----------------------------- */

function setView(v) {
  state.view = v;
  const now = v === "now";
  const tabNow = $("tab-now"), tabEver = $("tab-ever");
  tabNow.setAttribute("aria-selected", String(now));
  tabEver.setAttribute("aria-selected", String(!now));
  const on = "bg-vf-red text-white shadow";
  const off = "text-zinc-400";
  tabNow.className = `rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${now ? on : off}`;
  tabEver.className = `rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${now ? off : on}`;
  renderList();
}

function wire() {
  $("tab-now").addEventListener("click", () => setView("now"));
  $("tab-ever").addEventListener("click", () => setView("ever"));
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; renderList(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
  setView("now");
  skeleton();
  load();
  setInterval(renderHeader, 30000);
}

wire();
