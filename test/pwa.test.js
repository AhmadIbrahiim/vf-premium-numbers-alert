import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import manifest from "../app/manifest.js";

/**
 * Installability is all-or-nothing and fails silently: if the manifest is missing a
 * required field or an icon file is absent, the browser simply never offers to install
 * and reports nothing. These assertions are the only warning we get.
 */

const root = (p) => new URL(`../${p}`, import.meta.url);

test("manifest has every field installability requires", () => {
  const m = manifest();
  for (const field of ["name", "short_name", "start_url", "display", "icons"]) {
    assert.ok(m[field], `manifest.${field} is required for installability`);
  }
  assert.ok(["standalone", "fullscreen", "minimal-ui"].includes(m.display), "display must be app-like");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
});

test("manifest declares both a 192px and a 512px icon", () => {
  // Chromium refuses to install without both of these exact sizes.
  const sizes = manifest().icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192"), `missing 192x192, have: ${sizes}`);
  assert.ok(sizes.includes("512x512"), `missing 512x512, have: ${sizes}`);
});

test("maskable icons are declared separately from normal ones", () => {
  // A single icon marked "any maskable" is wrong in one of its two roles: Android crops
  // maskable icons to the device silhouette, so shared art is either clipped or floats
  // in padding.
  const icons = manifest().icons;
  const maskable = icons.filter((i) => i.purpose === "maskable");
  const any = icons.filter((i) => i.purpose === "any");
  assert.ok(maskable.length >= 1, "needs at least one maskable icon");
  assert.ok(any.length >= 1, "needs at least one normal icon");
  assert.ok(
    !icons.some((i) => (i.purpose || "").includes("any") && i.purpose.includes("maskable")),
    "no icon should claim both purposes"
  );
});

test("short_name is short enough for a home screen label", () => {
  // Home screens truncate around 12 characters.
  assert.ok(manifest().short_name.length <= 12, "short_name would be truncated on a home screen");
});

test("every icon the manifest references exists on disk", async () => {
  for (const icon of manifest().icons) {
    const path = root(`public${icon.src}`);
    const info = await stat(path).catch(() => null);
    assert.ok(info?.isFile(), `${icon.src} is referenced by the manifest but missing from public/`);
    assert.ok(info.size > 0, `${icon.src} is empty`);
  }
});

test("the icons are real PNGs, not SVGs with a .png name", async () => {
  // A mislabelled file passes a naive existence check and then fails to render as an
  // app icon, which is close to impossible to notice.
  for (const icon of manifest().icons) {
    const buf = await readFile(root(`public${icon.src}`));
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    assert.ok(isPng, `${icon.src} does not start with the PNG magic bytes`);
    // IHDR carries the real dimensions; check them against what the manifest claims.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.equal(width, w, `${icon.src} is ${width}px wide but declared ${w}`);
    assert.equal(height, h, `${icon.src} is ${height}px tall but declared ${h}`);
  }
});

test("the apple-touch-icon exists at 180x180", async () => {
  // iOS ignores the manifest entirely and uses this file.
  const buf = await readFile(root("public/apple-touch-icon.png"));
  assert.equal(buf.readUInt32BE(16), 180);
  assert.equal(buf.readUInt32BE(20), 180);
});

test("the service worker never caches navigations or the API", async () => {
  const sw = await readFile(root("public/sw.js"), "utf8");
  // Pages are server-rendered from live Postgres. Serving a cached page would show
  // stale numbers, which is worse than showing the offline notice.
  assert.match(sw, /\/api\//, "must special-case /api");
  assert.match(sw, /OFFLINE_URL/, "must have an offline fallback");
  assert.ok(
    !/cache\.put\(request/.test(sw.split("isStaticAsset")[0]),
    "must not put navigations in the cache"
  );
});

test("the service worker precaches the offline page it falls back to", async () => {
  const sw = await readFile(root("public/sw.js"), "utf8");
  const offline = await stat(root("public/offline.html")).catch(() => null);
  assert.ok(offline?.isFile(), "offline.html must exist or the fallback returns an error");
  assert.match(sw, /PRECACHE/, "offline page must be precached at install time");
});

test("sw.js is served uncached, or updates can never reach clients", async () => {
  const config = await readFile(root("next.config.mjs"), "utf8");
  assert.match(config, /source:\s*"\/sw\.js"/, "sw.js needs its own header rule");
  const swRule = config.slice(config.indexOf('"/sw.js"'));
  assert.match(swRule, /no-store/, "sw.js must be sent with no-store");
});
