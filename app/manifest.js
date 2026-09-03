/**
 * Web App Manifest, served at /manifest.webmanifest by Next's metadata route.
 *
 * Installability needs all of: a manifest with name, a 192px and a 512px icon,
 * a display mode, and HTTPS. Miss any one and the browser silently refuses to offer
 * installation, with no error anywhere.
 */
export default function manifest() {
  return {
    name: "Egypt Premium Numbers",
    // Home screens truncate around 12 characters, so this is not just the name again.
    short_name: "EG Numbers",
    description:
      "Every premium mobile number listed by Vodafone, Etisalat and WE Egypt, scored by digit pattern and refreshed continuously.",
    start_url: "/",
    // Installed app opens without browser chrome; falls back to a normal tab where
    // standalone is unsupported.
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait-primary",
    // Matches the light-theme page background so there is no flash on launch.
    background_color: "#fafafa",
    theme_color: "#e60000",
    scope: "/",
    lang: "en",
    dir: "ltr",
    categories: ["utilities", "shopping"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate maskable entries: Android crops icons to the device silhouette, and a
      // "any maskable" icon gets clipped in one of the two roles. Keeping them apart
      // means neither the glyph nor the padding is wrong.
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Changes", short_name: "Changes", url: "/changes" },
      { name: "Provider status", short_name: "Status", url: "/status" },
    ],
  };
}
