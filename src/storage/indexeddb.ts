/**
 * IndexedDB `Db`. The only file in the project that knows IndexedDB exists.
 *
 * Schema upgrades live in `upgrade()`: add a case, bump `DB_VERSION`.
 * Never rename a store or index in place — add the new one and migrate.
 */

import type { Entity } from '../domain/types.js';
import {
  INDEXES,
  STORE_NAMES,
  type Db,
  type Key,
  type QueryOptions,
  type Range,
  type Store,
  type StoreName,
} from './types.js';

export const DB_NAME = 'flashy';
export const DB_VERSION = 5;

function toKeyRange(range: Range): IDBKeyRange | null {
  const { lower, upper, lowerOpen = false, upperOpen = false } = range;
  if (lower !== undefined && upper !== undefined) {
    return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  }
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return null;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IdbStore<T extends Entity> implements Store<T> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly name: StoreName,
  ) {}

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }

  async get(id: string): Promise<T | null> {
    const found = await promisify<T | undefined>(this.tx('readonly').get(id));
    return found ?? null;
  }

  async getMany(ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const store = this.tx('readonly');
    const out: T[] = [];
    for (const id of ids) {
      const found = (await promisify(store.get(id))) as T | undefined;
      if (found !== undefined) out.push(found);
    }
    return out;
  }

  async getAll(): Promise<T[]> {
    return promisify<T[]>(this.tx('readonly').getAll());
  }

  async put(item: T): Promise<void> {
    const store = this.tx('readwrite');
    store.put(item);
    await finished(store.transaction);
  }

  async putMany(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;
    const store = this.tx('readwrite');
    for (const item of items) store.put(item);
    await finished(store.transaction);
  }

  async delete(id: string): Promise<void> {
    const store = this.tx('readwrite');
    store.delete(id);
    await finished(store.transaction);
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const store = this.tx('readwrite');
    for (const id of ids) store.delete(id);
    await finished(store.transaction);
  }

  async count(): Promise<number> {
    return promisify<number>(this.tx('readonly').count());
  }

  async byIndex(index: string, value: Key): Promise<T[]> {
    return promisify<T[]>(this.tx('readonly').index(index).getAll(value));
  }

  async byRange(index: string, range: Range, options: QueryOptions = {}): Promise<T[]> {
    // IndexedDB reads a `count` of 0 as "no limit"; we mean what we say.
    if (options.limit === 0) return [];

    const idx = this.tx('readonly').index(index);
    const keyRange = toKeyRange(range);

    // getAll() cannot express descending order, so only the descending and
    // limited cases pay for a cursor walk.
    if (!options.descending) {
      return promisify<T[]>(
        options.limit === undefined
          ? idx.getAll(keyRange)
          : idx.getAll(keyRange, options.limit),
      );
    }

    return new Promise((resolve, reject) => {
      const out: T[] = [];
      const request = idx.openCursor(keyRange, 'prev');
      request.onerror = () => reject(request.error ?? new Error('cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || (options.limit !== undefined && out.length >= options.limit)) {
          resolve(out);
          return;
        }
        out.push(cursor.value as T);
        cursor.continue();
      };
    });
  }

  async countRange(index: string, range: Range): Promise<number> {
    const keyRange = toKeyRange(range);
    const idx = this.tx('readonly').index(index);
    return promisify<number>(keyRange ? idx.count(keyRange) : idx.count());
  }

  async clear(): Promise<void> {
    const store = this.tx('readwrite');
    store.clear();
    await finished(store.transaction);
  }
}

function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction | null): void {
  // Each version adds only what is missing, so an existing collection is
  // upgraded in place rather than rebuilt. Never rename or drop a store
  // here; add the new one and migrate into it.
  const ensureStore = (name: StoreName): void => {
    if (db.objectStoreNames.contains(name)) return;
    const store = db.createObjectStore(name, { keyPath: 'id' });
    for (const index of INDEXES[name]) store.createIndex(index, index, { unique: false });
  };

  /** Add any index declared for a store that the store does not yet have. */
  const ensureIndexes = (name: StoreName): void => {
    if (!tx || !db.objectStoreNames.contains(name)) return;
    const store = tx.objectStore(name);
    for (const index of INDEXES[name]) {
      if (!store.indexNames.contains(index)) store.createIndex(index, index, { unique: false });
    }
  };

  if (oldVersion < 1) {
    for (const name of STORE_NAMES) ensureStore(name);
  }

  if (oldVersion < 2) {
    // Tombstones, so deletions can be replayed onto another device, and the
    // `modified` indexes the change feed scans.
    ensureStore('deletions');
    for (const name of STORE_NAMES) ensureIndexes(name);
  }

  if (oldVersion < 3) {
    // Images and sounds attached to notes.
    ensureStore('media');
  }

  if (oldVersion < 4) {
    // Make INDEXES authoritative by dropping anything a store still
    // carries that is no longer declared. An index costs roughly 30% of
    // the write time of its store, so a dead one left in place is a tax
    // every existing collection would go on paying.
    for (const name of STORE_NAMES) dropUndeclaredIndexes(name);
  }

  if (oldVersion < 5) {
    // Per-peer sync watermarks. This was version 4 while the sync work was
    // on its own branch, but main shipped a different version 4 first, so
    // it moves up rather than colliding with a migration users have run.
    ensureStore('syncState');
  }

  /** Remove indexes the store has but INDEXES no longer lists. */
  function dropUndeclaredIndexes(name: StoreName): void {
    if (!tx || !db.objectStoreNames.contains(name)) return;
    const store = tx.objectStore(name);
    const declared = new Set<string>(INDEXES[name]);
    for (const existing of Array.from(store.indexNames)) {
      if (!declared.has(existing)) store.deleteIndex(existing);
    }
  }
}

export class IdbDb implements Db {
  readonly decks: Db['decks'];
  readonly deckConfigs: Db['deckConfigs'];
  readonly noteTypes: Db['noteTypes'];
  readonly notes: Db['notes'];
  readonly cards: Db['cards'];
  readonly reviewLogs: Db['reviewLogs'];
  readonly meta: Db['meta'];
  readonly media: Db['media'];
  readonly syncState: Db['syncState'];
  readonly deletions: Db['deletions'];

  private constructor(private readonly raw: IDBDatabase) {
    this.decks = new IdbStore(raw, 'decks') as Db['decks'];
    this.deckConfigs = new IdbStore(raw, 'deckConfigs') as Db['deckConfigs'];
    this.noteTypes = new IdbStore(raw, 'noteTypes') as Db['noteTypes'];
    this.notes = new IdbStore(raw, 'notes') as Db['notes'];
    this.cards = new IdbStore(raw, 'cards') as Db['cards'];
    this.reviewLogs = new IdbStore(raw, 'reviewLogs') as Db['reviewLogs'];
    this.meta = new IdbStore(raw, 'meta') as Db['meta'];
    this.media = new IdbStore(raw, 'media') as Db['media'];
    this.syncState = new IdbStore(raw, 'syncState') as Db['syncState'];
    this.deletions = new IdbStore(raw, 'deletions') as Db['deletions'];
  }

  static open(name = DB_NAME, version = DB_VERSION): Promise<IdbDb> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion, request.transaction);
      request.onsuccess = () => resolve(new IdbDb(request.result));
      request.onerror = () => reject(request.error ?? new Error('could not open IndexedDB'));
      request.onblocked = () =>
        reject(new Error('IndexedDB upgrade blocked — close other Flashy tabs and reload'));
    });
  }

  async clear(): Promise<void> {
    const tx = this.raw.transaction(STORE_NAMES as unknown as string[], 'readwrite');
    for (const name of STORE_NAMES) tx.objectStore(name).clear();
    await finished(tx);
  }

  close(): void {
    this.raw.close();
  }
}

/** Delete the whole database. Used by import and by the debug page. */
export function deleteDatabase(name = DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('could not delete database'));
    request.onblocked = () => resolve();
  });
}

/** True when this browser can actually give us IndexedDB. */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}
