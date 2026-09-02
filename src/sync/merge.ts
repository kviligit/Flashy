/**
 * Applying a peer's changes to the local collection.
 *
 * The rules, and why each one is what it is:
 *
 *  - **Review logs are append-only.** They record something that actually
 *    happened, on a particular device, at a particular moment. Two devices
 *    each hold answers the other never saw, and the truth is the union.
 *    A log is never overwritten and never conflicts.
 *  - **Media is content-addressed**, so two files with the same id have the
 *    same bytes by construction. First writer wins; there is nothing to
 *    reconcile.
 *  - **Everything else is last-write-wins** on `modified`. It is the
 *    simplest rule that converges, and for a single user's own devices the
 *    losing edit is nearly always the older draft of the same thought.
 *  - **A tombstone wins only if the record has not changed since.** Editing
 *    a note on one device after deleting it on another means the edit is
 *    the later intention, and resurrecting it is the safer error.
 *
 * Upserts are applied before deletions. The other order lets a stale upsert
 * resurrect something the same change set deletes.
 *
 * Ties are broken by id so that two devices given the same inputs reach the
 * same answer. Without a deterministic rule they can disagree permanently,
 * each believing the other is behind.
 */

import { CONTENT_STORES, versionOf, type ChangeSet, type ContentStore, type Db, type Upsert } from '../storage/index.js';
import type { Entity } from '../domain/types.js';
import { replayCards } from './replay.js';
import { emptyCounts, type MergeCounts } from './types.js';

export interface MergeOptions {
  /**
   * Recompute the scheduling state of cards whose history changed. On by
   * default; off is useful when applying a batch and replaying once at the
   * end.
   */
  replay?: boolean;
}

/** Apply a peer's change set. Returns what happened, in detail. */
export async function applyChanges(
  db: Db,
  changes: ChangeSet,
  options: MergeOptions = {},
): Promise<MergeCounts> {
  const counts = emptyCounts();
  const touchedCards = new Set<string>();

  for (const upsert of changes.upserts) {
    if (!isContentStore(upsert.store)) continue;
    await applyUpsert(db, upsert, counts, touchedCards);
  }

  for (const deletion of changes.deletions) {
    if (!isContentStore(deletion.store)) continue;
    await applyDeletion(db, deletion.store, deletion.recordId, deletion.deletedAt, counts, touchedCards);
  }

  if (options.replay !== false && touchedCards.size > 0) {
    counts.cardsReplayed = await replayCards(db, touchedCards);
  }

  return counts;
}

async function applyUpsert(
  db: Db,
  upsert: Upsert,
  counts: MergeCounts,
  touchedCards: Set<string>,
): Promise<void> {
  const store = db[upsert.store] as unknown as {
    get(id: string): Promise<Entity | null>;
    put(item: Entity): Promise<void>;
  };
  const incoming = upsert.record;
  const local = await store.get(incoming.id);

  // Append-only: a review log that exists is already the truth.
  if (upsert.store === 'reviewLogs') {
    if (local) {
      counts.skipped += 1;
      return;
    }
    await store.put(incoming);
    counts.reviewLogs += 1;
    const cardId = (incoming as unknown as { cardId?: string }).cardId;
    if (cardId) touchedCards.add(cardId);
    return;
  }

  // Content-addressed: the same id is the same bytes.
  if (upsert.store === 'media') {
    if (local) {
      counts.skipped += 1;
      return;
    }
    await store.put(incoming);
    counts.applied += 1;
    return;
  }

  if (!local) {
    await store.put(incoming);
    counts.applied += 1;
    return;
  }

  const localVersion = versionOf(upsert.store, local);
  const remoteVersion = upsert.version;

  if (remoteVersion > localVersion || (remoteVersion === localVersion && wins(incoming, local))) {
    if (localVersion !== remoteVersion) counts.conflicts += 1;
    await store.put(incoming);
    counts.applied += 1;
    if (upsert.store === 'cards') touchedCards.add(incoming.id);
  } else {
    counts.skipped += 1;
    if (remoteVersion !== localVersion) counts.conflicts += 1;
  }
}

async function applyDeletion(
  db: Db,
  storeName: ContentStore,
  recordId: string,
  deletedAt: number,
  counts: MergeCounts,
  touchedCards: Set<string>,
): Promise<void> {
  const store = db[storeName] as unknown as {
    get(id: string): Promise<Entity | null>;
    delete(id: string): Promise<void>;
  };
  const local = await store.get(recordId);
  if (!local) return; // already gone, or never seen

  // An edit after the delete is the later intention.
  if (versionOf(storeName, local) > deletedAt) {
    counts.deletionsRejected += 1;
    return;
  }

  await store.delete(recordId);
  counts.deleted += 1;
  if (storeName === 'reviewLogs') {
    const cardId = (local as unknown as { cardId?: string }).cardId;
    if (cardId) touchedCards.add(cardId);
  }
}

/**
 * The tiebreak when two versions of the same record claim the same
 * modification time.
 *
 * It has to compare *contents*, not ids: both sides are the same record, so
 * their ids are identical by definition and comparing them makes every
 * device keep its own copy — the two then disagree permanently, each
 * convinced the other is behind. Comparing a canonical serialisation is
 * arbitrary but stable, which is the only property that matters here.
 */
function wins(incoming: Entity, local: Entity): boolean {
  return canonical(incoming) > canonical(local);
}

/**
 * A serialisation that does not depend on key order.
 *
 * A record that has been through JSON on its way from a peer can come back
 * with its keys in a different order than the one that created it, and an
 * order-sensitive comparison would then pick different winners on the two
 * devices — which is exactly the disagreement this is meant to prevent.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof ArrayBuffer) return `b${value.byteLength}`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function isContentStore(name: string): name is ContentStore {
  return (CONTENT_STORES as readonly string[]).includes(name);
}
