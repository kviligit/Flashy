/** Card construction. Template rendering and generation live in `render.ts`. */

import { newId } from './id.js';
import { CardFlag, NoteTypeKind, type Card, type NoteType } from './types.js';
import { State } from '../fsrs/index.js';
import { clozeOrdinals, isBlankQuestion, renderTemplate, stripHtml } from './render.js';

export interface NewCardInit {
  noteId: string;
  deckId: string;
  ord: number;
  position: number;
  now?: number;
}

export function makeCard(init: NewCardInit): Card {
  const now = init.now ?? Date.now();
  return {
    id: newId(),
    noteId: init.noteId,
    deckId: init.deckId,
    ord: init.ord,
    state: State.New,
    memory: null,
    due: new Date(now).toISOString(),
    lastReview: null,
    step: 0,
    reps: 0,
    lapses: 0,
    position: init.position,
    suspended: false,
    buriedUntil: null,
    flag: CardFlag.None,
    created: now,
    modified: now,
  };
}

/** True when a card has graduated and is on a long interval. */
export function isMature(card: Card, matureDays = 21): boolean {
  if (card.state !== State.Review || !card.lastReview) return false;
  const last = Date.parse(card.lastReview);
  const due = Date.parse(card.due);
  if (!Number.isFinite(last) || !Number.isFinite(due)) return false;
  return (due - last) / 86_400_000 >= matureDays;
}

// --- card generation -----------------------------------------------------

/**
 * Which cards a note should have.
 *
 * A standard note produces one card per template whose question side is not
 * blank — that is what stops "Basic (and reversed card)" from generating a
 * second card when the Back field is empty. A cloze note produces one card
 * per distinct cloze number found in its fields.
 */
export function generateOrds(noteType: NoteType, fields: Record<string, string>): number[] {
  if (noteType.kind === NoteTypeKind.Cloze) {
    const ordinals = new Set<number>();
    for (const value of Object.values(fields)) {
      for (const n of clozeOrdinals(value)) ordinals.add(n);
    }
    return [...ordinals].sort((a, b) => a - b);
  }

  const ords: number[] = [];
  for (const [index, template] of noteType.templates.entries()) {
    const question = renderTemplate(template.question, { fields, ord: index, side: 'question' });
    if (!isBlankQuestion(question)) ords.push(index);
  }
  return ords;
}

/** The question and answer HTML for one card of a note. */
export function renderCard(
  noteType: NoteType,
  fields: Record<string, string>,
  ord: number,
): { question: string; answer: string } {
  const templateIndex = noteType.kind === NoteTypeKind.Cloze ? 0 : ord;
  const template = noteType.templates[templateIndex] ?? noteType.templates[0];
  if (!template) return { question: '', answer: '' };

  const question = renderTemplate(template.question, { fields, ord, side: 'question' });
  const answer = renderTemplate(template.answer, {
    fields,
    ord,
    side: 'answer',
    frontSide: question,
  });
  return { question, answer };
}

/** A short one-line summary of a card, for lists and browsers. */
export function cardPreview(noteType: NoteType, fields: Record<string, string>, ord: number): string {
  return stripHtml(renderCard(noteType, fields, ord).question);
}
