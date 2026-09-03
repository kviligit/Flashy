import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import { Rating } from '../fsrs/index.js';
import type { DeckConfig, NoteType } from '../domain/types.js';
import { Scheduler } from './service.js';
import { dayStart } from './day.js';

/**
 * The session summary used to count answers in a closure that lived only
 * as long as the review screen. Answering six, navigating away and coming
 * back to finish reported the second sitting only — twenty-four answers
 * shown as eighteen. These read from the log instead.
 */

async function collection() {
  const db = withChangeTracking(new MemoryDb());
  await seedIfEmpty(db);
  const basic = (await db.noteTypes.getAll()).find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  const config = (await db.deckConfigs.getAll())[0] as DeckConfig;
  return { db, basic, deck, config };
}

test("the day's count survives the review screen being remounted", async () => {
  const { db, basic, deck, config } = await collection();

  const cardIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const { cards } = await addNote(db, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: `q${i}` },
    });
    cardIds.push(cards[0]!.id);
  }

  // Two separate sittings, each with its own Scheduler — which is what a
  // remount actually is.
  for (const chunk of [cardIds.slice(0, 2), cardIds.slice(2)]) {
    const scheduler = new Scheduler(db);
    await scheduler.load();
    for (const id of chunk) {
      await scheduler.answerCard((await db.cards.get(id))!, Rating.Good, config, 1500);
    }
  }

  const reader = new Scheduler(db);
  await reader.load();
  const stats = await reader.todayStats(deck.id);

  assert.equal(stats.answered, 5, 'every answer of the day is counted, not just the last sitting');
  assert.equal(stats.again, 0);
  assert.equal(stats.totalMs, 5 * 1500);
  assert.ok(stats.firstAt !== null);
});

test('Again is counted separately, so accuracy is right', async () => {
  const { db, basic, deck, config } = await collection();
  const scheduler = new Scheduler(db);
  await scheduler.load();

  for (const [i, rating] of [Rating.Good, Rating.Again, Rating.Easy, Rating.Again].entries()) {
    const { cards } = await addNote(db, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: `q${i}` },
    });
    await scheduler.answerCard(cards[0]!, rating, config, 1000);
  }

  const stats = await scheduler.todayStats(deck.id);
  assert.equal(stats.answered, 4);
  assert.equal(stats.again, 2);
});

test('answers in another deck are not counted', async () => {
  const { db, basic, deck, config } = await collection();
  const other = { ...deck, id: 'other-deck', name: 'Other', modified: Date.now() };
  await db.decks.put(other);

  const scheduler = new Scheduler(db);
  await scheduler.load();

  const mine = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'mine' },
  });
  const theirs = await addNote(db, {
    noteTypeId: basic.id,
    deckId: other.id,
    fields: { Front: 'theirs' },
  });
  await scheduler.answerCard(mine.cards[0]!, Rating.Good, config, 1000);
  await scheduler.answerCard(theirs.cards[0]!, Rating.Good, config, 1000);

  assert.equal((await scheduler.todayStats(deck.id)).answered, 1);
  assert.equal((await scheduler.todayStats(other.id)).answered, 1);
});

test('a subdeck counts towards its parent', async () => {
  // Decks nest by name, so "Default::Sets" is inside "Default".
  const { db, basic, deck, config } = await collection();
  const child = { ...deck, id: 'child', name: `${deck.name}::Sets`, modified: Date.now() };
  await db.decks.put(child);

  const scheduler = new Scheduler(db);
  await scheduler.load();
  const { cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: child.id,
    fields: { Front: 'in the subdeck' },
  });
  await scheduler.answerCard(cards[0]!, Rating.Good, config, 1000);

  assert.equal((await scheduler.todayStats(deck.id)).answered, 1, 'the parent sees it');
  assert.equal((await scheduler.todayStats(child.id)).answered, 1, 'and so does the subdeck');
});

test("yesterday's answers do not count towards today", async () => {
  const { db, basic, deck, config } = await collection();
  const scheduler = new Scheduler(db);
  await scheduler.load();

  const { cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'old' },
  });
  await scheduler.answerCard(cards[0]!, Rating.Good, config, 1000);

  // Push the log back before today's cutoff.
  const [log] = await db.reviewLogs.getAll();
  const before = dayStart(Date.now(), scheduler.dayCutoffHour) - 60_000;
  await db.reviewLogs.put({ ...log!, reviewedAt: before });

  assert.equal((await scheduler.todayStats(deck.id)).answered, 0);
});

test('a deck that does not exist reports nothing rather than throwing', async () => {
  const { db } = await collection();
  const scheduler = new Scheduler(db);
  await scheduler.load();
  assert.deepEqual(await scheduler.todayStats('gone'), {
    answered: 0,
    again: 0,
    totalMs: 0,
    firstAt: null,
  });
});
