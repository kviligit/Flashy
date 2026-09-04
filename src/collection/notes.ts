/**
 * Note operations that keep cards in sync.
 *
 * A note's cards are derived from its fields and its note type, so every
 * write here re-derives them: new deletions grow cards, removed ones prune
 * cards, and untouched ones keep their scheduling state. This is the only
 * place that creates or destroys cards.
 */

import { generateOrds } from '../domain/cards.js';
import { makeCard } from '../domain/cards.js';
import { newId } from '../domain/id.js';
import type { Card, Note, NoteType } from '../domain/types.js';
import type { Db } from '../storage/index.js';

export interface AddNoteInput {
  noteTypeId: string;
  deckId: string;
  fields: Record<string, string>;
  tags?: string[];
  now?: number;
}

export interface NoteSyncResult {
  note: Note;
  cards: Card[];
  added: number;
  removed: number;
}

/** The next `position` value, so new cards queue behind existing ones. */
export async function nextPosition(db: Db): Promise<number> {
  const [last] = await db.cards.byRange('position', {}, { descending: true, limit: 1 });
  return last ? last.position + 1 : 0;
}

/** Field values with every field the note type declares, missing ones blank. */
export function completeFields(
  noteType: NoteType,
  fields: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of noteType.fields) out[field.name] = fields[field.name] ?? '';
  return out;
}

/** Tags, trimmed, deduplicated and sorted. */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Swap one tag for another in the text the editor holds.
 *
 * Used when the deck changes while a new note is being written: the tag
 * for the old deck goes, the tag for the new one arrives, and everything
 * the user typed themselves stays where they put it.
 *
 * Adding is skipped when the tag is already there, so switching away and
 * back does not leave a duplicate, and removing is by exact token so a
 * deck tag of "Maths" never eats a hand-typed "Maths::Exam".
 */
export function replaceTag(raw: string, remove: string, add: string): string {
  const tokens = raw.split(/[\s,]+/).filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token !== remove);
  if (add && !kept.includes(add)) kept.push(add);
  return kept.join(' ');
}

/** Split a space-separated tag string, as typed in the editor. */
export function parseTags(raw: string): string[] {
  return normaliseTags(raw.split(/[\s,]+/));
}

/**
 * Create a note and its cards.
 *
 * Throws when the fields would generate no cards at all, which is the one
 * case the editor must not let through: a note with no cards is invisible
 * and unstudiable.
 */
export async function addNote(db: Db, input: AddNoteInput): Promise<NoteSyncResult> {
  const noteType = await db.noteTypes.get(input.noteTypeId);
  if (!noteType) throw new Error(`no such note type: ${input.noteTypeId}`);

  const now = input.now ?? Date.now();
  const fields = completeFields(noteType, input.fields);
  const ords = generateOrds(noteType, fields);
  if (ords.length === 0) throw new Error('These fields would not produce any cards.');

  const note: Note = {
    id: newId(),
    noteTypeId: noteType.id,
    fields,
    tags: normaliseTags(input.tags ?? []),
    created: now,
    modified: now,
  };

  let position = await nextPosition(db);
  const cards = ords.map((ord) =>
    makeCard({ noteId: note.id, deckId: input.deckId, ord, position: position++, now }),
  );

  await db.notes.put(note);
  await db.cards.putMany(cards);

  return { note, cards, added: cards.length, removed: 0 };
}

export interface UpdateNoteInput {
  fields?: Record<string, string>;
  tags?: string[];
  /** Deck for any cards this edit newly creates. */
  deckId?: string;
  now?: number;
}

/**
 * Update a note and reconcile its cards.
 *
 * Cards whose ordinal still exists are left completely alone — their
 * scheduling state is the user's study history and must survive an edit.
 */
export async function updateNote(
  db: Db,
  noteId: string,
  input: UpdateNoteInput,
): Promise<NoteSyncResult> {
  const note = await db.notes.get(noteId);
  if (!note) throw new Error(`no such note: ${noteId}`);
  const noteType = await db.noteTypes.get(note.noteTypeId);
  if (!noteType) throw new Error(`no such note type: ${note.noteTypeId}`);

  const now = input.now ?? Date.now();
  const fields = input.fields ? completeFields(noteType, input.fields) : note.fields;
  const ords = generateOrds(noteType, fields);
  if (ords.length === 0) throw new Error('These fields would not produce any cards.');

  const existing = await db.cards.byIndex('noteId', noteId);
  const existingOrds = new Set(existing.map((card) => card.ord));
  const wanted = new Set(ords);

  const toAdd = ords.filter((ord) => !existingOrds.has(ord));
  const toRemove = existing.filter((card) => !wanted.has(card.ord));

  const updated: Note = {
    ...note,
    fields,
    tags: input.tags ? normaliseTags(input.tags) : note.tags,
    modified: now,
  };

  const deckId = input.deckId ?? existing[0]?.deckId;
  let position = await nextPosition(db);
  const created = deckId
    ? toAdd.map((ord) => makeCard({ noteId, deckId, ord, position: position++, now }))
    : [];

  await db.notes.put(updated);
  if (created.length > 0) await db.cards.putMany(created);
  if (toRemove.length > 0) await db.cards.deleteMany(toRemove.map((card) => card.id));

  const cards = await db.cards.byIndex('noteId', noteId);
  return { note: updated, cards, added: created.length, removed: toRemove.length };
}

/** Delete notes together with all of their cards and review logs. */
export async function deleteNotes(db: Db, noteIds: readonly string[]): Promise<number> {
  let removedCards = 0;
  for (const noteId of noteIds) {
    const cards = await db.cards.byIndex('noteId', noteId);
    for (const card of cards) {
      const logs = await db.reviewLogs.byIndex('cardId', card.id);
      await db.reviewLogs.deleteMany(logs.map((log) => log.id));
    }
    await db.cards.deleteMany(cards.map((card) => card.id));
    removedCards += cards.length;
  }
  await db.notes.deleteMany(noteIds);
  return removedCards;
}

/** Move cards to another deck. */
export async function setCardDeck(
  db: Db,
  cardIds: readonly string[],
  deckId: string,
  now = Date.now(),
): Promise<void> {
  const cards = await db.cards.getMany(cardIds);
  await db.cards.putMany(cards.map((card) => ({ ...card, deckId, modified: now })));
}

/** Add or remove tags across many notes at once. */
export async function retagNotes(
  db: Db,
  noteIds: readonly string[],
  add: readonly string[],
  remove: readonly string[],
  now = Date.now(),
): Promise<void> {
  const removing = new Set(remove);
  const notes = await db.notes.getMany(noteIds);
  await db.notes.putMany(
    notes.map((note) => ({
      ...note,
      tags: normaliseTags([...note.tags, ...add].filter((tag) => !removing.has(tag))),
      modified: now,
    })),
  );
}
