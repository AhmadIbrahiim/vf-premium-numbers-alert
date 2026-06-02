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
 * Treat the 8 digits as four two-digit groups (e.g. 01 02 03 04) and report
 * how many leading groups form an arithmetic sequence with a non-zero step.
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
    score += 12;
    tags.push("triple-digit");
  }

  // --- ascending / descending consecutive runs ---
  const asc = longestAscRun(digits);
  const desc = longestDescRun(digits);
  if (asc === 8) {
    score += 85;
    tags.push("ascending");
  } else if (asc >= 4) {
    score += (asc - 3) * 14; // 4->14, 5->28, 6->42, 7->56
    tags.push(`ascending-run-x${asc}`);
  }
  if (desc === 8) {
    score += 85;
    tags.push("descending");
  } else if (desc >= 4) {
    score += (desc - 3) * 14;
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
  if (aabb) {
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
  if (isPalindrome(sub)) {
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

  // --- arithmetic ladders with ANY constant step >= 2 (e.g. 2468, 13579, 9753) ---
  // (steps of 0 = all-same and +/-1 = asc/desc are scored above; skip those here.)
  const arith = longestArithRun(digits);
  if (Math.abs(arith.step) >= 2) {
    if (arith.len === 8) {
      score += 80;
      tags.push(`ladder-step${arith.step}`);
    } else if (arith.len >= 5) {
      score += 50;
      tags.push(`ladder-step${arith.step}-x${arith.len}`);
    } else if (arith.len === 4) {
      score += 30;
      tags.push(`ladder-step${arith.step}-x4`);
    } else if (arith.len === 3) {
      score += 10;
      tags.push(`ladder-step${arith.step}-x3`);
    }
  }

  // --- pair ladders: groups like 01 02 03 04 or 10 20 30 40 ---
  const pl = pairLadder(digits);
  if (pl.count === 4) {
    score += 55;
    tags.push("pair-ladder");
  } else if (pl.count === 3) {
    score += 25;
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

  // --- lots of zeros anywhere (easy to dictate), beyond trailing zeros ---
  const zeros = countDigit(digits, 0);
  if (zeros >= 6) {
    score += 24;
    tags.push("mostly-zeros");
  } else if (zeros >= 5 && tz < 5) {
    score += 14;
    tags.push("many-zeros");
  }

  // Normalize / cap.
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return { score, tags };
}
