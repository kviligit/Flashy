import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PARAMS, PARAM_COUNT, S_MAX, S_MIN, D_MAX, D_MIN } from './params.js';
import {
  initialDifficulty,
  initialStability,
  intervalForStability,
  nextMemory,
  retrievability,
} from './core.js';
import { RATINGS, Rating, type Memory } from './types.js';

const W = DEFAULT_PARAMS;

function close(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

test('parameter list has the FSRS-6 shape', () => {
  assert.equal(DEFAULT_PARAMS.length, PARAM_COUNT);
  assert.ok(DEFAULT_PARAMS.every(Number.isFinite));
});

test('retrievability is 0.9 at exactly one stability-worth of days', () => {
  // Stability is *defined* as the interval at which recall drops to 90%.
  for (const s of [0.5, 1, 7, 100, 3650]) {
    close(retrievability(W, s, s), 0.9, 1e-6, `R(${s}, ${s})`);
  }
});

test('retrievability decays monotonically from 1 to 0', () => {
  close(retrievability(W, 0, 10), 1, 1e-12, 'R at t=0');
  let previous = 1;
  for (const t of [1, 2, 5, 10, 50, 500, 5000]) {
    const r = retrievability(W, t, 10);
    assert.ok(r < previous, `R must decrease: R(${t}) = ${r} >= ${previous}`);
    assert.ok(r > 0 && r < 1, `R must stay in (0, 1), got ${r}`);
    previous = r;
  }
});

test('intervalForStability inverts retrievability', () => {
  for (const s of [1, 10, 365]) {
    for (const target of [0.7, 0.8, 0.9, 0.95]) {
      const days = intervalForStability(W, s, target);
      close(retrievability(W, days, s), target, 1e-6, `roundtrip S=${s} r=${target}`);
    }
  }
});

test('a lower desired retention buys a longer interval', () => {
  const lax = intervalForStability(W, 10, 0.8);
  const strict = intervalForStability(W, 10, 0.95);
  assert.ok(lax > strict, `expected ${lax} > ${strict}`);
});

test('first review: better ratings give more stability and less difficulty', () => {
  const stabilities = RATINGS.map((r) => initialStability(W, r));
  const difficulties = RATINGS.map((r) => initialDifficulty(W, r));
  for (let i = 1; i < 4; i++) {
    assert.ok(stabilities[i]! > stabilities[i - 1]!, 'stability must rise with rating');
    assert.ok(difficulties[i]! < difficulties[i - 1]!, 'difficulty must fall with rating');
  }
});

test('nextMemory on a null memory equals the clamped initial state', () => {
  // The raw D0 formula can fall below 1 for Easy; the state must be clamped.
  for (const rating of RATINGS) {
    const m = nextMemory(W, null, rating, 0);
    const expectedD = Math.min(Math.max(initialDifficulty(W, rating), D_MIN), D_MAX);
    close(m.stability, initialStability(W, rating), 1e-12, `S0 rating ${rating}`);
    close(m.difficulty, expectedD, 1e-12, `D0 rating ${rating}`);
    assert.ok(m.difficulty >= D_MIN && m.difficulty <= D_MAX, 'D0 must be in range');
  }
});

/**
 * Golden vector lifted from the reference implementation's own
 * `test_memory_state` (fsrs-rs, src/inference.rs): the review sequence
 * Again, Good, Good, Good, Good, Good at 0, 0, 1, 3, 8 and 21 days must end
 * at stability 53.62691 and difficulty 6.3574867.
 *
 * The reference computes in f32 and we compute in f64, so six chained
 * updates diverge slightly; the tolerance is sized for that, not for a
 * formula difference.
 */
test('golden vector: matches the reference implementation', () => {
  const ratings: Rating[] = [1, 3, 3, 3, 3, 3];
  const elapsed = [0, 0, 1, 3, 8, 21];

  let memory: Memory | null = null;
  for (const [i, rating] of ratings.entries()) {
    memory = nextMemory(W, memory, rating, elapsed[i]!);
  }

  assert.ok(memory);
  close(memory.stability, 53.62691, 5e-3, 'final stability');
  close(memory.difficulty, 6.3574867, 5e-4, 'final difficulty');
});

test('golden vector: still matches with short-term updates frozen', () => {
  // Same sequence with w17 = w18 = w19 = 0, which the reference asserts
  // lands on stability 53.335106 and the same difficulty.
  const w = [...DEFAULT_PARAMS];
  w[17] = 0;
  w[18] = 0;
  w[19] = 0;

  const ratings: Rating[] = [1, 3, 3, 3, 3, 3];
  const elapsed = [0, 0, 1, 3, 8, 21];

  let memory: Memory | null = null;
  for (const [i, rating] of ratings.entries()) {
    memory = nextMemory(w, memory, rating, elapsed[i]!);
  }

  assert.ok(memory);
  close(memory.stability, 53.335106, 5e-3, 'final stability (frozen short term)');
  close(memory.difficulty, 6.3574867, 5e-4, 'final difficulty (frozen short term)');
});

test('a lapse never increases stability', () => {
  for (const stability of [0.5, 1, 10, 100, 1000]) {
    for (const difficulty of [1, 5, 10]) {
      const before: Memory = { stability, difficulty };
      const after = nextMemory(W, before, Rating.Again, Math.round(stability));
      assert.ok(
        after.stability <= stability + 1e-9,
        `lapse grew stability: ${stability} -> ${after.stability}`,
      );
    }
  }
});

test('a success never decreases stability, and better ratings give more', () => {
  const before: Memory = { stability: 10, difficulty: 5 };
  const results = [Rating.Hard, Rating.Good, Rating.Easy].map(
    (r) => nextMemory(W, before, r, 10).stability,
  );
  assert.ok(results[0]! >= before.stability, 'Hard should not lose stability here');
  assert.ok(results[1]! > results[0]!, 'Good must beat Hard');
  assert.ok(results[2]! > results[1]!, 'Easy must beat Good');
});

test('difficulty moves the right way and stays in range', () => {
  const before: Memory = { stability: 10, difficulty: 5 };
  const again = nextMemory(W, before, Rating.Again, 10).difficulty;
  const good = nextMemory(W, before, Rating.Good, 10).difficulty;
  const easy = nextMemory(W, before, Rating.Easy, 10).difficulty;
  assert.ok(again > good, 'Again must raise difficulty relative to Good');
  assert.ok(easy < good, 'Easy must lower difficulty relative to Good');

  // Hammering either button must not escape the bounds.
  let m: Memory = { stability: 10, difficulty: 5 };
  for (let i = 0; i < 200; i++) m = nextMemory(W, m, Rating.Again, 1);
  assert.ok(m.difficulty <= D_MAX && m.difficulty >= D_MIN, `difficulty escaped: ${m.difficulty}`);
  m = { stability: 10, difficulty: 5 };
  for (let i = 0; i < 200; i++) m = nextMemory(W, m, Rating.Easy, 1);
  assert.ok(m.difficulty <= D_MAX && m.difficulty >= D_MIN, `difficulty escaped: ${m.difficulty}`);
});

test('stability stays inside its clamp under abuse', () => {
  let m: Memory = { stability: S_MIN, difficulty: 1 };
  for (let i = 0; i < 500; i++) m = nextMemory(W, m, Rating.Easy, 3650);
  assert.ok(m.stability <= S_MAX, `stability escaped high: ${m.stability}`);

  m = { stability: S_MAX, difficulty: 10 };
  for (let i = 0; i < 500; i++) m = nextMemory(W, m, Rating.Again, 1);
  assert.ok(m.stability >= S_MIN, `stability escaped low: ${m.stability}`);
});

test('same-day reviews use the short-term formula, not the elapsed one', () => {
  const before: Memory = { stability: 10, difficulty: 5 };
  const sameDay = nextMemory(W, before, Rating.Good, 0);
  const nextDay = nextMemory(W, before, Rating.Good, 1);
  assert.notEqual(sameDay.stability, nextDay.stability);
  assert.ok(sameDay.stability >= before.stability, 'same-day Good must not lose stability');
});
