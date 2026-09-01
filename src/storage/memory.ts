/**
 * In-memory `Db`. Used by the test suite and as the fallback when
 * IndexedDB is unavailable (private browsing, an unsupported embed).
 *
 * Values are deep-cloned on the way in and out, so callers cannot mutate
 * stored state by holding on to a reference — matching what IndexedDB does
 * by virtue of structured cloning.
 */

import type { Entity } from '../domain/types.js';
import {
  compareKeys,
  inRange,
  INDEXES,
  STORE_NAMES,
  type Db,
  type Key,
  type QueryOptions,
  type Range,
  type Store,
  type StoreName,
} from './types.js';

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

function keyOf(item: Record<string, unknown>, index: string): Key | undefined {
  const value = item[index];
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
}

export class MemoryStore<T extends Entity> implements Store<T> {
  private items = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    const found = this.items.get(id);
    return found ? clone(found) : null;
  }

  async getMany(ids: readonly string[]): Promise<T[]> {
    const out: T[] = [];
    for (const id of ids) {
      const found = this.items.get(id);
      if (found) out.push(clone(found));
    }
    return out;
  }

  async getAll(): Promise<T[]> {
    return [...this.items.values()].map(clone);
  }

  async put(item: T): Promise<void> {
    this.items.set(item.id, clone(item));
  }

  async putMany(items: readonly T[]): Promise<void> {
    for (const item of items) this.items.set(item.id, clone(item));
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.items.delete(id);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async byIndex(index: string, value: Key): Promise<T[]> {
    const out: T[] = [];
    for (const item of this.items.values()) {
      if (keyOf(item as unknown as Record<string, unknown>, index) === value) out.push(clone(item));
    }
    return out;
  }

  async byRange(index: string, range: Range, options: QueryOptions = {}): Promise<T[]> {
    const matches: Array<{ key: Key; item: T }> = [];
    for (const item of this.items.values()) {
      const key = keyOf(item as unknown as Record<string, unknown>, index);
      if (key === undefined || !inRange(key, range)) continue;
      matches.push({ key, item });
    }
    matches.sort((a, b) => compareKeys(a.key, b.key));
    if (options.descending) matches.reverse();
    const limited = options.limit === undefined ? matches : matches.slice(0, options.limit);
    return limited.map((m) => clone(m.item));
  }

  async countRange(index: string, range: Range): Promise<number> {
    let n = 0;
    for (const item of this.items.values()) {
      const key = keyOf(item as unknown as Record<string, unknown>, index);
      if (key !== undefined && inRange(key, range)) n += 1;
    }
    return n;
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}

export class MemoryDb implements Db {
  readonly decks = new MemoryStore<never>() as Db['decks'];
  readonly deckConfigs = new MemoryStore<never>() as Db['deckConfigs'];
  readonly noteTypes = new MemoryStore<never>() as Db['noteTypes'];
  readonly notes = new MemoryStore<never>() as Db['notes'];
  readonly cards = new MemoryStore<never>() as Db['cards'];
  readonly reviewLogs = new MemoryStore<never>() as Db['reviewLogs'];
  readonly meta = new MemoryStore<never>() as Db['meta'];
  readonly deletions = new MemoryStore<never>() as Db['deletions'];

  async clear(): Promise<void> {
    for (const name of STORE_NAMES) {
      await (this[name] as Store<Entity>).clear();
    }
  }

  close(): void {
    // Nothing to release.
  }
}

/** The index names the memory backend honours, for parity assertions. */
export const MEMORY_INDEXES = INDEXES;
export type { StoreName };
