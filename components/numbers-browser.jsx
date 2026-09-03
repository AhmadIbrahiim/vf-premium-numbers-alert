"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CARRIERS, digitsOnly, formatInt } from "../lib/format.js";
import NumberRow from "./number-row.jsx";
import TopPick from "./top-pick.jsx";

const PAGE_SIZE = 60;
/** Typing shouldn't fire a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

const SORTS = [
  { id: "score", label: "Best first" },
  { id: "new", label: "Newest first" },
  { id: "msisdn", label: "Numerically" },
];

const VIEWS = [
  { id: "now", label: "Available" },
  { id: "ever", label: "Ever seen" },
];

/**
 * The interactive list.
 *
 * Seeded with rows the server already rendered, so the first paint has content and no
 * spinner. Every filter, sort and page after that is a fresh query against Postgres —
 * a search covers the whole ~205k catalogue, not a pre-loaded slice.
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
  // Only crown a top pick on the default view — under a search or a non-score sort the
  // first row is not "the best", so calling it that would be a lie.
  const hero = !searching && sort === "score" && view === "now" ? rows[0] : null;
  const listRows = hero ? rows.slice(1) : rows;
  const remaining = Math.max(0, total - rows.length);

  // min-h-[44px] on touch, tightened at sm: where there is a pointer. The selects and
  // the search box were 32-34px tall, below every touch-target guideline.
  const control =
    "min-h-[44px] rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200 sm:min-h-0 sm:rounded-md sm:px-2.5 sm:py-1.5";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Phone order: tabs, search, then the two selects side by side. */}
        <div role="tablist" className="flex w-full items-center gap-0.5 rounded-lg border border-zinc-200 p-1 dark:border-white/10 sm:w-auto sm:rounded-md sm:p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              type="button"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={`min-h-[44px] flex-1 rounded-md px-2.5 text-[13px] font-medium transition sm:min-h-0 sm:flex-none sm:rounded sm:py-1 ${
                view === v.id
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <label className="relative w-full sm:ml-auto sm:w-auto">
          <span className="sr-only">Search by digits</span>
          <input
            type="search"
            inputMode="numeric"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search any digits"
            className={`${control} w-full placeholder-zinc-400 focus-visible:ring-2 focus-visible:ring-zinc-400/40 sm:w-52`}
          />
        </label>

        <select aria-label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} className={`${control} flex-1 sm:flex-none`}>
          {CARRIERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>

        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className={`${control} flex-1 sm:flex-none`}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <p className="mb-3 text-[12px] text-zinc-500" aria-live="polite">
        {error ? (
          <span className="text-red-500">{error}</span>
        ) : (
          <>
            {formatInt(rows.length)} of {formatInt(total)} {total === 1 ? "number" : "numbers"}
            {searching ? " · searched every number" : ""}
            {loading ? " · loading" : ""}
          </>
        )}
      </p>

      {hero ? <TopPick row={hero} /> : null}

      {rows.length === 0 && !loading ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-5 py-12 text-center dark:border-white/10">
          <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">No matches</p>
          <p className="mt-1 text-[12px] text-zinc-500">
            {searching ? "Try a different digit sequence." : "Nothing to show for this filter."}
          </p>
        </div>
      ) : (
        <div role="list" className="space-y-1.5">
          {listRows.map((r, i) => (
            <NumberRow key={r.msisdn} row={r} rank={hero ? i + 1 : i} />
          ))}
        </div>
      )}

      {remaining > 0 ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => load({ append: true })}
            className="min-h-[44px] rounded-lg border border-zinc-300 px-5 text-[13px] font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-60 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/5"
          >
            {loading ? "Loading" : `Show ${formatInt(Math.min(PAGE_SIZE, remaining))} more`}
          </button>
        </div>
      ) : null}
    </>
  );
}
