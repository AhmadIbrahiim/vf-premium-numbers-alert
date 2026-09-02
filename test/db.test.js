import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../src/db.js";
import { fakeDb } from "./helpers/fake-db.js";

const CONN = "postgresql://u:p@ep-x-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require";

/** db opts pointing at an in-memory stand-in for Neon's /sql endpoint. */
function opts(fake) {
  return { fetchImpl: fake.fetch, connectionString: CONN };
}

const ROWS = [
  { msisdn: "01012345678", carrier: "vodafone", tier: "", sim_type: "ESIM", score: 40, tags: ["a", "b"] },
  { msisdn: "01112345678", carrier: "etisalat", tier: "silver", sim_type: "", score: 55, tags: [] },
  { msisdn: "01512345678", carrier: "we", tier: "GRADE_017", sim_type: "", score: 20, tags: ["x"] },
];

test("sql posts to the connection host's /sql endpoint with the string as a header", async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.conn = init.headers["neon-connection-string"];
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ rows: [] }) };
  };
  await db.sql("select $1::int", [7], { fetchImpl, connectionString: CONN });
  assert.equal(seen.url, "https://ep-x-pooler.c-4.us-east-2.aws.neon.tech/sql");
  assert.equal(seen.conn, CONN);
  assert.deepEqual(seen.body, { query: "select $1::int", params: [7] });
});

test("sql surfaces the Postgres error and never leaks the connection string", async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400, json: async () => ({ message: 'relation "nope" does not exist' }),
  });
  await assert.rejects(
    () => db.sql("select 1", [], { fetchImpl, connectionString: CONN }),
    (err) => {
      assert.match(err.message, /relation "nope" does not exist/);
      assert.ok(!err.message.includes("npg_"), "no credential in the message");
      assert.ok(!err.message.includes(CONN));
      return true;
    }
  );
});

test("sql refuses to run without a connection string", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(() => db.sql("select 1"), /DATABASE_URL is not set/);
    assert.equal(db.hasDb(), false);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("upsertNumbers inserts, then keeps first_seen and only raises best_grade", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-08-01", runSeq: 1 }, opts(fake));
  assert.equal(fake.rows.get("01012345678").first_seen, "2026-08-01");
  assert.equal(fake.rows.get("01012345678").best_grade, 40);

  // Seen again a month later at a lower score: first_seen sticks, best_grade holds.
  await db.upsertNumbers(
    { rows: [{ ...ROWS[0], score: 12 }], today: "2026-09-02", runSeq: 2 },
    opts(fake)
  );
  const r = fake.rows.get("01012345678");
  assert.equal(r.first_seen, "2026-08-01");
  assert.equal(r.last_seen, "2026-09-02");
  assert.equal(r.score, 12);
  assert.equal(r.best_grade, 40);
});

test("upsertNumbers round-trips tags, including an empty list", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  const rows = await db.readPublishRows({ perCarrier: 10, today: "2026-09-02" }, opts(fake));
  const byId = Object.fromEntries(rows.map((r) => [r.msisdn, r]));
  assert.deepEqual(byId["01012345678"].tags, ["a", "b"]);
  // Neon decodes an empty text[] as [""] over HTTP; it must come back as a real [].
  assert.deepEqual(byId["01112345678"].tags, []);
});

test("readPublishRows drops the [''] Neon returns for an empty array", async () => {
  const fake = fakeDb();
  fake.rows.set("01100000001", {
    msisdn: "01100000001", carrier: "etisalat", tier: "", sim_type: "", score: 10,
    tags: [""], best_grade: 10, first_seen: "2026-09-02", last_seen: "2026-09-02",
    available: true, run_seq: 1,
  });
  const [row] = await db.readPublishRows({ perCarrier: 10, today: "2026-09-02" }, opts(fake));
  assert.deepEqual(row.tags, []);
});

test("markGone flags exactly the rows this run did not touch", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  // Next run sees only the Vodafone number.
  await db.upsertNumbers({ rows: [ROWS[0]], today: "2026-09-03", runSeq: 2 }, opts(fake));
  const gone = await db.markGone({ runSeq: 2 }, opts(fake));
  assert.deepEqual(gone.sort(), ["01112345678", "01512345678"]);
  assert.equal(fake.rows.get("01012345678").available, true);
  assert.deepEqual(await db.readAvailable(opts(fake)), ["01012345678"]);
});

test("applyGrades raises best_grade but never lowers it", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  await db.applyGrades({ grades: new Map([["01012345678", 97], ["01112345678", 3]]) }, opts(fake));
  assert.equal(fake.rows.get("01012345678").best_grade, 97);
  assert.equal(fake.rows.get("01112345678").best_grade, 55); // heuristic score wins
});

test("applyGrades makes no request when nothing was graded", async () => {
  const fake = fakeDb();
  await db.applyGrades({ grades: new Map() }, opts(fake));
  assert.deepEqual(fake.queries, []);
});

test("pruneGone deletes only rows gone longer than keepDays", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-07-01", runSeq: 1 }, opts(fake));
  await db.markGone({ runSeq: 2 }, opts(fake)); // all three now gone as of 2026-07-01
  // 2026-09-02 is 63 days later, so a 30-day window drops all of them.
  assert.equal(await db.pruneGone({ keepDays: 30, today: "2026-09-02" }, opts(fake)), 3);
  assert.equal(fake.rows.size, 0);
});

test("pruneGone keeps recently-gone rows and every available row", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-01", runSeq: 1 }, opts(fake));
  await db.upsertNumbers({ rows: [ROWS[0]], today: "2026-09-02", runSeq: 2 }, opts(fake));
  await db.markGone({ runSeq: 2 }, opts(fake));
  assert.equal(await db.pruneGone({ keepDays: 30, today: "2026-09-02" }, opts(fake)), 0);
  assert.equal(fake.rows.size, 3);
});

test("readPublishRows caps per carrier so a small catalog is not crowded out", async () => {
  const fake = fakeDb();
  // 5 high-scoring Etisalat numbers vs 2 low-scoring Vodafone ones.
  const et = Array.from({ length: 5 }, (_, i) => ({
    msisdn: `0110000000${i}`, carrier: "etisalat", tier: "", sim_type: "", score: 90, tags: [],
  }));
  const vf = Array.from({ length: 2 }, (_, i) => ({
    msisdn: `0100000000${i}`, carrier: "vodafone", tier: "", sim_type: "", score: 5, tags: [],
  }));
  await db.upsertNumbers({ rows: [...et, ...vf], today: "2026-09-02", runSeq: 1 }, opts(fake));
  const rows = await db.readPublishRows({ perCarrier: 2, today: "2026-09-02" }, opts(fake));
  assert.equal(rows.filter((r) => r.carrier === "etisalat").length, 2);
  assert.equal(rows.filter((r) => r.carrier === "vodafone").length, 2);
  assert.ok(rows[0].score >= rows.at(-1).score, "returned best-first");
});

test("readPublishRows marks a row first seen today as new, with age 0", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: [ROWS[0]], today: "2026-08-01", runSeq: 1 }, opts(fake));
  await db.upsertNumbers({ rows: [ROWS[1]], today: "2026-09-02", runSeq: 2 }, opts(fake));
  const rows = await db.readPublishRows({ perCarrier: 10, today: "2026-09-02" }, opts(fake));
  const byId = Object.fromEntries(rows.map((r) => [r.msisdn, r]));
  assert.equal(byId["01112345678"].is_new, true);
  assert.equal(byId["01112345678"].age_days, 0);
  assert.equal(byId["01012345678"].is_new, false);
  assert.equal(byId["01012345678"].age_days, 32);
});

test("readBestEverRows ranks by best_grade and includes gone numbers", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  await db.applyGrades({ grades: new Map([["01512345678", 99]]) }, opts(fake));
  await db.markGone({ runSeq: 2 }, opts(fake)); // everything gone
  const rows = await db.readBestEverRows({ limit: 2, today: "2026-09-02" }, opts(fake));
  assert.deepEqual(rows.map((r) => r.msisdn), ["01512345678", "01112345678"]);
  assert.equal(rows[0].best_grade, 99);
  assert.equal(rows[0].available, false);
});

test("readSearchIndex emits fixed-width msisdn + carrier initial + 3-digit score", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  const index = await db.readSearchIndex(opts(fake));
  assert.deepEqual(index, ["01012345678v040", "01112345678e055", "01512345678w020"]);
  assert.ok(index.every((r) => r.length === 15));
});

test("readSearchIndex covers only available numbers", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  await db.upsertNumbers({ rows: [ROWS[0]], today: "2026-09-03", runSeq: 2 }, opts(fake));
  await db.markGone({ runSeq: 2 }, opts(fake));
  assert.deepEqual(await db.readSearchIndex(opts(fake)), ["01012345678v040"]);
});

test("readCounts reports the per-carrier split and the total", async () => {
  const fake = fakeDb();
  await db.upsertNumbers({ rows: ROWS, today: "2026-09-02", runSeq: 1 }, opts(fake));
  assert.deepEqual(await db.readCounts(opts(fake)), {
    available_total: 3,
    by_carrier: { etisalat: 1, vodafone: 1, we: 1 },
  });
});

test("upsertNumbers batches large inputs instead of one huge request", async () => {
  const fake = fakeDb();
  const many = Array.from({ length: 12000 }, (_, i) => ({
    msisdn: "010" + String(i).padStart(8, "0"),
    carrier: "vodafone", tier: "", sim_type: "", score: 1, tags: [],
  }));
  await db.upsertNumbers({ rows: many, today: "2026-09-02", runSeq: 1 }, opts(fake));
  const inserts = fake.queries.filter((q) => q.includes("insert into numbers"));
  assert.equal(inserts.length, 3); // 12000 / 5000 -> 3 requests
  assert.equal(fake.rows.size, 12000);
});
