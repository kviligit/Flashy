import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, withDefaults } from './config.js';
import { answer, cardRetrievability, elapsedDaysOf, newCard, schedule } from './scheduler.js';
import { fuzzBounds, formatInterval, DAY_MS, MINUTE_MS } from './interval.js';
import { Rating, State, type SchedulingCard } from './types.js';

const T0 = Date.parse('2026-01-01T09:00:00.000Z');
/** Deterministic "random": always the midpoint of the fuzz range. */
const mid = () => 0.5;
const noFuzz = withDefaults({ enableFuzz: false });

function at(card: SchedulingCard, rating: Rating, now: number, elapsedDays?: number) {
  return answer(noFuzz, card, rating, { now, random: mid, ...(elapsedDays === undefined ? {} : { elapsedDays }) });
}

function minutesUntil(card: SchedulingCard, now: number): number {
  return (Date.parse(card.due) - now) / MINUTE_MS;
}

test('a new card is due immediately and has no memory', () => {
  const card = newCard(T0);
  assert.equal(card.state, State.New);
  assert.equal(card.memory, null);
  assert.equal(card.reps, 0);
  assert.equal(Date.parse(card.due), T0);
  assert.equal(cardRetrievability(noFuzz, card, T0), null);
});

test('new card: Again and Good follow the learning steps, Easy graduates', () => {
  const card = newCard(T0); // learning steps [1, 10]

  const again = at(card, Rating.Again, T0);
  assert.equal(again.card.state, State.Learning);
  assert.equal(again.card.step, 0);
  assert.equal(minutesUntil(again.card, T0), 1);

  const good = at(card, Rating.Good, T0);
  assert.equal(good.card.state, State.Learning);
  assert.equal(good.card.step, 1);
  assert.equal(minutesUntil(good.card, T0), 10);

  const easy = at(card, Rating.Easy, T0);
  assert.equal(easy.card.state, State.Review);
  assert.ok(easy.intervalDays >= 1, `Easy should graduate to >= 1 day, got ${easy.intervalDays}`);
});

test('new card: Hard on the first step waits the average of the first two', () => {
  const hard = at(newCard(T0), Rating.Hard, T0);
  assert.equal(hard.card.state, State.Learning);
  assert.equal(hard.card.step, 0);
  assert.equal(minutesUntil(hard.card, T0), (1 + 10) / 2);
});

test('Good on the last learning step graduates to Review', () => {
  const onLastStep: SchedulingCard = {
    ...newCard(T0),
    state: State.Learning,
    step: 1,
    memory: { stability: 1.5, difficulty: 5 },
    lastReview: new Date(T0).toISOString(),
    reps: 1,
  };
  const good = at(onLastStep, Rating.Good, T0 + 10 * MINUTE_MS, 0);
  assert.equal(good.card.state, State.Review);
  assert.equal(good.card.step, 0);
  assert.ok(good.intervalDays >= 1);
});

test('empty learning steps graduate a new card straight to Review', () => {
  const config = withDefaults({ learningSteps: [], enableFuzz: false });
  const choices = schedule(config, newCard(T0), { now: T0, random: mid });
  for (const info of Object.values(choices)) {
    assert.equal(info.card.state, State.Review);
    assert.ok(info.intervalDays >= 1);
  }
});

test('Again on a Review card lapses it into Relearning', () => {
  const review: SchedulingCard = {
    state: State.Review,
    memory: { stability: 30, difficulty: 5 },
    lastReview: new Date(T0 - 30 * DAY_MS).toISOString(),
    due: new Date(T0).toISOString(),
    step: 0,
    lapses: 2,
    reps: 9,
  };
  const again = at(review, Rating.Again, T0);
  assert.equal(again.card.state, State.Relearning);
  assert.equal(again.card.lapses, 3, 'lapse count must increment');
  assert.equal(minutesUntil(again.card, T0), 10, 'must land on the first relearning step');
  assert.ok(again.card.memory!.stability < 30, 'a lapse must lose stability');
});

test('Again on a Review card with no relearning steps stays in Review', () => {
  const config = withDefaults({ relearningSteps: [], enableFuzz: false });
  const review: SchedulingCard = {
    state: State.Review,
    memory: { stability: 30, difficulty: 5 },
    lastReview: new Date(T0 - 30 * DAY_MS).toISOString(),
    due: new Date(T0).toISOString(),
    step: 0,
    lapses: 0,
    reps: 9,
  };
  const again = answer(config, review, Rating.Again, { now: T0, random: mid });
  assert.equal(again.card.state, State.Review);
  assert.equal(again.card.lapses, 1);
  assert.ok(again.intervalDays >= 1);
});

test('Good on a Relearning card graduates it back to Review', () => {
  const relearning: SchedulingCard = {
    state: State.Relearning,
    memory: { stability: 2, difficulty: 7 },
    lastReview: new Date(T0).toISOString(),
    due: new Date(T0 + 10 * MINUTE_MS).toISOString(),
    step: 0,
    lapses: 1,
    reps: 12,
  };
  const good = at(relearning, Rating.Good, T0 + 10 * MINUTE_MS, 0);
  assert.equal(good.card.state, State.Review);
  assert.equal(good.card.lapses, 1, 'graduating must not add a lapse');
});

test('all four buttons are offered, in non-decreasing interval order', () => {
  const review: SchedulingCard = {
    state: State.Review,
    memory: { stability: 20, difficulty: 5 },
    lastReview: new Date(T0 - 20 * DAY_MS).toISOString(),
    due: new Date(T0).toISOString(),
    step: 0,
    lapses: 0,
    reps: 5,
  };
  const c = schedule(noFuzz, review, { now: T0, random: mid });
  assert.ok(c[Rating.Again].intervalDays <= c[Rating.Hard].intervalDays);
  assert.ok(c[Rating.Hard].intervalDays < c[Rating.Good].intervalDays);
  assert.ok(c[Rating.Good].intervalDays < c[Rating.Easy].intervalDays);
  for (const rating of [1, 2, 3, 4] as Rating[]) {
    assert.ok(c[rating].label.length > 0, 'every button needs a label');
  }
});

test('every answer bumps reps and stamps lastReview', () => {
  const card = newCard(T0);
  const good = at(card, Rating.Good, T0);
  assert.equal(good.card.reps, 1);
  assert.equal(Date.parse(good.card.lastReview!), T0);
});

test('intervals honour maximumInterval', () => {
  const config = withDefaults({ maximumInterval: 30, enableFuzz: false });
  const mature: SchedulingCard = {
    state: State.Review,
    memory: { stability: 5000, difficulty: 2 },
    lastReview: new Date(T0 - 1000 * DAY_MS).toISOString(),
    due: new Date(T0).toISOString(),
    step: 0,
    lapses: 0,
    reps: 40,
  };
  const good = answer(config, mature, Rating.Good, { now: T0, random: mid });
  assert.ok(good.intervalDays <= 30, `expected <= 30, got ${good.intervalDays}`);
});

test('elapsedDaysOf floors to whole days and never goes negative', () => {
  const card: SchedulingCard = { ...newCard(T0), lastReview: new Date(T0).toISOString() };
  assert.equal(elapsedDaysOf(card, T0), 0);
  assert.equal(elapsedDaysOf(card, T0 + DAY_MS - 1), 0);
  assert.equal(elapsedDaysOf(card, T0 + DAY_MS), 1);
  assert.equal(elapsedDaysOf(card, T0 + 9.9 * DAY_MS), 9);
  assert.equal(elapsedDaysOf(card, T0 - DAY_MS), 0);
});

test('retrievability of a just-reviewed card is ~1 and decays over time', () => {
  const card: SchedulingCard = {
    ...newCard(T0),
    state: State.Review,
    memory: { stability: 10, difficulty: 5 },
    lastReview: new Date(T0).toISOString(),
  };
  assert.equal(cardRetrievability(noFuzz, card, T0), 1);
  const later = cardRetrievability(noFuzz, card, T0 + 10 * DAY_MS)!;
  assert.ok(Math.abs(later - 0.9) < 1e-6, `expected ~0.9 at S days, got ${later}`);
});

test('fuzz leaves short intervals alone and widens longer ones', () => {
  assert.deepEqual(fuzzBounds(1), [1, 1]);
  assert.deepEqual(fuzzBounds(2), [2, 2]);
  const [lo, hi] = fuzzBounds(100);
  assert.ok(lo < 100 && hi > 100, `expected a band around 100, got ${lo}..${hi}`);
  assert.ok(hi - lo > 5, 'a 100-day interval should have a meaningful band');
});

test('fuzzed intervals stay within their bounds', () => {
  const config = withDefaults({ enableFuzz: true });
  const review: SchedulingCard = {
    state: State.Review,
    memory: { stability: 100, difficulty: 5 },
    lastReview: new Date(T0 - 100 * DAY_MS).toISOString(),
    due: new Date(T0).toISOString(),
    step: 0,
    lapses: 0,
    reps: 20,
  };
  for (let i = 0; i < 300; i++) {
    const good = answer(config, review, Rating.Good, { now: T0, random: Math.random });
    assert.ok(good.intervalDays >= 1, `interval fell below 1: ${good.intervalDays}`);
    assert.ok(Number.isInteger(good.intervalDays), `interval not whole: ${good.intervalDays}`);
  }
});

test('formatInterval reads the way Anki does', () => {
  assert.equal(formatInterval(1 / 1440), '1m');
  assert.equal(formatInterval(10 / 1440), '10m');
  assert.equal(formatInterval(1 / 24), '1h');
  assert.equal(formatInterval(1), '1d');
  assert.equal(formatInterval(21), '21d');
  assert.equal(formatInterval(45), '1.5mo');
  assert.equal(formatInterval(730), '2y');
});

test('the default config is a sane starting point', () => {
  assert.equal(DEFAULT_CONFIG.desiredRetention, 0.9);
  assert.deepEqual(DEFAULT_CONFIG.learningSteps, [1, 10]);
  assert.deepEqual(DEFAULT_CONFIG.relearningSteps, [10]);
  // withDefaults must copy the arrays, not alias the frozen defaults.
  const a = withDefaults({});
  a.learningSteps.push(999);
  assert.deepEqual(DEFAULT_CONFIG.learningSteps, [1, 10]);
});

test('a full learn-review-lapse-relearn round trip behaves', () => {
  let card = newCard(T0);
  let now = T0;

  card = at(card, Rating.Good, now).card; // step 0 -> 1
  assert.equal(card.state, State.Learning);

  now += 10 * MINUTE_MS;
  card = at(card, Rating.Good, now, 0).card; // graduates
  assert.equal(card.state, State.Review);
  const firstInterval = Math.round((Date.parse(card.due) - now) / DAY_MS);
  assert.ok(firstInterval >= 1);

  now = Date.parse(card.due);
  card = at(card, Rating.Good, now).card; // a successful review
  assert.equal(card.state, State.Review);
  assert.ok(card.memory!.stability > 0);

  now = Date.parse(card.due);
  card = at(card, Rating.Again, now).card; // forgot it
  assert.equal(card.state, State.Relearning);
  assert.equal(card.lapses, 1);

  now += 10 * MINUTE_MS;
  card = at(card, Rating.Good, now, 0).card; // back on the horse
  assert.equal(card.state, State.Review);
  assert.equal(card.reps, 5);
});
