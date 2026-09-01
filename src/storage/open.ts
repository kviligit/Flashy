/**
 * Opening the collection: pick a backend, then make sure it holds the
 * minimum a usable collection needs (a config preset, note types, a deck).
 */

import { defaultNoteTypes, makeDeck, makeDeckConfig, makeMeta } from '../domain/defaults.js';
import type { Db } from './types.js';
import { IdbDb, idbAvailable } from './indexeddb.js';
import { MemoryDb } from './memory.js';

export interface OpenResult {
  db: Db;
  /** False when IndexedDB was unavailable and data will not survive a reload. */
  persistent: boolean;
  /** Why persistence was unavailable, when it was. */
  reason?: string;
}

export async function openCollection(name?: string): Promise<OpenResult> {
  if (!idbAvailable()) {
    return {
      db: new MemoryDb(),
      persistent: false,
      reason: 'This browser does not expose IndexedDB.',
    };
  }
  try {
    const db = await IdbDb.open(name);
    return { db, persistent: true };
  } catch (error) {
    return {
      db: new MemoryDb(),
      persistent: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Populate an empty collection. Idempotent: a collection that already has
 * note types is left completely alone, so this is safe to call on boot.
 */
export async function seedIfEmpty(db: Db, now = Date.now()): Promise<void> {
  const existing = await db.noteTypes.count();
  if (existing > 0) {
    if ((await db.meta.get('meta')) === null) await db.meta.put(makeMeta(now));
    return;
  }

  const config = makeDeckConfig('Default', now);
  const deck = makeDeck('Default', config.id, now);

  await db.meta.put(makeMeta(now));
  await db.deckConfigs.put(config);
  await db.decks.put(deck);
  await db.noteTypes.putMany(defaultNoteTypes(now));
}
