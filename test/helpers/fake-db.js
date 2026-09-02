/**
 * fake-db.js — an in-memory stand-in for Neon's SQL-over-HTTP endpoint.
 *
 * src/db.js issues a small, fixed set of statements, so the stub matches on a
 * distinctive substring of each rather than parsing SQL. It keeps a Map of rows with
 * the same semantics as the real schema (first_seen set once, best_grade only climbs,
 * run_seq marking which rows this run touched), which is enough for the end-to-end
 * run tests to assert on real state transitions.
 */

/**
 * @param {Record<string, any>} [seed] - initial rows keyed by msisdn
 * @returns {{ fetch: Function, rows: Map<string, any>, queries: string[] }}
 */
export function fakeDb(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([msisdn, r]) => [msisdn, { msisdn, ...r }]));
  const queries = [];

  const reply = (out) => ({
    ok: true,
    status: 200,
    json: async () => ({ rows: out, command: "SELECT", rowCount: out.length }),
  });

  const dayDiff = (from, to) => {
    const a = Date.parse(from + "T00:00:00Z");
    const b = Date.parse(to + "T00:00:00Z");
    return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86400000);
  };

  async function fetchImpl(url, init) {
    const { query, params } = JSON.parse(init.body);
    queries.push(query);

    if (/^\s*create /i.test(query)) return reply([]);

    if (query.includes("select msisdn from numbers where available")) {
      return reply([...rows.values()].filter((r) => r.available).map((r) => ({ msisdn: r.msisdn })));
    }

    if (query.includes("insert into numbers")) {
      const [msisdns, carriers, tiers, simTypes, scores, tagsCsv, bestGrades, firstSeens, lastSeens, avail, runSeqs] = params;
      msisdns.forEach((msisdn, i) => {
        const prev = rows.get(msisdn);
        rows.set(msisdn, {
          msisdn,
          carrier: carriers[i],
          tier: tiers[i],
          sim_type: simTypes[i],
          score: scores[i],
          tags: tagsCsv[i] ? tagsCsv[i].split(",") : [],
          best_grade: Math.max(prev?.best_grade ?? 0, bestGrades[i]),
          first_seen: prev?.first_seen ?? firstSeens[i],
          last_seen: lastSeens[i],
          available: avail[i],
          run_seq: runSeqs[i],
        });
      });
      return reply([]);
    }

    if (query.includes("set available = false")) {
      const [runSeq] = params;
      const gone = [];
      for (const r of rows.values()) {
        if (r.available && r.run_seq !== runSeq) {
          r.available = false;
          gone.push({ msisdn: r.msisdn });
        }
      }
      return reply(gone);
    }

    if (query.includes("set best_grade = greatest")) {
      const [msisdns, grades] = params;
      msisdns.forEach((msisdn, i) => {
        const r = rows.get(msisdn);
        if (r) r.best_grade = Math.max(r.best_grade ?? 0, grades[i]);
      });
      return reply([]);
    }

    if (query.includes("delete from numbers")) {
      const [today, keepDays] = params;
      const dropped = [];
      for (const r of [...rows.values()]) {
        if (!r.available && dayDiff(r.last_seen, today) > keepDays) {
          rows.delete(r.msisdn);
          dropped.push({ msisdn: r.msisdn });
        }
      }
      return reply(dropped);
    }

    if (query.includes("group by carrier")) {
      const counts = new Map();
      for (const r of rows.values()) {
        if (r.available) counts.set(r.carrier, (counts.get(r.carrier) || 0) + 1);
      }
      return reply([...counts.entries()].sort().map(([carrier, n]) => ({ carrier, n })));
    }

    if (query.includes("row_number() over")) {
      const [perCarrier, today] = params;
      const perC = new Map();
      const out = [];
      const sorted = [...rows.values()]
        .filter((r) => r.available)
        .sort((a, b) => b.score - a.score || a.msisdn.localeCompare(b.msisdn));
      for (const r of sorted) {
        const n = (perC.get(r.carrier) || 0) + 1;
        perC.set(r.carrier, n);
        if (n > perCarrier) continue;
        out.push({
          msisdn: r.msisdn, score: r.score, tags: r.tags, sim_type: r.sim_type,
          carrier: r.carrier, tier: r.tier, best_grade: r.best_grade,
          first_seen: r.first_seen, age_days: dayDiff(r.first_seen, today),
          is_new: r.first_seen === today,
        });
      }
      return reply(out);
    }

    if (query.includes("order by best_grade desc")) {
      const [limit, today] = params;
      return reply(
        [...rows.values()]
          .sort((a, b) => b.best_grade - a.best_grade || b.score - a.score || a.msisdn.localeCompare(b.msisdn))
          .slice(0, limit)
          .map((r) => ({
            msisdn: r.msisdn, score: r.score, tags: r.tags, sim_type: r.sim_type,
            carrier: r.carrier, tier: r.tier, best_grade: r.best_grade, available: r.available,
            first_seen: r.first_seen, age_days: dayDiff(r.first_seen, today),
          }))
      );
    }

    if (query.includes("left(carrier, 1)")) {
      return reply(
        [...rows.values()]
          .filter((r) => r.available)
          .sort((a, b) => a.msisdn.localeCompare(b.msisdn))
          .map((r) => ({ msisdn: r.msisdn, c: r.carrier[0], score: r.score }))
      );
    }

    throw new Error("fake-db: unhandled query: " + query.slice(0, 120));
  }

  return { fetch: fetchImpl, rows, queries };
}
