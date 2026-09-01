import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb } from './memory.js';
import { CHECK_COUNT, runConformance } from './conformance.js';
import { CONTENT_STORES, compareKeys, inRange, INDEXES, STORE_NAMES, VERSION_FIELD } from './types.js';

test('the memory backend satisfies the storage conformance suite', async () => {
  const db = new MemoryDb();
  const results = await runConformance(db);

  assert.equal(results.length, CHECK_COUNT, 'every check must report');
  const failures = results.filter((r) => !r.ok);
  assert.deepEqual(
    failures.map((f) => `${f.name}: ${f.error}`),
    [],
    'no conformance check may fail',
  );
});

test('inRange handles every bound combination', () => {
  assert.ok(inRange(5, {}));
  assert.ok(inRange(5, { lower: 5 }));
  assert.ok(!inRange(5, { lower: 5, lowerOpen: true }));
  assert.ok(inRange(5, { upper: 5 }));
  assert.ok(!inRange(5, { upper: 5, upperOpen: true }));
  assert.ok(inRange(5, { lower: 1, upper: 9 }));
  assert.ok(!inRange(0, { lower: 1, upper: 9 }));
  assert.ok(!inRange(10, { lower: 1, upper: 9 }));
});

test('compareKeys sorts numbers numerically and strings lexically', () => {
  assert.deepEqual([10, 2, 1].sort(compareKeys), [1, 2, 10]);
  assert.deepEqual(['b', 'a', 'c'].sort(compareKeys), ['a', 'b', 'c']);
});

test('every store declares its indexes', () => {
  assert.deepEqual(STORE_NAMES.sort(), [
    'cards',
    'deckConfigs',
    'decks',
    'deletions',
    'meta',
    'noteTypes',
    'notes',
    'reviewLogs',
  ]);
  // The queue depends on these three; losing one would silently break it.
  assert.ok(INDEXES.cards.includes('due'));
  assert.ok(INDEXES.cards.includes('deckId'));
  assert.ok(INDEXES.cards.includes('noteId'));
});

test('every content store indexes the field the change feed scans', () => {
  // Without the index this is a full read on IndexedDB at best, and an
  // outright error at worst — and the in-memory backend would hide it.
  for (const store of CONTENT_STORES) {
    const field = VERSION_FIELD[store];
    assert.ok(
      (INDEXES[store] as readonly string[]).includes(field),
      `${store} must index "${field}"`,
    );
  }
  assert.ok(INDEXES.deletions.includes('deletedAt'));
});
