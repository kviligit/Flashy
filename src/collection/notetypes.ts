/**
 * Note type surgery.
 *
 * Changing a note type reaches into every note and card made from it, so
 * each operation here is responsible for migrating that data. Field values
 * are keyed by name, which makes renames and reorders cheap; templates are
 * addressed by index, which makes removal the delicate one.
 */

import { generateOrds, makeCard } from '../domain/cards.js';
import type { CardTemplate, FieldDef, Note, NoteType } from '../domain/types.js';
import { NoteTypeKind } from '../domain/types.js';
import type { Db } from '../storage/index.js';
import { nextPosition } from './notes.js';

async function load(db: Db, noteTypeId: string): Promise<NoteType> {
  const noteType = await db.noteTypes.get(noteTypeId);
  if (!noteType) throw new Error(`no such note type: ${noteTypeId}`);
  return noteType;
}

async function notesOf(db: Db, noteTypeId: string): Promise<Note[]> {
  return db.notes.byIndex('noteTypeId', noteTypeId);
}

/** Update the parts of a note type that need no data migration. */
export async function updateNoteType(
  db: Db,
  noteTypeId: string,
  patch: Partial<Pick<NoteType, 'name' | 'css' | 'templates' | 'sortField'>>,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  const updated: NoteType = { ...noteType, ...patch, modified: now };

  if (updated.templates.length === 0) throw new Error('A note type needs at least one template.');
  if (updated.name.trim() === '') throw new Error('A note type needs a name.');
  updated.sortField = Math.min(Math.max(0, updated.sortField), updated.fields.length - 1);

  await db.noteTypes.put(updated);
  return updated;
}

export async function addField(
  db: Db,
  noteTypeId: string,
  name: string,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A field needs a name.');
  if (noteType.fields.some((f) => f.name === trimmed)) {
    throw new Error(`This note type already has a field called "${trimmed}".`);
  }

  const updated: NoteType = {
    ...noteType,
    fields: [...noteType.fields, { name: trimmed } as FieldDef],
    modified: now,
  };
  await db.noteTypes.put(updated);

  const notes = await notesOf(db, noteTypeId);
  await db.notes.putMany(
    notes.map((note) => ({ ...note, fields: { ...note.fields, [trimmed]: '' }, modified: now })),
  );

  return updated;
}

/** Rename a field, migrating every note's values and every template. */
export async function renameField(
  db: Db,
  noteTypeId: string,
  from: string,
  to: string,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  const trimmed = to.trim();
  if (!trimmed) throw new Error('A field needs a name.');
  if (from === trimmed) return noteType;
  if (!noteType.fields.some((f) => f.name === from)) throw new Error(`No field called "${from}".`);
  if (noteType.fields.some((f) => f.name === trimmed)) {
    throw new Error(`This note type already has a field called "${trimmed}".`);
  }

  const updated: NoteType = {
    ...noteType,
    fields: noteType.fields.map((f) => (f.name === from ? { ...f, name: trimmed } : f)),
    // Templates reference fields by name, so they have to follow.
    templates: noteType.templates.map((t) => ({
      ...t,
      question: rewriteReferences(t.question, from, trimmed),
      answer: rewriteReferences(t.answer, from, trimmed),
    })),
    modified: now,
  };
  await db.noteTypes.put(updated);

  const notes = await notesOf(db, noteTypeId);
  await db.notes.putMany(
    notes.map((note) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(note.fields)) {
        fields[key === from ? trimmed : key] = value;
      }
      return { ...note, fields, modified: now };
    }),
  );

  return updated;
}

/** Rewrite `{{Field}}`, `{{filter:Field}}` and `{{#Field}}…{{/Field}}`. */
export function rewriteReferences(template: string, from: string, to: string): string {
  return template.replace(/\{\{([#^/]?)(?:([a-z]+):)?\s*([^}]+?)\s*\}\}/g, (match, prefix: string, filter: string | undefined, name: string) => {
    if (name.trim() !== from) return match;
    const filterPart = filter ? `${filter}:` : '';
    return `{{${prefix}${filterPart}${to}}}`;
  });
}

/**
 * Remove a field, and with it every note's value for that field. Cards are
 * resynced afterwards, since a template may now render blank.
 */
export async function removeField(
  db: Db,
  noteTypeId: string,
  name: string,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  if (noteType.fields.length <= 1) throw new Error('A note type needs at least one field.');
  if (!noteType.fields.some((f) => f.name === name)) throw new Error(`No field called "${name}".`);

  const fields = noteType.fields.filter((f) => f.name !== name);
  const updated: NoteType = {
    ...noteType,
    fields,
    sortField: Math.min(noteType.sortField, fields.length - 1),
    modified: now,
  };
  await db.noteTypes.put(updated);

  const notes = await notesOf(db, noteTypeId);
  await db.notes.putMany(
    notes.map((note) => {
      const remaining = { ...note.fields };
      delete remaining[name];
      return { ...note, fields: remaining, modified: now };
    }),
  );

  await resyncCards(db, noteTypeId, now);
  return updated;
}

/** Reorder fields. Note values are name-keyed, so nothing else moves. */
export async function moveField(
  db: Db,
  noteTypeId: string,
  from: number,
  to: number,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  const fields = [...noteType.fields];
  if (from < 0 || from >= fields.length || to < 0 || to >= fields.length) return noteType;

  const [moved] = fields.splice(from, 1);
  if (!moved) return noteType;
  fields.splice(to, 0, moved);

  const sortFieldName = noteType.fields[noteType.sortField]?.name;
  const updated: NoteType = {
    ...noteType,
    fields,
    sortField: Math.max(0, fields.findIndex((f) => f.name === sortFieldName)),
    modified: now,
  };
  await db.noteTypes.put(updated);
  return updated;
}

export async function addTemplate(
  db: Db,
  noteTypeId: string,
  template: CardTemplate,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  if (noteType.kind === NoteTypeKind.Cloze) {
    throw new Error('A cloze note type has exactly one template; its cards come from the deletions.');
  }

  const updated: NoteType = {
    ...noteType,
    templates: [...noteType.templates, template],
    modified: now,
  };
  await db.noteTypes.put(updated);
  await resyncCards(db, noteTypeId, now);
  return updated;
}

/**
 * Remove a template.
 *
 * Cards are addressed by template index, so removing template `n` deletes
 * every card with that ordinal and shifts the higher ones down. Getting
 * this wrong would silently point cards at the wrong template.
 */
export async function removeTemplate(
  db: Db,
  noteTypeId: string,
  index: number,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  if (noteType.kind === NoteTypeKind.Cloze) {
    throw new Error('A cloze note type must keep its single template.');
  }
  if (noteType.templates.length <= 1) throw new Error('A note type needs at least one template.');
  if (index < 0 || index >= noteType.templates.length) throw new Error('No such template.');

  const updated: NoteType = {
    ...noteType,
    templates: noteType.templates.filter((_, i) => i !== index),
    modified: now,
  };
  await db.noteTypes.put(updated);

  const notes = await notesOf(db, noteTypeId);
  const noteIds = new Set(notes.map((note) => note.id));
  const cards = (await db.cards.getAll()).filter((card) => noteIds.has(card.noteId));

  const doomed = cards.filter((card) => card.ord === index);
  const shifted = cards
    .filter((card) => card.ord > index)
    .map((card) => ({ ...card, ord: card.ord - 1, modified: now }));

  await db.cards.deleteMany(doomed.map((card) => card.id));
  await db.cards.putMany(shifted);

  return updated;
}

export interface ResyncResult {
  added: number;
  removed: number;
}

/**
 * Bring every note's cards back in line with what its note type now
 * generates. Cards whose ordinal survives keep their scheduling state.
 */
export async function resyncCards(
  db: Db,
  noteTypeId: string,
  now = Date.now(),
): Promise<ResyncResult> {
  const noteType = await load(db, noteTypeId);
  const notes = await notesOf(db, noteTypeId);

  let position = await nextPosition(db);
  const toAdd = [];
  const toRemove: string[] = [];

  for (const note of notes) {
    const wanted = new Set(generateOrds(noteType, note.fields));
    const existing = await db.cards.byIndex('noteId', note.id);
    const have = new Set(existing.map((card) => card.ord));

    // A note that would generate nothing keeps its cards: silently
    // deleting someone's study history on a template edit is far worse
    // than leaving a card that renders blank.
    if (wanted.size === 0) continue;

    const deckId = existing[0]?.deckId;
    if (deckId) {
      for (const ord of wanted) {
        if (!have.has(ord)) {
          toAdd.push(makeCard({ noteId: note.id, deckId, ord, position: position++, now }));
        }
      }
    }
    for (const card of existing) {
      if (!wanted.has(card.ord)) toRemove.push(card.id);
    }
  }

  if (toAdd.length > 0) await db.cards.putMany(toAdd);
  if (toRemove.length > 0) await db.cards.deleteMany(toRemove);

  return { added: toAdd.length, removed: toRemove.length };
}

/** How many notes use a note type — what makes deletion safe or not. */
export async function noteTypeUsage(db: Db, noteTypeId: string): Promise<number> {
  return (await db.notes.byIndex('noteTypeId', noteTypeId)).length;
}

export async function deleteNoteType(db: Db, noteTypeId: string): Promise<void> {
  const used = await noteTypeUsage(db, noteTypeId);
  if (used > 0) {
    throw new Error(`${used} note(s) still use this note type. Delete or convert them first.`);
  }
  const remaining = await db.noteTypes.count();
  if (remaining <= 1) throw new Error('The collection needs at least one note type.');
  await db.noteTypes.delete(noteTypeId);
}

/** Duplicate a note type, so it can be modified without touching the original. */
export async function cloneNoteType(
  db: Db,
  noteTypeId: string,
  name: string,
  now = Date.now(),
): Promise<NoteType> {
  const noteType = await load(db, noteTypeId);
  const { newId } = await import('../domain/id.js');
  const clone: NoteType = {
    ...noteType,
    id: newId(),
    name: name.trim() || `${noteType.name} copy`,
    fields: noteType.fields.map((f) => ({ ...f })),
    templates: noteType.templates.map((t) => ({ ...t })),
    created: now,
    modified: now,
  };
  await db.noteTypes.put(clone);
  return clone;
}
