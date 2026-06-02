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
    "You are an expert at grading premium Egyptian mobile numbers (MSISDNs). " +
    "From the supplied list, pick and rank the best " +
    count +
    " numbers, most desirable first. " +
    "Grade reflects how desirable/premium the digit pattern is (repeats, sequences, " +
    "palindromes, round endings, memorability). " +
    'Return STRICT JSON only: {"ranked":[{"msisdn":"...","grade":<0-100 int>,"reason":"<short why>"}, ...]}. ' +
    "Only use msisdns from the supplied list.";

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
