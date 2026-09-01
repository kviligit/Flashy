import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb } from './memory.js';
import { pruneTombstones, tombstoneId, withChangeTracking } from './tracking.js';
import { changeSetSize, changesSince, versionOf } from './changes.js';
import { CONTENT_STORES } from './types.js';
import type { Deck, Note } from '../domain/types.js';

let clock = 1000;
const now = () => clock;

function tracked() {
  clock = 1000;
  return withChangeTracking(new MemoryDb(), { now });
}

function deck(id: string, modified = clock): Deck {
  return { id, name: id, configId: 'cfg', description: '', collapsed: false, created: 0, modified };
}

function note(id: string, modified = clock): Note {
  return { id, noteTypeId: 'basic', fields: { Front: id }, tags: [], created: 0, modified };
}

// --- tombstones ----------------------------------------------------------

test('deleting a record writes a tombstone', async () => {
  const db = tracked();
  await db.decks.put(deck('a'));
  await db.decks.delete('a');

  const tombstones = await db.deletions.getAll();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0]?.id, tombstoneId('decks', 'a'));
  assert.equal(tombstones[0]?.store, 'decks');
  assert.equal(tombstones[0]?.recordId, 'a');
  assert.equal(tombstones[0]?.deletedAt, 1000);
});

test('the record really is gone, tombstone notwithstanding', async () => {
  const db = tracked();
  await db.decks.put(deck('a'));
  await db.decks.delete('a');
  assert.equal(await db.decks.get('a'), null);
  assert.equal(await db.decks.count(), 0);
});

test('deleteMany tombstones every id, and an empty batch does nothing', async () => {
  const db = tracked();
  await db.decks.putMany([deck('a'), deck('b'), deck('c')]);
  await db.decks.deleteMany(['a', 'c']);

  const ids = (await db.deletions.getAll()).map((d) => d.recordId).sort();
  assert.deepEqual(ids, ['a', 'c']);

  await db.decks.deleteMany([]);
  assert.equal(await db.deletions.count(), 2, 'an empty batch is not a deletion');
});

test('deleting the same record twice leaves one tombstone', async () => {
  const db = tracked();
  await db.decks.put(deck('a'));
  await db.decks.delete('a');
  clock = 2000;
  await db.decks.delete('a');
  assert.equal(await db.deletions.count(), 1, 'the id is derived, so it overwrites');
  assert.equal((await db.deletions.getAll())[0]?.deletedAt, 2000, 'and records the later time');
});

test('tombstones are namespaced by store, so ids cannot collide', async () => {
  const db = tracked();
  await db.decks.put(deck('same-id'));
  await db.notes.put(note('same-id'));
  await db.decks.delete('same-id');
  await db.notes.delete('same-id');

  const stores = (await db.deletions.getAll()).map((d) => d.store).sort();
  assert.deepEqual(stores, ['decks', 'notes']);
  assert.equal(await db.deletions.count(), 2);
});

test('every content store is tracked', async () => {
  const db = tracked();
  for (const store of CONTENT_STORES) {
    // Records only need an id for this; the stores are untyped at runtime.
    await (db[store] as unknown as { put(item: { id: string }): Promise<void> }).put({ id: 'x' });
    await db[store].delete('x');
  }
  const stores = (await db.deletions.getAll()).map((d) => d.store).sort();
  assert.deepEqual(stores, [...CONTENT_STORES].sort(), 'no content store may be untracked');
});

test('clear() is a wipe, not a deletion, and records nothing', async () => {
  const db = tracked();
  await db.decks.putMany([deck('a'), deck('b')]);
  await db.decks.clear();
  assert.equal(await db.decks.count(), 0);
  assert.equal(
    await db.deletions.count(),
    0,
    'tombstoning a whole collection would tell a peer to delete its own copy',
  );
});

test('meta is not tracked — it is per-device configuration', async () => {
  const db = tracked();
  await db.meta.put({
    id: 'meta',
    schemaVersion: 2,
    dayCutoffHour: 4,
    deviceId: 'dev',
    created: 0,
    modified: 0,
  });
  await db.meta.delete('meta');
  assert.equal(await db.deletions.count(), 0);
});

test('reads and writes pass through the wrapper unchanged', async () => {
  const db = tracked();
  await db.decks.putMany([deck('a'), deck('b')]);
  assert.equal(await db.decks.count(), 2);
  assert.equal((await db.decks.get('a'))?.name, 'a');
  assert.equal((await db.decks.getAll()).length, 2);
  assert.equal((await db.decks.getMany(['a'])).length, 1);
  assert.equal((await db.decks.byIndex('name', 'a')).length, 1);
  assert.equal((await db.decks.byRange('modified', {})).length, 2);
  assert.equal(await db.decks.countRange('modified', {}), 2);
});

test('pruneTombstones drops only what is older than the bound', async () => {
  const db = tracked();
  await db.decks.putMany([deck('a'), deck('b')]);
  await db.decks.delete('a');
  clock = 5000;
  await db.decks.delete('b');

  const pruned = await pruneTombstones(db, 5000);
  assert.equal(pruned, 1, 'the bound is exclusive');
  const left = await db.deletions.getAll();
  assert.equal(left.length, 1);
  assert.equal(left[0]?.recordId, 'b');
});

// --- change feed ---------------------------------------------------------

test('changesSince returns records modified after the bound, oldest first', async () => {
  const db = tracked();
  await db.decks.put(deck('old', 100));
  await db.decks.put(deck('mid', 500));
  await db.notes.put(note('new', 900));

  const changes = await changesSince(db, 400, 1000);
  assert.equal(changes.since, 400);
  assert.equal(changes.until, 1000);
  assert.deepEqual(
    changes.upserts.map((u) => u.record.id),
    ['mid', 'new'],
    'sorted by version, and the older record is excluded',
  );
  assert.deepEqual(changes.upserts.map((u) => u.store), ['decks', 'notes']);
});

test('the change bound is exclusive, so a feed cannot replay itself', async () => {
  const db = tracked();
  await db.decks.put(deck('a', 500));

  const first = await changesSince(db, 0, 500);
  assert.equal(first.upserts.length, 1);

  // Feeding `until` back in must not return the same record again.
  const second = await changesSince(db, first.until, 600);
  assert.equal(second.upserts.length, 0);
});

test('review logs are versioned by when the answer happened', async () => {
  const db = tracked();
  await db.reviewLogs.put({
    id: 'log',
    cardId: 'c',
    reviewedAt: 700,
    rating: 3,
    stateBefore: 0,
    stateAfter: 1,
    intervalDays: 1,
    lastIntervalDays: 0,
    elapsedDays: 0,
    stability: 1,
    difficulty: 5,
    timeTakenMs: 0,
    snapshot: { id: 'c' } as never,
    siblingsBuried: [],
  });

  assert.equal((await changesSince(db, 600, 800)).upserts.length, 1);
  assert.equal((await changesSince(db, 800, 900)).upserts.length, 0);
});

test('changesSince reports deletions alongside upserts', async () => {
  const db = tracked();
  await db.decks.putMany([deck('a', 100), deck('b', 100)]);
  clock = 700;
  await db.decks.delete('a');
  await db.decks.put(deck('c', 800));

  const changes = await changesSince(db, 500, 900);
  assert.deepEqual(changes.upserts.map((u) => u.record.id), ['c']);
  assert.deepEqual(changes.deletions.map((d) => d.recordId), ['a']);
  assert.equal(changeSetSize(changes), 2);
});

test('versionOf reads the right field per store and tolerates a missing one', () => {
  assert.equal(versionOf('decks', deck('a', 42)), 42);
  assert.equal(versionOf('reviewLogs', { id: 'l', reviewedAt: 99 } as never), 99);
  assert.equal(versionOf('decks', { id: 'x' } as never), 0);
});

test('a fresh collection reports everything from zero', async () => {
  const db = tracked();
  await db.decks.put(deck('a', 10));
  await db.notes.put(note('b', 20));

  const changes = await changesSince(db, 0, 100);
  assert.equal(changes.upserts.length, 2, 'since 0 means "give me everything"');
  assert.equal(changes.deletions.length, 0);
});
