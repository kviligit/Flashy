/**
 * The entity model, borrowed from Anki.
 *
 *   NoteType  — a shape: which fields exist, and which templates turn those
 *               fields into cards.
 *   Note      — one fact, holding the field values.
 *   Card      — one question generated from a note by a template. Cards are
 *               what get scheduled; notes never are.
 *   Deck      — a named bucket of cards, with a config attached.
 *   ReviewLog — an append-only record of every answer ever given.
 *
 * The indirection is what buys reverse cards and cloze deletions: editing
 * one note updates every card made from it.
 */

import type { Memory, State } from '../fsrs/index.js';

/** Every stored entity is addressed by a string id. */
export interface Entity {
  id: string;
}

// --- Note types ----------------------------------------------------------

export interface FieldDef {
  name: string;
  /** Keep this field's value when adding the next note (Anki's "sticky"). */
  sticky?: boolean;
  /** Render right-to-left. */
  rtl?: boolean;
}

export interface CardTemplate {
  name: string;
  /** Mustache-ish question side, e.g. `{{Front}}`. */
  question: string;
  /** Answer side. `{{FrontSide}}` expands to the rendered question. */
  answer: string;
}

export const NoteTypeKind = {
  Standard: 'standard',
  Cloze: 'cloze',
} as const;
export type NoteTypeKind = (typeof NoteTypeKind)[keyof typeof NoteTypeKind];

export interface NoteType extends Entity {
  name: string;
  kind: NoteTypeKind;
  fields: FieldDef[];
  /** A cloze note type has exactly one template; ordinals come from the text. */
  templates: CardTemplate[];
  /** Extra CSS scoped to this note type's cards. */
  css: string;
  /** Index of the field shown in browsers and used for duplicate checks. */
  sortField: number;
  created: number;
  modified: number;
}

// --- Notes ---------------------------------------------------------------

export interface Note extends Entity {
  noteTypeId: string;
  /**
   * Field values keyed by field *name*, not ordinal. Names survive
   * reordering, which ordinals do not, and make exports readable.
   */
  fields: Record<string, string>;
  tags: string[];
  created: number;
  modified: number;
}

// --- Cards ---------------------------------------------------------------

export const CardFlag = {
  None: 0,
  Red: 1,
  Orange: 2,
  Green: 3,
  Blue: 4,
} as const;
export type CardFlag = (typeof CardFlag)[keyof typeof CardFlag];

export interface Card extends Entity {
  noteId: string;
  deckId: string;
  /**
   * Which card of the note this is. For a standard note type it is the
   * template index; for a cloze note type it is the cloze number (1-based).
   */
  ord: number;

  // --- scheduling state (mirrors fsrs SchedulingCard) ---
  state: State;
  memory: Memory | null;
  /** ISO timestamp. */
  due: string;
  /** ISO timestamp, or null if never answered. */
  lastReview: string | null;
  step: number;
  reps: number;
  lapses: number;

  /** Ordering position for new cards within a deck. */
  position: number;
  /** Suspended cards never appear in any queue until unsuspended. */
  suspended: boolean;
  /** ISO timestamp until which the card is buried, or null. */
  buriedUntil: string | null;
  flag: CardFlag;
  created: number;
  modified: number;
}

// --- Decks ---------------------------------------------------------------

export interface Deck extends Entity {
  /** Full path; `::` separates levels, exactly as in Anki. */
  name: string;
  configId: string;
  description: string;
  collapsed: boolean;
  created: number;
  modified: number;
}

export const NewCardOrder = {
  /** Show new cards in the order they were added. */
  Sequential: 'sequential',
  /** Shuffle new cards within the day's batch. */
  Random: 'random',
} as const;
export type NewCardOrder = (typeof NewCardOrder)[keyof typeof NewCardOrder];

export const ReviewOrder = {
  /** Most-overdue first. */
  DueFirst: 'due',
  Random: 'random',
  /** Hardest cards first. */
  DifficultyDescending: 'difficulty',
} as const;
export type ReviewOrder = (typeof ReviewOrder)[keyof typeof ReviewOrder];

export const LeechAction = {
  Suspend: 'suspend',
  TagOnly: 'tag',
} as const;
export type LeechAction = (typeof LeechAction)[keyof typeof LeechAction];

/**
 * Per-deck settings. Split from the deck itself so several decks can share
 * one preset, as in Anki.
 */
export interface DeckConfig extends Entity {
  name: string;

  // Daily limits
  newPerDay: number;
  reviewsPerDay: number;

  // FSRS
  /** The 21 FSRS-6 weights. */
  params: number[];
  desiredRetention: number;
  learningSteps: number[];
  relearningSteps: number[];
  maximumInterval: number;
  enableFuzz: boolean;

  // Queue behaviour
  newCardOrder: NewCardOrder;
  reviewOrder: ReviewOrder;
  /** Hide siblings of a reviewed card until tomorrow. */
  burySiblings: boolean;

  // Leeches
  leechThreshold: number;
  leechAction: LeechAction;

  created: number;
  modified: number;
}

// --- Review log ----------------------------------------------------------

export interface ReviewLog extends Entity {
  cardId: string;
  /** Epoch ms. Also the natural sort key. */
  reviewedAt: number;
  rating: number;
  /** Card state *before* this answer. */
  stateBefore: State;
  /** Card state *after* this answer. */
  stateAfter: State;
  /** Interval in days that this answer produced. */
  intervalDays: number;
  /** Interval the card was on before this answer, in days. */
  lastIntervalDays: number;
  /** Whole days since the previous review. */
  elapsedDays: number;
  stability: number;
  difficulty: number;
  /** Milliseconds the reviewer spent on the card. */
  timeTakenMs: number;
  /**
   * The complete pre-answer card, stored so undo is an exact restore rather
   * than a recomputation. Cheap: one small object per review.
   */
  snapshot: Card;
  /**
   * Sibling cards this answer buried, so undo can unbury exactly those and
   * leave siblings buried by some earlier answer alone.
   */
  siblingsBuried: string[];
}

// --- Collection metadata -------------------------------------------------

export interface Meta extends Entity {
  /** Always `"meta"`. */
  id: string;
  schemaVersion: number;
  /** Hour (0-23, local time) at which a new study day begins. Anki uses 4. */
  dayCutoffHour: number;
  /**
   * Stable identifier for this installation.
   *
   * Nothing uses it yet. It exists because any future sync has to be able
   * to say "this change came from that device", and minting it now means
   * every record written from here on can be attributed later.
   */
  deviceId: string;
  created: number;
  modified: number;
}

/**
 * A record of something having been deleted — a tombstone.
 *
 * Deleting a row outright is fine for a single device and impossible to
 * synchronise: a peer cannot tell "you deleted this" apart from "you have
 * never seen this", so deletions silently resurrect. Tombstones are the one
 * piece of sync groundwork that genuinely cannot be added later, because
 * deletions that happened before they existed leave nothing behind to
 * recover.
 *
 * They are written automatically by the storage layer. Nothing else needs
 * to know they exist.
 */
export interface Deletion extends Entity {
  /** `"<store>:<recordId>"`, so a record can only be tombstoned once. */
  id: string;
  store: string;
  recordId: string;
  deletedAt: number;
}

/**
 * A stored image or sound.
 *
 * The id is a content hash, so adding the same file twice stores it once —
 * which matters when the natural way to build a deck is to paste one
 * diagram onto twenty cards.
 *
 * Bytes are held as an ArrayBuffer rather than a Blob: both IndexedDB and
 * structuredClone handle it everywhere, including in the in-memory backend
 * under Node, which a Blob does not reliably survive.
 */
export interface MediaFile extends Entity {
  /** Content hash. */
  id: string;
  /** The name it was added under, preserved for exports. */
  filename: string;
  mime: string;
  size: number;
  data: ArrayBuffer;
  created: number;
  modified: number;
}

export const SCHEMA_VERSION = 3;
