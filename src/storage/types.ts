/**
 * Storage interfaces. Everything above this layer talks to `Db` and never
 * to IndexedDB directly, which is what makes the in-memory implementation
 * (and, later, a synced one) a drop-in replacement.
 */

import type {
  Card,
  Deck,
  DeckConfig,
  Deletion,
  Entity,
  Meta,
  Note,
  NoteType,
  ReviewLog,
} from '../domain/types.js';

/** A key an index can be queried by. */
export type Key = string | number;

/** Half-open or closed range over an index. Mirrors IDBKeyRange. */
export interface Range {
  lower?: Key;
  upper?: Key;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

export interface QueryOptions {
  /** Stop after this many matches. */
  limit?: number;
  /** Iterate the index in descending order. */
  descending?: boolean;
}

/**
 * A keyed collection of one entity type.
 *
 * Every method is async because IndexedDB is; the in-memory implementation
 * resolves immediately rather than pretending to be synchronous, so tests
 * exercise the same await points as production.
 */
export interface Store<T extends Entity> {
  get(id: string): Promise<T | null>;
  getMany(ids: readonly string[]): Promise<T[]>;
  getAll(): Promise<T[]>;
  put(item: T): Promise<void>;
  putMany(items: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
  count(): Promise<number>;
  /** All items whose `index` field equals `value`. */
  byIndex(index: string, value: Key): Promise<T[]>;
  /** All items whose `index` field falls in `range`, in index order. */
  byRange(index: string, range: Range, options?: QueryOptions): Promise<T[]>;
  /** Number of items whose `index` field falls in `range`. */
  countRange(index: string, range: Range): Promise<number>;
  clear(): Promise<void>;
}

/** The whole collection. */
export interface Db {
  readonly decks: Store<Deck>;
  readonly deckConfigs: Store<DeckConfig>;
  readonly noteTypes: Store<NoteType>;
  readonly notes: Store<Note>;
  readonly cards: Store<Card>;
  readonly reviewLogs: Store<ReviewLog>;
  readonly meta: Store<Meta>;
  /** Tombstones. Written by the storage layer, not by callers. */
  readonly deletions: Store<Deletion>;
  /** Wipe every store. */
  clear(): Promise<void>;
  close(): void;
}

/** Which fields are indexed, per store. Shared by both implementations. */
export const INDEXES = {
  // `modified` is indexed on every content store because the change feed
  // range-scans it; without the index that scan is a full table read on
  // IndexedDB, and an outright error if the index is missing.
  decks: ['name', 'configId', 'modified'],
  deckConfigs: ['name', 'modified'],
  noteTypes: ['name', 'modified'],
  notes: ['noteTypeId', 'modified'],
  cards: ['noteId', 'deckId', 'due', 'state', 'position', 'modified'],
  reviewLogs: ['cardId', 'reviewedAt'],
  meta: [],
  deletions: ['store', 'deletedAt'],
} as const satisfies Record<string, readonly string[]>;

export type StoreName = keyof typeof INDEXES;

export const STORE_NAMES = Object.keys(INDEXES) as StoreName[];

/** True when `value` falls inside `range`. */
export function inRange(value: Key, range: Range): boolean {
  if (range.lower !== undefined) {
    if (value < range.lower) return false;
    if (range.lowerOpen && value === range.lower) return false;
  }
  if (range.upper !== undefined) {
    if (value > range.upper) return false;
    if (range.upperOpen && value === range.upper) return false;
  }
  return true;
}

/** Total order over index keys, so both backends sort identically. */
export function compareKeys(a: Key, b: Key): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}


/**
 * The field that carries each store's version, for change feeds.
 *
 * Everything is mutated in place and carries `modified`, except review
 * logs, which are append-only and are versioned by when the answer
 * happened. `deletions` is not listed: tombstones are read as deletions,
 * never as upserts.
 */
export const VERSION_FIELD = {
  decks: 'modified',
  deckConfigs: 'modified',
  noteTypes: 'modified',
  notes: 'modified',
  cards: 'modified',
  reviewLogs: 'reviewedAt',
  meta: 'modified',
} as const satisfies Partial<Record<StoreName, string>>;

/** The stores that hold user content — everything a sync would carry. */
export const CONTENT_STORES = [
  'decks',
  'deckConfigs',
  'noteTypes',
  'notes',
  'cards',
  'reviewLogs',
] as const satisfies readonly StoreName[];

export type ContentStore = (typeof CONTENT_STORES)[number];
