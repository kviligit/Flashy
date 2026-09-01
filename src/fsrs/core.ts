/**
 * FSRS-6 memory model — the pure maths, and nothing else.
 *
 * Ported from the reference implementation
 * (open-spaced-repetition/fsrs-rs, `src/model.rs`). Every function here is
 * total, side-effect free and independent of the calendar: elapsed time is
 * always passed in as a number of days.
 *
 * The two state variables:
 *   stability (S)  — days for recall probability to fall from 100% to 90%.
 *   difficulty (D) — 1..10; how weakly a success grows stability.
 */

import {
  clamp,
  D_MAX,
  D_MIN,
  S_MAX,
  S_MIN,
  type Params,
} from './params.js';
import type { Memory, Rating } from './types.js';

/** `decay` and `factor` both fall out of `w[20]`; compute them once. */
function curveConstants(w: Params): { decay: number; factor: number } {
  const decay = -w[20]!;
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return { decay, factor };
}

/**
 * Probability of recall `t` days after a review, given stability `s`.
 * A power curve, not an exponential — that is the core FSRS claim.
 */
export function retrievability(w: Params, elapsedDays: number, stability: number): number {
  const { decay, factor } = curveConstants(w);
  const s = clamp(stability, S_MIN, S_MAX);
  return Math.pow((Math.max(elapsedDays, 0) / s) * factor + 1, decay);
}

/**
 * Inverse of {@link retrievability}: how many days until recall probability
 * decays to `desiredRetention`.
 */
export function intervalForStability(
  w: Params,
  stability: number,
  desiredRetention: number,
): number {
  const { decay, factor } = curveConstants(w);
  const s = clamp(stability, S_MIN, S_MAX);
  const r = clamp(desiredRetention, 0.7, 0.99);
  return (s / factor) * (Math.pow(r, 1 / decay) - 1);
}

/** Stability assigned by the very first review, chosen by its rating. */
export function initialStability(w: Params, rating: Rating): number {
  return w[clamp(rating - 1, 0, 3)]!;
}

/** Difficulty assigned by the very first review, chosen by its rating. */
export function initialDifficulty(w: Params, rating: Rating): number {
  return w[4]! - Math.exp(w[5]! * (rating - 1)) + 1;
}

/**
 * Difficulty moves by a fixed step per rating, damped so that cards already
 * near the maximum move less. Mean reversion (applied separately) then pulls
 * it back toward the difficulty an "Easy" first answer would have set,
 * which stops long streaks from driving D to an extreme.
 */
function nextDifficulty(w: Params, difficulty: number, rating: Rating): number {
  const deltaD = -w[6]! * (rating - 3);
  const damped = ((10 - difficulty) * deltaD) / 9;
  return difficulty + damped;
}

function meanReversion(w: Params, newDifficulty: number): number {
  const target = w[4]! - Math.exp(w[5]! * 3) + 1; // initialDifficulty at Easy
  return w[7]! * (target - newDifficulty) + newDifficulty;
}

/** Stability after a successful review (Hard, Good or Easy) on a later day. */
function stabilityAfterSuccess(
  w: Params,
  stability: number,
  difficulty: number,
  r: number,
  rating: Rating,
): number {
  const hardPenalty = rating === 2 ? w[15]! : 1;
  const easyBonus = rating === 4 ? w[16]! : 1;
  return (
    stability *
    (Math.exp(w[8]!) *
      (11 - difficulty) *
      Math.pow(stability, -w[9]!) *
      (Math.exp((1 - r) * w[10]!) - 1) *
      hardPenalty *
      easyBonus +
      1)
  );
}

/**
 * Stability after a lapse. Capped so a failure can never be worth more than
 * the same card would have been worth had it been answered again the same
 * day — otherwise forgetting could increase stability.
 */
function stabilityAfterFailure(
  w: Params,
  stability: number,
  difficulty: number,
  r: number,
): number {
  const s =
    w[11]! *
    Math.pow(difficulty, -w[12]!) *
    (Math.pow(stability + 1, w[13]!) - 1) *
    Math.exp((1 - r) * w[14]!);
  const cap = stability / Math.exp(w[17]! * w[18]!);
  return Math.min(s, cap);
}

/**
 * Stability after a same-day review (`elapsedDays === 0`), such as a second
 * pass through a learning step. FSRS-6 makes this shrink as stability grows,
 * via `w[19]`, so repeated same-day drilling stops paying off.
 */
function stabilityShortTerm(w: Params, stability: number, rating: Rating): number {
  const sinc = Math.exp(w[17]! * (rating - 3 + w[18]!)) * Math.pow(stability, -w[19]!);
  return stability * (rating >= 2 ? Math.max(sinc, 1) : sinc);
}

/**
 * Advance the memory state by one review.
 *
 * @param memory      current state, or `null` for a card never answered.
 * @param elapsedDays whole days since the last review; `0` for same-day.
 */
export function nextMemory(
  w: Params,
  memory: Memory | null,
  rating: Rating,
  elapsedDays: number,
): Memory {
  if (memory === null) {
    return {
      stability: clamp(initialStability(w, rating), S_MIN, S_MAX),
      difficulty: clamp(initialDifficulty(w, rating), D_MIN, D_MAX),
    };
  }

  const s = clamp(memory.stability, S_MIN, S_MAX);
  const d = clamp(memory.difficulty, D_MIN, D_MAX);
  const t = Math.max(elapsedDays, 0);
  const r = retrievability(w, t, s);

  let stability: number;
  if (t === 0) stability = stabilityShortTerm(w, s, rating);
  else if (rating === 1) stability = stabilityAfterFailure(w, s, d, r);
  else stability = stabilityAfterSuccess(w, s, d, r, rating);

  const difficulty = clamp(meanReversion(w, nextDifficulty(w, d, rating)), D_MIN, D_MAX);

  return { stability: clamp(stability, S_MIN, S_MAX), difficulty };
}
