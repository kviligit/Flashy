import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_REVIEWS_TO_OPTIMIZE,
  buildSequences,
  evaluateLoss,
  optimize,
  type Sequence,
} from './optimize.js';
import { DEFAULT_PARAMS, Rating, State, nextMemory, retrievability } from '../fsrs/index.js';
import { makeCard } from '../domain/cards.js';
import type { ReviewLog } from '../domain/types.js';

function log(overrides: Partial<ReviewLog>): ReviewLog {
  return {
    id: Math.random().toString(36).slice(2),
    cardId: 'c1',
    reviewedAt: 0,
    rating: Rating.Good,
    stateBefore: State.Review,
    stateAfter: State.Review,
    intervalDays: 1,
    lastIntervalDays: 1,
    elapsedDays: 1,
    stability: 1,
    difficulty: 5,
    timeTakenMs: 0,
    snapshot: makeCard({ noteId: 'n', deckId: 'd', ord: 0, position: 0, now: 0 }),
    siblingsBuried: [],
    ...overrides,
  };
}

// --- sequence building ---------------------------------------------------

test('buildSequences groups by card and orders by time', () => {
  const sequences = buildSequences([
    log({ cardId: 'a', reviewedAt: 300, elapsedDays: 3, rating: Rating.Easy }),
    log({ cardId: 'a', reviewedAt: 100, elapsedDays: 0, stateBefore: State.New }),
    log({ cardId: 'a', reviewedAt: 200, elapsedDays: 1 }),
    log({ cardId: 'b', reviewedAt: 100, elapsedDays: 0, stateBefore: State.New }),
    log({ cardId: 'b', reviewedAt: 200, elapsedDays: 2 }),
  ]);

  assert.equal(sequences.length, 2);
  const a = sequences.find((s) => s.length === 3)!;
  assert.deepEqual(a.map((r) => r.elapsedDays), [0, 1, 3]);
  assert.equal(a[2]?.rating, Rating.Easy);
});

test('a single-answer card contributes no sequence', () => {
  assert.equal(buildSequences([log({ cardId: 'only', stateBefore: State.New })]).length, 0);
});

test('a card reset with forget starts a new sequence', () => {
  const sequences = buildSequences([
    log({ cardId: 'a', reviewedAt: 1, stateBefore: State.New }),
    log({ cardId: 'a', reviewedAt: 2, stateBefore: State.Review }),
    // forget: the card is New again, and the old memory state is gone.
    log({ cardId: 'a', reviewedAt: 3, stateBefore: State.New }),
    log({ cardId: 'a', reviewedAt: 4, stateBefore: State.Review }),
  ]);
  assert.equal(sequences.length, 2, 'replaying across the reset would be fiction');
  assert.deepEqual(sequences.map((s) => s.length), [2, 2]);
});

// --- loss ----------------------------------------------------------------

test('loss ignores the first review and same-day answers', () => {
  // Two answers, the second on the same day: nothing is scoreable.
  const sameDay: Sequence = [
    { rating: Rating.Good, elapsedDays: 0 },
    { rating: Rating.Good, elapsedDays: 0 },
  ];
  assert.equal(evaluateLoss(DEFAULT_PARAMS, [sameDay]).count, 0);

  const dated: Sequence = [
    { rating: Rating.Good, elapsedDays: 0 },
    { rating: Rating.Good, elapsedDays: 5 },
    { rating: Rating.Good, elapsedDays: 10 },
  ];
  assert.equal(evaluateLoss(DEFAULT_PARAMS, [dated]).count, 2);
});

test('loss is lower when the model predicts what actually happened', () => {
  // A card reviewed at exactly its stability has a predicted recall of 0.9,
  // so a success should cost much less than a failure.
  const success: Sequence = [
    { rating: Rating.Good, elapsedDays: 0 },
    { rating: Rating.Good, elapsedDays: 1 },
  ];
  const failure: Sequence = [
    { rating: Rating.Good, elapsedDays: 0 },
    { rating: Rating.Again, elapsedDays: 1 },
  ];
  assert.ok(
    evaluateLoss(DEFAULT_PARAMS, [success]).loss < evaluateLoss(DEFAULT_PARAMS, [failure]).loss,
  );
});

test('loss and rmse are infinite when there is nothing to score', () => {
  const result = evaluateLoss(DEFAULT_PARAMS, []);
  assert.equal(result.count, 0);
  assert.ok(!Number.isFinite(result.loss));
  assert.ok(!Number.isFinite(result.rmse));
});

// --- optimisation --------------------------------------------------------

/**
 * Build a history from a *known* parameter set: replay each card, and let
 * the true model decide whether each review was recalled. A fitter that
 * works should move the stock parameters toward this history.
 */
function syntheticHistory(trueParams: readonly number[], cards: number, reviews: number): Sequence[] {
  let seed = 4242;
  const rng = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const sequences: Sequence[] = [];
  for (let c = 0; c < cards; c++) {
    const sequence: Sequence = [{ rating: Rating.Good, elapsedDays: 0 }];
    let memory = nextMemory(trueParams, null, Rating.Good, 0);

    for (let r = 0; r < reviews; r++) {
      // Review somewhere around the current stability.
      const elapsed = Math.max(1, Math.round(memory.stability * (0.6 + rng() * 0.8)));
      const recalled = rng() < retrievability(trueParams, elapsed, memory.stability);
      const rating: Rating = recalled ? (rng() < 0.25 ? Rating.Easy : Rating.Good) : Rating.Again;
      sequence.push({ rating, elapsedDays: elapsed });
      memory = nextMemory(trueParams, memory, rating, elapsed);
    }
    sequences.push(sequence);
  }
  return sequences;
}

test('optimising lowers the loss on a history generated from other parameters', async () => {
  // A deliberately different "true" model: much faster forgetting.
  const trueParams = [...DEFAULT_PARAMS];
  trueParams[20] = 0.45; // steeper decay
  trueParams[8] = 3.4; // stronger stability growth

  const sequences = syntheticHistory(trueParams, 60, 12);
  const before = evaluateLoss(DEFAULT_PARAMS, sequences);
  assert.ok(before.count >= MIN_REVIEWS_TO_OPTIMIZE, `need a real history, got ${before.count}`);

  const result = await optimize(sequences, { passes: 4 });

  assert.ok(result.finalLoss < result.initialLoss, `loss must fall: ${result.initialLoss} -> ${result.finalLoss}`);
  assert.ok(result.finalRmse <= result.initialRmse, 'calibration must not get worse');
  assert.ok(result.changed > 0, 'some weights must have moved');
  assert.equal(result.reviewsUsed, before.count);
});

test('optimised parameters stay inside their valid ranges', async () => {
  const sequences = syntheticHistory(DEFAULT_PARAMS, 40, 10);
  const result = await optimize(sequences, { passes: 3 });
  assert.equal(result.params.length, 21);
  for (const [i, w] of result.params.entries()) {
    assert.ok(Number.isFinite(w), `weight ${i} is not finite`);
  }
  // Round-tripping through the validator must find nothing wrong.
  const { validateParams } = await import('../fsrs/params.js');
  assert.deepEqual(validateParams(result.params), []);
});

test('optimising never returns something worse than it started with', async () => {
  const sequences = syntheticHistory(DEFAULT_PARAMS, 30, 8);
  const result = await optimize(sequences, { passes: 2 });
  assert.ok(result.finalLoss <= result.initialLoss + 1e-12);
});

test('optimising reports progress once per pass', async () => {
  const sequences = syntheticHistory(DEFAULT_PARAMS, 20, 6);
  const seen: number[] = [];
  await optimize(sequences, {
    passes: 3,
    onProgress: (pass, passes, loss) => {
      seen.push(pass);
      assert.equal(passes, 3);
      assert.ok(Number.isFinite(loss));
    },
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('optimising an empty history fails with a message, not a crash', async () => {
  await assert.rejects(() => optimize([]), /no dated reviews/);
});
