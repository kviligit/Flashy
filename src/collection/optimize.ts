/**
 * Fitting the FSRS weights to one person's actual review history.
 *
 * The reference implementation trains with gradient descent through a
 * differentiable model. This is a coordinate-descent hill climb over the
 * same log-loss with the same parameter bounds: much simpler, no
 * dependencies, and it runs in a browser tab in a second. It will not match
 * a full trainer's result, but it reliably beats the stock defaults once
 * there is a real history to fit, and it can never make the loss worse than
 * the parameters it started from.
 */

import { retrievability, nextMemory } from '../fsrs/core.js';
import { clamp, coerceParams, DEFAULT_PARAMS, PARAM_BOUNDS, PARAM_COUNT } from '../fsrs/params.js';
import { Rating, State, type Memory } from '../fsrs/types.js';
import type { ReviewLog } from '../domain/types.js';

/** One answer, reduced to what the model needs. */
export interface ReviewItem {
  rating: Rating;
  /** Whole days since the previous review of this card. */
  elapsedDays: number;
}

/** One card's answers, in order, starting from its introduction. */
export type Sequence = ReviewItem[];

/**
 * Group review logs into per-card sequences.
 *
 * A card that was reset with "forget" starts a new sequence: its memory
 * state was discarded, so replaying across the reset would model something
 * that never happened.
 */
export function buildSequences(logs: readonly ReviewLog[]): Sequence[] {
  const byCard = new Map<string, ReviewLog[]>();
  for (const log of logs) {
    const list = byCard.get(log.cardId);
    if (list) list.push(log);
    else byCard.set(log.cardId, [log]);
  }

  const sequences: Sequence[] = [];
  for (const list of byCard.values()) {
    list.sort((a, b) => a.reviewedAt - b.reviewedAt);

    let current: Sequence = [];
    for (const [index, log] of list.entries()) {
      // A New state after the first entry means the card was reset.
      if (index > 0 && log.stateBefore === State.New) {
        if (current.length > 1) sequences.push(current);
        current = [];
      }
      current.push({
        rating: log.rating as Rating,
        elapsedDays: Math.max(0, Math.round(log.elapsedDays)),
      });
    }
    if (current.length > 1) sequences.push(current);
  }

  return sequences;
}

export interface LossResult {
  /** Mean binary log loss over the scored reviews. */
  loss: number;
  /** How many reviews were actually scored. */
  count: number;
  /** Root mean squared error between predicted and observed recall. */
  rmse: number;
}

/** Probabilities are clamped away from 0 and 1 so the log stays finite. */
const EPSILON = 1e-6;

/**
 * Mean log loss of a parameter set against a history.
 *
 * Only reviews with at least one day elapsed are scored. Same-day answers
 * have a predicted recall of essentially 1, so including them would swamp
 * the objective with reviews that carry no information about forgetting.
 */
export function evaluateLoss(params: readonly number[], sequences: readonly Sequence[]): LossResult {
  const w = params;
  let total = 0;
  let squared = 0;
  let count = 0;

  for (const sequence of sequences) {
    let memory: Memory | null = null;

    for (const [index, review] of sequence.entries()) {
      if (index > 0 && memory && review.elapsedDays > 0) {
        const predicted = clamp(
          retrievability(w, review.elapsedDays, memory.stability),
          EPSILON,
          1 - EPSILON,
        );
        const observed = review.rating === Rating.Again ? 0 : 1;
        total += -(observed * Math.log(predicted) + (1 - observed) * Math.log(1 - predicted));
        squared += (predicted - observed) ** 2;
        count += 1;
      }
      memory = nextMemory(w, memory, review.rating, index === 0 ? 0 : review.elapsedDays);
    }
  }

  return {
    loss: count === 0 ? Number.POSITIVE_INFINITY : total / count,
    count,
    rmse: count === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(squared / count),
  };
}

export interface OptimizeOptions {
  /** Where to start. Defaults to the stock parameters. */
  initial?: readonly number[];
  /** Full passes over all 21 weights. */
  passes?: number;
  /** Called between passes, so a UI can show progress and stay responsive. */
  onProgress?: (pass: number, passes: number, loss: number) => void | Promise<void>;
}

export interface OptimizeResult {
  params: number[];
  initialLoss: number;
  finalLoss: number;
  initialRmse: number;
  finalRmse: number;
  reviewsUsed: number;
  /** How many weights actually moved. */
  changed: number;
}

/** Below this there is not enough signal to fit anything meaningful. */
export const MIN_REVIEWS_TO_OPTIMIZE = 100;

/**
 * Coordinate descent: try each weight up and down by a step, keep any move
 * that lowers the loss, then shrink the step and go round again.
 */
export async function optimize(
  sequences: readonly Sequence[],
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const passes = options.passes ?? 6;
  const start = coerceParams([...(options.initial ?? DEFAULT_PARAMS)]);

  const baseline = evaluateLoss(start, sequences);
  if (!Number.isFinite(baseline.loss)) {
    throw new Error('There are no dated reviews to learn from yet.');
  }

  const params = [...start];
  let best = baseline.loss;

  for (let pass = 0; pass < passes; pass++) {
    // Steps shrink geometrically: coarse moves first, fine tuning later.
    const scale = 0.5 * Math.pow(0.55, pass);

    for (let i = 0; i < PARAM_COUNT; i++) {
      const [lo, hi] = PARAM_BOUNDS[i]!;
      const span = hi - lo;
      const step = Math.max(span * scale * 0.25, 1e-4);
      const original = params[i]!;

      for (const candidate of [original + step, original - step]) {
        const clamped = clamp(candidate, lo, hi);
        if (clamped === original) continue;

        params[i] = clamped;
        const { loss } = evaluateLoss(params, sequences);
        if (loss < best - 1e-12) {
          best = loss;
        } else {
          params[i] = original;
        }
      }
    }

    await options.onProgress?.(pass + 1, passes, best);
  }

  const final = evaluateLoss(params, sequences);

  // Never hand back something worse than what we were given.
  if (final.loss > baseline.loss) {
    return {
      params: [...start],
      initialLoss: baseline.loss,
      finalLoss: baseline.loss,
      initialRmse: baseline.rmse,
      finalRmse: baseline.rmse,
      reviewsUsed: baseline.count,
      changed: 0,
    };
  }

  return {
    params,
    initialLoss: baseline.loss,
    finalLoss: final.loss,
    initialRmse: baseline.rmse,
    finalRmse: final.rmse,
    reviewsUsed: final.count,
    changed: params.reduce((n, value, i) => n + (Math.abs(value - start[i]!) > 1e-9 ? 1 : 0), 0),
  };
}
