import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buttonUsage,
  cardCounts,
  daysAgo,
  difficultyHistogram,
  dueForecast,
  intervalDaysOf,
  intervalHistogram,
  MATURE_DAYS,
  reviewHistory,
  studyStreak,
  trueRetention,
} from './stats.js';
import { makeCard } from '../domain/cards.js';
import { Rating, State } from '../fsrs/index.js';
import type { Card, ReviewLog } from '../domain/types.js';

const CUTOFF = 4;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 86_400_000;

function card(overrides: Partial<Card> = {}): Card {
  return { ...makeCard({ noteId: 'n', deckId: 'd', ord: 0, position: 0, now: NOW }), ...overrides };
}

/** A review card sitting on a given interval, due `dueInDays` from now. */
function reviewCard(intervalDays: number, dueInDays: number): Card {
  const due = NOW + dueInDays * DAY;
  return card({
    state: State.Review,
    memory: { stability: intervalDays, difficulty: 5 },
    lastReview: new Date(due - intervalDays * DAY).toISOString(),
    due: new Date(due).toISOString(),
  });
}

function log(overrides: Partial<ReviewLog> = {}): ReviewLog {
  return {
    id: 'l',
    cardId: 'c',
    reviewedAt: NOW,
    rating: Rating.Good,
    stateBefore: State.Review,
    stateAfter: State.Review,
    intervalDays: 10,
    lastIntervalDays: 5,
    elapsedDays: 5,
    stability: 10,
    difficulty: 5,
    timeTakenMs: 4000,
    snapshot: card(),
    siblingsBuried: [],
    ...overrides,
  };
}

// --- card counts ---------------------------------------------------------

test('cardCounts splits by state, with young and mature separated', () => {
  const counts = cardCounts(
    [
      card(),
      card(),
      card({ state: State.Learning }),
      card({ state: State.Relearning }),
      reviewCard(5, 1),
      reviewCard(MATURE_DAYS, 1),
      reviewCard(100, 1),
    ],
    NOW,
  );
  assert.equal(counts.new, 2);
  assert.equal(counts.learning, 2, 'learning and relearning are one bucket');
  assert.equal(counts.young, 1);
  assert.equal(counts.mature, 2, '21 days is the maturity boundary, inclusive');
  assert.equal(counts.total, 7);
});

test('suspended and buried cards are counted separately, not by state', () => {
  const counts = cardCounts(
    [
      card({ suspended: true }),
      reviewCard(100, 1),
      { ...reviewCard(100, 1), buriedUntil: new Date(NOW + DAY).toISOString() },
      { ...reviewCard(100, 1), buriedUntil: new Date(NOW - DAY).toISOString() },
    ],
    NOW,
  );
  assert.equal(counts.suspended, 1);
  assert.equal(counts.buried, 1, 'only a bury still in the future counts');
  assert.equal(counts.mature, 2, 'the expired bury is back in the normal counts');
});

test('intervalDaysOf is zero for a card never reviewed', () => {
  assert.equal(intervalDaysOf(card()), 0);
  assert.equal(Math.round(intervalDaysOf(reviewCard(7, 3))), 7);
});

// --- forecast ------------------------------------------------------------

test('dueForecast buckets by day and folds overdue cards into today', () => {
  const forecast = dueForecast(
    [
      reviewCard(5, -10), // badly overdue
      reviewCard(5, -1), // due yesterday
      reviewCard(5, 0), // today
      reviewCard(5, 1),
      reviewCard(30, 1),
      reviewCard(5, 400), // beyond the window
    ],
    NOW,
    CUTOFF,
    30,
  );

  assert.equal(forecast[0]!.total, 3, 'overdue cards land on today');
  assert.equal(forecast[1]!.total, 2);
  assert.equal(forecast[1]!.young, 1);
  assert.equal(forecast[1]!.mature, 1);
  assert.equal(forecast.length, 30);
  assert.equal(
    forecast.reduce((sum, day) => sum + day.total, 0),
    5,
    'the card beyond the window is not counted',
  );
});

test('dueForecast ignores new, learning and suspended cards', () => {
  const forecast = dueForecast(
    [card(), card({ state: State.Learning }), { ...reviewCard(5, 1), suspended: true }],
    NOW,
    CUTOFF,
    30,
  );
  assert.equal(forecast.reduce((s, d) => s + d.total, 0), 0);
});

// --- review history ------------------------------------------------------

test('reviewHistory buckets answers by study day, oldest first', () => {
  const history = reviewHistory(
    [
      log({ reviewedAt: NOW }),
      log({ reviewedAt: NOW }),
      log({ reviewedAt: NOW - DAY }),
      log({ reviewedAt: NOW - 40 * DAY }), // outside the window
    ],
    NOW,
    CUTOFF,
    30,
  );

  assert.equal(history.length, 30);
  assert.equal(history[29]!.offset, 0, 'the last entry is today');
  assert.equal(history[29]!.total, 2);
  assert.equal(history[28]!.total, 1);
  assert.equal(history.reduce((s, d) => s + d.total, 0), 3);
});

test('reviewHistory splits by what was answered, using the pre-answer state', () => {
  const history = reviewHistory(
    [
      log({ stateBefore: State.New }),
      log({ stateBefore: State.Learning }),
      log({ stateBefore: State.Relearning }),
      log({ stateBefore: State.Review, lastIntervalDays: 5 }),
      log({ stateBefore: State.Review, lastIntervalDays: 60 }),
    ],
    NOW,
    CUTOFF,
    30,
  );
  const today = history[29]!;
  assert.equal(today.learning, 2, 'new and learning share a bucket');
  assert.equal(today.relearning, 1);
  assert.equal(today.young, 1);
  assert.equal(today.mature, 1);
  assert.equal(today.timeMs, 5 * 4000);
});

// --- retention -----------------------------------------------------------

test('true retention counts only answers on cards that were in review', () => {
  const r = trueRetention([
    log({ stateBefore: State.Review, rating: Rating.Good }),
    log({ stateBefore: State.Review, rating: Rating.Hard }),
    log({ stateBefore: State.Review, rating: Rating.Again }),
    // These must not count: failing a card you saw ten minutes ago says
    // nothing about long-term recall.
    log({ stateBefore: State.Learning, rating: Rating.Again }),
    log({ stateBefore: State.New, rating: Rating.Again }),
    log({ stateBefore: State.Relearning, rating: Rating.Again }),
  ]);
  assert.equal(r.reviews, 3);
  assert.equal(r.passed, 2, 'Hard counts as recalled');
  assert.ok(Math.abs(r.rate! - 2 / 3) < 1e-9);
});

test('retention over an empty period reports null rather than zero', () => {
  assert.equal(trueRetention([]).rate, null);
  assert.equal(trueRetention([log({ stateBefore: State.New })]).rate, null);
});

test('retention honours the since cutoff', () => {
  const logs = [
    log({ reviewedAt: NOW - 40 * DAY, rating: Rating.Again }),
    log({ reviewedAt: NOW, rating: Rating.Good }),
  ];
  assert.equal(trueRetention(logs).rate, 0.5);
  assert.equal(trueRetention(logs, daysAgo(NOW, CUTOFF, 30)).rate, 1);
});

// --- buttons and histograms ---------------------------------------------

test('buttonUsage tallies each rating by maturity', () => {
  const usage = buttonUsage([
    log({ rating: Rating.Again, stateBefore: State.Review, lastIntervalDays: 60 }),
    log({ rating: Rating.Good, stateBefore: State.Review, lastIntervalDays: 3 }),
    log({ rating: Rating.Good, stateBefore: State.Learning }),
    log({ rating: Rating.Easy, stateBefore: State.Review, lastIntervalDays: 60 }),
  ]);
  assert.equal(usage[0]!.mature, 1, 'Again on a mature card');
  assert.equal(usage[2]!.young, 1);
  assert.equal(usage[2]!.learning, 1);
  assert.equal(usage[2]!.total, 2);
  assert.equal(usage[3]!.mature, 1);
  assert.equal(usage[1]!.total, 0, 'Hard was never pressed');
});

test('intervalHistogram places cards in the right bands, once each', () => {
  const cards = [reviewCard(1, 1), reviewCard(3, 1), reviewCard(10, 1), reviewCard(400, 1)];
  const buckets = intervalHistogram(cards);
  assert.equal(buckets.reduce((s, b) => s + b.count, 0), 4, 'every card lands somewhere');
  assert.equal(buckets.find((b) => b.label === '1d')?.count, 1);
  assert.equal(buckets.find((b) => b.label === '2-3d')?.count, 1);
  assert.equal(buckets.find((b) => b.label === '1-2w')?.count, 1);
  assert.equal(buckets.find((b) => b.label === '1y+')?.count, 1);
});

test('difficultyHistogram spreads across ten bands and clamps the extremes', () => {
  const cards = [1, 1.5, 5.5, 10].map((difficulty) =>
    card({ state: State.Review, memory: { stability: 10, difficulty } }),
  );
  const buckets = difficultyHistogram(cards);
  assert.equal(buckets.length, 10);
  assert.equal(buckets[0]!.count, 2, 'D of 1 and 1.5 both land in band 1');
  assert.equal(buckets[4]!.count, 1);
  assert.equal(buckets[9]!.count, 1, 'D of exactly 10 stays in the last band');
});

// --- streaks -------------------------------------------------------------

test('studyStreak counts consecutive days and survives an unfinished today', () => {
  const days = (offsets: number[]) => offsets.map((o) => log({ reviewedAt: NOW - o * DAY }));

  const unbroken = studyStreak(days([0, 1, 2, 3]), NOW, CUTOFF);
  assert.equal(unbroken.current, 4);
  assert.equal(unbroken.longest, 4);
  assert.equal(unbroken.daysStudied, 4);

  // Nothing studied today yet: yesterday's streak still stands.
  const pending = studyStreak(days([1, 2, 3]), NOW, CUTOFF);
  assert.equal(pending.current, 3);

  // A two-day gap breaks it.
  const broken = studyStreak(days([2, 3, 4]), NOW, CUTOFF);
  assert.equal(broken.current, 0);
  assert.equal(broken.longest, 3);
});

test('several reviews on one day count as one study day', () => {
  const streak = studyStreak([log(), log(), log()], NOW, CUTOFF);
  assert.equal(streak.daysStudied, 1);
  assert.equal(streak.totalReviews, 3);
  assert.equal(streak.totalTimeMs, 12000);
});

test('an empty history has no streak', () => {
  const streak = studyStreak([], NOW, CUTOFF);
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 0);
  assert.equal(streak.daysStudied, 0);
});
