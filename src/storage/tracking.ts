/**
 * Change tracking: a `Db` wrapper that records a tombstone for every
 * deletion.
 *
 * This is a decorator rather than something call sites opt into, and that
 * is the whole point. A deletion that is not recorded is invisible to any
 * future sync, and "remember to also write a tombstone" is exactly the kind
 * of rule that gets forgotten at the eighth call site. Wrapping the store
 * makes it impossible to forget, and means no feature code mentions
 * tombstones at all.
 *
 * It composes over any `Db`, so it works identically with the IndexedDB and
 * in-memory backends.
 */

import type { Deletion, Entity } from '../domain/types.js';
import {
  CONTENT_STORES,
  type ContentStore,
  type Db,
  type Key,
  type QueryOptions,
  type Range,
  type Store,
} from './types.js';

export interface TrackingOptions {
  /** Clock, injected so tests can pin the timestamps. */
  now?: () => number;
}

/** `"<store>:<recordId>"` — one tombstone per record, ever. */
export function tombstoneId(store: string, recordId: string): string {
  return `${store}:${recordId}`;
}

class TrackedStore<T extends Entity> implements Store<T> {
  constructor(
    private readonly inner: Store<T>,
    private readonly deletions: Store<Deletion>,
    private readonly storeName: string,
    private readonly now: () => number,
  ) {}

  // --- reads and writes pass straight through ---------------------------

  get(id: string): Promise<T | null> {
    return this.inner.get(id);
  }
  getMany(ids: readonly string[]): Promise<T[]> {
    return this.inner.getMany(ids);
  }
  getAll(): Promise<T[]> {
    return this.inner.getAll();
  }
  put(item: T): Promise<void> {
    return this.inner.put(item);
  }
  putMany(items: readonly T[]): Promise<void> {
    return this.inner.putMany(items);
  }
  count(): Promise<number> {
    return this.inner.count();
  }
  byIndex(index: string, value: Key): Promise<T[]> {
    return this.inner.byIndex(index, value);
  }
  byRange(index: string, range: Range, options?: QueryOptions): Promise<T[]> {
    return this.inner.byRange(index, range, options);
  }
  countRange(index: string, range: Range): Promise<number> {
    return this.inner.countRange(index, range);
  }

  // --- deletions leave a mark ------------------------------------------

  async delete(id: string): Promise<void> {
    await this.inner.delete(id);
    await this.deletions.put(this.tombstone(id));
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.inner.deleteMany(ids);
    await this.deletions.putMany(ids.map((id) => this.tombstone(id)));
  }

  /**
   * `clear()` is a wholesale wipe — a restore or a reset, not a series of
   * user deletions — so it deliberately records nothing. Tombstoning an
   * entire collection would tell a peer to delete its own copy.
   */
  clear(): Promise<void> {
    return this.inner.clear();
  }

  private tombstone(recordId: string): Deletion {
    return {
      id: tombstoneId(this.storeName, recordId),
      store: this.storeName,
      recordId,
      deletedAt: this.now(),
    };
  }
}

/**
 * Wrap a database so deletions from its content stores are recorded.
 *
 * `meta` and `deletions` themselves are passed through untouched: the first
 * is per-device configuration that is never synchronised, and tombstoning
 * tombstones would not terminate.
 */
export function withChangeTracking(db: Db, options: TrackingOptions = {}): Db {
  const now = options.now ?? (() => Date.now());

  const wrap = <K extends ContentStore>(name: K): Db[K] =>
    new TrackedStore(
      db[name] as unknown as Store<Entity>,
      db.deletions,
      name,
      now,
    ) as unknown as Db[K];

  const tracked = {
    decks: wrap('decks'),
    deckConfigs: wrap('deckConfigs'),
    noteTypes: wrap('noteTypes'),
    notes: wrap('notes'),
    cards: wrap('cards'),
    reviewLogs: wrap('reviewLogs'),
    media: wrap('media'),
    meta: db.meta,
    deletions: db.deletions,
    clear: () => db.clear(),
    close: () => db.close(),
  } satisfies Db;

  return tracked;
}

/** Drop tombstones older than `before`. Sync would call this after a round. */
export async function pruneTombstones(db: Db, before: number): Promise<number> {
  const stale = await db.deletions.byRange('deletedAt', { upper: before, upperOpen: true });
  await db.deletions.deleteMany(stale.map((entry) => entry.id));
  return stale.length;
}

export { CONTENT_STORES };
