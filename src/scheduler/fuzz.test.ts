import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import { Rating, RATINGS } from '../fsrs/index.js';
import type { DeckConfig, NoteType } from '../domain/types.js';
import { Scheduler } from './service.js';
import { fuzzFor, seededRandom } from './fuzz.js';

async function collection() {
  const db = withChangeTracking(new MemoryDb());
  await seedIfEmpty(db);
  const basic = (await db.noteTypes.getAll()).find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  const config = (await db.deckConfigs.getAll())[0] as DeckConfig;
  return { db, basic, deck, config };
}

test('the interval on the answer button is the interval the card gets', async () => {
  // This was wrong seven times out of ten: the button and the answer each
  // rolled fuzz from Math.random, so the number shown was not the number
  // applied. A new card would say "8 days" on Easy and be scheduled for 7.
  const { db, basic, deck, config } = await collection();
  assert.equal(config.enableFuzz, true, 'the default preset fuzzes; that is the case that broke');

  for (let i = 0; i < 25; i += 1) {
    const { cards } = await addNote(db, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: `q${i}` },
    });
    const card = cards[0]!;
    const rating = RATINGS[i % RATINGS.length]!;

    const scheduler = new Scheduler(db);
    await scheduler.load();

    const shown = (await scheduler.choicesFor(card, config))[rating].intervalDays;
    const applied = await scheduler.answerCard(card, rating, config, 1000);

    assert.equal(
      applied.log.intervalDays,
      shown,
      `rating ${rating} on a new card: button said ${shown}, card got ${applied.log.intervalDays}`,
    );
  }
});

test('every rating agrees, not just the one that was pressed', async () => {
  const { db, basic, deck, config } = await collection();
  const { cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'all four' },
  });
  const card = cards[0]!;

  const scheduler = new Scheduler(db);
  await scheduler.load();

  // Reading the buttons twice must give the same answer both times — a
  // redraw of the review screen should not change what it promises.
  const first = await scheduler.choicesFor(card, config);
  const second = await scheduler.choicesFor(card, config);
  for (const rating of RATINGS) {
    assert.equal(
      second[rating].intervalDays,
      first[rating].intervalDays,
      `rating ${rating} changed between two reads`,
    );
  }
});

test('two cards answered the same way do not land on the same day', async () => {
  // Which is the whole point of fuzz: making it deterministic per card
  // must not make it constant across cards.
  const { db, basic, deck, config } = await collection();
  const intervals = new Set<number>();

  for (let i = 0; i < 20; i += 1) {
    const { cards } = await addNote(db, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: `spread ${i}` },
    });
    const scheduler = new Scheduler(db);
    await scheduler.load();
    const result = await scheduler.answerCard(cards[0]!, Rating.Easy, config, 1000);
    intervals.add(result.log.intervalDays);
  }

  assert.ok(intervals.size > 1, `every card got the same interval: ${[...intervals]}`);
});

test('the seeded generator is deterministic, and different seeds differ', () => {
  const a = seededRandom('card-1:0');
  const b = seededRandom('card-1:0');
  const c = seededRandom('card-1:1');

  const first = [a(), a(), a(), a()];
  assert.deepEqual([b(), b(), b(), b()], first, 'same seed, same sequence');
  assert.notDeepEqual([c(), c(), c(), c()], first, 'a later review fuzzes differently');

  for (const value of first) {
    assert.ok(value >= 0 && value < 1, `${value} is out of range`);
  }
});

test('the fuzz seed changes as a card is reviewed', () => {
  const before = fuzzFor({ id: 'c1', reps: 0 })();
  const after = fuzzFor({ id: 'c1', reps: 1 })();
  assert.notEqual(before, after, 'a card would otherwise fuzz identically for ever');
});
