import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking, CONTENT_STORES } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import { addMedia } from '../collection/media.js';
import { Scheduler } from '../scheduler/index.js';
import { Rating } from '../fsrs/index.js';
import type { DeckConfig, Entity, NoteType } from '../domain/types.js';
import { applyChanges } from './merge.js';
import { validateRecord } from './validate.js';

function makeClock(start = Date.now() + 60_000) {
  let value = start;
  return () => (value += 1000);
}

/**
 * A real collection, exercised until every content store has something in
 * it. The validator has to accept everything this app actually writes —
 * that is a far more useful test than any record written by hand, because
 * a hand-written one shares the validator's assumptions.
 */
async function livedInCollection() {
  const tick = makeClock();
  const db = withChangeTracking(new MemoryDb(), { now: tick });
  await seedIfEmpty(db, tick());

  const basic = (await db.noteTypes.getAll()).find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  const config = (await db.deckConfigs.getAll())[0] as DeckConfig;

  const { cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'q', Back: 'a' },
    now: tick(),
  });
  await addMedia(db, {
    filename: 'a.png',
    mime: 'image/png',
    data: new Uint8Array([1, 2, 3]).buffer,
    now: tick(),
  });

  const at = tick();
  const scheduler = new Scheduler(db, { now: () => at, random: () => 0.5 });
  await scheduler.load();
  await scheduler.answerCard((await db.cards.get(cards[0]!.id))!, Rating.Good, config, 2000);

  return db;
}

test('every record this app writes passes its own validator', async () => {
  const db = await livedInCollection();

  for (const store of CONTENT_STORES) {
    const records = (await db[store].getAll()) as Entity[];
    assert.ok(records.length > 0, `${store} has something to check`);
    for (const record of records) {
      assert.equal(
        validateRecord(store, record),
        null,
        `${store}/${record.id} was refused: ${validateRecord(store, record)}`,
      );
    }
  }
});

test('the exact record the audit demonstrated is refused', () => {
  const reason = validateRecord('cards', {
    id: 'c1',
    deckId: {},
    noteId: null,
    ord: 0,
    state: 'banana',
    memory: 'nope',
    due: ['x'],
    lastReview: null,
    step: 0,
    reps: -99,
    lapses: 0,
    position: 0,
    suspended: false,
    buriedUntil: null,
    flag: 0,
    created: 1,
    modified: 2,
  } as unknown as Entity);

  assert.ok(reason, 'refused');
  // The first bad field is named, so a peer's author can fix it.
  assert.match(reason ?? '', /noteId|deckId/);
});

test('a hostile card never reaches the database', async () => {
  const db = await livedInCollection();
  const before = (await db.cards.getAll()).length;

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'cards',
        version: Date.now(),
        record: {
          id: 'hostile',
          deckId: {},
          noteId: null,
          state: 'banana',
          due: ['x'],
          reps: -99,
        } as unknown as Entity,
      },
    ],
  });

  assert.equal(counts.rejected, 1);
  assert.equal(counts.applied, 0);
  assert.equal((await db.cards.getAll()).length, before, 'nothing was written');
});

test('each store refuses a record of the wrong shape, field by field', () => {
  const cases: Array<[Parameters<typeof validateRecord>[0], Record<string, unknown>, RegExp]> = [
    ['decks', { id: 'd', name: 1 }, /name/],
    ['decks', { id: 'd', name: 'x', configId: 'c', description: '', collapsed: 'yes' }, /collapsed/],
    ['deckConfigs', { id: 'c', name: 'x', newPerDay: -1 }, /newPerDay/],
    ['deckConfigs', { id: 'c', name: 'x', newPerDay: 1, reviewsPerDay: 1, params: ['a'] }, /params/],
    ['noteTypes', { id: 'n', name: 'x', kind: 'weird' }, /kind/],
    ['notes', { id: 'n', noteTypeId: 'nt', fields: { Front: 5 } }, /fields/],
    ['notes', { id: 'n', noteTypeId: 'nt', fields: {}, tags: [1] }, /tags/],
    ['cards', { id: 'c', noteId: 'n', deckId: 'd', ord: 0, state: 9 }, /state/],
    ['cards', { id: 'c', noteId: 'n', deckId: 'd', ord: 0, state: 0, memory: null, due: 'not a date' }, /due/],
    ['media', { id: 'm', filename: 'a', mime: 'image/png', size: 1, data: 'base64' }, /data/],
    ['reviewLogs', { id: 'l', cardId: 'c', reviewedAt: 'soon' }, /reviewedAt/],
  ];

  for (const [store, record, expected] of cases) {
    const reason = validateRecord(store, record as unknown as Entity);
    assert.ok(reason, `${store} should refuse ${JSON.stringify(record)}`);
    assert.match(reason ?? '', expected, `${store}: ${reason}`);
  }
});

test('a record with no id is refused before anything else is looked at', () => {
  assert.match(validateRecord('notes', {} as Entity) ?? '', /id is missing/);
  assert.match(validateRecord('notes', { id: '' } as Entity) ?? '', /id is missing/);
});

test('unknown fields are carried through, so a newer peer is not shut out', () => {
  // A device running a later version will send fields this one has never
  // heard of. Refusing those would mean upgrading one device silently
  // breaks sync with the rest of the fleet.
  const deck = {
    id: 'd1',
    name: 'Deck',
    configId: 'c1',
    description: '',
    collapsed: false,
    created: 1,
    modified: 2,
    somethingFromTheFuture: { nested: true },
  } as unknown as Entity;

  assert.equal(validateRecord('decks', deck), null);
});
