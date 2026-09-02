/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The app is at the repo root so Vercel auto-detects it with no Root Directory
  // setting — getting that setting wrong is a 404 with a build that produces nothing.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
