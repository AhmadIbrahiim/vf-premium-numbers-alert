import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildQuery, MAX_LIMIT, CARRIERS } from "../worker/api.js";

/** buildQuery accepts URLSearchParams in production; a plain object is equivalent. */
const q = (route, params) => buildQuery(route, new URLSearchParams(params));

test("an unknown route is rejected rather than guessed at", () => {
  assert.throws(() => q("../../etc/passwd"), /unknown route/);
  assert.throws(() => q("numbers; drop table numbers"), /unknown route/);
});

test("no client input is ever interpolated into the SQL text", () => {
  const injected = q("numbers", { q: "1' or 1=1 --", carrier: "all", limit: "10" });
  assert.ok(!injected.sql.includes("or 1=1"));
  assert.ok(!injected.sql.includes("--"));
  // The digits survive as a bound parameter; the rest is discarded.
  assert.ok(injected.params.includes("%111%"));
});

test("a search is reduced to digits and length-capped", () => {
  assert.ok(q("numbers", { q: "0110-117 3349" }).params.includes("%01101173349%"));
  const long = q("numbers", { q: "0".repeat(50) });
  const pattern = long.params.find((p) => typeof p === "string" && p.startsWith("%"));
  assert.equal(pattern.length, 13, "11 digits plus the two wildcards");
});

test("an unknown carrier or sort is rejected, not silently ignored", () => {
  assert.throws(() => q("numbers", { carrier: "orange" }), /unknown carrier/);
  assert.throws(() => q("numbers", { sort: "score; delete from numbers" }), /unknown sort/);
  for (const c of CARRIERS) assert.ok(q("numbers", { carrier: c }).params.includes(c));
});

test("limit is clamped so one request cannot drain the table", () => {
  const asked = q("numbers", { limit: "100000" });
  assert.ok(asked.params.includes(MAX_LIMIT));
  assert.ok(q("numbers", { limit: "0" }).params.includes(1));
  assert.ok(q("numbers", { limit: "not-a-number" }).params.includes(100)); // default
});

test("an absent numeric param uses its default, not the clamp minimum", () => {
  // Number(null) and Number("") are both 0, which used to clamp `limit` down to 1.
  assert.ok(q("numbers", {}).params.includes(100), "default limit");
  assert.ok(q("numbers", { limit: "" }).params.includes(100), "empty limit");
  assert.deepEqual(q("status", {}).params, [48]);
  assert.deepEqual(q("events", {}).params, [100]);
});

test("offset is clamped and never negative", () => {
  assert.ok(q("numbers", { offset: "-5" }).params.includes(0));
  assert.ok(q("numbers", { offset: "99999999" }).params.includes(1000000));
});

test("the default view is what is currently buyable", () => {
  assert.match(q("numbers", {}).sql, /where available/);
  assert.match(q("numbers", { carrier: "we" }).sql, /where available and carrier = \$1/);
});

test("the 'ever' view drops the availability filter but keeps the rest", () => {
  const ever = q("numbers", { view: "ever", carrier: "we" });
  assert.ok(!/where available/.test(ever.sql));
  assert.match(ever.sql, /where carrier = \$1/);
  assert.ok(ever.params.includes("we"));
});

test("every sort maps to a fixed ORDER BY, never client text", () => {
  for (const [key, frag] of [["score", "score desc"], ["grade", "best_grade desc"], ["new", "first_seen desc"], ["msisdn", "order by msisdn"]]) {
    assert.match(q("numbers", { sort: key }).sql, new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("numbers_count mirrors the numbers filters so paging totals agree", () => {
  const rows = q("numbers", { carrier: "etisalat", q: "0110", view: "now" });
  const count = q("numbers_count", { carrier: "etisalat", q: "0110", view: "now" });
  assert.deepEqual(count.params, ["etisalat", "%0110%"]);
  assert.ok(rows.params.slice(0, 2).every((p, i) => p === count.params[i]));
  assert.match(count.sql, /count\(\*\)::int as total/);
});

test("counts reports the per-carrier split with no parameters", () => {
  const c = q("counts");
  assert.deepEqual(c.params, []);
  assert.match(c.sql, /group by carrier/);
  assert.match(c.sql, /where available/);
});

test("status and history clamp their window", () => {
  assert.deepEqual(q("status", { window: "9999" }).params, [500]);
  assert.deepEqual(q("status", { window: "0" }).params, [1]);
  assert.deepEqual(q("history", {}).params, [48]);
});

test("status exposes per-carrier health, not raw rows", () => {
  const s = q("status");
  for (const field of ["last_ok", "last_trusted", "last_error", "polls_ok", "avg_duration_ms", "available_now"]) {
    assert.match(s.sql, new RegExp(field));
  }
});

test("events is capped like every other list", () => {
  assert.deepEqual(q("events", { limit: "5" }).params, [5]);
  assert.deepEqual(q("events", { limit: "99999" }).params, [MAX_LIMIT]);
});

test("every route only ever reads", () => {
  for (const route of ["counts", "numbers", "numbers_count", "status", "history", "events"]) {
    const { sql } = q(route, {});
    assert.match(sql, /^\s*(select|with)\b/i, `${route} must start as a read`);
    assert.ok(!/\b(insert|update|delete|drop|alter|truncate|grant|create)\b/i.test(sql), `${route} must not mutate`);
  }
});

test("buildQuery also accepts a plain object, not just URLSearchParams", () => {
  const viaObject = buildQuery("numbers", { carrier: "we", limit: 5 });
  assert.ok(viaObject.params.includes("we"));
  assert.ok(viaObject.params.includes(5));
});

test("the worker source stays safe to inline into the deploy call", async () => {
  // It is uploaded by embedding this file inside a JS template literal, so a backtick,
  // a dollar-brace or a backslash escape would be silently mangled in the deployed copy.
  const src = await readFile(new URL("../worker/api.js", import.meta.url), "utf8");
  assert.ok(!src.includes("`"), "no backticks");
  assert.ok(!src.includes("${"), "no dollar-brace");
  assert.ok(!src.includes("\\"), "no backslashes");
});
