/**
 * Opening the collection: pick a backend, then make sure it holds the
 * minimum a usable collection needs (a config preset, note types, a deck).
 */

import { defaultNoteTypes, makeDeck, makeDeckConfig, makeMeta } from '../domain/defaults.js';
import { newId } from '../domain/id.js';
import { SCHEMA_VERSION } from '../domain/types.js';
import type { Db } from './types.js';
import { IdbDb, idbAvailable } from './indexeddb.js';
import { MemoryDb } from './memory.js';
import { requestPersistence, type StorageStatus } from './persistence.js';
import { withChangeTracking } from './tracking.js';

export interface OpenResult {
  db: Db;
  /** False when IndexedDB was unavailable and data will not survive a reload. */
  persistent: boolean;
  /** Why persistence was unavailable, when it was. */
  reason?: string;
  /**
   * Whether the browser promised not to evict the collection under storage
   * pressure. Absent when the database is only in memory anyway.
   */
  storage?: StorageStatus;
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
    // Ask for durable storage before handing the database out, so a phone
    // low on space cannot quietly evict months of review history.
    const storage = await requestPersistence();
    return { db: withChangeTracking(db), persistent: true, storage };
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
    // Backfill anything a collection created by an older version lacks,
    // rather than rewriting it wholesale.
    const meta = await db.meta.get('meta');
    if (meta === null) {
      await db.meta.put(makeMeta(now));
    } else if (!meta.deviceId || meta.schemaVersion !== SCHEMA_VERSION) {
      await db.meta.put({
        ...meta,
        deviceId: meta.deviceId || newId(),
        schemaVersion: SCHEMA_VERSION,
        modified: now,
      });
    }
    return;
  }

  const config = makeDeckConfig('Default', now);
  const deck = makeDeck('Default', config.id, now);

  await db.meta.put(makeMeta(now));
  await db.deckConfigs.put(config);
  await db.decks.put(deck);
  await db.noteTypes.putMany(defaultNoteTypes(now));
}
