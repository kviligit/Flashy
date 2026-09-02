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

import {
  CONTENT_STORES,
  versionOf,
  type ChangeSet,
  type ContentStore,
  type Db,
  type Upsert,
} from '../storage/index.js';
import type { Entity } from '../domain/types.js';
import { hashContent } from '../domain/media.js';
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
    const replay = await replayCards(db, touchedCards);
    counts.cardsReplayed = replay.changed;
    counts.replayFailures = replay.failed.length;
  }

  return counts;
}

/**
 * How far apart two devices' clocks may be before this one stops trusting
 * the other's ordering at all. Used for watermarks and the relay lookback.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * How far into the future a *record's* timestamp may be.
 *
 * This used to be the day above, and a day is far too generous. Last-write
 * wins compares peer-supplied timestamps, so whatever slack is allowed here
 * is exactly how long a peer can hold a record above every edit the user
 * makes afterwards — applying them locally, showing no conflict, and
 * overwriting them again on the next round. At a day, a peer that re-sends
 * one record with a refreshed timestamp owns that record for ever and the
 * user watches their edits evaporate with no explanation.
 *
 * Five minutes is far more slack than a network-synchronised clock needs,
 * and it bounds the damage to five minutes of work rather than a day's.
 *
 * It does not eliminate the problem, and pretending otherwise would be
 * worse than stating it: any last-write-wins scheme that trusts a peer's
 * clock lets that peer win by claiming to be slightly ahead. Fixing it
 * properly needs version vectors or receipt-time tracking, neither of
 * which is a change to make while nobody is watching.
 */
export const MAX_FUTURE_VERSION_MS = 5 * 60 * 1000;

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
  if (version > now + MAX_FUTURE_VERSION_MS) return false;
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

    // `reviewedAt` orders the replay and `snapshot` is where it starts
    // from, which makes them the two most powerful fields in the record —
    // and they were the two this function did not look at. One log with a
    // snapshot claiming a stability of a million moves a card's due date
    // into the next century, counted to the user as one review received.
    const reviewedAt = log['reviewedAt'];
    if (typeof reviewedAt !== 'number' || !Number.isFinite(reviewedAt)) return false;
    if (reviewedAt < 0 || reviewedAt > now + MAX_FUTURE_VERSION_MS) return false;
    if (!isPlausibleSnapshot(log['snapshot'])) return false;
  }

  return true;
}

/** A century of days of stability, and the hardest a card can be. */
const MAX_STABILITY = 36_500;
const MAX_DIFFICULTY = 10;
const MAX_REPS = 1_000_000;

/**
 * Whether a review log's snapshot could have come from this app.
 *
 * The replay seeds a card's entire scheduling history from the earliest
 * log's snapshot, so an unchecked one is not a cosmetic problem: it is
 * arbitrary control over the card's future, exercised through a code path
 * whose counters report nothing unusual. A missing snapshot is just as
 * bad in the other direction — it throws inside the replay, after the log
 * has already been written, leaving the card permanently unreplayable.
 */
function isPlausibleSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;

  if (typeof card['id'] !== 'string' || card['id'].length === 0) return false;
  const state = card['state'];
  if (typeof state !== 'number' || !STATES_ALLOWED.has(state)) return false;

  for (const field of ['reps', 'lapses', 'step'] as const) {
    const number = card[field];
    if (typeof number !== 'number' || !Number.isInteger(number)) return false;
    if (number < 0 || number > MAX_REPS) return false;
  }

  if (typeof card['due'] !== 'string' || !Number.isFinite(Date.parse(card['due']))) return false;
  const lastReview = card['lastReview'];
  if (lastReview !== null && lastReview !== undefined) {
    if (typeof lastReview !== 'string' || !Number.isFinite(Date.parse(lastReview))) return false;
  }

  const memory = card['memory'];
  if (memory === null || memory === undefined) return true;
  if (typeof memory !== 'object' || Array.isArray(memory)) return false;
  const { stability, difficulty } = memory as Record<string, unknown>;
  if (typeof stability !== 'number' || !(stability > 0) || stability > MAX_STABILITY) return false;
  if (typeof difficulty !== 'number' || !(difficulty >= 1) || difficulty > MAX_DIFFICULTY) {
    return false;
  }
  return true;
}

const RATINGS_ALLOWED = new Set<number>([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
const STATES_ALLOWED = new Set<number>([State.New, State.Learning, State.Review, State.Relearning]);

/** A century of days: past any real interval, short of absurd. */
const MAX_ELAPSED_DAYS = 36_500;


/**
 * Whether a media record's id is genuinely the hash of its bytes.
 *
 * This is what makes "the same id is the same bytes" a fact rather than a
 * hope, and it is the only reason first-writer-wins is safe for media: a
 * peer cannot claim an id it has not earned, so it cannot squat the id a
 * file the user has not added yet will hash to.
 */
async function hasMatchingHash(record: Entity): Promise<boolean> {
  const data = (record as unknown as { data?: unknown }).data;
  if (!(data instanceof ArrayBuffer)) return false;
  if (data.byteLength === 0) return false;
  try {
    return (await hashContent(data)) === record.id;
  } catch {
    // A browser without SubtleCrypto cannot check, and accepting on the
    // strength of "we could not look" is how this kind of check gets
    // quietly disabled. Sync needs SubtleCrypto anyway.
    return false;
  }
}

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

  // Media is content-addressed, and first-writer-wins is only safe because
  // of that: two records with the same id must be the same bytes. Nothing
  // used to check it, which made the rule a liability rather than a
  // shortcut — a peer could claim the id an image *will* hash to, and the
  // real file would then be skipped as already present, permanently.
  if (upsert.store === 'media') {
    if (!(await hasMatchingHash(incoming))) {
      counts.rejected += 1;
      return;
    }
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
