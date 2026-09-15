import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty } from '../storage/index.js';
import { makeDeck } from '../domain/defaults.js';
import { addNote } from './notes.js';
import { parseCsv } from './csv.js';
import {
  ANKI_SEPARATOR,
  ankiExportPlan,
  ankiFilename,
  ankiHeader,
  exportForAnki,
  referencesMedia,
} from './anki.js';
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

/** Split an exported file into its directive lines and its note rows. */
function split(text: string): { directives: string[]; rows: string[][] } {
  const lines = text.split('\n');
  const directives: string[] = [];
  while (lines.length > 0 && lines[0]!.startsWith('#')) directives.push(lines.shift()!);
  return { directives, rows: parseCsv(lines.join('\n'), ANKI_SEPARATOR) };
}

function directive(text: string, name: string): string | undefined {
  const line = split(text).directives.find((d) => d.startsWith(`#${name}:`));
  return line?.slice(name.length + 2);
}

// --- the header Anki reads ----------------------------------------------

test('the header names the note type and points at each special column', () => {
  const header = ankiHeader('Basic', ['Front', 'Back']);
  assert.match(header, /^#separator:tab$/m);
  assert.match(header, /^#html:true$/m);
  assert.match(header, /^#notetype:Basic$/m);
  // Fields occupy columns 1 and 2, so the extras start at 3.
  assert.match(header, /^#tags column:3$/m);
  assert.match(header, /^#deck column:4$/m);
  assert.match(header, /^#guid column:5$/m);
  assert.match(header, /^#columns:Front\tBack\tTags\tDeck\tGUID$/m);
});

test('column numbers follow the note type, not a fixed layout', () => {
  const header = ankiHeader('Long', ['A', 'B', 'C', 'D']);
  assert.match(header, /^#tags column:5$/m);
  assert.match(header, /^#guid column:7$/m);
});

test('a tab in a name cannot shift the columns of the file', () => {
  const header = ankiHeader('Weird\tName', ['Front\there', 'Back']);
  assert.match(header, /^#notetype:Weird Name$/m);
  assert.match(header, /^#columns:Front here\tBack\tTags\tDeck\tGUID$/m);
});

// --- the file ------------------------------------------------------------

test('a note becomes one row of fields, tags, deck and a stable id', async () => {
  const { db, basic, deck } = await setup();
  const note = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'union', Back: 'A ∪ B' },
    tags: ['mengdelære', 'sets'],
  });

  const file = await exportForAnki(db, basic.id);
  const { rows } = split(file.text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['union', 'A ∪ B', 'mengdelære sets', deck.name, note.note.id]);
  assert.equal(directive(file.text, 'notetype'), 'Basic');
});

test('the id is the note id, so re-importing updates instead of duplicating', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });

  const first = split((await exportForAnki(db, basic.id)).text).rows[0]!;
  const second = split((await exportForAnki(db, basic.id)).text).rows[0]!;
  assert.equal(first.at(-1), second.at(-1));
  assert.ok(first.at(-1)!.length > 0, 'a note always carries an id');
});

test('HTML is kept, because the header says the fields are HTML', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: '<b>bold</b>', Back: '&lt;a,b&gt;' },
  });

  const file = await exportForAnki(db, basic.id);
  assert.equal(directive(file.text, 'html'), 'true');
  const row = split(file.text).rows[0]!;
  assert.equal(row[0], '<b>bold</b>');
  // The escaped angle brackets stay escaped: with #html:true Anki renders
  // them as the <a,b> the user typed.
  assert.equal(row[1], '&lt;a,b&gt;');
});

test('a field holding a tab or a newline survives the round trip', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'one\ttwo', Back: 'line one\nline two' },
  });

  const row = split((await exportForAnki(db, basic.id)).text).rows[0]!;
  assert.equal(row[0], 'one\ttwo');
  assert.equal(row[1], 'line one\nline two');
});

test('each note type gets its own file with its own columns', async () => {
  const { db, basic, cloze, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });
  await addNote(db, {
    noteTypeId: cloze.id,
    deckId: deck.id,
    fields: { Text: 'The {{c1::empty set}} has no members.', Extra: '' },
  });

  const basicFile = await exportForAnki(db, basic.id);
  const clozeFile = await exportForAnki(db, cloze.id);
  assert.match(basicFile.text, /^#columns:Front\tBack\t/m);
  assert.match(clozeFile.text, /^#columns:Text\tExtra\t/m);
  assert.equal(split(basicFile.text).rows.length, 1);
  assert.equal(split(clozeFile.text).rows.length, 1);
  assert.notEqual(basicFile.filename, clozeFile.filename);
});

test('notes keep the deck they are in, one column per row', async () => {
  const { db, basic, deck } = await setup();
  const other = makeDeck('Diskret matematikk::Mengdelære', deck.configId);
  await db.decks.put(other);
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });
  await addNote(db, { noteTypeId: basic.id, deckId: other.id, fields: { Front: 'c', Back: 'd' } });

  const file = await exportForAnki(db, basic.id);
  const decks = split(file.text).rows.map((row) => row[3]);
  assert.deepEqual(decks.sort(), [deck.name, 'Diskret matematikk::Mengdelære'].sort());
  // Anki nests on "::" too, so the hierarchy arrives intact.
  assert.deepEqual(file.decks, ['Diskret matematikk::Mengdelære', deck.name].sort((a, b) => a.localeCompare(b)));
});

test('the file ends on a newline so the last note is a whole line', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });
  assert.ok((await exportForAnki(db, basic.id)).text.endsWith('\n'));
});

// --- the plan ------------------------------------------------------------

test('the plan lists only note types that have notes, busiest first', async () => {
  const { db, basic, cloze, deck } = await setup();
  await addNote(db, { noteTypeId: cloze.id, deckId: deck.id, fields: { Text: 'x {{c1::y}}' } });
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'c', Back: 'd' } });

  const plan = await ankiExportPlan(db);
  assert.deepEqual(plan.map((g) => g.noteTypeName), ['Basic', 'Cloze']);
  assert.deepEqual(plan.map((g) => g.notes), [2, 1]);
  assert.ok(plan.every((g) => g.decks.length === 1));
});

test('an empty collection has nothing to export', async () => {
  const { db } = await setup();
  assert.deepEqual(await ankiExportPlan(db), []);
});

test('exporting a note type that is gone says so rather than writing nothing', async () => {
  const { db } = await setup();
  await assert.rejects(() => exportForAnki(db, 'no-such-type'), /no longer in this collection/);
});

// --- media ---------------------------------------------------------------

test('notes pointing at a file are counted, because the file cannot travel', async () => {
  const { db, basic, deck } = await setup();
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'What is this?', Back: '<img src="flashy-media:abc">' },
  });
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a', Back: 'b' } });

  const file = await exportForAnki(db, basic.id);
  assert.equal(file.notes, 2);
  assert.equal(file.withMedia, 1);
});

test('referencesMedia spots the tags a field can carry a file in', () => {
  assert.ok(referencesMedia('<img src="x.png">'));
  assert.ok(referencesMedia('<AUDIO controls></AUDIO>'));
  assert.ok(referencesMedia('[sound:x.mp3]'));
  assert.ok(!referencesMedia('an image of a set'));
  assert.ok(!referencesMedia('<b>image</b>'));
});

// --- filenames -----------------------------------------------------------

test('a filename is dated, lower case and free of anything a disk dislikes', () => {
  const date = new Date('2026-09-15T00:00:00Z');
  assert.equal(ankiFilename('Basic', date), 'flashy-basic-2026-09-15.txt');
  assert.equal(ankiFilename('Basic (and reversed card)', date), 'flashy-basic-and-reversed-card-2026-09-15.txt');
  assert.equal(ankiFilename('Mengdelære/øving', date), 'flashy-mengdel-re-ving-2026-09-15.txt');
  assert.equal(ankiFilename('???', date), 'flashy-notes-2026-09-15.txt');
});
