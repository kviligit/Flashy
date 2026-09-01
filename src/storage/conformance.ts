/**
 * One behaviour suite, run against every `Db` implementation.
 *
 * It is written as plain functions rather than as `node:test` cases because
 * the IndexedDB backend can only run in a browser: the node suite drives it
 * over the memory backend, and the debug page drives the identical suite
 * over IndexedDB. If the two ever diverge, one of them goes red.
 */

import type { Card, Deck, Note } from '../domain/types.js';
import { State } from '../fsrs/index.js';
import { CardFlag } from '../domain/types.js';
import { CONTENT_STORES, VERSION_FIELD, type Db } from './types.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

class Failure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Failure(`${message}: expected ${expected}, got ${actual}`);
}

function assertSameIds(actual: Array<{ id: string }>, expected: string[], message: string): void {
  const got = actual.map((x) => x.id).join(',');
  const want = expected.join(',');
  if (got !== want) throw new Failure(`${message}: expected [${want}], got [${got}]`);
}

// --- fixtures ------------------------------------------------------------

function deck(id: string, name: string): Deck {
  return {
    id,
    name,
    configId: 'cfg',
    description: '',
    collapsed: false,
    created: 0,
    modified: 0,
  };
}

function note(id: string, noteTypeId: string): Note {
  return {
    id,
    noteTypeId,
    fields: { Front: `front ${id}`, Back: `back ${id}` },
    tags: [],
    created: 0,
    modified: 0,
  };
}

function card(id: string, noteId: string, deckId: string, due: string, position: number): Card {
  return {
    id,
    noteId,
    deckId,
    ord: 0,
    state: State.New,
    memory: null,
    due,
    lastReview: null,
    step: 0,
    reps: 0,
    lapses: 0,
    position,
    suspended: false,
    buriedUntil: null,
    flag: CardFlag.None,
    created: 0,
    modified: 0,
  };
}

const DAY = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

// --- the checks ----------------------------------------------------------

type Check = { name: string; run: (db: Db) => Promise<void> };

const CHECKS: Check[] = [
  {
    name: 'put then get returns the stored item',
    run: async (db) => {
      await db.decks.put(deck('d1', 'Spanish'));
      const found = await db.decks.get('d1');
      assert(found, 'deck should exist');
      assertEqual(found.name, 'Spanish', 'name round-trips');
    },
  },
  {
    name: 'get of a missing id returns null, not undefined',
    run: async (db) => {
      assertEqual(await db.decks.get('nope'), null, 'missing deck');
    },
  },
  {
    name: 'put overwrites an existing item',
    run: async (db) => {
      await db.decks.put(deck('d1', 'Spanish'));
      await db.decks.put({ ...deck('d1', 'Spanish'), name: 'Español' });
      assertEqual(await db.decks.count(), 1, 'still one deck');
      assertEqual((await db.decks.get('d1'))?.name, 'Español', 'name updated');
    },
  },
  {
    name: 'stored items are decoupled from the caller’s object',
    run: async (db) => {
      const d = deck('d1', 'Spanish');
      await db.decks.put(d);
      d.name = 'mutated after put';
      assertEqual((await db.decks.get('d1'))?.name, 'Spanish', 'store kept its own copy');

      const first = await db.decks.get('d1');
      assert(first, 'deck exists');
      first.name = 'mutated after get';
      assertEqual((await db.decks.get('d1'))?.name, 'Spanish', 'store unaffected by caller');
    },
  },
  {
    name: 'putMany and getMany',
    run: async (db) => {
      await db.decks.putMany([deck('a', 'A'), deck('b', 'B'), deck('c', 'C')]);
      assertEqual(await db.decks.count(), 3, 'three decks');
      const found = await db.decks.getMany(['a', 'c', 'missing']);
      assertSameIds(found, ['a', 'c'], 'getMany skips missing ids');
      assertSameIds(await db.decks.getMany([]), [], 'empty getMany');
    },
  },
  {
    name: 'delete and deleteMany',
    run: async (db) => {
      await db.decks.putMany([deck('a', 'A'), deck('b', 'B'), deck('c', 'C')]);
      await db.decks.delete('b');
      assertEqual(await db.decks.count(), 2, 'one removed');
      await db.decks.delete('b');
      assertEqual(await db.decks.count(), 2, 'deleting twice is a no-op');
      await db.decks.deleteMany(['a', 'c']);
      assertEqual(await db.decks.count(), 0, 'all removed');
    },
  },
  {
    name: 'byIndex finds every match and nothing else',
    run: async (db) => {
      await db.notes.putMany([note('n1', 'basic'), note('n2', 'basic'), note('n3', 'cloze')]);
      const basics = await db.notes.byIndex('noteTypeId', 'basic');
      assertEqual(basics.length, 2, 'two basic notes');
      assertEqual((await db.notes.byIndex('noteTypeId', 'cloze')).length, 1, 'one cloze note');
      assertEqual((await db.notes.byIndex('noteTypeId', 'nope')).length, 0, 'no matches');
    },
  },
  {
    name: 'byRange over a string index returns index order',
    run: async (db) => {
      await db.cards.putMany([
        card('c3', 'n1', 'd1', DAY(3), 3),
        card('c1', 'n1', 'd1', DAY(1), 1),
        card('c5', 'n1', 'd1', DAY(5), 5),
        card('c2', 'n1', 'd1', DAY(2), 2),
      ]);
      const upToDay3 = await db.cards.byRange('due', { upper: DAY(3) });
      assertSameIds(upToDay3, ['c1', 'c2', 'c3'], 'inclusive upper bound, sorted by due');

      const exclusive = await db.cards.byRange('due', { upper: DAY(3), upperOpen: true });
      assertSameIds(exclusive, ['c1', 'c2'], 'exclusive upper bound');

      const band = await db.cards.byRange('due', { lower: DAY(2), upper: DAY(3) });
      assertSameIds(band, ['c2', 'c3'], 'bounded both ends');

      const unbounded = await db.cards.byRange('due', {});
      assertSameIds(unbounded, ['c1', 'c2', 'c3', 'c5'], 'no bounds returns everything sorted');
    },
  },
  {
    name: 'byRange over a numeric index sorts numerically, not lexically',
    run: async (db) => {
      await db.cards.putMany([
        card('c2', 'n1', 'd1', DAY(1), 2),
        card('c10', 'n1', 'd1', DAY(1), 10),
        card('c1', 'n1', 'd1', DAY(1), 1),
      ]);
      const all = await db.cards.byRange('position', {});
      assertSameIds(all, ['c1', 'c2', 'c10'], '1 < 2 < 10, not "1" < "10" < "2"');
    },
  },
  {
    name: 'byRange honours limit and descending',
    run: async (db) => {
      await db.cards.putMany([
        card('c1', 'n1', 'd1', DAY(1), 1),
        card('c2', 'n1', 'd1', DAY(2), 2),
        card('c3', 'n1', 'd1', DAY(3), 3),
        card('c4', 'n1', 'd1', DAY(4), 4),
      ]);
      assertSameIds(await db.cards.byRange('due', {}, { limit: 2 }), ['c1', 'c2'], 'limit');
      assertSameIds(
        await db.cards.byRange('due', {}, { descending: true }),
        ['c4', 'c3', 'c2', 'c1'],
        'descending',
      );
      assertSameIds(
        await db.cards.byRange('due', {}, { descending: true, limit: 2 }),
        ['c4', 'c3'],
        'descending with limit',
      );
      assertSameIds(await db.cards.byRange('due', {}, { limit: 0 }), [], 'limit 0');
    },
  },
  {
    name: 'countRange agrees with byRange',
    run: async (db) => {
      await db.cards.putMany([
        card('c1', 'n1', 'd1', DAY(1), 1),
        card('c2', 'n1', 'd1', DAY(2), 2),
        card('c3', 'n1', 'd1', DAY(3), 3),
      ]);
      for (const range of [{}, { upper: DAY(2) }, { lower: DAY(2) }, { lower: DAY(9) }]) {
        const counted = await db.cards.countRange('due', range);
        const listed = (await db.cards.byRange('due', range)).length;
        assertEqual(counted, listed, `countRange vs byRange for ${JSON.stringify(range)}`);
      }
    },
  },
  {
    name: 'nested objects and arrays survive a round trip',
    run: async (db) => {
      const rich: Card = {
        ...card('c1', 'n1', 'd1', DAY(1), 1),
        state: State.Review,
        memory: { stability: 12.5, difficulty: 6.25 },
        lastReview: DAY(1),
        flag: CardFlag.Blue,
      };
      await db.cards.put(rich);
      const found = await db.cards.get('c1');
      assert(found, 'card exists');
      assertEqual(found.memory?.stability, 12.5, 'stability survives');
      assertEqual(found.memory?.difficulty, 6.25, 'difficulty survives');
      assertEqual(found.state, State.Review, 'state survives');
      assertEqual(found.flag, CardFlag.Blue, 'flag survives');

      const tagged = { ...note('n1', 'basic'), tags: ['verb', 'chapter::1'] };
      await db.notes.put(tagged);
      const back = await db.notes.get('n1');
      assertEqual(back?.tags.join('|'), 'verb|chapter::1', 'tags survive');
      assertEqual(back?.fields['Front'], 'front n1', 'fields survive');
    },
  },
  {
    name: 'stores are independent of one another',
    run: async (db) => {
      await db.decks.put(deck('x', 'X'));
      await db.notes.put(note('x', 'basic'));
      assertEqual(await db.decks.count(), 1, 'deck stored');
      assertEqual(await db.notes.count(), 1, 'note stored');
      await db.decks.clear();
      assertEqual(await db.decks.count(), 0, 'decks cleared');
      assertEqual(await db.notes.count(), 1, 'notes untouched by clearing decks');
    },
  },
  {
    name: 'db.clear empties every store',
    run: async (db) => {
      await db.decks.put(deck('d', 'D'));
      await db.notes.put(note('n', 'basic'));
      await db.cards.put(card('c', 'n', 'd', DAY(1), 1));
      await db.clear();
      assertEqual(await db.decks.count(), 0, 'decks');
      assertEqual(await db.notes.count(), 0, 'notes');
      assertEqual(await db.cards.count(), 0, 'cards');
    },
  },
  {
    name: 'empty batch operations are safe',
    run: async (db) => {
      await db.decks.putMany([]);
      await db.decks.deleteMany([]);
      assertEqual(await db.decks.count(), 0, 'still empty');
    },
  },
  {
    name: 'a realistic queue query works',
    run: async (db) => {
      // 3 due cards in deck A, 1 not yet due, 2 in deck B.
      await db.cards.putMany([
        { ...card('a1', 'n1', 'A', DAY(1), 1), state: State.Review },
        { ...card('a2', 'n2', 'A', DAY(2), 2), state: State.Review },
        { ...card('a3', 'n3', 'A', DAY(3), 3), state: State.Review },
        { ...card('a4', 'n4', 'A', DAY(9), 4), state: State.Review },
        { ...card('b1', 'n5', 'B', DAY(1), 5), state: State.Review },
        { ...card('b2', 'n6', 'B', DAY(2), 6), state: State.Review },
      ]);
      const dueNow = await db.cards.byRange('due', { upper: DAY(4) });
      const inA = dueNow.filter((c) => c.deckId === 'A');
      assertSameIds(inA, ['a1', 'a2', 'a3'], 'due cards in deck A, in due order');
      assertEqual(await db.cards.countRange('due', { upper: DAY(4) }), 5, 'due across all decks');
    },
  },
];

CHECKS.push(
  {
    name: 'every content store can be range-scanned by its version field',
    run: async (db) => {
      // The change feed depends on this. The in-memory backend reads the
      // field directly and would happily pretend the index exists, so this
      // check only has teeth against IndexedDB — which is the point.
      for (const store of CONTENT_STORES) {
        const field = VERSION_FIELD[store];
        const all = await db[store].byRange(field, {});
        assertEqual(all.length, 0, `${store} scanned by "${field}" on an empty database`);
        const counted = await db[store].countRange(field, { lower: 0 });
        assertEqual(counted, 0, `${store} counted by "${field}"`);
      }
    },
  },
  {
    name: 'the deletions store holds tombstones and scans by time',
    run: async (db) => {
      await db.deletions.putMany([
        { id: 'decks:a', store: 'decks', recordId: 'a', deletedAt: 100 },
        { id: 'notes:b', store: 'notes', recordId: 'b', deletedAt: 200 },
      ]);
      assertEqual(await db.deletions.count(), 2, 'both tombstones stored');

      const recent = await db.deletions.byRange('deletedAt', { lower: 150 });
      assertSameIds(recent, ['notes:b'], 'scanned by deletedAt');

      const byStore = await db.deletions.byIndex('store', 'decks');
      assertEqual(byStore.length, 1, 'scanned by store');
    },
  },
);

/** Run every check against a freshly-cleared database. */
export async function runConformance(db: Db): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    await db.clear();
    try {
      await check.run(db);
      results.push({ name: check.name, ok: true });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await db.clear();
  return results;
}

export const CHECK_COUNT = CHECKS.length;
