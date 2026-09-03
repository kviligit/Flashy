/**
 * One round of synchronisation with one peer.
 *
 * Pull first, then push, so what we send already reflects what they had.
 * Watermarks are stored per peer: their clock for what we have pulled, ours
 * for what we have pushed. Both bounds are exclusive, so a completed round
 * cannot replay itself.
 *
 * A record we just accepted from a peer may be pushed straight back to them
 * on the same round, if its timestamp falls inside our push window. That is
 * wasted bytes rather than a bug — applying it is idempotent — and removing
 * it would mean tracking provenance per record, which is not worth the
 * complexity until a real transport shows it matters.
 */

import { changesSince, type ChangeSet, type Db } from '../storage/index.js';
import type { SyncState } from '../domain/types.js';
import { applyChanges } from './merge.js';
import { emptyCounts, type SyncResult, type SyncTransport } from './types.js';

export interface SyncOptions {
  /** Clock, injected so tests can pin timestamps. */
  now?: () => number;
  /** Skip sending anything; useful for a read-only first look at a peer. */
  pullOnly?: boolean;
  /** Most records to send in one round. See the constant below. */
  maxRecordsPerPush?: number;
}

/**
 * How many records one round will send.
 *
 * Measured, not guessed. A 10,000-note collection's first sync is 87,000
 * records and, once chunked and encrypted, 1,147 events and 72MB — which
 * is both a lot of hand-written cryptography to run on a phone in one go
 * and more than any public relay should be asked to swallow at once. At
 * 20,000 records a round is a few seconds and a few hundred events, and
 * the remainder follows on the next round.
 *
 * The pull side has the same budget for the same reason. Both halves being
 * bounded is what makes a large collection sync at all rather than failing
 * repeatedly at the same place.
 */
export const DEFAULT_MAX_RECORDS_PER_PUSH = 20_000;

/**
 * Cut a change set down to `limit` records by narrowing its window.
 *
 * Not by truncating the list: what is dropped has to be recoverable, and
 * the only thing the next round knows is a timestamp. So the cut is made
 * at a version — everything at or below it is sent, everything above waits
 * — and `until` is set to that version, which becomes the exclusive lower
 * bound next time. Records sharing the cut version travel together, so a
 * single millisecond's worth of edits is never split across rounds.
 */
function narrowWindow(changes: ChangeSet, limit: number): ChangeSet {
  const total = changes.upserts.length + changes.deletions.length;
  if (total <= limit) return changes;

  // Upserts arrive sorted by version; deletions by deletedAt.
  const versions: number[] = [];
  for (const upsert of changes.upserts) versions.push(upsert.version);
  for (const deletion of changes.deletions) versions.push(deletion.deletedAt);
  versions.sort((a, b) => a - b);

  const cut = versions[Math.min(limit, versions.length) - 1] ?? changes.until;

  const upserts = changes.upserts.filter((upsert) => upsert.version <= cut);
  const deletions = changes.deletions.filter((deletion) => deletion.deletedAt <= cut);

  // If everything shares one version there is nothing to narrow to, and a
  // window that excluded them all would stall forever. Send the batch.
  if (upserts.length + deletions.length === 0) return changes;

  return { since: changes.since, until: cut, upserts, deletions };
}

export async function readSyncState(db: Db, peerId: string): Promise<SyncState> {
  const existing = await db.syncState.get(peerId);
  if (existing) return existing;
  return { id: peerId, lastPulledAt: 0, lastPushedAt: 0, lastSyncedAt: 0, modified: 0 };
}

/** Run a round with one peer. */
export async function syncWith(
  db: Db,
  transport: SyncTransport,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());
  const state = await readSyncState(db, transport.peerId);

  // --- pull ---
  const incoming = await transport.pull(state.lastPulledAt);
  const pulled = incoming.upserts.length + incoming.deletions.length > 0
    ? await applyChanges(db, incoming)
    : emptyCounts();

  // --- push ---
  const at = now();
  let pushed = { upserts: 0, deletions: 0, remaining: 0 };
  let pushedThrough = at;

  if (!options.pullOnly) {
    const all = await changesSince(db, state.lastPushedAt, at);
    const limit = options.maxRecordsPerPush ?? DEFAULT_MAX_RECORDS_PER_PUSH;
    const outgoing = narrowWindow(all, limit);

    if (outgoing.upserts.length + outgoing.deletions.length > 0) {
      await transport.push(outgoing);
    }
    pushed = {
      upserts: outgoing.upserts.length,
      deletions: outgoing.deletions.length,
      remaining:
        all.upserts.length + all.deletions.length -
        (outgoing.upserts.length + outgoing.deletions.length),
    };
    // The watermark may only claim what was actually sent. Advancing to
    // `at` after a partial push would put everything left behind below an
    // exclusive lower bound, and it would never be offered again — the
    // same permanent loss the pull side had, mirrored.
    pushedThrough = outgoing.until;
  }

  const next: SyncState = {
    id: transport.peerId,
    // Their clock for the pull bound, ours for the push bound. Mixing them
    // up is the classic way to silently skip records when clocks differ.
    lastPulledAt: incoming.until,
    lastPushedAt: options.pullOnly ? state.lastPushedAt : pushedThrough,
    lastSyncedAt: at,
    modified: at,
  };
  await db.syncState.put(next);

  return {
    peerId: transport.peerId,
    pulled,
    pushed,
    lastPulledAt: next.lastPulledAt,
    lastPushedAt: next.lastPushedAt,
  };
}

/** Forget a peer's watermarks, so the next round re-reads everything. */
export async function resetSyncState(db: Db, peerId: string): Promise<void> {
  await db.syncState.delete(peerId);
}
