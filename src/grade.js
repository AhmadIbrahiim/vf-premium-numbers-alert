const ENDPOINT = "https://models.github.ai/inference/chat/completions";

/**
 * Build the deterministic fallback ranking from the input candidates.
 * @param {Array<{msisdn:string, score:number, tags:string[]}>} candidates
 * @param {number} count
 * @returns {Array<{msisdn:string, grade:number, reason:string}>}
 */
function fallback(candidates, count) {
  return candidates.slice(0, count).map((c) => ({
    msisdn: c.msisdn,
    grade: c.score,
    reason: (Array.isArray(c.tags) ? c.tags : []).join(", ") || "pattern match",
  }));
}

/** Clamp a value to an integer in the 0-100 range. */
function clampGrade(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Rank candidates into the best `count` with reasons via GitHub Models;
 * deterministic fallback on any error. Never throws.
 * @param {Array<{msisdn:string, score:number, tags:string[]}>} candidates - already pattern-ranked, top ~80
 * @param {object} [opts] - { token, model, count=30, fetchImpl, timeoutMs }
 * @returns {Promise<Array<{msisdn:string, grade:number, reason:string}>>}  length <= count
 */
export async function gradeCandidates(candidates, opts = {}) {
  const {
    token,
    model = "openai/gpt-4o-mini",
    count = 30,
    fetchImpl,
    timeoutMs = 20000,
  } = opts;

  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.msisdn) : [];

  // No token -> deterministic fallback without touching the network.
  if (!token) {
    console.warn("gradeCandidates fallback: no token provided");
    return fallback(list, count);
  }

  const fetchFn = fetchImpl || globalThis.fetch;

  const system =
    "You are a specialist grader for the EGYPTIAN VIP phone number market. Dealers pay 500–50,000+ EGP " +
    "for numbers with strong patterns. Judge the LAST 8 DIGITS only (the 010/011/012/015 prefix is commodity).\n\n" +
    "WHAT DRIVES VALUE — in order of importance:\n" +
    "1. REPETITION DENSITY: More of the same digit = more valuable. Six identical digits beats four.\n" +
    "2. ZEROS: Zeros are highly prized (easy to dictate, looks impressive). Extra zeros always lift the grade.\n" +
    "3. SEQUENTIAL RUNS: 12345678, 87654321, or partial runs of 5+ digits.\n" +
    "4. EASY TO DICTATE: Can you describe it in ≤5 words? (\"five twos then six\", \"all nines\", \"one-two alternating\") → 75+.\n" +
    "5. COMBINATION BONUS: Two or more patterns together always grade higher than either alone.\n\n" +
    "GRADE ANCHORS:\n" +
    "- 95-100 (VIP): All-same digit (44444444), full 8-digit sequential run (12345678/87654321), " +
    "6+ same digits in a row (e.g. 12333333), 5+ trailing zeros (X0000000), ultra-clean round forms " +
    "(01000000, 00100100, 01010101, 10000001).\n" +
    "- 85-94 (Premium): 4-5 same digits in a row (e.g. 44445678), clean alternating block (12121212, 01010101-like), " +
    "4 trailing zeros (XX000000), full 2/3-digit repeating block (ABABABAB, ABCABCAB), " +
    "pair ladders (01020304, 10203040), two-pair AABB mirror with repetition (11221122).\n" +
    "- 70-84 (Good): Triple same digit run, AABB double-pairs (11223344, 55667788), 3 trailing zeros, " +
    "near-palindrome with strong repetition, arithmetic step-2 sequence (24681357), mostly-zero number.\n" +
    "- 55-69 (Mild): Plain palindrome without heavy repetition, 2-digit alternating for half the number, " +
    "two trailing zeros with another noticeable pattern, 2-3 distinct digits scattered.\n" +
    "- Below 55: No discernible pattern; random-looking digits.\n\n" +
    "KEY RULES:\n" +
    "- A plain palindrome alone (e.g. 44688644) is mid-tier (58-68), NOT premium. It needs heavy repetition " +
    "or zeros to reach 85+.\n" +
    "- When patterns combine (e.g. palindrome + triple repeat + trailing zero), add 10-15 to what either alone would earn.\n" +
    "- Prefer false-positive over false-negative: if unsure between two tiers, go higher.\n\n" +
    "From the supplied list, pick and rank the best " +
    count +
    " numbers, most desirable first. " +
    'Return STRICT JSON only: {"ranked":[{"msisdn":"...","grade":<0-100 int>,"reason":"<short why>"}, ...]}. ' +
    "Use only msisdns from the supplied list.";

  const user =
    "Candidates (compact JSON, already pattern-ranked best-first):\n" +
    JSON.stringify(
      list.map((c) => ({ msisdn: c.msisdn, tags: Array.isArray(c.tags) ? c.tags : [] })),
    ) +
    "\nPick and rank the best " +
    count +
    " and return the JSON object described.";

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res || !res.ok) {
      console.warn(
        "gradeCandidates fallback: non-2xx response (" + (res && res.status) + ")",
      );
      return fallback(list, count);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      console.warn("gradeCandidates fallback: empty or invalid content");
      return fallback(list, count);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn("gradeCandidates fallback: unparseable JSON content");
      return fallback(list, count);
    }

    const ranked = parsed?.ranked;
    if (!Array.isArray(ranked)) {
      console.warn("gradeCandidates fallback: missing ranked array");
      return fallback(list, count);
    }

    const allowed = new Set(list.map((c) => c.msisdn));
    const cleaned = ranked
      .filter((r) => r && allowed.has(r.msisdn))
      .map((r) => ({
        msisdn: r.msisdn,
        grade: clampGrade(r.grade),
        reason: typeof r.reason === "string" ? r.reason : "",
      }))
      .slice(0, count);

    if (cleaned.length < 1) {
      console.warn("gradeCandidates fallback: no valid ranked items");
      return fallback(list, count);
    }

    return cleaned;
  } catch (err) {
    console.warn("gradeCandidates fallback: request error (" + (err && err.name) + ")");
    return fallback(list, count);
  } finally {
    clearTimeout(timer);
  }
}
