"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CARRIERS, digitsOnly, formatInt } from "../lib/format.js";
import NumberRow from "./number-row.jsx";
import PodiumCard from "./podium-card.jsx";

const PAGE_SIZE = 60;
/** Typing shouldn't fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

const SORTS = [
  { id: "score", label: "Best score" },
  { id: "grade", label: "Best ever" },
  { id: "new", label: "Newest" },
  { id: "msisdn", label: "Number" },
];

const VIEWS = [
  { id: "now", label: "Available now" },
  { id: "ever", label: "Ever seen" },
];

/**
 * The interactive list.
 *
 * Seeded with rows the server already rendered, so the first paint has content and no
 * spinner. Every filter, sort and page after that is a fresh query against Postgres —
 * a search covers the whole ~206k catalogue, not a pre-loaded slice.
 */
export default function NumbersBrowser({ initialRows, initialTotal }) {
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [view, setView] = useState("now");
  const [carrier, setCarrier] = useState("all");
  const [sort, setSort] = useState("score");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Ignore a slow response that has been superseded by a newer request.
  const requestId = useRef(0);
  // Skip the fetch on first render: the server already gave us page one.
  const primed = useRef(false);

  const load = useCallback(
    async ({ append } = {}) => {
      const id = ++requestId.current;
      setLoading(true);
      const offset = append ? rows.length : 0;
      const params = new URLSearchParams({
        view,
        carrier,
        sort,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const digits = digitsOnly(search);
      if (digits) params.set("q", digits);

      try {
        const res = await fetch(`/api/numbers?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "request failed");
        const data = await res.json();
        if (id !== requestId.current) return; // a newer request already won
        setRows((prev) => (append ? [...prev, ...data.rows] : data.rows));
        setTotal(data.total);
        setError(null);
      } catch (err) {
        if (id === requestId.current) setError(err.message || String(err));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [view, carrier, sort, search, rows.length]
  );

  // Refetch when a filter changes; debounce only the search box.
  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      return;
    }
    const t = setTimeout(() => load(), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
    // `load` is intentionally omitted: it changes with rows.length, which would refetch
    // on every append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, carrier, sort, search]);

  const searching = Boolean(digitsOnly(search));
  const usePodium = !searching && rows.length >= 3;
  const podium = usePodium ? rows.slice(0, 3) : [];
  const rest = usePodium ? rows.slice(3) : rows;
  const remaining = Math.max(0, total - rows.length);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          className="flex items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-white/5 dark:bg-ink-850"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              type="button"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                view === v.id ? "bg-vf-red text-white shadow" : "text-zinc-500 dark:text-zinc-400"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <label className="relative ml-auto">
          <span className="sr-only">Search by digits</span>
          <input
            type="search"
            inputMode="numeric"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search any digits…"
            className="w-44 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus-visible:ring-2 focus-visible:ring-vf-red/40 dark:border-white/5 dark:bg-ink-850 dark:text-white sm:w-56"
          />
        </label>

        <select
          aria-label="Carrier"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-white/5 dark:bg-ink-850 dark:text-white"
        >
          {CARRIERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-white/5 dark:bg-ink-850 dark:text-white"
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <p className="mb-3 text-xs text-zinc-500" aria-live="polite">
        {error ? (
          <span className="text-red-500">{error}</span>
        ) : (
          <>
            {formatInt(rows.length)} of {formatInt(total)} {total === 1 ? "number" : "numbers"}
            {searching ? " · searched the whole catalogue" : ""}
            {loading ? " · loading…" : ""}
          </>
        )}
      </p>

      {podium.length ? (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
          {podium.map((r, i) => (
            <PodiumCard key={r.msisdn} row={r} rank={i} />
          ))}
        </div>
      ) : null}

      {rows.length === 0 && !loading ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-5 py-10 text-center dark:border-white/10 dark:bg-ink-900/50">
          <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">No matches</p>
          <p className="mt-1 text-xs text-zinc-500">
            {searching ? "Try a different digit sequence." : "Nothing to show for this filter."}
          </p>
        </div>
      ) : (
        <div role="list" className="space-y-2">
          {rest.map((r, i) => (
            <NumberRow key={r.msisdn} row={r} rank={usePodium ? i + 3 : i} />
          ))}
        </div>
      )}

      {remaining > 0 ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => load({ append: true })}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-xs font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-60 dark:border-white/10 dark:bg-ink-900/70 dark:text-zinc-300 dark:hover:border-white/20"
          >
            {loading ? "Loading…" : `Load ${formatInt(Math.min(PAGE_SIZE, remaining))} more`}
          </button>
        </div>
      ) : null}
    </>
  );
}
