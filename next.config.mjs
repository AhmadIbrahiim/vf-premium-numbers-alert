/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The app is at the repo root so Vercel auto-detects it with no Root Directory
  // setting — getting that setting wrong is a 404 with a build that produces nothing.
  turbopack: { root: import.meta.dirname },

  // Headers live here rather than in vercel.json so local `next start` behaves like
  // production. A service worker that is accidentally cached is close to unfixable for
  // anyone who already loaded it, so its headers matter more than the rest.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          // Never cache the worker itself, or an update can never reach clients.
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
