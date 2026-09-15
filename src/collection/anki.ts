/**
 * Export notes in the text format Anki imports.
 *
 * The point of this file is a one-way door: cards written in Flashy on a
 * phone, opened in Anki on a computer, without retyping any of them.
 * Scheduling deliberately does not travel. Anki's own scheduler is not
 * FSRS-6-with-Flashy's-parameters, and a half-translated review history
 * that silently reschedules a year of work is worse than a clean start —
 * so what crosses over is the thing that took the effort to write: the
 * fields, the tags and the deck each note lives in.
 *
 * Anki 2.1.54 and newer read directives from the top of a text file
 * (https://docs.ankiweb.net/importing/text-files.html), which is what
 * removes every manual mapping step from the import dialog. Writing them
 * means the user opens the file and presses Import.
 *
 * One file per note type, because the column layout *is* the note type's
 * field list: a file mixing a two-field Basic with a two-field Cloze would
 * have to be mapped by hand again, which is the thing being avoided.
 */

import { DECK_SEPARATOR } from '../domain/decks.js';
import type { Db } from '../storage/index.js';
import type { NoteType } from '../domain/types.js';
import { toCsv } from './csv.js';

/** Anki's default, and the one that needs the least quoting in HTML. */
export const ANKI_SEPARATOR = '\t';

/** The oldest Anki that understands the directives written here. */
export const ANKI_MINIMUM_VERSION = '2.1.54';

/** The three columns that follow the note type's own fields. */
export const ANKI_EXTRA_COLUMNS = ['Tags', 'Deck', 'GUID'] as const;

export interface AnkiExportGroup {
  noteTypeId: string;
  noteTypeName: string;
  /** How many notes this note type would contribute. */
  notes: number;
  /** Decks those notes live in, sorted, for the summary. */
  decks: string[];
  /** Notes whose fields point at an image or a sound. */
  withMedia: number;
}

export interface AnkiExportFile extends AnkiExportGroup {
  filename: string;
  mime: string;
  text: string;
}

/**
 * A field value that refers to a file rather than only carrying text.
 *
 * Media lives in this collection's own store and is addressed by an id
 * Anki knows nothing about, so an `<img>` arrives in Anki as a broken
 * image. That is worth saying out loud before the export rather than
 * discovering it card by card afterwards.
 */
export function referencesMedia(value: string): boolean {
  return /<img\b|<audio\b|<video\b|\[sound:/i.test(value);
}

/**
 * A directive value cannot contain the separator or a line break.
 *
 * Note type and deck names are user-authored, and a tab inside one would
 * silently shift every column of the file that follows it.
 */
function directiveSafe(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * The header Anki reads before the first note.
 *
 * Column numbers are 1-based and the fields come first, in the note type's
 * own order, so the positional mapping Anki falls back on is already the
 * right one even if a directive is ignored.
 */
export function ankiHeader(noteTypeName: string, fieldNames: readonly string[]): string {
  const tagsColumn = fieldNames.length + 1;
  const deckColumn = fieldNames.length + 2;
  const guidColumn = fieldNames.length + 3;
  // `#separator:` has to come first: Anki splits `#columns:` on whatever
  // separator has been set by the time it reads that line.
  return [
    '#separator:tab',
    // Field values are stored as HTML here exactly as they are in Anki, so
    // saying so keeps `<b>` bold instead of printing it.
    '#html:true',
    `#notetype:${directiveSafe(noteTypeName)}`,
    `#tags column:${tagsColumn}`,
    `#deck column:${deckColumn}`,
    // A stable id per note means a second export updates the notes from the
    // first instead of duplicating them.
    `#guid column:${guidColumn}`,
    `#columns:${[...fieldNames.map(directiveSafe), ...ANKI_EXTRA_COLUMNS].join(ANKI_SEPARATOR)}`,
  ].join('\n');
}

interface Gathered {
  noteType: NoteType;
  notes: Array<{ id: string; fields: Record<string, string>; tags: string[]; created: number }>;
  deckByNote: Map<string, string>;
}

async function gather(db: Db): Promise<Map<string, Gathered>> {
  const noteTypes = await db.noteTypes.getAll();
  const decks = new Map((await db.decks.getAll()).map((d) => [d.id, d.name]));
  const cards = await db.cards.getAll();

  // A note's deck is the deck of its first card. A reversed note whose two
  // cards were moved apart cannot be represented by one column, and the
  // first card is the one the note was made in.
  const deckByNote = new Map<string, string>();
  for (const card of cards) {
    const existing = deckByNote.get(card.noteId);
    if (existing === undefined) deckByNote.set(card.noteId, decks.get(card.deckId) ?? '');
  }

  const groups = new Map<string, Gathered>();
  for (const noteType of noteTypes) {
    groups.set(noteType.id, { noteType, notes: [], deckByNote });
  }

  const notes = await db.notes.getAll();
  notes.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  for (const note of notes) {
    groups.get(note.noteTypeId)?.notes.push(note);
  }
  return groups;
}

function summarise(group: Gathered): AnkiExportGroup {
  const decks = new Set<string>();
  let withMedia = 0;
  for (const note of group.notes) {
    const deck = group.deckByNote.get(note.id);
    if (deck) decks.add(deck);
    if (Object.values(note.fields).some(referencesMedia)) withMedia += 1;
  }
  return {
    noteTypeId: group.noteType.id,
    noteTypeName: group.noteType.name,
    notes: group.notes.length,
    decks: [...decks].sort((a, b) => a.localeCompare(b)),
    withMedia,
  };
}

/** What an export would contain, per note type, without building the files. */
export async function ankiExportPlan(db: Db): Promise<AnkiExportGroup[]> {
  const groups = [...(await gather(db)).values()]
    .filter((group) => group.notes.length > 0)
    .map(summarise);
  // Busiest first: with several note types, the one meant is almost always
  // the one with the most notes in it.
  groups.sort((a, b) => b.notes - a.notes || a.noteTypeName.localeCompare(b.noteTypeName));
  return groups;
}

/**
 * The file for one note type.
 *
 * `.txt` rather than `.csv`: Anki's file picker offers all three, and on
 * iOS a plain-text file is the one the share sheet will hand to every
 * target — Files, Mail and AirDrop alike — without renaming it.
 */
export async function exportForAnki(db: Db, noteTypeId: string): Promise<AnkiExportFile> {
  const groups = await gather(db);
  const group = groups.get(noteTypeId);
  if (!group) throw new Error('That note type is no longer in this collection.');

  const fieldNames = group.noteType.fields.map((f) => f.name);
  const rows = group.notes.map((note) => [
    ...fieldNames.map((name) => note.fields[name] ?? ''),
    note.tags.join(' '),
    group.deckByNote.get(note.id) ?? '',
    note.id,
  ]);

  const summary = summarise(group);
  const body = toCsv(rows, ANKI_SEPARATOR);
  return {
    ...summary,
    filename: ankiFilename(group.noteType.name),
    mime: 'text/plain',
    // A trailing newline so the last note is not a partial line.
    text: `${ankiHeader(group.noteType.name, fieldNames)}\n${body}\n`,
  };
}

/** A filename that survives every filesystem the file might land on. */
export function ankiFilename(noteTypeName: string, date = new Date()): string {
  const slug = noteTypeName
    .split(DECK_SEPARATOR)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = date.toISOString().slice(0, 10);
  return `flashy-${slug || 'notes'}-${stamp}.txt`;
}
