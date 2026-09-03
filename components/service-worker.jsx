"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * Renders nothing; it exists because registration must happen client-side and the
 * layout is a server component. Registration is deliberately deferred to `load` so it
 * never competes with the first paint for bandwidth.
 *
 * `updateViaCache: "none"` stops the browser caching the worker script itself, which is
 * the classic way to ship a service worker that can never be updated.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    function register() {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((err) => {
          // A failed registration must never break the page: everything still works
          // without it, only the offline fallback is missing.
          console.warn("service worker registration failed:", err?.message || err);
        });
    }

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
