"use client";

import { useState } from "react";

/** Copy a number to the clipboard, with a brief confirmation. */
export default function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);

  async function copy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked (insecure context, permissions). Still confirm, so the button
      // does not look broken; the number is on screen to copy by hand.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${value}`}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border bg-white transition dark:bg-ink-850 ${
        copied
          ? "border-emerald-500/40 text-emerald-500"
          : "border-zinc-200 text-zinc-400 hover:border-zinc-300 hover:text-zinc-900 dark:border-white/5 dark:text-zinc-400 dark:hover:text-white"
      }`}
    >
      {copied ? (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}
