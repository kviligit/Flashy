/**
 * FSRS-6 types. This module is pure: no I/O, no DOM, no ambient clock.
 * Everything the algorithm needs is passed in.
 */

/** The four grades a reviewer can give, matching Anki's buttons. */
export const Rating = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
} as const;
export type Rating = (typeof Rating)[keyof typeof Rating];

export const RATINGS: readonly Rating[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export const RATING_LABEL: Record<Rating, string> = {
  [Rating.Again]: 'Again',
  [Rating.Hard]: 'Hard',
  [Rating.Good]: 'Good',
  [Rating.Easy]: 'Easy',
};

/**
 * Where a card sits in its lifecycle.
 *
 * `New` cards have never been answered. `Learning` cards are working through
 * the learning steps, `Relearning` through the lapse steps after a failure,
 * and `Review` cards are on long, FSRS-computed intervals.
 */
export const State = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const;
export type State = (typeof State)[keyof typeof State];

export const STATE_LABEL: Record<State, string> = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
};

/**
 * The memory state FSRS tracks per card.
 *
 * - `stability`: days until recall probability decays to `desiredRetention`'s
 *   reference point (0.9). Bigger = remembered longer.
 * - `difficulty`: 1..10, how much each successful review grows stability.
 *   Lower = easier material.
 */
export interface Memory {
  stability: number;
  difficulty: number;
}

/** The scheduling-relevant part of a card. Storage adds identity and content. */
export interface SchedulingCard {
  state: State;
  /** null until the card has been answered at least once. */
  memory: Memory | null;
  /** ISO timestamp of the last review, or null if never reviewed. */
  lastReview: string | null;
  /** ISO timestamp when the card is next due. */
  due: string;
  /** Index into the learning/relearning step list; 0 when not stepping. */
  step: number;
  /** Count of Again ratings given while in the Review state. */
  lapses: number;
  /** Total answers given. */
  reps: number;
}

/** What the scheduler produces for one possible rating. */
export interface SchedulingInfo {
  card: SchedulingCard;
  /** Interval in days (fractional for sub-day learning steps). */
  intervalDays: number;
  /** Human-facing label, e.g. "10m" or "3d". */
  label: string;
}

/** All four options, so the UI can preview every button. */
export type SchedulingChoices = Record<Rating, SchedulingInfo>;
