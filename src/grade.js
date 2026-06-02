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
    "You grade Egyptian mobile numbers (01X + 8 digits) for the EGYPTIAN VIP/special-number " +
    "MARKET. The 010/011/012/015 prefix is not special; judge the last 8 digits. Value is driven " +
    "FIRST by repetition density and zeros, the way Egyptian dealers price numbers. Be STRICT and " +
    "calibrated: most numbers are ordinary and should score low. Reserve high grades for genuinely " +
    "rare patterns.\n" +
    "Market tiers (anchor to these):\n" +
    "- 95-100 (VIP, very rare): 6+ same digit in a row (hexa/penta), 5+ trailing zeros or round forms " +
    "(...000000, 0100000), a full 8-digit sequential run (12345678), or famous formats like 0101010 / 0100100.\n" +
    "- 85-94 (premium): tetra (4 same in a row), a clean whole-number repeating block (ABABABAB, ABCABCAB, " +
    "01000100), 4 trailing zeros, or a long partial sequential run.\n" +
    "- 70-84 (good): a clear triple repeat, AABB doubling (55667788), pair ladders (01 02 03 04), " +
    "3 trailing zeros, or a short clean sequential run.\n" +
    "- 55-69 (mild): a MIRROR/palindrome that has 3+ distinct digits, only 2-3 distinct digits with no run, " +
    "scattered zeros, or a weak partial pattern.\n" +
    "- below 55: ordinary / random-looking.\n" +
    "IMPORTANT: a plain mirror/palindrome (e.g. 44688644) is MID-TIER (~60-72), NOT premium. A mirror only " +
    "earns 85+ when it ALSO has heavy repetition or zeros. Do not over-reward mirrors or 'three distinct " +
    "digits'. Memorability matters, but repetition and zeros matter more.\n" +
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
