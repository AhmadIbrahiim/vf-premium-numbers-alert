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
 *
 * Production only. Service workers do run on localhost, but dev `/_next/static/` URLs
 * are rebuilt without changing name, so caching them cache-first serves stale chunks
 * and breaks hot reload. In dev we actively unregister instead, because a worker
 * installed once keeps controlling localhost across every future dev session.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then(
        (regs) => regs.forEach((r) => r.unregister()),
        () => {}
      );
      return;
    }

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
