/**
 * Pure premium-pattern scorer for Egyptian mobile MSISDNs.
 *
 * An MSISDN looks like "01055455833": prefix `01[0125]` followed by 8 digits.
 * We judge "premium-ness" purely on the digit pattern of the LAST 8 DIGITS
 * (the subscriber part), using a set of weighted heuristics. Each matched
 * heuristic contributes points and a short human-readable tag. The final
 * score is normalized/capped to the inclusive range [0, 100].
 *
 * The function is pure: no I/O, no Date, no randomness.
 */

const MSISDN_RE = /^01[0125]\d{8}$/;

/** Longest run of strictly ascending consecutive digits (e.g. 4,5,6). */
function longestAscRun(d) {
  let best = 1;
  let cur = 1;
  for (let i = 1; i < d.length; i++) {
    if (d[i] === d[i - 1] + 1) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/** Longest run of strictly descending consecutive digits (e.g. 6,5,4). */
function longestDescRun(d) {
  let best = 1;
  let cur = 1;
  for (let i = 1; i < d.length; i++) {
    if (d[i] === d[i - 1] - 1) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/** Longest run of the same repeated digit (e.g. 4,4,4,4). */
function longestSameRun(d) {
  let best = 1;
  let cur = 1;
  for (let i = 1; i < d.length; i++) {
    if (d[i] === d[i - 1]) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }
  return best;
}

/** Number of trailing zeros. */
function trailingZeros(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === "0") n += 1;
    else break;
  }
  return n;
}

/** True if the string reads the same forwards and backwards. */
function isPalindrome(s) {
  for (let i = 0, j = s.length - 1; i < j; i++, j--) {
    if (s[i] !== s[j]) return false;
  }
  return true;
}

/**
 * True when the whole string is the same block repeated (block length k,
 * 1 <= k < len, len % k === 0). Used to detect repeating blocks like
 * "45454545" (k=2) or "678678" within a sliced window.
 */
function isRepeatingBlock(s) {
  const len = s.length;
  for (let k = 1; k <= len / 2; k++) {
    if (len % k !== 0) continue;
    const block = s.slice(0, k);
    let ok = true;
    for (let i = k; i < len; i += k) {
      if (s.slice(i, i + k) !== block) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

/**
 * Longest run with a CONSTANT step (arithmetic ladder), e.g. 2,4,6,8 (step 2)
 * or 9,7,5,3 (step -2). Returns the longest run and its step. Steps of 0
 * (all-same) and ±1 (plain asc/desc) are handled elsewhere; callers filter.
 * @returns {{len:number, step:number}}
 */
function longestArithRun(d) {
  let bestLen = 1;
  let bestStep = 0;
  for (let i = 1; i < d.length; i++) {
    const step = d[i] - d[i - 1];
    let len = 2;
    let j = i + 1;
    while (j < d.length && d[j] - d[j - 1] === step) {
      len += 1;
      j += 1;
    }
    if (len > bestLen) {
      bestLen = len;
      bestStep = step;
    }
    i = j - 1;
  }
  return { len: bestLen, step: bestStep };
}

/**
 * Steps between two-digit groups that a person actually perceives as a sequence.
 *
 * 01 02 03 04 (1), 10 20 30 40 (10), 11 22 33 44 (11) and 55 60 65 70 (5) all read as
 * patterns. An arbitrary step does not: 01 17 33 49 is arithmetic with step 16 and
 * completely invisible. Accepting any step made the scorer rank random numbers above
 * genuinely memorable ones — it put 01101173349 at the top of the list, ahead of
 * 01555656789, which contains a plainly visible 656789.
 */
const PERCEPTIBLE_PAIR_STEPS = new Set([1, 5, 10, 11]);

/**
 * Treat the 8 digits as four two-digit groups (e.g. 01 02 03 04) and report how many
 * leading groups form an arithmetic sequence with a step a human would notice.
 * @returns {{count:number, step:number}}  count in 1..4
 */
function pairLadder(d) {
  const pairs = [
    d[0] * 10 + d[1],
    d[2] * 10 + d[3],
    d[4] * 10 + d[5],
    d[6] * 10 + d[7],
  ];
  const step = pairs[1] - pairs[0];
  if (step === 0) return { count: 1, step: 0 };
  if (!PERCEPTIBLE_PAIR_STEPS.has(Math.abs(step))) return { count: 1, step };
  let count = 2;
  for (let i = 2; i < 4; i++) {
    if (pairs[i] - pairs[i - 1] === step) count += 1;
    else break;
  }
  return { count, step };
}

/**
 * Run-length groups of the digit string, e.g. "00112233" -> [2,2,2,2].
 * @returns {number[]} the length of each consecutive same-digit group
 */
function runLengths(d) {
  const out = [];
  let cur = 1;
  for (let i = 1; i < d.length; i++) {
    if (d[i] === d[i - 1]) cur += 1;
    else {
      out.push(cur);
      cur = 1;
    }
  }
  out.push(cur);
  return out;
}

/** Count of a given digit anywhere in the string. */
function countDigit(d, target) {
  let n = 0;
  for (const x of d) if (x === target) n += 1;
  return n;
}

/**
 * Pure. Score how premium a number's digit pattern is.
 * @param {string} msisdn 11-digit Egyptian mobile, e.g. "01055455833"
 * @returns {{score:number, tags:string[]}} score in [0,100], plus matched-pattern tags
 */
export function scoreMsisdn(msisdn) {
  if (typeof msisdn !== "string" || !MSISDN_RE.test(msisdn)) {
    return { score: 0, tags: [] };
  }

  const sub = msisdn.slice(3); // last 8 digits (subscriber part)
  const digits = sub.split("").map(Number);

  let score = 0;
  const tags = [];

  // --- all-same digit (e.g. 44444444): the strongest single pattern ---
  const sameRun = longestSameRun(digits);
  if (sameRun === 8) {
    score += 95;
    tags.push("all-same");
  } else if (sameRun >= 6) {
    score += 55;
    tags.push(`repeated-digit-x${sameRun}`);
  } else if (sameRun >= 4) {
    score += 30;
    tags.push(`repeated-digit-x${sameRun}`);
  } else if (sameRun === 3) {
    score += 20;
    tags.push("triple-digit");
  }

  // --- ascending / descending consecutive runs ---
  const asc = longestAscRun(digits);
  const desc = longestDescRun(digits);
  if (asc === 8) {
    score += 85;
    tags.push("ascending");
  } else if (asc >= 4) {
    score += (asc - 3) * 18; // 4->18, 5->36, 6->54, 7->72
    tags.push(`ascending-run-x${asc}`);
  }
  if (desc === 8) {
    score += 85;
    tags.push("descending");
  } else if (desc >= 4) {
    score += (desc - 3) * 18;
    tags.push(`descending-run-x${desc}`);
  }

  // --- repeated pairs: AABB (e.g. 55449900) and ABAB (e.g. 54545454) ---
  // AABB: four consecutive equal pairs.
  let aabb = true;
  for (let i = 0; i < 8; i += 2) {
    if (digits[i] !== digits[i + 1]) {
      aabb = false;
      break;
    }
  }
  // An all-same number is vacuously AABB, and vacuously a palindrome, and vacuously
  // two-groups-of-pairs. Letting those fire stacked 95 + 52 + 28 = 175 onto 77777777
  // before any zero credit existed, so it hit the 100 cap on its own and tied with
  // 00000000 — which the market prices far higher. A pattern bonus should describe
  // something the all-same rule has not already said.
  if (aabb && sameRun < 8) {
    score += 52;
    tags.push("paired-AABB");
  }
  // ABAB...: alternating two-digit pattern over the whole 8.
  let abab = true;
  for (let i = 2; i < 8; i++) {
    if (digits[i] !== digits[i - 2]) {
      abab = false;
      break;
    }
  }
  if (abab && digits[0] !== digits[1]) {
    score += 45;
    tags.push("alternating-ABAB");
  }

  // --- palindrome of the 8 digits (e.g. 12344321) ---
  // Mirror is a recognized but MID-tier category in the EG market: a palindrome
  // with several distinct digits is not "premium" on its own. It only climbs when
  // paired with heavy repetition or zeros, which other rules above already reward.
  if (isPalindrome(sub) && sameRun < 8) {
    score += 28;
    tags.push("palindrome");
  }

  // --- repeating blocks (e.g. 45454545, 678678.. within window) ---
  const wholeBlock = isRepeatingBlock(sub);
  if (wholeBlock && wholeBlock < 8 && !abab) {
    // wholeBlock===1 is all-same (already handled); guard against double count.
    if (wholeBlock >= 2) {
      score += 30;
      tags.push(`repeating-block-${wholeBlock}`);
    }
  }
  // A 6-char repeating block sitting inside the 8 (e.g. "678678" + 2 free).
  const head6 = sub.slice(0, 6);
  const tail6 = sub.slice(2, 8);
  if (isRepeatingBlock(head6) >= 2 && isRepeatingBlock(head6) < 6) {
    if (!tags.some((t) => t.startsWith("repeating-block"))) {
      score += 18;
      tags.push("repeating-block-partial");
    }
  } else if (isRepeatingBlock(tail6) >= 2 && isRepeatingBlock(tail6) < 6) {
    if (!tags.some((t) => t.startsWith("repeating-block"))) {
      score += 18;
      tags.push("repeating-block-partial");
    }
  }

  // --- heavy zeros / round endings ---
  const tz = trailingZeros(sub);
  if (tz >= 5) {
    score += 60;
    tags.push(`ending-${"0".repeat(tz)}`);
  } else if (tz === 4) {
    score += 40;
    tags.push("ending-0000");
  } else if (tz === 3) {
    score += 22;
    tags.push("ending-000");
  } else if (tz === 2) {
    score += 8;
    tags.push("ending-00");
  }

  // --- low distinct-digit count across the 8 ---
  const distinct = new Set(digits).size;
  if (distinct === 1) {
    // already captured by all-same; small reinforcing bonus only.
    score += 3;
  } else if (distinct === 2) {
    score += 22;
    tags.push("two-distinct-digits");
  } else if (distinct === 3) {
    score += 8;
    tags.push("three-distinct-digits");
  } else if (distinct === 4) {
    score += 4;
  }

  // --- mirror / symmetry bonus: the two 4-digit halves mirror each other ---
  const left = sub.slice(0, 4);
  const right = sub.slice(4, 8);
  const rightReversed = right.split("").reverse().join("");
  if (left === rightReversed && !isPalindrome(sub)) {
    score += 12;
    tags.push("mirror-halves");
  }
  // ladder: two stacked ascending/descending pairs etc. captured by runs;
  // add a small bonus when both halves are themselves repeating pairs.
  if (
    left[0] === left[1] &&
    left[2] === left[3] &&
    right[0] === right[1] &&
    right[2] === right[3] &&
    !aabb
  ) {
    score += 6;
    tags.push("ladder");
  }

  // --- arithmetic ladders, step 2 only (2468, 13579, 9753) ---
  // Steps of 0 (all-same) and +/-1 (asc/desc) are scored above. Larger steps are not
  // perceptible: 147036 and 159370 are arithmetic but read as random, and rewarding
  // them was a large part of why the top of the list looked arbitrary.
  const arith = longestArithRun(digits);
  if (Math.abs(arith.step) === 2) {
    if (arith.len === 8) {
      score += 62;
      tags.push(`ladder-step${arith.step}`);
    } else if (arith.len >= 5) {
      score += 30;
      tags.push(`ladder-step${arith.step}-x${arith.len}`);
    } else if (arith.len === 4) {
      score += 16;
      tags.push(`ladder-step${arith.step}-x4`);
    }
    // A 3-long step-2 run (135, 246) is not a pattern anyone notices; scoring it
    // filled the top of the list with numbers that look random.
  }

  // --- pair ladders: groups like 01 02 03 04 or 10 20 30 40 ---
  const pl = pairLadder(digits);
  if (pl.count === 4) {
    score += 50;
    tags.push("pair-ladder");
  } else if (pl.count === 3) {
    score += 12;
    tags.push("pair-ladder-partial");
  }

  // --- grouped pairs/triples: every group repeats (00 11 22 33, 444 555 ..) ---
  const groups = runLengths(digits);
  const cleanlyGrouped =
    groups.length >= 2 && groups.length <= 4 && groups.every((g) => g >= 2);
  if (cleanlyGrouped) {
    // 'aabb' (all groups == 2) already added 52; give the rest a real boost.
    score += aabb ? 8 : 24;
    if (!tags.includes("paired-AABB")) tags.push("grouped");
  }

  /*
   * --- zeros, and to a lesser extent ones, anywhere in the number ---
   *
   * The market rule, stated plainly by a dealer: "the more zeros the more premium",
   * with 010 00000000 the top of the tree and 11111111 close behind. The old code paid
   * for zeros only when they were TRAILING, or when there were at least five of them,
   * which produced a score that FELL as zeros were added:
   *
   *   20345678  1 zero  -> 54     00120012  4 zeros -> 38
   *   20304567  2 zeros -> 18     00100201  5 zeros -> 22
   *   20304056  3 zeros -> 12     00100001  6 zeros -> 76
   *
   * Non-monotonic, and inverted at the low end: each zero broke the ascending run that
   * was earning the points and nothing replaced it, so counts 1-4 earned nothing at all
   * for their zeros.
   *
   * A monotonic ladder fixes the ordering of the repetition patterns too, without a
   * separate rule: eight zeros collect the top rung while eight fours collect nothing,
   * so all-zeros now outranks all-ones which outranks all-fours — which the digit-blind
   * `all-same` bonus alone could never express.
   *
   * Indexed by count, 0..8.
   */
  const ZERO_LADDER = [0, 2, 7, 14, 23, 34, 46, 58, 70];
  const ONE_LADDER = [0, 0, 2, 5, 9, 14, 20, 27, 34];

  const zeros = countDigit(digits, 0);
  if (zeros >= 1) {
    score += ZERO_LADDER[zeros];
    if (zeros >= 5) tags.push(zeros >= 6 ? "mostly-zeros" : "many-zeros");
    else if (zeros >= 2) tags.push(`zeros-x${zeros}`);
  }

  const ones = countDigit(digits, 1);
  if (ones >= 2) {
    score += ONE_LADDER[ones];
    if (ones >= 5) tags.push("mostly-ones");
    else tags.push(`ones-x${ones}`);
  }

  /*
   * Normalise.
   *
   * A hard cap at 100 destroyed the ordering of everything above it, and the bonuses sum
   * well past 100: 00000077 (six zeros) and 00777777 (two zeros) both landed on exactly
   * 100, which contradicts the market rule the zero ladder exists to express. Nine
   * distinct patterns tied at the ceiling.
   *
   * So the cap is now a soft knee. Below 85 the score is untouched — that band holds
   * every number the carriers actually publish (the highest ever observed across ~206k
   * real numbers is 59), so the calibration of ALERT_THRESHOLD against real data is
   * unaffected. Above 85 it approaches 100 asymptotically, which keeps distinct patterns
   * distinctly ordered no matter how many bonuses they collect.
   */
  if (score < 0) score = 0;
  const KNEE = 85;
  if (score > KNEE) {
    score = Math.round(KNEE + (100 - KNEE) * (1 - Math.exp(-(score - KNEE) / 45)));
  }

  return { score, tags };
}
