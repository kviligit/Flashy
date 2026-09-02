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
import { Rating, State } from '../fsrs/index.js';
import { replayCards } from './replay.js';
import { emptyCounts, type MergeCounts } from './types.js';

export interface MergeOptions {
  /**
   * Recompute the scheduling state of cards whose history changed. On by
   * default; off is useful when applying a batch and replaying once at the
   * end.
   */
  replay?: boolean;
  /** Current time, for the clock-skew check. Injected so tests can pin it. */
  now?: number;
}

/** Apply a peer's change set. Returns what happened, in detail. */
export async function applyChanges(
  db: Db,
  changes: ChangeSet,
  options: MergeOptions = {},
): Promise<MergeCounts> {
  const counts = emptyCounts();
  const touchedCards = new Set<string>();
  const now = options.now ?? Date.now();

  for (const upsert of changes.upserts) {
    if (!isContentStore(upsert.store)) continue;
    await applyUpsert(db, upsert, counts, touchedCards, now);
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

/**
 * How far into the future a peer's timestamp may be before we disbelieve it.
 *
 * Clocks differ, so some slack is necessary; a day is generous for that and
 * still refuses a record dated next century, which would otherwise win every
 * conflict for the rest of the collection's life.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a record is fit to be written at all.
 *
 * A peer being authenticated says who sent something, not that what they
 * sent is true. A compromised device, or a relay that alters what it
 * relays, hands over exactly the same shape of data as an honest one — so
 * the content is checked on arrival regardless of who it came from.
 */
function isAcceptable(store: ContentStore, record: Entity, version: number, now: number): boolean {
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (!Number.isFinite(version) || version < 0) return false;
  if (version > now + MAX_CLOCK_SKEW_MS) return false;
  if (hasNonFiniteNumber(record)) return false;

  if (store === 'reviewLogs') {
    const log = record as unknown as Record<string, unknown>;
    // These feed the scheduler through replay, so a nonsense value here
    // does not merely look wrong — it rewrites the card's future.
    const rating = log['rating'];
    if (typeof rating !== 'number' || !RATINGS_ALLOWED.has(rating)) return false;
    const elapsed = log['elapsedDays'];
    if (typeof elapsed !== 'number' || elapsed < 0 || elapsed > MAX_ELAPSED_DAYS) return false;
    if (typeof log['cardId'] !== 'string' || log['cardId'].length === 0) return false;
    const before = log['stateBefore'];
    if (typeof before !== 'number' || !STATES_ALLOWED.has(before)) return false;
  }

  return true;
}

const RATINGS_ALLOWED = new Set<number>([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
const STATES_ALLOWED = new Set<number>([State.New, State.Learning, State.Review, State.Relearning]);

/** A century of days: past any real interval, short of absurd. */
const MAX_ELAPSED_DAYS = 36_500;

/** True if any number anywhere in the record is not finite. */
function hasNonFiniteNumber(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some((item) => hasNonFiniteNumber(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => hasNonFiniteNumber(item, depth + 1));
  }
  return false;
}

async function applyUpsert(
  db: Db,
  upsert: Upsert,
  counts: MergeCounts,
  touchedCards: Set<string>,
  now: number,
): Promise<void> {
  const store = db[upsert.store] as unknown as {
    get(id: string): Promise<Entity | null>;
    put(item: Entity): Promise<void>;
  };
  const incoming = upsert.record;

  // The version is re-derived from the record rather than taken from the
  // envelope. A peer that simply declared `version: Number.MAX_SAFE_INTEGER`
  // could otherwise overwrite anything, forever, whatever the record
  // actually says about itself.
  const remoteVersion = versionOf(upsert.store, incoming);

  if (!isAcceptable(upsert.store, incoming, remoteVersion, now)) {
    counts.rejected += 1;
    return;
  }

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

  // Review logs are append-only, and that has to hold against a peer too.
  // A tombstone for one would erase study that genuinely happened, and the
  // replay that follows would recompute the card's schedule from a
  // truncated history — silent, and invisible until the intervals are
  // wrong. Locally-originated deletions still work: undo restores a card
  // and drops its log through the store directly, not through a merge.
  if (storeName === 'reviewLogs') {
    counts.deletionsRejected += 1;
    return;
  }

  if (!Number.isFinite(deletedAt) || deletedAt < 0) {
    counts.deletionsRejected += 1;
    return;
  }

  // An edit after the delete is the later intention.
  if (versionOf(storeName, local) > deletedAt) {
    counts.deletionsRejected += 1;
    return;
  }

  await store.delete(recordId);
  counts.deleted += 1;
  // Deleting a card leaves its history orphaned but harmless; nothing needs
  // replaying, because review logs are never deleted by a merge.
  if (storeName === 'cards') touchedCards.delete(recordId);
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
