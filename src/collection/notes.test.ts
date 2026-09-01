import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty } from '../storage/index.js';
import { addNote, deleteNotes, normaliseTags, parseTags, retagNotes, setCardDeck, updateNote } from './notes.js';
import { makeDeck } from '../domain/defaults.js';
import { Rating, State } from '../fsrs/index.js';
import type { NoteType } from '../domain/types.js';

async function setup() {
  const now = Date.parse('2026-02-01T12:00:00Z');
  const db = new MemoryDb();
  await seedIfEmpty(db, now);
  const noteTypes = await db.noteTypes.getAll();
  const byName = (name: string): NoteType => {
    const found = noteTypes.find((nt) => nt.name === name);
    if (!found) throw new Error(`missing note type ${name}`);
    return found;
  };
  const deck = (await db.decks.getAll())[0]!;
  const other = makeDeck('Other', deck.configId, now);
  await db.decks.put(other);
  return { db, now, basic: byName('Basic'), reversed: byName('Basic (and reversed card)'), cloze: byName('Cloze'), deck, other };
}

test('adding a Basic note creates one card in the chosen deck', async () => {
  const { db, basic, deck } = await setup();
  const result = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'bonjour', Back: 'hello' },
    tags: ['french'],
  });

  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]?.deckId, deck.id);
  assert.equal(result.cards[0]?.state, State.New);
  assert.equal((await db.notes.count()), 1);
  assert.deepEqual((await db.notes.get(result.note.id))?.tags, ['french']);
});

test('missing fields are filled in blank rather than left absent', async () => {
  const { db, basic, deck } = await setup();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  assert.deepEqual(Object.keys(note.fields).sort(), ['Back', 'Front']);
  assert.equal(note.fields['Back'], '');
});

test('a reversed note creates two cards; a note with no cards is refused', async () => {
  const { db, reversed, cloze, deck } = await setup();
  const both = await addNote(db, {
    noteTypeId: reversed.id,
    deckId: deck.id,
    fields: { Front: 'a', Back: 'b' },
  });
  assert.equal(both.cards.length, 2);
  assert.deepEqual(both.cards.map((c) => c.ord), [0, 1]);

  await assert.rejects(
    () => addNote(db, { noteTypeId: cloze.id, deckId: deck.id, fields: { Text: 'no deletions' } }),
    /would not produce any cards/,
  );
});

test('new cards queue behind existing ones', async () => {
  const { db, basic, deck } = await setup();
  const a = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a' } });
  const b = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'b' } });
  assert.ok(b.cards[0]!.position > a.cards[0]!.position, 'later notes get later positions');
});

test('editing fields keeps the existing card and its scheduling state', async () => {
  const { db, basic, deck } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'a', Back: 'b' },
  });

  // Give the card some history worth losing.
  const studied = { ...cards[0]!, state: State.Review, reps: 7, memory: { stability: 30, difficulty: 4 } };
  await db.cards.put(studied);

  const result = await updateNote(db, note.id, { fields: { Front: 'a2', Back: 'b2' } });
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);

  const after = await db.cards.get(studied.id);
  assert.equal(after?.reps, 7, 'history survived the edit');
  assert.equal(after?.state, State.Review);
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'a2');
});

test('adding a cloze deletion adds a card; removing one removes only that card', async () => {
  const { db, cloze, deck } = await setup();
  const { note } = await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: '{{c1::alpha}}', Extra: '' },
  });
  assert.equal((await db.cards.byIndex('noteId', note.id)).length, 1);

  const grown = await updateNote(db, note.id, {
    fields: { Text: '{{c1::alpha}} {{c2::beta}}', Extra: '' },
  });
  assert.equal(grown.added, 1);
  assert.deepEqual(grown.cards.map((c) => c.ord).sort(), [1, 2]);

  // Mark c1 as studied, then delete c2. c1 must be untouched.
  const c1 = grown.cards.find((c) => c.ord === 1)!;
  await db.cards.put({ ...c1, reps: 3, state: State.Review });

  const shrunk = await updateNote(db, note.id, {
    fields: { Text: '{{c1::alpha}} beta', Extra: '' },
  });
  assert.equal(shrunk.removed, 1);
  assert.deepEqual(shrunk.cards.map((c) => c.ord), [1]);
  assert.equal((await db.cards.get(c1.id))?.reps, 3, 'the surviving card kept its history');
});

test('new cards from an edit land in the same deck as the note’s existing cards', async () => {
  const { db, cloze, deck, other } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: '{{c1::a}}', Extra: '' },
  });
  await setCardDeck(db, [cards[0]!.id], other.id);

  const grown = await updateNote(db, note.id, { fields: { Text: '{{c1::a}} {{c2::b}}', Extra: '' } });
  const added = grown.cards.find((c) => c.ord === 2);
  assert.equal(added?.deckId, other.id, 'the new card follows its siblings');
});

test('an edit that would leave no cards is refused and changes nothing', async () => {
  const { db, cloze, deck } = await setup();
  const { note } = await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: '{{c1::a}}', Extra: '' },
  });

  await assert.rejects(
    () => updateNote(db, note.id, { fields: { Text: 'nothing here', Extra: '' } }),
    /would not produce any cards/,
  );
  assert.equal((await db.cards.byIndex('noteId', note.id)).length, 1, 'card still there');
  assert.equal((await db.notes.get(note.id))?.fields['Text'], '{{c1::a}}', 'fields unchanged');
});

test('deleting notes removes their cards and review logs', async () => {
  const { db, reversed, deck } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: reversed.id,
    deckId: deck.id,
    fields: { Front: 'a', Back: 'b' },
  });
  await db.reviewLogs.put({
    id: 'log1',
    cardId: cards[0]!.id,
    reviewedAt: 1,
    rating: Rating.Good,
    stateBefore: State.New,
    stateAfter: State.Learning,
    intervalDays: 0,
    lastIntervalDays: 0,
    elapsedDays: 0,
    stability: 1,
    difficulty: 5,
    timeTakenMs: 0,
    snapshot: cards[0]!,
    siblingsBuried: [],
  });

  const removed = await deleteNotes(db, [note.id]);
  assert.equal(removed, 2);
  assert.equal(await db.notes.count(), 0);
  assert.equal(await db.cards.count(), 0);
  assert.equal(await db.reviewLogs.count(), 0);
});

test('tags are trimmed, deduplicated and sorted', () => {
  assert.deepEqual(normaliseTags([' b ', 'a', 'b', '', '  ']), ['a', 'b']);
  assert.deepEqual(parseTags('verb  chapter::1, noun'), ['chapter::1', 'noun', 'verb']);
  assert.deepEqual(parseTags('   '), []);
});

test('retagNotes adds and removes across a selection', async () => {
  const { db, basic, deck } = await setup();
  const a = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a' }, tags: ['old'] });
  const b = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'b' }, tags: ['keep'] });

  await retagNotes(db, [a.note.id, b.note.id], ['new'], ['old']);
  assert.deepEqual((await db.notes.get(a.note.id))?.tags, ['new']);
  assert.deepEqual((await db.notes.get(b.note.id))?.tags, ['keep', 'new']);
});
