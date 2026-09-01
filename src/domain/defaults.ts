/**
 * The collection a brand-new user starts with: one deck, one config preset,
 * and the three note types that cover almost everything.
 */

import { DEFAULT_CONFIG, DEFAULT_PARAMS } from '../fsrs/index.js';
import { newId } from './id.js';
import {
  LeechAction,
  NewCardOrder,
  NoteTypeKind,
  ReviewOrder,
  SCHEMA_VERSION,
  type Deck,
  type DeckConfig,
  type Meta,
  type NoteType,
} from './types.js';

/** Shared by every card unless a note type overrides it. */
export const BASE_CARD_CSS = `.card {
  font-size: 1.35rem;
  line-height: 1.6;
  text-align: center;
  color: var(--text);
}
.cloze { color: var(--accent); font-weight: 600; }
.hint { color: var(--text-dim); font-size: 0.9em; }`;

export function makeDeckConfig(name = 'Default', now = Date.now()): DeckConfig {
  return {
    id: newId(),
    name,
    newPerDay: 20,
    reviewsPerDay: 200,
    params: [...DEFAULT_PARAMS],
    desiredRetention: DEFAULT_CONFIG.desiredRetention,
    learningSteps: [...DEFAULT_CONFIG.learningSteps],
    relearningSteps: [...DEFAULT_CONFIG.relearningSteps],
    maximumInterval: DEFAULT_CONFIG.maximumInterval,
    enableFuzz: DEFAULT_CONFIG.enableFuzz,
    newCardOrder: NewCardOrder.Sequential,
    reviewOrder: ReviewOrder.DueFirst,
    burySiblings: true,
    leechThreshold: 8,
    leechAction: LeechAction.Suspend,
    created: now,
    modified: now,
  };
}

export function makeDeck(name: string, configId: string, now = Date.now()): Deck {
  return {
    id: newId(),
    name,
    configId,
    description: '',
    collapsed: false,
    created: now,
    modified: now,
  };
}

export function makeMeta(now = Date.now()): Meta {
  return {
    id: 'meta',
    schemaVersion: SCHEMA_VERSION,
    dayCutoffHour: 4,
    deviceId: newId(),
    created: now,
    modified: now,
  };
}

export function basicNoteType(now = Date.now()): NoteType {
  return {
    id: newId(),
    name: 'Basic',
    kind: NoteTypeKind.Standard,
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [
      {
        name: 'Card 1',
        question: '{{Front}}',
        answer: '{{FrontSide}}<hr>{{Back}}',
      },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
    created: now,
    modified: now,
  };
}

export function basicReversedNoteType(now = Date.now()): NoteType {
  return {
    id: newId(),
    name: 'Basic (and reversed card)',
    kind: NoteTypeKind.Standard,
    fields: [{ name: 'Front' }, { name: 'Back' }],
    templates: [
      { name: 'Card 1', question: '{{Front}}', answer: '{{FrontSide}}<hr>{{Back}}' },
      { name: 'Card 2', question: '{{Back}}', answer: '{{FrontSide}}<hr>{{Front}}' },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
    created: now,
    modified: now,
  };
}

export function clozeNoteType(now = Date.now()): NoteType {
  return {
    id: newId(),
    name: 'Cloze',
    kind: NoteTypeKind.Cloze,
    fields: [{ name: 'Text' }, { name: 'Extra' }],
    templates: [
      {
        name: 'Cloze',
        question: '{{cloze:Text}}',
        answer: '{{cloze:Text}}<br>{{Extra}}',
      },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
    created: now,
    modified: now,
  };
}

export function defaultNoteTypes(now = Date.now()): NoteType[] {
  return [basicNoteType(now), basicReversedNoteType(now), clozeNoteType(now)];
}
