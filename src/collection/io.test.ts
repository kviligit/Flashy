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
import { addMedia } from './media.js';
import { mediaUrl } from '../domain/media.js';
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

// --- media in backups ----------------------------------------------------

test('media survives a backup and restore, byte for byte', async () => {
  const { db, basic, deck } = await setup();
  const bytes = new Uint8Array([0, 255, 128, 1, 254, 77]);
  const added = await addMedia(db, { filename: 'cat.png', mime: 'image/png', data: bytes.buffer });
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: `<img src="${mediaUrl(added.file.id)}">`, Back: 'a cat' },
  });

  // Through JSON, as a real backup file would be.
  const wire = JSON.parse(JSON.stringify(await exportCollection(db)));
  assert.equal(wire.media.length, 1);
  assert.equal(typeof wire.media[0].data, 'string', 'bytes travel base64-encoded');

  const fresh = new MemoryDb();
  const summary = await importCollection(fresh, wire, 'replace');
  assert.equal(summary.media, 1);

  const restored = await fresh.media.get(added.file.id);
  assert.ok(restored, 'the file came back');
  assert.deepEqual(new Uint8Array(restored.data), bytes, 'and the bytes are identical');
  assert.equal(restored.filename, 'cat.png');
  assert.equal(restored.mime, 'image/png');
});

test('an older backup with no media section still imports', async () => {
  // Export format 1 predates media entirely.
  const db = new MemoryDb();
  const summary = await importCollection(
    db,
    { format: EXPORT_FORMAT, version: 1, decks: [{ id: 'd', name: 'D' }] },
    'replace',
  );
  assert.equal(summary.media, 0);
  assert.equal(summary.decks, 1);
});

test('a backup with a malformed media entry is refused', () => {
  assert.throws(
    () =>
      validateExport({
        format: EXPORT_FORMAT,
        version: 2,
        media: [{ id: 'x', filename: 'x.png', data: 12345 }],
      }),
    /has no content/,
  );
});

test('merging a backup does not duplicate media, since ids are content hashes', async () => {
  const { db } = await setup();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await addMedia(db, { filename: 'a.png', mime: 'image/png', data: bytes.buffer });

  const wire = JSON.parse(JSON.stringify(await exportCollection(db)));
  const summary = await importCollection(db, wire, 'merge');

  assert.equal(summary.media, 0, 'the identical file is already there');
  assert.equal(await db.media.count(), 1);
});

// --- hostile backups -----------------------------------------------------

test('a backup carrying a non-finite number is refused', () => {
  // JSON.parse turns 1e309 into Infinity. A record with an infinite
  // `modified` would win every conflict forever, and one with an infinite
  // elapsedDays would poison a card's schedule.
  const withInfinity = JSON.parse(
    `{"format":"${EXPORT_FORMAT}","version":2,"noteTypes":[{"id":"nt"}],` +
      `"notes":[{"id":"n","modified":1e309,"fields":{}}]}`,
  );
  assert.throws(() => validateExport(withInfinity), /impossible number/);

  const nested = JSON.parse(
    `{"format":"${EXPORT_FORMAT}","version":2,` +
      `"reviewLogs":[{"id":"l","elapsedDays":-1e400,"snapshot":{"id":"c"}}]}`,
  );
  assert.throws(() => validateExport(nested), /impossible number/);
});

test('an ordinary backup still validates', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'ok' } });
  const wire = JSON.parse(JSON.stringify(await exportCollection(db)));
  assert.doesNotThrow(() => validateExport(wire));
});

test('a hostile media type is neutralised on import', async () => {
  const db = new MemoryDb();
  await importCollection(
    db,
    {
      format: EXPORT_FORMAT,
      version: 2,
      media: [
        { id: 'a', filename: 'x.html', mime: 'text/html', size: 4, data: btoa('evil'), created: 1, modified: 1 },
        { id: 'b', filename: 'y.png', mime: 'image/png', size: 4, data: btoa('png!'), created: 1, modified: 1 },
        { id: 'c', filename: 'z.png', mime: 'image/svg+xml;charset=utf-8', size: 4, data: btoa('svg!'), created: 1, modified: 1 },
      ],
    },
    'replace',
  );

  assert.equal((await db.media.get('a'))?.mime, 'application/octet-stream', 'text/html is neutralised');
  assert.equal((await db.media.get('b'))?.mime, 'image/png', 'a real image type survives');
  assert.equal((await db.media.get('c'))?.mime, 'image/svg+xml', 'parameters are stripped');
});

test('a lying size is replaced by the real one', async () => {
  const db = new MemoryDb();
  await importCollection(
    db,
    {
      format: EXPORT_FORMAT,
      version: 2,
      media: [{ id: 'a', filename: 'x.png', mime: 'image/png', size: 999999, data: btoa('four'), created: 1, modified: 1 }],
    },
    'replace',
  );
  assert.equal((await db.media.get('a'))?.size, 4, 'the bytes decide, not the claim');
});
