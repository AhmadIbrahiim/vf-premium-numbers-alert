/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This app is a subdirectory of a larger repo (the poller lives at the root), so pin
  // the workspace root — otherwise Turbopack walks up looking for a lockfile and warns.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
