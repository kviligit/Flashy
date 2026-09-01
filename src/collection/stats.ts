/**
 * Statistics, computed from cards and review logs.
 *
 * Pure functions over plain arrays: the UI loads the data, these shape it,
 * and every one of them is testable without a database or a DOM.
 */

import type { Card, ReviewLog } from '../domain/types.js';
import { Rating, State } from '../fsrs/index.js';
import { dayIndex, dayStart } from '../scheduler/day.js';

/** Interval, in days, at which a review card is considered mature. */
export const MATURE_DAYS = 21;

export interface CardCounts {
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
  buried: number;
  total: number;
}

/** How the collection breaks down right now. Suspended and buried win. */
export function cardCounts(cards: readonly Card[], now: number): CardCounts {
  const counts: CardCounts = {
    new: 0,
    learning: 0,
    young: 0,
    mature: 0,
    suspended: 0,
    buried: 0,
    total: cards.length,
  };

  for (const card of cards) {
    if (card.suspended) {
      counts.suspended += 1;
      continue;
    }
    if (card.buriedUntil && Date.parse(card.buriedUntil) > now) {
      counts.buried += 1;
      continue;
    }
    switch (card.state) {
      case State.New:
        counts.new += 1;
        break;
      case State.Learning:
      case State.Relearning:
        counts.learning += 1;
        break;
      case State.Review:
        if (intervalDaysOf(card) >= MATURE_DAYS) counts.mature += 1;
        else counts.young += 1;
        break;
    }
  }

  return counts;
}

/** The interval a card currently sits on, in days. */
export function intervalDaysOf(card: Card): number {
  if (!card.lastReview) return 0;
  const last = Date.parse(card.lastReview);
  const due = Date.parse(card.due);
  if (!Number.isFinite(last) || !Number.isFinite(due)) return 0;
  return Math.max(0, (due - last) / 86_400_000);
}

export interface ForecastDay {
  /** Days from today; 0 is today. */
  offset: number;
  young: number;
  mature: number;
  total: number;
}

/**
 * How many review cards fall due on each of the next `days` days.
 * Anything already overdue is folded into today, which is where it will
 * actually be studied.
 */
export function dueForecast(
  cards: readonly Card[],
  now: number,
  cutoffHour: number,
  days = 30,
): ForecastDay[] {
  const out: ForecastDay[] = Array.from({ length: days }, (_, offset) => ({
    offset,
    young: 0,
    mature: 0,
    total: 0,
  }));

  const today = dayIndex(now, cutoffHour);

  for (const card of cards) {
    if (card.state !== State.Review || card.suspended) continue;
    const due = Date.parse(card.due);
    if (!Number.isFinite(due)) continue;

    const offset = Math.max(0, dayIndex(due, cutoffHour) - today);
    if (offset >= days) continue;

    const bucket = out[offset]!;
    if (intervalDaysOf(card) >= MATURE_DAYS) bucket.mature += 1;
    else bucket.young += 1;
    bucket.total += 1;
  }

  return out;
}

export interface ReviewDay {
  /** Days before today; 0 is today. */
  offset: number;
  learning: number;
  young: number;
  mature: number;
  relearning: number;
  total: number;
  timeMs: number;
}

/** Answers per day over the last `days` days, split by what was answered. */
export function reviewHistory(
  logs: readonly ReviewLog[],
  now: number,
  cutoffHour: number,
  days = 30,
): ReviewDay[] {
  const out: ReviewDay[] = Array.from({ length: days }, (_, i) => ({
    offset: days - 1 - i,
    learning: 0,
    young: 0,
    mature: 0,
    relearning: 0,
    total: 0,
    timeMs: 0,
  }));

  const today = dayIndex(now, cutoffHour);

  for (const log of logs) {
    const offset = today - dayIndex(log.reviewedAt, cutoffHour);
    if (offset < 0 || offset >= days) continue;

    const bucket = out[days - 1 - offset]!;
    switch (log.stateBefore) {
      case State.New:
      case State.Learning:
        bucket.learning += 1;
        break;
      case State.Relearning:
        bucket.relearning += 1;
        break;
      case State.Review:
        if (log.lastIntervalDays >= MATURE_DAYS) bucket.mature += 1;
        else bucket.young += 1;
        break;
    }
    bucket.total += 1;
    bucket.timeMs += log.timeTakenMs;
  }

  return out;
}

export interface Retention {
  /** Answers on review-state cards. */
  reviews: number;
  /** Of those, how many were not Again. */
  passed: number;
  /** passed / reviews, or null when there is nothing to measure. */
  rate: number | null;
}

/**
 * True retention: how often a card that was actually due was recalled.
 *
 * Only answers on cards already in the Review state count. Learning-step
 * answers are excluded, because failing a card you saw ten minutes ago says
 * nothing about long-term recall — including them is the classic way to
 * make a retention figure look better than it is.
 */
export function trueRetention(
  logs: readonly ReviewLog[],
  since = Number.NEGATIVE_INFINITY,
): Retention {
  let reviews = 0;
  let passed = 0;
  for (const log of logs) {
    if (log.reviewedAt < since) continue;
    if (log.stateBefore !== State.Review) continue;
    reviews += 1;
    if (log.rating !== Rating.Again) passed += 1;
  }
  return { reviews, passed, rate: reviews === 0 ? null : passed / reviews };
}

/** How often each answer button was pressed, split by card maturity. */
export interface ButtonUsage {
  rating: Rating;
  learning: number;
  young: number;
  mature: number;
  total: number;
}

export function buttonUsage(logs: readonly ReviewLog[]): ButtonUsage[] {
  const out: ButtonUsage[] = ([1, 2, 3, 4] as Rating[]).map((rating) => ({
    rating,
    learning: 0,
    young: 0,
    mature: 0,
    total: 0,
  }));

  for (const log of logs) {
    const bucket = out[log.rating - 1];
    if (!bucket) continue;
    if (log.stateBefore === State.Review) {
      if (log.lastIntervalDays >= MATURE_DAYS) bucket.mature += 1;
      else bucket.young += 1;
    } else {
      bucket.learning += 1;
    }
    bucket.total += 1;
  }

  return out;
}

export interface Bucket {
  label: string;
  from: number;
  to: number;
  count: number;
}

const INTERVAL_BUCKETS: Array<[string, number, number]> = [
  ['<1d', 0, 1],
  ['1d', 1, 2],
  ['2-3d', 2, 4],
  ['4-7d', 4, 8],
  ['1-2w', 8, 15],
  ['2-4w', 15, 31],
  ['1-3mo', 31, 93],
  ['3-6mo', 93, 186],
  ['6-12mo', 186, 366],
  ['1y+', 366, Infinity],
];

/** Distribution of current review intervals. */
export function intervalHistogram(cards: readonly Card[]): Bucket[] {
  const buckets: Bucket[] = INTERVAL_BUCKETS.map(([label, from, to]) => ({
    label,
    from,
    to,
    count: 0,
  }));

  for (const card of cards) {
    if (card.state !== State.Review || card.suspended) continue;
    const days = intervalDaysOf(card);
    const bucket = buckets.find((b) => days >= b.from && days < b.to);
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

/** Distribution of difficulty, in ten bands from 1 to 10. */
export function difficultyHistogram(cards: readonly Card[]): Bucket[] {
  const buckets: Bucket[] = Array.from({ length: 10 }, (_, i) => ({
    label: String(i + 1),
    from: i + 1,
    to: i + 2,
    count: 0,
  }));

  for (const card of cards) {
    if (!card.memory || card.suspended) continue;
    const index = Math.min(9, Math.max(0, Math.floor(card.memory.difficulty) - 1));
    buckets[index]!.count += 1;
  }

  return buckets;
}

export interface StudyStreak {
  /** Consecutive study days ending today or yesterday. */
  current: number;
  longest: number;
  /** Distinct days on which anything was answered. */
  daysStudied: number;
  totalReviews: number;
  totalTimeMs: number;
}

export function studyStreak(
  logs: readonly ReviewLog[],
  now: number,
  cutoffHour: number,
): StudyStreak {
  const days = new Set<number>();
  let totalTimeMs = 0;
  for (const log of logs) {
    days.add(dayIndex(log.reviewedAt, cutoffHour));
    totalTimeMs += log.timeTakenMs;
  }

  const sorted = [...days].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  // A streak survives until the current day is over, so "today or
  // yesterday" both count as unbroken.
  const today = dayIndex(now, cutoffHour);
  let current = 0;
  let cursor = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  while (cursor !== null && days.has(cursor)) {
    current += 1;
    cursor -= 1;
  }

  return {
    current,
    longest,
    daysStudied: days.size,
    totalReviews: logs.length,
    totalTimeMs,
  };
}

/** Epoch ms `days` study days before now — the cutoff for "last N days". */
export function daysAgo(now: number, cutoffHour: number, days: number): number {
  return dayStart(now, cutoffHour) - (days - 1) * 86_400_000;
}
