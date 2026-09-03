"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "Install app" prompt.
 *
 * Two paths, because there is no single cross-browser way to do this:
 *
 *   - **Chromium (Android, desktop)** fires `beforeinstallprompt`. We stop the browser's
 *     own mini-infobar, keep the event, and call `prompt()` from our button. Next's own
 *     docs warn against relying on this event alone precisely because of the second case.
 *   - **iOS Safari** has no such event and never will; installation is only possible
 *     through Share → Add to Home Screen. All we can do is show those instructions, so
 *     that is exactly what we do — and only on iOS, where they are true.
 *
 * Restraint matters more than reach here. The prompt is suppressed when already
 * installed, and a dismissal is remembered for DISMISS_DAYS so the app does not nag.
 * The browser also permanently ignores a `prompt()` call that is not tied to a user
 * gesture, which is the other reason this is a button rather than something automatic.
 */

const DISMISS_KEY = "eg-numbers:install-dismissed-at";
const DISMISS_DAYS = 14;

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
  // `null` until mounted, so the server and the first client render agree.
  const [visible, setVisible] = useState(false);
  const [promptEvent, setPromptEvent] = useState(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (isInstalled() || dismissedRecently()) return;

    // iOS detection is by necessity user-agent based: there is no feature to test for,
    // because the capability we need (an install event) simply does not exist there.
    const ua = window.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    // iPadOS 13+ reports itself as a Mac; a touch-capable "Mac" is really an iPad.
    const iPadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    const appleMobile = ios || iPadOs;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);

    if (appleMobile && isSafari) {
      setIsIos(true);
      setVisible(true);
      return;
    }

    function onBeforeInstallPrompt(e) {
      // Suppress the browser's mini-infobar so there is only one prompt on screen.
      e.preventDefault();
      setPromptEvent(e);
      setVisible(true);
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
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    setShowIosHelp(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
  }, []);

  const install = useCallback(async () => {
    if (isIos) {
      setShowIosHelp((v) => !v);
      return;
    }
    if (!promptEvent) return;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    // The event is single-use whatever the answer, so drop it either way.
    setPromptEvent(null);
    if (outcome === "dismissed") dismiss();
    else setVisible(false);
  }, [isIos, promptEvent, dismiss]);

  if (!visible) return null;

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-vf-red text-[11px] font-extrabold text-white">
          EG
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
          <span className="font-semibold text-zinc-900 dark:text-white">Install the app</span>{" "}
          for full-screen access from your home screen.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={install}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {isIos ? "How" : "Install"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss install prompt"
            className="rounded-md px-2 py-1.5 text-[12px] font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-white"
          >
            Not now
          </button>
        </div>
      </div>

      {showIosHelp ? (
        <ol className="mt-3 space-y-1 border-t border-zinc-100 pt-3 text-[12px] text-zinc-600 dark:border-white/[0.06] dark:text-zinc-300">
          <li>
            1. Tap the <strong>Share</strong> button in Safari&apos;s toolbar.
          </li>
          <li>
            2. Scroll down and choose <strong>Add to Home Screen</strong>.
          </li>
          <li>
            3. Tap <strong>Add</strong>.
          </li>
        </ol>
      ) : null}
    </div>
  );
}
