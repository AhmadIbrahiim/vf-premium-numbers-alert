import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import manifest from "../app/manifest.js";

/**
 * Installability is all-or-nothing and fails silently: if the manifest is missing a
 * required field or an icon file is absent, the browser simply never offers to install
 * and reports nothing. These assertions are the only warning we get.
 *
 * Manifest, icon files and headers only. The service worker's behaviour is tested
 * by executing it, in sw.test.js.
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

test("a real multi-size favicon.ico exists", async () => {
  // Browsers request /favicon.ico unprompted whether or not anything links to it, so
  // its absence is a 404 on every first visit. Next serves app/favicon.ico at that
  // path by convention.
  const buf = await readFile(root("app/favicon.ico"));
  // ICONDIR: reserved 0, type 1 (icon), then the image count.
  assert.equal(buf.readUInt16LE(0), 0, "not an ICO: reserved field is not 0");
  assert.equal(buf.readUInt16LE(2), 1, "not an ICO: type is not 1");
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 2, `expected several sizes to choose from, got ${count}`);

  // Each 16-byte directory entry starts with width and height, where 0 means 256.
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    sizes.push(buf[off] || 256);
  }
  assert.ok(sizes.includes(16), `missing a 16px entry, have: ${sizes}`);
  assert.ok(sizes.includes(32), `missing a 32px entry, have: ${sizes}`);
});

test("the apple-touch-icon exists at 180x180", async () => {
  // iOS ignores the manifest entirely and uses this file.
  const buf = await readFile(root("public/apple-touch-icon.png"));
  assert.equal(buf.readUInt32BE(16), 180);
  assert.equal(buf.readUInt32BE(20), 180);
});

test("sw.js is served uncached, or updates can never reach clients", async () => {
  const config = await readFile(root("next.config.mjs"), "utf8");
  assert.match(config, /source:\s*"\/sw\.js"/, "sw.js needs its own header rule");
  const swRule = config.slice(config.indexOf('"/sw.js"'));
  assert.match(swRule, /no-store/, "sw.js must be sent with no-store");
});
