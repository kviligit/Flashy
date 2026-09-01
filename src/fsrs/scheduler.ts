/**
 * The card state machine: New -> Learning -> Review, with Relearning after a
 * lapse. FSRS supplies the memory model; this module supplies the Anki-style
 * step handling around it, and turns stability into a concrete due date.
 *
 * Still pure — `now` and the random source are injected, never ambient.
 */

import { coerceParams } from './params.js';
import { intervalForStability, nextMemory, retrievability } from './core.js';
import type { FsrsConfig } from './config.js';
import {
  constrainInterval,
  DAY_MS,
  formatInterval,
  MINUTE_MS,
  type Random,
} from './interval.js';
import {
  RATINGS,
  Rating,
  State,
  type SchedulingCard,
  type SchedulingChoices,
  type SchedulingInfo,
} from './types.js';

export interface ScheduleOptions {
  /** Current time, in epoch milliseconds. */
  now: number;
  /**
   * Whole days since the card's last review. The caller owns this because
   * "a day" depends on the collection's day-cutoff hour, which this layer
   * deliberately knows nothing about. Defaults to the wall-clock difference.
   */
  elapsedDays?: number;
  /** Randomness for fuzz. Defaults to `Math.random`. */
  random?: Random;
}

/** A card that has never been seen. */
export function newCard(now: number): SchedulingCard {
  return {
    state: State.New,
    memory: null,
    lastReview: null,
    due: new Date(now).toISOString(),
    step: 0,
    lapses: 0,
    reps: 0,
  };
}

/** Whole days between the last review and now, floored at 0. */
export function elapsedDaysOf(card: SchedulingCard, now: number): number {
  if (!card.lastReview) return 0;
  const last = Date.parse(card.lastReview);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, Math.floor((now - last) / DAY_MS));
}

/**
 * Current recall probability, or `null` for a card with no memory state.
 * Used by the UI and by the stats layer; never by scheduling itself.
 */
export function cardRetrievability(
  config: FsrsConfig,
  card: SchedulingCard,
  now: number,
): number | null {
  if (!card.memory) return null;
  const w = coerceParams(config.params);
  return retrievability(w, elapsedDaysOf(card, now), card.memory.stability);
}

/**
 * Every outcome for a card, one per rating, so the UI can label all four
 * buttons before the reviewer commits to one.
 */
export function schedule(
  config: FsrsConfig,
  card: SchedulingCard,
  options: ScheduleOptions,
): SchedulingChoices {
  const now = options.now;
  const elapsed = options.elapsedDays ?? elapsedDaysOf(card, now);
  const random = options.random ?? Math.random;
  const w = coerceParams(config.params);

  const build = (rating: Rating): SchedulingInfo => {
    // Learning steps are same-day repetitions, so the memory model must be
    // told 0 days elapsed even if the card sat in the queue overnight.
    const memoryElapsed = card.state === State.New ? 0 : elapsed;
    const memory = nextMemory(w, card.memory, rating, memoryElapsed);

    const steps = stepsFor(card.state, config);
    const graduate = (): SchedulingInfo => {
      const raw = intervalForStability(w, memory.stability, config.desiredRetention);
      const days = constrainInterval(raw, config.maximumInterval, config.enableFuzz, random);
      return finish(card, memory, State.Review, 0, days * DAY_MS, days, now, rating);
    };
    const stepAt = (index: number): SchedulingInfo => {
      const minutes = steps[Math.min(index, steps.length - 1)] ?? 1;
      const state = card.state === State.Review || card.state === State.Relearning
        ? State.Relearning
        : State.Learning;
      const ms = minutes * MINUTE_MS;
      return finish(card, memory, state, index, ms, ms / DAY_MS, now, rating);
    };

    switch (card.state) {
      case State.New:
      case State.Learning:
      case State.Relearning: {
        if (steps.length === 0) return graduate();
        const at = card.state === State.New ? 0 : card.step;
        switch (rating) {
          case Rating.Again:
            return stepAt(0);
          case Rating.Hard:
            return hardStep(card, memory, steps, at, now, rating);
          case Rating.Good:
            return at + 1 >= steps.length ? graduate() : stepAt(at + 1);
          case Rating.Easy:
            return graduate();
        }
        return graduate();
      }
      case State.Review: {
        if (rating === Rating.Again) {
          const relearn = config.relearningSteps;
          if (relearn.length === 0) {
            const raw = intervalForStability(w, memory.stability, config.desiredRetention);
            const days = constrainInterval(raw, config.maximumInterval, config.enableFuzz, random);
            return finish(card, memory, State.Review, 0, days * DAY_MS, days, now, rating, 1);
          }
          const ms = relearn[0]! * MINUTE_MS;
          return finish(card, memory, State.Relearning, 0, ms, ms / DAY_MS, now, rating, 1);
        }
        return graduate();
      }
    }
    return graduate();
  };

  const choices = {} as SchedulingChoices;
  for (const rating of RATINGS) choices[rating] = build(rating);
  enforceOrdering(choices, config.maximumInterval);
  return choices;
}

/** Convenience: schedule and pick one rating's result. */
export function answer(
  config: FsrsConfig,
  card: SchedulingCard,
  rating: Rating,
  options: ScheduleOptions,
): SchedulingInfo {
  return schedule(config, card, options)[rating];
}

function stepsFor(state: State, config: FsrsConfig): number[] {
  return state === State.Review || state === State.Relearning
    ? config.relearningSteps
    : config.learningSteps;
}

/**
 * Hard repeats the current step rather than advancing. On the very first
 * step Anki instead waits the average of the first two steps, which gives
 * Hard somewhere sensible to sit between Again and Good.
 */
function hardStep(
  card: SchedulingCard,
  memory: { stability: number; difficulty: number },
  steps: number[],
  at: number,
  now: number,
  rating: Rating,
): SchedulingInfo {
  const first = steps[0] ?? 1;
  let minutes: number;
  if (at === 0) minutes = steps.length >= 2 ? (first + steps[1]!) / 2 : first * 1.5;
  else minutes = steps[Math.min(at, steps.length - 1)] ?? first;

  const state = card.state === State.Review || card.state === State.Relearning
    ? State.Relearning
    : State.Learning;
  const ms = minutes * MINUTE_MS;
  return finish(card, memory, state, at, ms, ms / DAY_MS, now, rating);
}

function finish(
  card: SchedulingCard,
  memory: { stability: number; difficulty: number },
  state: State,
  step: number,
  dueInMs: number,
  intervalDays: number,
  now: number,
  _rating: Rating,
  extraLapses = 0,
): SchedulingInfo {
  return {
    card: {
      state,
      memory,
      lastReview: new Date(now).toISOString(),
      due: new Date(now + dueInMs).toISOString(),
      step,
      lapses: card.lapses + extraLapses,
      reps: card.reps + 1,
    },
    intervalDays,
    label: formatInterval(intervalDays),
  };
}

/**
 * Guarantee Again <= Hard <= Good <= Easy on the buttons. FSRS almost always
 * produces this ordering already, but rounding and fuzz can invert two
 * neighbouring options, which reads as a bug to the reviewer. Only
 * day-scale (graduated) intervals are nudged; learning steps are fixed by
 * configuration and are left exactly as configured. The nudge can never
 * push an interval past `maximumInterval` — at the ceiling, two buttons
 * showing the same interval is the correct answer.
 */
function enforceOrdering(choices: SchedulingChoices, maximumInterval: number): void {
  for (let i = 1; i < RATINGS.length; i++) {
    const previous = choices[RATINGS[i - 1]!];
    const current = choices[RATINGS[i]!];
    if (current.card.state !== State.Review) continue;
    if (previous.intervalDays < 1) continue;
    if (current.intervalDays > previous.intervalDays) continue;

    const days = Math.min(Math.round(previous.intervalDays) + 1, maximumInterval);
    if (days <= current.intervalDays) continue;
    current.intervalDays = days;
    current.label = formatInterval(days);
    const base = Date.parse(current.card.lastReview ?? new Date().toISOString());
    current.card.due = new Date(base + days * DAY_MS).toISOString();
  }
}
