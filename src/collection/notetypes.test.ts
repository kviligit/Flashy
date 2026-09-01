import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty } from '../storage/index.js';
import { addNote } from './notes.js';
import {
  addField,
  addTemplate,
  cloneNoteType,
  deleteNoteType,
  moveField,
  noteTypeUsage,
  removeField,
  removeTemplate,
  renameField,
  resyncCards,
  rewriteReferences,
  updateNoteType,
} from './notetypes.js';
import { State } from '../fsrs/index.js';
import type { NoteType } from '../domain/types.js';

async function setup() {
  const now = Date.parse('2026-04-01T09:00:00Z');
  const db = new MemoryDb();
  await seedIfEmpty(db, now);
  const types = await db.noteTypes.getAll();
  const find = (name: string): NoteType => {
    const nt = types.find((t) => t.name === name);
    if (!nt) throw new Error(name);
    return nt;
  };
  const deck = (await db.decks.getAll())[0]!;
  return { db, now, basic: find('Basic'), reversed: find('Basic (and reversed card)'), cloze: find('Cloze'), deck };
}

// --- template reference rewriting ---------------------------------------

test('rewriteReferences updates every form of reference and nothing else', () => {
  assert.equal(rewriteReferences('{{Front}}', 'Front', 'Question'), '{{Question}}');
  assert.equal(rewriteReferences('{{ Front }}', 'Front', 'Question'), '{{Question}}');
  assert.equal(rewriteReferences('{{text:Front}}', 'Front', 'Question'), '{{text:Question}}');
  assert.equal(rewriteReferences('{{cloze:Front}}', 'Front', 'Question'), '{{cloze:Question}}');
  assert.equal(
    rewriteReferences('{{#Front}}x{{/Front}}', 'Front', 'Question'),
    '{{#Question}}x{{/Question}}',
  );
  assert.equal(rewriteReferences('{{Back}}', 'Front', 'Question'), '{{Back}}', 'other fields untouched');
  assert.equal(rewriteReferences('{{FrontSide}}', 'Front', 'Question'), '{{FrontSide}}', 'FrontSide is not a field');
});

// --- fields --------------------------------------------------------------

test('adding a field gives every existing note a blank value', async () => {
  const { db, basic, deck } = await setup();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });

  await addField(db, basic.id, 'Example');
  const updated = await db.notes.get(note.id);
  assert.equal(updated?.fields['Example'], '');
  assert.deepEqual((await db.noteTypes.get(basic.id))?.fields.map((f) => f.name), ['Front', 'Back', 'Example']);
});

test('a duplicate or blank field name is refused', async () => {
  const { db, basic } = await setup();
  await assert.rejects(() => addField(db, basic.id, 'Front'), /already has a field/);
  await assert.rejects(() => addField(db, basic.id, '   '), /needs a name/);
});

test('renaming a field migrates note values and templates together', async () => {
  const { db, basic, deck } = await setup();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'bonjour', Back: 'hello' } });

  await renameField(db, basic.id, 'Front', 'Question');

  const updatedNote = await db.notes.get(note.id);
  assert.equal(updatedNote?.fields['Question'], 'bonjour', 'the value moved to the new name');
  assert.equal(updatedNote?.fields['Front'], undefined, 'the old key is gone');

  const nt = await db.noteTypes.get(basic.id);
  assert.equal(nt?.templates[0]?.question, '{{Question}}', 'the template follows the rename');
  assert.match(nt?.templates[0]?.answer ?? '', /\{\{FrontSide\}\}/, 'FrontSide is not renamed');
});

test('renaming onto an existing name is refused', async () => {
  const { db, basic } = await setup();
  await assert.rejects(() => renameField(db, basic.id, 'Front', 'Back'), /already has a field/);
  await assert.rejects(() => renameField(db, basic.id, 'Nope', 'X'), /No field called/);
});

test('removing a field drops its values and resyncs cards', async () => {
  const { db, reversed, deck } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: reversed.id,
    deckId: deck.id,
    fields: { Front: 'a', Back: 'b' },
  });
  assert.equal(cards.length, 2);

  await removeField(db, reversed.id, 'Back');

  assert.equal((await db.notes.get(note.id))?.fields['Back'], undefined);
  const remaining = await db.cards.byIndex('noteId', note.id);
  assert.equal(remaining.length, 1, 'the reverse card had nothing left to ask');
  assert.equal(remaining[0]?.ord, 0);
});

test('the last field cannot be removed', async () => {
  const { db, basic } = await setup();
  await removeField(db, basic.id, 'Back');
  await assert.rejects(() => removeField(db, basic.id, 'Front'), /at least one field/);
});

test('reordering fields leaves note values alone and follows the sort field', async () => {
  const { db, basic, deck } = await setup();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });

  const updated = await moveField(db, basic.id, 0, 1);
  assert.deepEqual(updated.fields.map((f) => f.name), ['Back', 'Front']);
  assert.equal(updated.sortField, 1, 'the sort field tracked its field');

  const stored = await db.notes.get(note.id);
  assert.equal(stored?.fields['Front'], 'a', 'values are keyed by name, so reordering is free');
  assert.equal(stored?.fields['Back'], 'b');
});

// --- templates -----------------------------------------------------------

test('adding a template generates a card for every note that fills it', async () => {
  const { db, basic, deck } = await setup();
  const { note } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });

  await addTemplate(db, basic.id, {
    name: 'Reverse',
    question: '{{Back}}',
    answer: '{{FrontSide}}<hr>{{Front}}',
  });

  const cards = await db.cards.byIndex('noteId', note.id);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.ord).sort(), [0, 1]);
});

test('removing a template deletes its cards and shifts the higher ordinals down', async () => {
  const { db, reversed, deck } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: reversed.id,
    deckId: deck.id,
    fields: { Front: 'a', Back: 'b' },
  });

  // Give the second card history, so we can prove the right one survived.
  const second = cards.find((c) => c.ord === 1)!;
  await db.cards.put({ ...second, state: State.Review, reps: 9 });

  await removeTemplate(db, reversed.id, 0);

  const remaining = await db.cards.byIndex('noteId', note.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, second.id, 'the surviving card is the one that was card 2');
  assert.equal(remaining[0]?.ord, 0, 'and it has been shifted down to ordinal 0');
  assert.equal(remaining[0]?.reps, 9, 'with its history intact');
});

test('the last template cannot be removed, and cloze templates are fixed', async () => {
  const { db, basic, cloze } = await setup();
  await assert.rejects(() => removeTemplate(db, basic.id, 0), /at least one template/);
  await assert.rejects(() => removeTemplate(db, cloze.id, 0), /must keep its single template/);
  await assert.rejects(
    () => addTemplate(db, cloze.id, { name: 'x', question: '{{Text}}', answer: '{{Text}}' }),
    /exactly one template/,
  );
});

test('editing template text does not disturb existing cards', async () => {
  const { db, basic, deck } = await setup();
  const { note, cards } = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });
  await db.cards.put({ ...cards[0]!, state: State.Review, reps: 4 });

  await updateNoteType(db, basic.id, {
    templates: [{ name: 'Card 1', question: 'Q: {{Front}}', answer: '{{FrontSide}}<hr>A: {{Back}}' }],
  });

  const after = await db.cards.byIndex('noteId', note.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.reps, 4);
});

test('a note type cannot be left nameless or templateless', async () => {
  const { db, basic } = await setup();
  await assert.rejects(() => updateNoteType(db, basic.id, { templates: [] }), /at least one template/);
  await assert.rejects(() => updateNoteType(db, basic.id, { name: '  ' }), /needs a name/);
});

// --- resync --------------------------------------------------------------

test('resyncCards adds missing cards and removes obsolete ones', async () => {
  const { db, cloze, deck } = await setup();
  const { note } = await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: '{{c1::a}} {{c2::b}}', Extra: '' },
  });
  assert.equal((await db.cards.byIndex('noteId', note.id)).length, 2);

  // Edit the note behind the service's back, then resync.
  const stored = (await db.notes.get(note.id))!;
  await db.notes.put({ ...stored, fields: { ...stored.fields, Text: '{{c1::a}} {{c3::c}}' } });

  const result = await resyncCards(db, cloze.id);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual((await db.cards.byIndex('noteId', note.id)).map((c) => c.ord).sort(), [1, 3]);
});

test('resyncCards leaves a note alone rather than deleting all of its cards', async () => {
  const { db, cloze, deck } = await setup();
  const { note } = await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: '{{c1::a}}', Extra: '' },
  });

  const stored = (await db.notes.get(note.id))!;
  await db.notes.put({ ...stored, fields: { ...stored.fields, Text: 'no deletions any more' } });

  const result = await resyncCards(db, cloze.id);
  assert.equal(result.removed, 0, 'study history must not vanish because of a typo');
  assert.equal((await db.cards.byIndex('noteId', note.id)).length, 1);
});

// --- lifecycle -----------------------------------------------------------

test('a note type in use cannot be deleted', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a' } });
  assert.equal(await noteTypeUsage(db, basic.id), 1);
  await assert.rejects(() => deleteNoteType(db, basic.id), /still use this note type/);
});

test('an unused note type can be deleted, but never the last one', async () => {
  const { db, cloze } = await setup();
  await deleteNoteType(db, cloze.id);
  assert.equal(await db.noteTypes.count(), 2);

  const remaining = await db.noteTypes.getAll();
  await deleteNoteType(db, remaining[0]!.id);
  await assert.rejects(() => deleteNoteType(db, remaining[1]!.id), /at least one note type/);
});

test('cloning a note type produces an independent copy', async () => {
  const { db, basic } = await setup();
  const clone = await cloneNoteType(db, basic.id, 'Basic (mine)');
  assert.notEqual(clone.id, basic.id);
  assert.equal(clone.name, 'Basic (mine)');

  await renameField(db, clone.id, 'Front', 'Prompt');
  const original = await db.noteTypes.get(basic.id);
  assert.equal(original?.fields[0]?.name, 'Front', 'the original is untouched');
});
