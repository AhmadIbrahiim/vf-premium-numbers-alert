"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "Install app" prompt. Presents itself — it is a sheet pinned to the bottom of the
 * screen that appears on its own, not something the user has to go looking for.
 *
 * Two paths, because there is no single cross-browser way to do this:
 *
 *   - **Chromium (Android, desktop)** fires `beforeinstallprompt`. We stop the browser's
 *     own mini-infobar, keep the event, and call `prompt()` from our button. Next's own
 *     docs warn against relying on this event alone precisely because of the second case.
 *   - **iOS and iPadOS** fire no such event in any browser — every engine there is
 *     WebKit, and installing is only possible through Share → Add to Home Screen. So
 *     there the sheet shows those steps directly; there is no dialog to open, which is
 *     why the steps are the content rather than hidden behind a "how" button.
 *
 * The one thing this cannot do is open the native install dialog by itself: Chromium
 * ignores a `prompt()` that is not tied to a user gesture, permanently. So the sheet
 * appears unprompted and the button inside it opens the real dialog.
 *
 * Restraint still matters. It is suppressed when already installed, held back for
 * APPEAR_DELAY_MS so it never competes with the first paint, and a dismissal is
 * remembered for DISMISS_DAYS.
 */

const DISMISS_KEY = "eg-numbers:install-dismissed-at";
const DISMISS_DAYS = 14;
/** Long enough that the page is read first, short enough to still be seen. */
const APPEAR_DELAY_MS = 2500;

/** Already running as an installed app? Then there is nothing to offer. */
function isInstalled() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    // iOS Safari's own non-standard flag.
    window.navigator.standalone === true
  );
}

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    if (!at) return false;
    return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    // Private mode: treat as not dismissed rather than hiding the feature entirely.
    return false;
  }
}

export default function InstallPrompt() {
  // Starts hidden and is only ever shown from an effect, so the server render and the
  // first client render agree on rendering nothing.
  const [visible, setVisible] = useState(false);
  const [promptEvent, setPromptEvent] = useState(null);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (isInstalled() || dismissedRecently()) return;

    // Apple detection is by necessity user-agent based: there is no feature to test for,
    // because the capability we need (an install event) does not exist there at all.
    const ua = window.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    // iPadOS 13+ reports itself as a Mac; a touch-capable "Mac" is really an iPad.
    const iPadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;

    let timer;
    // Deliberately not gated on Safari: Chrome and Firefox on iOS are WebKit too and
    // offer the same Share → Add to Home Screen, so gating on Safari would leave them
    // with no path at all.
    if (ios || iPadOs) {
      setIsIos(true);
      timer = setTimeout(() => setVisible(true), APPEAR_DELAY_MS);
      return () => clearTimeout(timer);
    }

    function onBeforeInstallPrompt(e) {
      // Suppress the browser's mini-infobar so there is only one prompt on screen.
      e.preventDefault();
      setPromptEvent(e);
      timer = setTimeout(() => setVisible(true), APPEAR_DELAY_MS);
    }

    function onInstalled() {
      setVisible(false);
      setPromptEvent(null);
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch {}
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Reserve room at the end of the page while the sheet is up; see globals.css.
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add("install-prompt-open");
    return () => document.body.classList.remove("install-prompt-open");
  }, [visible]);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return;
    // The event is single-use whatever happens, so it is dropped in every branch —
    // including a rejection, which otherwise leaves the button live but inert.
    setPromptEvent(null);
    try {
      promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === "dismissed") dismiss();
      else setVisible(false);
    } catch (err) {
      // An already-consumed or invalidated event: hide the sheet rather than leave a
      // button that silently does nothing.
      console.warn("install prompt failed:", err?.message || err);
      setVisible(false);
    }
  }, [promptEvent, dismiss]);

  if (!visible) return null;

  return (
    // Fixed, so it costs the page no layout space at any width — as an inline banner it
    // pushed the content down by ~190px on a 320px screen. pb picks up the iOS home-bar
    // inset when running standalone.
    <div
      role="dialog"
      aria-label="Install this app"
      className="fixed inset-x-0 bottom-0 z-50 animate-fadeUp p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem] sm:p-0"
    >
      <div className="rounded-2xl border border-zinc-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-white/10 dark:bg-ink-850/95">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-vf-red text-[13px] font-extrabold text-white"
          >
            EG
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-zinc-900 dark:text-white">
              Install EG Numbers
            </p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400">
              {isIos
                ? "Add it to your home screen for full-screen access."
                : "Get full-screen access from your home screen."}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss install prompt"
            className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-white/5 dark:hover:text-white"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {isIos ? (
          // No dialog exists to open on iOS, so the steps are shown outright rather
          // than hidden behind another tap.
          <ol className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3 text-[12.5px] text-zinc-600 dark:border-white/[0.06] dark:text-zinc-300">
            <li className="flex gap-2">
              <span aria-hidden="true" className="font-semibold text-zinc-400">1.</span>
              <span>
                Tap the <strong className="font-semibold">Share</strong> button in the browser toolbar.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="font-semibold text-zinc-400">2.</span>
              <span>
                Choose <strong className="font-semibold">Add to Home Screen</strong>.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="font-semibold text-zinc-400">3.</span>
              <span>
                Tap <strong className="font-semibold">Add</strong>.
              </span>
            </li>
          </ol>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={install}
              className="min-h-[44px] flex-1 rounded-xl bg-zinc-900 px-4 text-[13px] font-semibold text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Install
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="min-h-[44px] rounded-xl px-4 text-[13px] font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-white"
            >
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
