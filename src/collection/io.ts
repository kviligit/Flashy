/**
 * Backup, restore and CSV exchange.
 *
 * The JSON format is the whole collection verbatim — every store, as
 * stored — so a restore is exact rather than approximate. It carries a
 * format version so a future schema change can migrate old backups.
 */

import { generateOrds, makeCard } from '../domain/cards.js';
import { fromBase64, toBase64 } from '../domain/media.js';
import { makeDeck } from '../domain/defaults.js';
import { newId } from '../domain/id.js';
import { stripHtml } from '../domain/render.js';
import { SCHEMA_VERSION } from '../domain/types.js';
import type {
  Card,
  Deck,
  DeckConfig,
  MediaFile,
  Meta,
  Note,
  NoteType,
  ReviewLog,
} from '../domain/types.js';
import type { Db } from '../storage/index.js';
import { completeFields, nextPosition, normaliseTags } from './notes.js';
import { parseCsv, sniffDelimiter, toCsv } from './csv.js';

export const EXPORT_FORMAT = 'flashy-collection';
export const EXPORT_VERSION = 2;

/**
 * A media file inside a backup.
 *
 * JSON cannot carry an ArrayBuffer, so the bytes travel base64-encoded.
 * That inflates them by about a third, which is the price of a backup that
 * is a single self-contained file rather than a file plus a folder that can
 * be separated from it.
 */
export interface MediaFileExport {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** base64-encoded bytes. */
  data: string;
  created: number;
  modified: number;
}

export interface CollectionExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  schemaVersion: number;
  exportedAt: string;
  decks: Deck[];
  deckConfigs: DeckConfig[];
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  reviewLogs: ReviewLog[];
  meta: Meta[];
  /** Added in export format 2; absent in older backups. */
  media: MediaFileExport[];
}

/** Everything, exactly as stored. */
export async function exportCollection(db: Db): Promise<CollectionExport> {
  const [decks, deckConfigs, noteTypes, notes, cards, reviewLogs, meta, media] = await Promise.all([
    db.decks.getAll(),
    db.deckConfigs.getAll(),
    db.noteTypes.getAll(),
    db.notes.getAll(),
    db.cards.getAll(),
    db.reviewLogs.getAll(),
    db.meta.getAll(),
    db.media.getAll(),
  ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    decks,
    deckConfigs,
    noteTypes,
    notes,
    cards,
    reviewLogs,
    meta,
    media: media.map(encodeMedia),
  };
}

function encodeMedia(file: MediaFile): MediaFileExport {
  return {
    id: file.id,
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    data: toBase64(file.data),
    created: file.created,
    modified: file.modified,
  };
}

function decodeMedia(file: MediaFileExport): MediaFile {
  return {
    id: file.id,
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    data: fromBase64(file.data),
    created: file.created,
    modified: file.modified,
  };
}

export interface ImportSummary {
  decks: number;
  deckConfigs: number;
  noteTypes: number;
  notes: number;
  cards: number;
  reviewLogs: number;
  media: number;
  /** Records skipped because an id already existed (merge mode only). */
  skipped: number;
}

export type ImportMode = 'replace' | 'merge';

export interface ImportProgress {
  /** Which store is being written. */
  store: string;
  /** Human-readable name for that store. */
  label: string;
  /** How many records this step writes. */
  records: number;
  /** Steps finished before this one. */
  step: number;
  /** Total steps. */
  steps: number;
}

/**
 * Progress is reported once per store, not once per chunk.
 *
 * Each store is written in a single IndexedDB transaction, so reporting at
 * that granularity costs nothing. Splitting the work finer to get a
 * smoother bar measured about 50% slower overall — 17 seconds became 26 —
 * whatever the chunk size, because the cost is in committing transactions
 * rather than in the number of chunks. A coarse honest bar beats a smooth
 * one that makes the wait half again as long.
 */
export interface ImportOptions {
  onProgress?: (progress: ImportProgress) => void;
}

const STORE_LABELS: Record<string, string> = {
  deckConfigs: 'deck presets',
  decks: 'decks',
  noteTypes: 'note types',
  notes: 'notes',
  cards: 'cards',
  reviewLogs: 'review history',
  media: 'images and sounds',
};

/**
 * Restore a backup.
 *
 * `replace` wipes the collection first — the faithful restore. `merge`
 * keeps what is there and adds only records whose ids are new, which is
 * how two collections are combined without clobbering either.
 */
export async function importCollection(
  db: Db,
  data: unknown,
  mode: ImportMode = 'replace',
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const parsed = validateExport(data);

  if (mode === 'replace') await db.clear();

  const steps = Object.keys(STORE_LABELS).length;
  let step = 0;
  const report = (store: string, records: number): void => {
    options.onProgress?.({
      store,
      label: STORE_LABELS[store] ?? store,
      records,
      step,
      steps,
    });
    step += 1;
  };

  const summary: ImportSummary = {
    decks: 0,
    deckConfigs: 0,
    noteTypes: 0,
    notes: 0,
    cards: 0,
    reviewLogs: 0,
    media: 0,
    skipped: 0,
  };

  const put = async <T extends { id: string }>(
    store: { getAll(): Promise<T[]>; putMany(items: readonly T[]): Promise<void> },
    items: T[],
    key: keyof ImportSummary,
  ): Promise<void> => {
    let incoming = items;
    if (mode === 'merge') {
      const existing = new Set((await store.getAll()).map((item) => item.id));
      incoming = items.filter((item) => !existing.has(item.id));
      summary.skipped += items.length - incoming.length;
    }
    report(String(key), incoming.length);
    // Yield so the progress just reported actually paints before the
    // transaction begins; without this the bar only moves once it is over.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.putMany(incoming);
    summary[key] = incoming.length;
  };

  // Order matters on merge: the things cards and notes point at first.
  await put(db.deckConfigs, parsed.deckConfigs, 'deckConfigs');
  await put(db.decks, parsed.decks, 'decks');
  await put(db.noteTypes, parsed.noteTypes, 'noteTypes');
  await put(db.notes, parsed.notes, 'notes');
  await put(db.cards, parsed.cards, 'cards');
  await put(db.reviewLogs, parsed.reviewLogs, 'reviewLogs');
  // Media before nothing in particular — ids are content hashes, so a
  // merge can never produce a conflicting file under the same id.
  await put(db.media, parsed.media.map(decodeMedia), 'media');

  // Meta is collection-wide, so a merge keeps the collection's own.
  if (mode === 'replace') await db.meta.putMany(parsed.meta);

  return summary;
}

/** Check a parsed backup's shape, with messages a user can act on. */
export function validateExport(data: unknown): CollectionExport {
  if (typeof data !== 'object' || data === null) {
    throw new Error('That file is not a Flashy backup.');
  }
  const record = data as Record<string, unknown>;

  if (record['format'] !== EXPORT_FORMAT) {
    throw new Error('That file is not a Flashy backup (missing format marker).');
  }
  if (typeof record['version'] !== 'number' || record['version'] > EXPORT_VERSION) {
    throw new Error(
      `That backup was made by a newer version of Flashy (format ${String(record['version'])}).`,
    );
  }

  const arrayField = <T>(name: keyof CollectionExport): T[] => {
    const value = record[name as string];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`Backup field "${String(name)}" is not a list.`);
    return value as T[];
  };

  const parsed: CollectionExport = {
    format: EXPORT_FORMAT,
    version: record['version'],
    schemaVersion: typeof record['schemaVersion'] === 'number' ? record['schemaVersion'] : 1,
    exportedAt: typeof record['exportedAt'] === 'string' ? record['exportedAt'] : '',
    decks: arrayField<Deck>('decks'),
    deckConfigs: arrayField<DeckConfig>('deckConfigs'),
    noteTypes: arrayField<NoteType>('noteTypes'),
    notes: arrayField<Note>('notes'),
    cards: arrayField<Card>('cards'),
    reviewLogs: arrayField<ReviewLog>('reviewLogs'),
    meta: arrayField<Meta>('meta'),
    media: arrayField<MediaFileExport>('media'),
  };

  for (const [name, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'object' || item === null || typeof (item as Card).id !== 'string') {
        throw new Error(`Backup contains a malformed record in "${name}".`);
      }
    }
  }

  if (parsed.notes.length > 0 && parsed.noteTypes.length === 0) {
    throw new Error('Backup contains notes but no note types.');
  }

  for (const file of parsed.media) {
    if (typeof file.data !== 'string') {
      throw new Error(`Backup media file "${file.filename ?? file.id}" has no content.`);
    }
  }

  return parsed;
}

// --- CSV -----------------------------------------------------------------

export interface CsvExportOptions {
  /** Restrict to one note type; otherwise every note type is exported. */
  noteTypeId?: string;
  /** Include a header row naming the columns. */
  header?: boolean;
  delimiter?: string;
  /** Strip HTML from field values. */
  plainText?: boolean;
}

/**
 * Export notes as CSV: one row per note, one column per field, plus tags
 * and the deck of the note's first card.
 */
export async function exportCsv(db: Db, options: CsvExportOptions = {}): Promise<string> {
  const delimiter = options.delimiter ?? ',';
  const noteTypes = await db.noteTypes.getAll();
  const typeById = new Map(noteTypes.map((nt) => [nt.id, nt]));
  const decks = new Map((await db.decks.getAll()).map((d) => [d.id, d]));
  const cards = await db.cards.getAll();
  const deckByNote = new Map<string, string>();
  for (const card of cards) {
    if (!deckByNote.has(card.noteId)) {
      deckByNote.set(card.noteId, decks.get(card.deckId)?.name ?? '');
    }
  }

  let notes = await db.notes.getAll();
  if (options.noteTypeId) notes = notes.filter((n) => n.noteTypeId === options.noteTypeId);
  notes.sort((a, b) => a.created - b.created);

  // With a single note type the columns are its fields; with several, the
  // union, so no value is silently dropped.
  const relevant = options.noteTypeId
    ? [typeById.get(options.noteTypeId)].filter((nt): nt is NoteType => Boolean(nt))
    : noteTypes;
  const fieldNames: string[] = [];
  for (const nt of relevant) {
    for (const f of nt.fields) if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
  }

  const rows: string[][] = [];
  if (options.header !== false) rows.push([...fieldNames, 'Tags', 'Deck', 'Note type']);

  for (const note of notes) {
    const noteType = typeById.get(note.noteTypeId);
    rows.push([
      ...fieldNames.map((name) => {
        const value = note.fields[name] ?? '';
        return options.plainText ? stripHtml(value) : value;
      }),
      note.tags.join(' '),
      deckByNote.get(note.id) ?? '',
      noteType?.name ?? '',
    ]);
  }

  return toCsv(rows, delimiter);
}

export interface CsvImportOptions {
  noteTypeId: string;
  deckId: string;
  /** Column index for each field name; -1 means "leave blank". */
  fieldColumns: Record<string, number>;
  /** Column holding space-separated tags, or -1. */
  tagsColumn?: number;
  /** Treat the first row as headers. */
  hasHeader?: boolean;
  delimiter?: string;
  /** Skip a row whose first mapped field matches an existing note. */
  skipDuplicates?: boolean;
  now?: number;
}

export interface CsvImportResult {
  notesAdded: number;
  cardsAdded: number;
  duplicatesSkipped: number;
  /** Rows that produced no cards, with the reason. */
  errors: Array<{ row: number; message: string }>;
}

/** Preview a CSV before importing it. */
export function previewCsv(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const chosen = delimiter ?? sniffDelimiter(text);
  return { rows: parseCsv(text, chosen), delimiter: chosen };
}

/** Import notes from CSV. Rows that cannot make a card are reported, not thrown. */
export async function importCsv(
  db: Db,
  text: string,
  options: CsvImportOptions,
): Promise<CsvImportResult> {
  const noteType = await db.noteTypes.get(options.noteTypeId);
  if (!noteType) throw new Error('Choose a note type to import into.');
  const deck = await db.decks.get(options.deckId);
  if (!deck) throw new Error('Choose a deck to import into.');

  const now = options.now ?? Date.now();
  const rows = parseCsv(text, options.delimiter ?? sniffDelimiter(text));
  const dataRows = options.hasHeader === false ? rows : rows.slice(1);

  const result: CsvImportResult = {
    notesAdded: 0,
    cardsAdded: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  // Duplicate detection uses the note type's sort field, matching Anki's
  // "first field" rule.
  const sortFieldName = noteType.fields[noteType.sortField]?.name ?? noteType.fields[0]?.name;
  const existingKeys = new Set<string>();
  if (options.skipDuplicates && sortFieldName) {
    for (const note of await db.notes.byIndex('noteTypeId', noteType.id)) {
      existingKeys.add(duplicateKey(note.fields[sortFieldName] ?? ''));
    }
  }

  const notes: Note[] = [];
  const cards: Card[] = [];
  let position = await nextPosition(db);

  for (const [index, row] of dataRows.entries()) {
    const rowNumber = index + (options.hasHeader === false ? 1 : 2);

    const fields: Record<string, string> = {};
    for (const [name, column] of Object.entries(options.fieldColumns)) {
      if (column < 0) continue;
      fields[name] = (row[column] ?? '').trim();
    }
    const complete = completeFields(noteType, fields);

    if (Object.values(complete).every((value) => value.trim() === '')) continue; // blank line

    if (options.skipDuplicates && sortFieldName) {
      const key = duplicateKey(complete[sortFieldName] ?? '');
      if (existingKeys.has(key)) {
        result.duplicatesSkipped += 1;
        continue;
      }
      existingKeys.add(key);
    }

    const ords = generateOrds(noteType, complete);
    if (ords.length === 0) {
      result.errors.push({ row: rowNumber, message: 'would not produce any cards' });
      continue;
    }

    const tagsCell = options.tagsColumn !== undefined && options.tagsColumn >= 0
      ? (row[options.tagsColumn] ?? '')
      : '';

    const note: Note = {
      id: newId(),
      noteTypeId: noteType.id,
      fields: complete,
      tags: normaliseTags(tagsCell.split(/[\s,]+/)),
      created: now,
      modified: now,
    };
    notes.push(note);
    for (const ord of ords) {
      cards.push(makeCard({ noteId: note.id, deckId: deck.id, ord, position: position++, now }));
    }
  }

  await db.notes.putMany(notes);
  await db.cards.putMany(cards);

  result.notesAdded = notes.length;
  result.cardsAdded = cards.length;
  return result;
}

function duplicateKey(value: string): string {
  return stripHtml(value).toLowerCase();
}

/** Create the deck named in a CSV, if it is not there already. */
export async function ensureDeck(db: Db, name: string, configId: string): Promise<Deck> {
  const existing = (await db.decks.getAll()).find((d) => d.name === name);
  if (existing) return existing;
  const deck = makeDeck(name, configId);
  await db.decks.put(deck);
  return deck;
}
