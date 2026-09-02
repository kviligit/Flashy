/**
 * What a record has to look like before it is allowed into the collection.
 *
 * The merge layer used to check that a record was an object with a string
 * id and then hand it to `put`. A peer could therefore write a card whose
 * `deckId` was `{}`, whose `state` was `'banana'` and whose `due` was an
 * array — accepted, counted as applied, and stored. Nothing then crashed
 * immediately, which is the worst outcome: the damage surfaced later, in
 * the deck list or the scheduler, a long way from its cause.
 *
 * Two rules shape this file.
 *
 * **Known fields are checked; unknown fields are left alone.** A peer
 * running a newer version will send fields this one has never heard of,
 * and rejecting those would mean an upgrade on one device silently breaks
 * sync with the others. Extra fields are carried through untouched.
 *
 * **Checks are structural, not semantic.** Whether a `deckId` names a deck
 * that exists is not knowable here — the deck may arrive in a later chunk,
 * or a later round. So: is it a string? Is `state` one of the four states?
 * Is `due` something `Date.parse` accepts? Anything that asks about the
 * rest of the collection belongs somewhere with a view of it.
 */

import type { ContentStore } from '../storage/index.js';
import type { Entity } from '../domain/types.js';

/** Why a record was refused, for a caller that wants to say. */
export type ValidationError = string;

type Check = (record: Record<string, unknown>) => ValidationError | null;

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value);

/** An ISO timestamp, as every date in the collection is stored. */
const isTimestamp = (value: unknown): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const isNullable = (predicate: (value: unknown) => boolean) => (value: unknown): boolean =>
  value === null || value === undefined || predicate(value);

const isArrayOf = (predicate: (value: unknown) => boolean) => (value: unknown): boolean =>
  Array.isArray(value) && value.every(predicate);

/** A record of string to string, which is how note fields are stored. */
function isStringMap(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isString);
}

/**
 * Build a check from a field-to-predicate table.
 *
 * A field that is absent is refused as loudly as one of the wrong type:
 * a card with no `due` is not a forward-compatible card, it is a card the
 * scheduler will trip over.
 */
function shape(fields: Record<string, (value: unknown) => boolean>): Check {
  return (record) => {
    for (const [name, predicate] of Object.entries(fields)) {
      if (!predicate(record[name])) return `${name} is missing or the wrong type`;
    }
    return null;
  };
}

const STATES = new Set([0, 1, 2, 3]);
const FLAGS = new Set([0, 1, 2, 3, 4]);
const NOTE_TYPE_KINDS = new Set(['standard', 'cloze']);
const NEW_CARD_ORDERS = new Set(['sequential', 'random']);
const REVIEW_ORDERS = new Set(['due', 'random', 'difficulty']);
const LEECH_ACTIONS = new Set(['suspend', 'tag']);

const oneOf = (allowed: ReadonlySet<unknown>) => (value: unknown): boolean => allowed.has(value);

/** A whole number that is a count of something, not an identifier. */
const isCount = (value: unknown): boolean => isInteger(value) && (value as number) >= 0;

function isMemory(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const { stability, difficulty } = value as Record<string, unknown>;
  return isFiniteNumber(stability) && isFiniteNumber(difficulty);
}

function isFieldDefs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => item && typeof item === 'object' && isString((item as Record<string, unknown>)['name']))
  );
}

function isTemplates(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const template = item as Record<string, unknown>;
      return isString(template['name']) && isString(template['question']) && isString(template['answer']);
    })
  );
}

const CHECKS: Record<ContentStore, Check> = {
  decks: shape({
    name: isString,
    configId: isString,
    description: isString,
    collapsed: isBoolean,
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),

  deckConfigs: shape({
    name: isString,
    newPerDay: isCount,
    reviewsPerDay: isCount,
    params: isArrayOf(isFiniteNumber),
    desiredRetention: isFiniteNumber,
    learningSteps: isArrayOf(isFiniteNumber),
    relearningSteps: isArrayOf(isFiniteNumber),
    maximumInterval: isFiniteNumber,
    enableFuzz: isBoolean,
    newCardOrder: oneOf(NEW_CARD_ORDERS),
    reviewOrder: oneOf(REVIEW_ORDERS),
    burySiblings: isBoolean,
    leechThreshold: isCount,
    leechAction: oneOf(LEECH_ACTIONS),
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),

  noteTypes: shape({
    name: isString,
    kind: oneOf(NOTE_TYPE_KINDS),
    fields: isFieldDefs,
    templates: isTemplates,
    css: isString,
    sortField: isCount,
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),

  notes: shape({
    noteTypeId: isString,
    fields: isStringMap,
    tags: isArrayOf(isString),
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),

  cards: shape({
    noteId: isString,
    deckId: isString,
    ord: isCount,
    state: oneOf(STATES),
    memory: isMemory,
    due: isTimestamp,
    lastReview: isNullable(isTimestamp),
    step: isCount,
    reps: isCount,
    lapses: isCount,
    position: isFiniteNumber,
    suspended: isBoolean,
    buriedUntil: isNullable(isTimestamp),
    flag: oneOf(FLAGS),
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),

  // Review logs carry additional semantic checks in `merge.ts`, which is
  // where the scheduler-facing constraints belong. These are the plain
  // structural ones.
  reviewLogs: shape({
    cardId: isString,
    reviewedAt: isFiniteNumber,
    rating: isInteger,
    stateBefore: oneOf(STATES),
    stateAfter: oneOf(STATES),
    intervalDays: isFiniteNumber,
    lastIntervalDays: isFiniteNumber,
    elapsedDays: isFiniteNumber,
    stability: isFiniteNumber,
    difficulty: isFiniteNumber,
    timeTakenMs: isFiniteNumber,
    siblingsBuried: isArrayOf(isString),
  }),

  media: shape({
    filename: isString,
    mime: isString,
    size: isCount,
    data: (value) => value instanceof ArrayBuffer,
    created: isFiniteNumber,
    modified: isFiniteNumber,
  }),
};

/**
 * Check a record against its store's shape.
 *
 * Returns the reason it was refused, or null when it is fit to store.
 */
export function validateRecord(store: ContentStore, record: Entity): ValidationError | null {
  if (typeof record.id !== 'string' || record.id.length === 0) return 'id is missing';
  const check = CHECKS[store];
  if (!check) return `unknown store ${store}`;
  return check(record as unknown as Record<string, unknown>);
}
