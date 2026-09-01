import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty } from '../storage/index.js';
import { makeCard } from '../domain/cards.js';
import { makeDeck, makeDeckConfig, makeMeta } from '../domain/defaults.js';
import { newId } from '../domain/id.js';
import { CardFlag, LeechAction, type Card, type Deck, type DeckConfig, type Note } from '../domain/types.js';
import { Rating, State } from '../fsrs/index.js';
import { Scheduler } from './service.js';
import { DAY_MS, dayStart } from './day.js';
import { buildQueue, isAvailable, pickNext } from './queue.js';

const CUTOFF = 4;

/** A clock the tests drive by hand. */
function clock(start: number) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (ms: number) => {
      t = ms;
      return t;
    },
  };
}

/** Deterministic randomness: always the middle of any range. */
const mid = () => 0.5;

interface Fixture {
  db: MemoryDb;
  scheduler: Scheduler;
  deck: Deck;
  config: DeckConfig;
  clock: ReturnType<typeof clock>;
  addNote(front: string): Promise<Card>;
}

async function fixture(options: Partial<DeckConfig> = {}, startAt?: number): Promise<Fixture> {
  const start = startAt ?? new Date(2026, 0, 5, 10, 0, 0).getTime();
  const c = clock(start);
  const db = new MemoryDb();
  await seedIfEmpty(db, start);
  await db.meta.put({ ...makeMeta(start), dayCutoffHour: CUTOFF });

  const config: DeckConfig = { ...makeDeckConfig('Test', start), enableFuzz: false, ...options };
  await db.deckConfigs.put(config);
  const deck = makeDeck('Test', config.id, start);
  await db.decks.put(deck);

  const scheduler = new Scheduler(db, { now: c.now, random: mid });
  await scheduler.load();

  let position = 0;
  const addNote = async (front: string): Promise<Card> => {
    const note: Note = {
      id: newId(),
      noteTypeId: 'basic',
      fields: { Front: front, Back: `${front} (back)` },
      tags: [],
      created: c.now(),
      modified: c.now(),
    };
    await db.notes.put(note);
    const card = makeCard({ noteId: note.id, deckId: deck.id, ord: 0, position: position++, now: c.now() });
    await db.cards.put(card);
    return card;
  };

  return { db, scheduler, deck, config, clock: c, addNote };
}

// --- queue building ------------------------------------------------------

test('the daily new-card limit is enforced', async () => {
  const f = await fixture({ newPerDay: 3, reviewsPerDay: 100 });
  for (let i = 0; i < 10; i++) await f.addNote(`card ${i}`);

  const session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.new, 3, 'only three new cards may be offered');
  assert.equal(session.counts.review, 0);
});

test('the limit shrinks as new cards are introduced today', async () => {
  const f = await fixture({ newPerDay: 3 });
  for (let i = 0; i < 10; i++) await f.addNote(`card ${i}`);

  let session = await f.scheduler.startSession(f.deck.id);
  const first = session.queue.newCards[0]!;
  await f.scheduler.answerCard(first, Rating.Easy, f.config); // graduates, uses a slot

  session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.new, 2, 'one slot consumed');
});

test('re-answering a learning card does not consume another new-card slot', async () => {
  const f = await fixture({ newPerDay: 1, learningSteps: [1, 10] });
  await f.addNote('only card');

  let session = await f.scheduler.startSession(f.deck.id);
  const card = session.queue.newCards[0]!;

  // Again, then Again again — both are answers on the same card.
  const first = await f.scheduler.answerCard(card, Rating.Again, f.config);
  f.clock.advance(60_000);
  await f.scheduler.answerCard(first.card, Rating.Again, f.config);

  session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.new, 0, 'the one new slot is used');
  assert.equal(session.counts.learning, 1, 'the card is still in learning and still studiable');
});

test('suspended and buried cards stay out of the queue', async () => {
  const f = await fixture();
  const a = await f.addNote('a');
  const b = await f.addNote('b');
  const c = await f.addNote('c');

  await f.scheduler.setSuspended([a.id], true);
  await f.scheduler.bury([b.id]);

  const session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.new, 1, 'only the untouched card remains');
  assert.equal(session.queue.newCards[0]?.id, c.id);
});

test('burying expires at the next day boundary', async () => {
  const f = await fixture();
  const a = await f.addNote('a');
  await f.scheduler.bury([a.id]);

  assert.equal((await f.scheduler.startSession(f.deck.id)).counts.new, 0, 'buried today');

  f.clock.advance(DAY_MS);
  assert.equal((await f.scheduler.startSession(f.deck.id)).counts.new, 1, 'available tomorrow');
});

test('review cards due later today are counted; later days are not', async () => {
  const f = await fixture();
  const now = f.clock.now();
  const soon: Card = {
    ...(await f.addNote('due tonight')),
    state: State.Review,
    memory: { stability: 10, difficulty: 5 },
    lastReview: new Date(now - 10 * DAY_MS).toISOString(),
    due: new Date(now + 3 * 3_600_000).toISOString(),
  };
  const later: Card = {
    ...(await f.addNote('due next week')),
    state: State.Review,
    memory: { stability: 10, difficulty: 5 },
    lastReview: new Date(now).toISOString(),
    due: new Date(now + 7 * DAY_MS).toISOString(),
  };
  await f.db.cards.putMany([soon, later]);

  const session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.review, 1, 'only the card due within this study day');
});

test('subdecks are included in the parent’s session and counts', async () => {
  const f = await fixture();
  const child = makeDeck('Test::Child', f.config.id, f.clock.now());
  await f.db.decks.put(child);

  const note = { id: newId(), noteTypeId: 'basic', fields: {}, tags: [], created: 0, modified: 0 };
  await f.db.notes.put(note);
  await f.db.cards.put(
    makeCard({ noteId: note.id, deckId: child.id, ord: 0, position: 0, now: f.clock.now() }),
  );
  await f.addNote('in parent');

  const session = await f.scheduler.startSession(f.deck.id);
  assert.equal(session.counts.new, 2, 'parent session covers the subdeck');

  const counts = await f.scheduler.allDeckCounts();
  assert.equal(counts.get(f.deck.id)?.new, 2, 'parent count includes the child');
  assert.equal(counts.get(child.id)?.new, 1, 'child counts only itself');
});

// --- answering -----------------------------------------------------------

test('answering persists the card and appends exactly one log', async () => {
  const f = await fixture();
  const card = await f.addNote('a');

  const result = await f.scheduler.answerCard(card, Rating.Good, f.config, 4200);

  const stored = await f.db.cards.get(card.id);
  assert.equal(stored?.state, result.card.state, 'card was written');
  assert.equal(stored?.reps, 1);

  const logs = await f.db.reviewLogs.getAll();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.cardId, card.id);
  assert.equal(logs[0]?.rating, Rating.Good);
  assert.equal(logs[0]?.stateBefore, State.New);
  assert.equal(logs[0]?.timeTakenMs, 4200);
  assert.equal(logs[0]?.snapshot.state, State.New, 'snapshot is the pre-answer card');
});

test('choicesFor offers all four ratings with labels', async () => {
  const f = await fixture();
  const card = await f.addNote('a');
  const choices = await f.scheduler.choicesFor(card, f.config);
  for (const rating of [1, 2, 3, 4] as Rating[]) {
    assert.ok(choices[rating].label.length > 0, `rating ${rating} needs a label`);
  }
});

test('siblings are buried when a card is answered, and only when configured', async () => {
  const f = await fixture({ burySiblings: true });
  const note: Note = {
    id: newId(),
    noteTypeId: 'reversed',
    fields: { Front: 'x', Back: 'y' },
    tags: [],
    created: 0,
    modified: 0,
  };
  await f.db.notes.put(note);
  const front = makeCard({ noteId: note.id, deckId: f.deck.id, ord: 0, position: 0, now: f.clock.now() });
  const back = makeCard({ noteId: note.id, deckId: f.deck.id, ord: 1, position: 1, now: f.clock.now() });
  await f.db.cards.putMany([front, back]);

  const result = await f.scheduler.answerCard(front, Rating.Good, f.config);
  assert.deepEqual(result.log.siblingsBuried, [back.id]);
  assert.ok((await f.db.cards.get(back.id))?.buriedUntil, 'sibling is buried');

  const noBury = await fixture({ burySiblings: false });
  const c1 = await noBury.addNote('a');
  const r = await noBury.scheduler.answerCard(c1, Rating.Good, noBury.config);
  assert.deepEqual(r.log.siblingsBuried, []);
});

// --- undo ----------------------------------------------------------------

test('undo restores the card exactly and removes the log', async () => {
  const f = await fixture();
  const card = await f.addNote('a');
  const before = await f.db.cards.get(card.id);

  await f.scheduler.answerCard(card, Rating.Good, f.config);
  assert.notDeepEqual(await f.db.cards.get(card.id), before, 'the answer changed something');

  const restored = await f.scheduler.undoLast();
  assert.ok(restored);
  assert.deepEqual(await f.db.cards.get(card.id), before, 'card is byte-for-byte back');
  assert.equal((await f.db.reviewLogs.getAll()).length, 0, 'log removed');
});

test('undo unburies the siblings that answer buried, and no others', async () => {
  const f = await fixture({ burySiblings: true });
  const note: Note = { id: newId(), noteTypeId: 'n', fields: {}, tags: [], created: 0, modified: 0 };
  await f.db.notes.put(note);
  const a = makeCard({ noteId: note.id, deckId: f.deck.id, ord: 0, position: 0, now: f.clock.now() });
  const b = makeCard({ noteId: note.id, deckId: f.deck.id, ord: 1, position: 1, now: f.clock.now() });
  await f.db.cards.putMany([a, b]);

  // Bury an unrelated card by hand; undo must leave it buried.
  const unrelated = await f.addNote('unrelated');
  await f.scheduler.bury([unrelated.id]);

  await f.scheduler.answerCard(a, Rating.Good, f.config);
  await f.scheduler.undoLast();

  assert.equal((await f.db.cards.get(b.id))?.buriedUntil, null, 'sibling unburied');
  assert.ok((await f.db.cards.get(unrelated.id))?.buriedUntil, 'unrelated card stays buried');
});

test('undo with nothing to undo returns null', async () => {
  const f = await fixture();
  assert.equal(await f.scheduler.undoLast(), null);
  assert.equal(await f.scheduler.undoDescription(), null);
});

test('undo walks back through several answers, most recent first', async () => {
  const f = await fixture();
  const a = await f.addNote('a');
  const b = await f.addNote('b');

  await f.scheduler.answerCard(a, Rating.Good, f.config);
  f.clock.advance(1000);
  await f.scheduler.answerCard(b, Rating.Again, f.config);

  assert.match((await f.scheduler.undoDescription()) ?? '', /Again/);
  assert.equal((await f.scheduler.undoLast())?.id, b.id, 'b first');
  assert.match((await f.scheduler.undoDescription()) ?? '', /Good/);
  assert.equal((await f.scheduler.undoLast())?.id, a.id, 'then a');
  assert.equal(await f.scheduler.undoLast(), null, 'then nothing');
});

// --- leeches -------------------------------------------------------------

test('crossing the leech threshold tags the note and suspends the card', async () => {
  const f = await fixture({
    leechThreshold: 2,
    leechAction: LeechAction.Suspend,
    relearningSteps: [10],
  });
  const note: Note = { id: newId(), noteTypeId: 'n', fields: {}, tags: [], created: 0, modified: 0 };
  await f.db.notes.put(note);
  let card = makeCard({ noteId: note.id, deckId: f.deck.id, ord: 0, position: 0, now: f.clock.now() });
  card = {
    ...card,
    state: State.Review,
    memory: { stability: 20, difficulty: 5 },
    lastReview: new Date(f.clock.now() - 20 * DAY_MS).toISOString(),
    lapses: 1,
  };
  await f.db.cards.put(card);

  const result = await f.scheduler.answerCard(card, Rating.Again, f.config);
  assert.equal(result.card.lapses, 2);
  assert.ok(result.becameLeech, 'threshold crossed');
  assert.ok(result.card.suspended, 'suspended by the configured action');
  assert.ok((await f.db.notes.get(note.id))?.tags.includes('leech'), 'note tagged');
});

test('leechAction "tag" tags without suspending', async () => {
  const f = await fixture({ leechThreshold: 1, leechAction: LeechAction.TagOnly });
  const note: Note = { id: newId(), noteTypeId: 'n', fields: {}, tags: [], created: 0, modified: 0 };
  await f.db.notes.put(note);
  const card: Card = {
    ...makeCard({ noteId: note.id, deckId: f.deck.id, ord: 0, position: 0, now: f.clock.now() }),
    state: State.Review,
    memory: { stability: 20, difficulty: 5 },
    lastReview: new Date(f.clock.now() - 20 * DAY_MS).toISOString(),
    lapses: 0,
  };
  await f.db.cards.put(card);

  const result = await f.scheduler.answerCard(card, Rating.Again, f.config);
  assert.ok(result.becameLeech);
  assert.equal(result.card.suspended, false, 'not suspended');
  assert.ok((await f.db.notes.get(note.id))?.tags.includes('leech'), 'still tagged');
});

// --- card actions --------------------------------------------------------

test('forget resets a card to New but keeps its logs', async () => {
  const f = await fixture();
  const card = await f.addNote('a');
  const answered = await f.scheduler.answerCard(card, Rating.Easy, f.config);
  assert.equal(answered.card.state, State.Review);

  await f.scheduler.forget([card.id]);
  const reset = await f.db.cards.get(card.id);
  assert.equal(reset?.state, State.New);
  assert.equal(reset?.memory, null);
  assert.equal(reset?.reps, 0);
  assert.equal((await f.db.reviewLogs.getAll()).length, 1, 'history is preserved');
});

test('flags and suspension round-trip', async () => {
  const f = await fixture();
  const card = await f.addNote('a');
  await f.scheduler.setFlag([card.id], CardFlag.Orange);
  await f.scheduler.setSuspended([card.id], true);
  const stored = await f.db.cards.get(card.id);
  assert.equal(stored?.flag, CardFlag.Orange);
  assert.equal(stored?.suspended, true);
  await f.scheduler.setSuspended([card.id], false);
  assert.equal((await f.db.cards.get(card.id))?.suspended, false);
});

// --- queue helpers -------------------------------------------------------

test('isAvailable rejects suspended and currently-buried cards', () => {
  const now = Date.now();
  const base = makeCard({ noteId: 'n', deckId: 'd', ord: 0, position: 0, now });
  assert.ok(isAvailable(base, now));
  assert.ok(!isAvailable({ ...base, suspended: true }, now));
  assert.ok(!isAvailable({ ...base, buriedUntil: new Date(now + 1000).toISOString() }, now));
  assert.ok(isAvailable({ ...base, buriedUntil: new Date(now - 1000).toISOString() }, now));
});

test('pickNext prefers a learning card that is actually due', () => {
  const now = Date.now();
  const learning = {
    ...makeCard({ noteId: 'n', deckId: 'd', ord: 0, position: 0, now }),
    state: State.Learning,
    due: new Date(now - 1000).toISOString(),
  };
  const fresh = makeCard({ noteId: 'n2', deckId: 'd', ord: 0, position: 1, now });
  const queue = buildQueue([learning, fresh], {
    now,
    dayEnd: now + DAY_MS,
    config: makeDeckConfig(),
    limits: { new: 10, review: 10 },
    random: mid,
  });
  assert.equal(pickNext(queue, now, mid)?.id, learning.id);
});

test('pickNext falls back to a not-quite-due learning card when nothing else remains', () => {
  const now = Date.now();
  const soon = {
    ...makeCard({ noteId: 'n', deckId: 'd', ord: 0, position: 0, now }),
    state: State.Learning,
    due: new Date(now + 5 * 60_000).toISOString(),
  };
  const queue = buildQueue([soon], {
    now,
    dayEnd: now + DAY_MS,
    config: makeDeckConfig(),
    limits: { new: 10, review: 10 },
    random: mid,
  });
  assert.equal(pickNext(queue, now, mid)?.id, soon.id, 'learn-ahead window');
});

test('pickNext returns null on an exhausted queue', () => {
  const now = Date.now();
  const queue = buildQueue([], {
    now,
    dayEnd: now + DAY_MS,
    config: makeDeckConfig(),
    limits: { new: 10, review: 10 },
    random: mid,
  });
  assert.equal(pickNext(queue, now, mid), null);
});

// --- the long simulation -------------------------------------------------

/**
 * Fifty cards, ninety days, one honest reviewer who answers correctly 85% of
 * the time. This is the test that would catch a scheduler that quietly
 * stalls, double-counts limits, loses cards, or lets intervals run away.
 */
test('90-day simulation: 50 cards stay consistent and mature', async () => {
  // A small deterministic PRNG, so a failure is always reproducible.
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const start = new Date(2026, 0, 5, 10, 0, 0).getTime();
  const c = clock(start);
  const db = new MemoryDb();
  await seedIfEmpty(db, start);
  await db.meta.put({ ...makeMeta(start), dayCutoffHour: CUTOFF });

  const config: DeckConfig = {
    ...makeDeckConfig('Sim', start),
    newPerDay: 10,
    reviewsPerDay: 200,
    enableFuzz: true,
    burySiblings: false,
  };
  await db.deckConfigs.put(config);
  const deck = makeDeck('Sim', config.id, start);
  await db.decks.put(deck);

  const scheduler = new Scheduler(db, { now: c.now, random: rng });
  await scheduler.load();

  const CARD_COUNT = 50;
  for (let i = 0; i < CARD_COUNT; i++) {
    const note: Note = {
      id: newId(),
      noteTypeId: 'basic',
      fields: { Front: `q${i}`, Back: `a${i}` },
      tags: [],
      created: start,
      modified: start,
    };
    await db.notes.put(note);
    await db.cards.put(
      makeCard({ noteId: note.id, deckId: deck.id, ord: 0, position: i, now: start }),
    );
  }

  let totalAnswers = 0;
  let introduced = 0;
  const dailyNew: number[] = [];

  for (let day = 0; day < 90; day++) {
    // Study at 10am each day.
    c.set(dayStart(start + day * DAY_MS, CUTOFF) + 6 * 3_600_000);

    let answeredToday = 0;
    let newToday = 0;

    // A generous safety valve: a healthy scheduler needs far fewer passes.
    for (let guard = 0; guard < 2000; guard++) {
      const session = await scheduler.startSession(deck.id);
      const card = scheduler.nextCard(session);
      if (!card) break;

      // Only study a learning card once its due time has actually arrived;
      // otherwise walk the clock forward, as a real reviewer would.
      const due = Date.parse(card.due);
      if (due > c.now()) {
        if (due > dayStart(c.now(), CUTOFF) + 20 * 3_600_000) break; // leave it for tomorrow
        c.set(due);
      }

      if (card.state === State.New) {
        newToday += 1;
        introduced += 1;
      }

      const rating: Rating = rng() < 0.85 ? Rating.Good : Rating.Again;
      await scheduler.answerCard(card, rating, config, 3000);
      answeredToday += 1;
      totalAnswers += 1;
      c.advance(8000);
    }

    dailyNew.push(newToday);
    assert.ok(newToday <= config.newPerDay, `day ${day}: ${newToday} new exceeds the limit`);
    assert.ok(answeredToday < 2000, `day ${day}: the queue never drained`);
  }

  // Nothing lost, nothing duplicated.
  const cards = await db.cards.getAll();
  assert.equal(cards.length, CARD_COUNT, 'card count is unchanged');
  assert.equal(new Set(cards.map((c2) => c2.id)).size, CARD_COUNT, 'no duplicate ids');

  // Every card was eventually introduced, and none more than once.
  assert.equal(introduced, CARD_COUNT, 'every card entered the rotation exactly once');
  assert.equal(
    dailyNew.reduce((a, b) => a + b, 0),
    CARD_COUNT,
    'daily new counts add up',
  );

  // The reviewer did real work, and the collection matured.
  assert.ok(totalAnswers > 300, `expected a busy 90 days, got ${totalAnswers} answers`);
  const reviewCards = cards.filter((card) => card.state === State.Review);
  assert.ok(
    reviewCards.length >= CARD_COUNT * 0.8,
    `expected most cards graduated, got ${reviewCards.length}/${CARD_COUNT}`,
  );

  // Every card has a sane, in-range memory state.
  for (const card of cards) {
    assert.ok(card.reps > 0, `card ${card.id} was never answered`);
    if (card.memory) {
      assert.ok(Number.isFinite(card.memory.stability), 'stability is finite');
      assert.ok(card.memory.stability > 0, 'stability is positive');
      assert.ok(card.memory.difficulty >= 1 && card.memory.difficulty <= 10, 'difficulty in range');
    }
    assert.ok(Number.isFinite(Date.parse(card.due)), 'due date parses');
  }

  // Intervals grew: the average review card should be well past a day.
  const intervals = reviewCards.map(
    (card) => (Date.parse(card.due) - Date.parse(card.lastReview!)) / DAY_MS,
  );
  const meanInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  assert.ok(meanInterval > 5, `expected intervals to grow, mean was ${meanInterval.toFixed(1)}d`);

  // One log per answer, all pointing at real cards.
  const logs = await db.reviewLogs.getAll();
  assert.equal(logs.length, totalAnswers, 'every answer logged exactly once');
  const cardIds = new Set(cards.map((card) => card.id));
  assert.ok(logs.every((log) => cardIds.has(log.cardId)), 'no orphaned logs');

  // And undo still works at the end of all that.
  const restored = await scheduler.undoLast();
  assert.ok(restored, 'undo works after a long history');
  assert.equal((await db.reviewLogs.getAll()).length, totalAnswers - 1);
});
