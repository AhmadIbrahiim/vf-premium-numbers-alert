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
  if (isPalindrome(sub)) {
    score += 40;
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
    score += 12;
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

  // Normalize / cap.
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return { score, tags };
}
