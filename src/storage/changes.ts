/**
 * A change feed over the collection.
 *
 * This is the seam a sync engine would attach to, and the reason it lives
 * here rather than in a sync module: reading "what has changed since X" is
 * a storage concern, and keeping it separate means a transport — a file, a
 * server, a nostr relay — only ever has to speak in terms of this shape.
 *
 * There is deliberately no sync engine. No merge policy, no transport, no
 * conflict resolution. Those are decisions that depend on the transport and
 * are cheap to add later; what is expensive to add later is the data these
 * functions read, which is why it is being recorded from the start.
 */

import type { Deletion, Entity } from '../domain/types.js';
import { CONTENT_STORES, VERSION_FIELD, type ContentStore, type Db } from './types.js';

/** One record that has been created or updated. */
export interface Upsert {
  store: ContentStore;
  record: Entity;
  /** The record's version — `modified`, or `reviewedAt` for review logs. */
  version: number;
}

export interface ChangeSet {
  /** Exclusive lower bound the set was gathered with. */
  since: number;
  /** The moment the set was gathered; use it as the next `since`. */
  until: number;
  upserts: Upsert[];
  deletions: Deletion[];
}

/** The version a record carries, or 0 when it has none. */
export function versionOf(store: ContentStore, record: Entity): number {
  const field = VERSION_FIELD[store];
  const value = (record as unknown as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Everything that changed after `since`.
 *
 * The bound is exclusive, so passing the previous call's `until` back in
 * cannot replay the same record twice.
 */
export async function changesSince(db: Db, since: number, now = Date.now()): Promise<ChangeSet> {
  const upserts: Upsert[] = [];

  for (const store of CONTENT_STORES) {
    const field = VERSION_FIELD[store];
    // Every versioned field is indexed, so this is a range scan rather than
    // a full read of the store.
    const records = (await db[store].byRange(field, { lower: since, lowerOpen: true })) as Entity[];
    for (const record of records) {
      upserts.push({ store, record, version: versionOf(store, record) });
    }
  }

  upserts.sort((a, b) => a.version - b.version);

  const deletions = await db.deletions.byRange('deletedAt', { lower: since, lowerOpen: true });

  return { since, until: now, upserts, deletions };
}

/** How many records a change set touches, for progress reporting. */
export function changeSetSize(changes: ChangeSet): number {
  return changes.upserts.length + changes.deletions.length;
}
