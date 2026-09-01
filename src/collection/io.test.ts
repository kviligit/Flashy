import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty } from '../storage/index.js';
import { parseCsv, sniffDelimiter, toCsv } from './csv.js';
import {
  EXPORT_FORMAT,
  exportCollection,
  exportCsv,
  importCollection,
  importCsv,
  previewCsv,
  validateExport,
} from './io.js';
import { addNote } from './notes.js';
import { Rating, State } from '../fsrs/index.js';
import type { NoteType } from '../domain/types.js';

async function setup() {
  const now = Date.parse('2026-03-01T09:00:00Z');
  const db = new MemoryDb();
  await seedIfEmpty(db, now);
  const noteTypes = await db.noteTypes.getAll();
  const find = (name: string): NoteType => {
    const nt = noteTypes.find((t) => t.name === name);
    if (!nt) throw new Error(name);
    return nt;
  };
  const deck = (await db.decks.getAll())[0]!;
  return { db, now, basic: find('Basic'), cloze: find('Cloze'), deck };
}

// --- CSV parsing ---------------------------------------------------------

test('parseCsv handles quotes, embedded delimiters and newlines', () => {
  assert.deepEqual(parseCsv('a,b,c'), [['a', 'b', 'c']]);
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('"a,1",b'), [['a,1', 'b']]);
  assert.deepEqual(parseCsv('"say ""hi""",b'), [['say "hi"', 'b']]);
  assert.deepEqual(parseCsv('"line1\nline2",b'), [['line1\nline2', 'b']]);
});

test('parseCsv accepts CRLF, lone CR and a BOM', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv('﻿a,b'), [['a', 'b']]);
});

test('parseCsv preserves empty cells and drops trailing blank lines', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv('a,b\n\n\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']], 'a trailing newline is not a row');
});

test('parseCsv honours a non-comma delimiter', () => {
  assert.deepEqual(parseCsv('a\tb\tc', '\t'), [['a', 'b', 'c']]);
  assert.deepEqual(parseCsv('a;b', ';'), [['a', 'b']]);
});

test('toCsv quotes only what needs it, and round-trips', () => {
  assert.equal(toCsv([['a', 'b']]), 'a,b');
  assert.equal(toCsv([['a,1', 'b']]), '"a,1",b');
  assert.equal(toCsv([['say "hi"']]), '"say ""hi"""');
  assert.equal(toCsv([['multi\nline']]), '"multi\nline"');
  assert.equal(toCsv([[' padded ']]), '" padded "', 'whitespace must survive');

  const rows = [
    ['Front', 'Back'],
    ['a,1', 'say "hi"'],
    ['multi\nline', ' padded '],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('sniffDelimiter picks the most common separator outside quotes', () => {
  assert.equal(sniffDelimiter('a,b,c'), ',');
  assert.equal(sniffDelimiter('a\tb\tc'), '\t');
  assert.equal(sniffDelimiter('a;b;c'), ';');
  assert.equal(sniffDelimiter('"a,b,c,d";x'), ';', 'commas inside quotes do not vote');
  assert.equal(sniffDelimiter('single'), ',', 'a single column defaults to comma');
});

// --- JSON backup ---------------------------------------------------------

test('a backup round-trips the collection exactly', async () => {
  const { db, basic, deck } = await setup();
  const { note, cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'bonjour', Back: 'hello' },
    tags: ['french'],
  });
  await db.cards.put({ ...cards[0]!, state: State.Review, reps: 5, memory: { stability: 30, difficulty: 4 } });
  await db.reviewLogs.put({
    id: 'log-1',
    cardId: cards[0]!.id,
    reviewedAt: 1000,
    rating: Rating.Good,
    stateBefore: State.New,
    stateAfter: State.Review,
    intervalDays: 3,
    lastIntervalDays: 0,
    elapsedDays: 0,
    stability: 3,
    difficulty: 5,
    timeTakenMs: 1234,
    snapshot: cards[0]!,
    siblingsBuried: [],
  });

  const backup = await exportCollection(db);
  assert.equal(backup.format, EXPORT_FORMAT);
  assert.equal(backup.notes.length, 1);

  // Serialise and reparse, as a real file would be.
  const wire = JSON.parse(JSON.stringify(backup));

  const fresh = new MemoryDb();
  const summary = await importCollection(fresh, wire, 'replace');
  assert.equal(summary.notes, 1);
  assert.equal(summary.reviewLogs, 1);

  assert.deepEqual(await fresh.notes.get(note.id), await db.notes.get(note.id));
  assert.deepEqual(await fresh.cards.get(cards[0]!.id), await db.cards.get(cards[0]!.id));
  assert.deepEqual(await fresh.reviewLogs.get('log-1'), await db.reviewLogs.get('log-1'));
  assert.deepEqual(await fresh.decks.getAll(), await db.decks.getAll());
});

test('replace wipes first, so a restore is not a merge', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'keep' } });
  const backup = JSON.parse(JSON.stringify(await exportCollection(db)));

  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'added later' } });
  assert.equal(await db.notes.count(), 2);

  await importCollection(db, backup, 'replace');
  assert.equal(await db.notes.count(), 1, 'the later note is gone');
  assert.equal((await db.notes.getAll())[0]?.fields['Front'], 'keep');
});

test('merge adds new records and skips ids that already exist', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'original' } });
  const backup = JSON.parse(JSON.stringify(await exportCollection(db)));

  const second = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'local only' } });

  const summary = await importCollection(db, backup, 'merge');
  assert.equal(summary.notes, 0, 'the backup note already exists');
  assert.ok(summary.skipped > 0);
  assert.equal(await db.notes.count(), 2, 'the local note survived');
  assert.ok(await db.notes.get(second.note.id), 'local note untouched');
});

test('validateExport rejects junk with a message a user can act on', () => {
  assert.throws(() => validateExport(null), /not a Flashy backup/);
  assert.throws(() => validateExport({}), /not a Flashy backup/);
  assert.throws(() => validateExport({ format: 'something-else' }), /not a Flashy backup/);
  assert.throws(
    () => validateExport({ format: EXPORT_FORMAT, version: 99 }),
    /newer version of Flashy/,
  );
  assert.throws(
    () => validateExport({ format: EXPORT_FORMAT, version: 1, notes: 'nope' }),
    /is not a list/,
  );
  assert.throws(
    () => validateExport({ format: EXPORT_FORMAT, version: 1, decks: [{ noId: true }] }),
    /malformed record/,
  );
  assert.throws(
    () => validateExport({ format: EXPORT_FORMAT, version: 1, notes: [{ id: 'n' }] }),
    /notes but no note types/,
  );
});

test('a backup missing optional sections still imports', async () => {
  const db = new MemoryDb();
  const summary = await importCollection(
    db,
    { format: EXPORT_FORMAT, version: 1, decks: [{ id: 'd', name: 'D' }] },
    'replace',
  );
  assert.equal(summary.decks, 1);
  assert.equal(summary.notes, 0);
});

// --- CSV export ----------------------------------------------------------

test('exportCsv writes a header, fields, tags and deck', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'bonjour', Back: 'hello' },
    tags: ['french', 'greeting'],
  });

  const rows = parseCsv(await exportCsv(db, { noteTypeId: basic.id }));
  assert.deepEqual(rows[0], ['Front', 'Back', 'Tags', 'Deck', 'Note type']);
  assert.deepEqual(rows[1], ['bonjour', 'hello', 'french greeting', deck.name, 'Basic']);
});

test('exportCsv can strip HTML and skip the header', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: '<b>bold</b> text', Back: 'x' },
  });

  const withHtml = parseCsv(await exportCsv(db, { noteTypeId: basic.id, header: false }));
  assert.equal(withHtml[0]?.[0], '<b>bold</b> text');

  const plain = parseCsv(await exportCsv(db, { noteTypeId: basic.id, header: false, plainText: true }));
  assert.equal(plain[0]?.[0], 'bold text');
});

// --- CSV import ----------------------------------------------------------

test('importCsv maps columns onto fields and creates cards', async () => {
  const { db, basic, deck } = await setup();
  const csv = 'Word,Meaning,Labels\nbonjour,hello,french greeting\nmerci,thank you,french';

  const result = await importCsv(db, csv, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fieldColumns: { Front: 0, Back: 1 },
    tagsColumn: 2,
  });

  assert.equal(result.notesAdded, 2);
  assert.equal(result.cardsAdded, 2);
  assert.equal(result.errors.length, 0);

  const notes = await db.notes.getAll();
  const bonjour = notes.find((n) => n.fields['Front'] === 'bonjour');
  assert.equal(bonjour?.fields['Back'], 'hello');
  assert.deepEqual(bonjour?.tags, ['french', 'greeting']);
  assert.equal((await db.cards.getAll())[0]?.deckId, deck.id);
});

test('importCsv skips duplicates by the sort field when asked', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'bonjour', Back: 'hi' } });

  const result = await importCsv(db, 'Front,Back\nBONJOUR,hello\nmerci,thanks', {
    noteTypeId: basic.id,
    deckId: deck.id,
    fieldColumns: { Front: 0, Back: 1 },
    skipDuplicates: true,
  });

  assert.equal(result.duplicatesSkipped, 1, 'duplicate detection is case-insensitive');
  assert.equal(result.notesAdded, 1);
});

test('importCsv reports rows that cannot make a card instead of throwing', async () => {
  const { db, cloze, deck } = await setup();
  const result = await importCsv(db, 'Text,Extra\n{{c1::good}},\nno deletions here,', {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fieldColumns: { Text: 0, Extra: 1 },
  });

  assert.equal(result.notesAdded, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.row, 3, 'the row number counts the header');
  assert.match(result.errors[0]?.message ?? '', /any cards/);
});

test('importCsv ignores blank lines and honours hasHeader:false', async () => {
  const { db, basic, deck } = await setup();
  const result = await importCsv(db, 'a,1\n\nb,2\n', {
    noteTypeId: basic.id,
    deckId: deck.id,
    fieldColumns: { Front: 0, Back: 1 },
    hasHeader: false,
  });
  assert.equal(result.notesAdded, 2, 'no row was consumed as a header');
});

test('importCsv rejects an unknown note type or deck with a clear message', async () => {
  const { db, basic, deck } = await setup();
  await assert.rejects(
    () => importCsv(db, 'a,b', { noteTypeId: 'nope', deckId: deck.id, fieldColumns: {} }),
    /note type/,
  );
  await assert.rejects(
    () => importCsv(db, 'a,b', { noteTypeId: basic.id, deckId: 'nope', fieldColumns: {} }),
    /deck/,
  );
});

test('a CSV exported from Flashy imports back into Flashy', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'has, comma', Back: 'has "quotes" and\nnewline' },
    tags: ['tricky'],
  });

  const csv = await exportCsv(db, { noteTypeId: basic.id });
  const fresh = await setup();
  await importCsv(fresh.db, csv, {
    noteTypeId: fresh.basic.id,
    deckId: fresh.deck.id,
    fieldColumns: { Front: 0, Back: 1 },
    tagsColumn: 2,
  });

  const note = (await fresh.db.notes.getAll())[0];
  assert.equal(note?.fields['Front'], 'has, comma');
  assert.equal(note?.fields['Back'], 'has "quotes" and\nnewline');
  assert.deepEqual(note?.tags, ['tricky']);
});

test('previewCsv reports the rows and the delimiter it chose', () => {
  const preview = previewCsv('a\tb\nc\td');
  assert.equal(preview.delimiter, '\t');
  assert.deepEqual(preview.rows, [['a', 'b'], ['c', 'd']]);
});
