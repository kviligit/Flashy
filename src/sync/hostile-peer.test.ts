import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking, type ChangeSet } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import { Scheduler } from '../scheduler/index.js';
import { Rating } from '../fsrs/index.js';
import { applyChanges, MAX_CLOCK_SKEW_MS } from './merge.js';
import type { DeckConfig, NoteType } from '../domain/types.js';

/**
 * A peer being authenticated says who sent something, not that what they
 * sent is true. These are the attacks a security audit demonstrated against
 * the merge layer before it validated anything: a compromised second
 * device, or a relay that alters what it relays, hands over exactly the
 * same shape of data as an honest peer.
 */

async function collection() {
  const now = Date.now();
  const db = withChangeTracking(new MemoryDb());
  await seedIfEmpty(db, now);
  const basic = (await db.noteTypes.getAll()).find((n) => n.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  const config = (await db.deckConfigs.getAll())[0] as DeckConfig;
  return { db, basic, deck, config, now };
}

function changeSet(partial: Partial<ChangeSet>): ChangeSet {
  return { since: 0, until: Date.now(), upserts: [], deletions: [], ...partial };
}

test('a peer cannot win by declaring an enormous version', async () => {
  const { db, basic, deck } = await collection();
  const { note } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'the real answer', Back: 'x' },
  });

  // The envelope claims a version far beyond any real timestamp, while the
  // record itself carries an ordinary one.
  const counts = await applyChanges(
    db,
    changeSet({
      upserts: [
        {
          store: 'notes',
          version: Number.MAX_SAFE_INTEGER,
          record: { ...note, fields: { Front: '<img src=x onerror=steal()>', Back: '' }, modified: 1 } as never,
        },
      ],
    }),
  );

  assert.equal(
    (await db.notes.get(note.id))?.fields['Front'],
    'the real answer',
    'the version is re-derived from the record, not taken from the envelope',
  );
  assert.equal(counts.applied, 0);
});

test('a record dated absurdly far in the future is refused', async () => {
  const { db, basic, deck, now } = await collection();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'real' } });

  const counts = await applyChanges(
    db,
    changeSet({
      upserts: [
        {
          store: 'notes',
          version: now + MAX_CLOCK_SKEW_MS * 100,
          record: { ...note, fields: { Front: 'from the future' }, modified: now + MAX_CLOCK_SKEW_MS * 100 } as never,
        },
      ],
    }),
    { now },
  );

  assert.equal(counts.rejected, 1);
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'real');
});

test('a modest clock difference is still tolerated', async () => {
  const { db, basic, deck, now } = await collection();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'old' } });

  const slightlyAhead = now + 60_000;
  const counts = await applyChanges(
    db,
    changeSet({
      upserts: [
        { store: 'notes', version: slightlyAhead, record: { ...note, fields: { Front: 'new' }, modified: slightlyAhead } as never },
      ],
    }),
    { now },
  );

  assert.equal(counts.applied, 1, 'devices do not have identical clocks');
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'new');
});

test('a record carrying a non-finite number is refused', async () => {
  const { db, basic, deck } = await collection();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'real' } });

  for (const poison of [Infinity, -Infinity, NaN]) {
    const counts = await applyChanges(
      db,
      changeSet({
        upserts: [{ store: 'notes', version: 1, record: { ...note, fields: { Front: 'bad' }, modified: poison } as never }],
      }),
    );
    assert.equal(counts.rejected, 1, String(poison));
  }
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'real');
});

test('a peer cannot delete review history', async () => {
  const { db, basic, deck, config } = await collection();
  const { cards } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x', Back: 'y' } });

  const scheduler = new Scheduler(db, { now: () => Date.now(), random: () => 0.5 });
  await scheduler.load();
  await scheduler.answerCard(cards[0]!, Rating.Good, config, 1000);

  const logs = await db.reviewLogs.byIndex('cardId', cards[0]!.id);
  assert.equal(logs.length, 1, 'there is history to destroy');

  // Review logs are documented as append-only. That has to hold against a
  // peer, or the claim is only true of honest ones.
  const counts = await applyChanges(
    db,
    changeSet({
      deletions: [
        { id: `reviewLogs:${logs[0]!.id}`, store: 'reviewLogs', recordId: logs[0]!.id, deletedAt: Date.now() },
      ],
    }),
  );

  assert.equal(counts.deleted, 0);
  assert.equal(counts.deletionsRejected, 1);
  assert.equal((await db.reviewLogs.byIndex('cardId', cards[0]!.id)).length, 1, 'history survived');
});

test('a review log with an impossible rating or elapsed time is refused', async () => {
  const { db, basic, deck } = await collection();
  const { cards } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  const card = cards[0]!;

  const log = (overrides: Record<string, unknown>) => ({
    store: 'reviewLogs' as const,
    version: Date.now(),
    record: {
      id: `log-${Math.random()}`,
      cardId: card.id,
      reviewedAt: Date.now(),
      rating: 3,
      stateBefore: 2,
      stateAfter: 2,
      intervalDays: 1,
      lastIntervalDays: 1,
      elapsedDays: 1,
      stability: 1,
      difficulty: 5,
      timeTakenMs: 0,
      snapshot: card,
      siblingsBuried: [],
      ...overrides,
    } as never,
  });

  for (const bad of [
    { rating: 0 },
    { rating: 5 },
    { rating: 3.5 },
    { rating: 'good' },
    { elapsedDays: -1 },
    { elapsedDays: 1e9 },
    { stateBefore: 99 },
    { cardId: '' },
  ]) {
    const counts = await applyChanges(db, changeSet({ upserts: [log(bad)] }));
    assert.equal(counts.rejected, 1, JSON.stringify(bad));
    assert.equal(counts.reviewLogs, 0, JSON.stringify(bad));
  }

  // A well-formed one still goes in.
  const good = await applyChanges(db, changeSet({ upserts: [log({})] }));
  assert.equal(good.reviewLogs, 1);
});

test('a tombstone with a nonsense timestamp is refused', async () => {
  const { db, basic, deck } = await collection();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'keep me' } });

  for (const deletedAt of [Infinity, NaN, -1]) {
    const counts = await applyChanges(
      db,
      changeSet({
        deletions: [{ id: `notes:${note.id}`, store: 'notes', recordId: note.id, deletedAt: deletedAt as number }],
      }),
    );
    assert.equal(counts.deletionsRejected, 1, String(deletedAt));
  }
  assert.ok(await db.notes.get(note.id), 'the note is still there');
});

test('an honest change set still applies completely', async () => {
  const { db, basic, deck, now } = await collection();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'before' } });

  const counts = await applyChanges(
    db,
    changeSet({
      upserts: [
        { store: 'notes', version: now + 1000, record: { ...note, fields: { Front: 'after' }, modified: now + 1000 } as never },
      ],
    }),
    { now },
  );

  assert.equal(counts.applied, 1);
  assert.equal(counts.rejected, 0);
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'after');
});
