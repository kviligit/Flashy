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

import { changesSince, type Db } from '../storage/index.js';
import type { SyncState } from '../domain/types.js';
import { applyChanges } from './merge.js';
import { emptyCounts, type SyncResult, type SyncTransport } from './types.js';

export interface SyncOptions {
  /** Clock, injected so tests can pin timestamps. */
  now?: () => number;
  /** Skip sending anything; useful for a read-only first look at a peer. */
  pullOnly?: boolean;
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
  let pushed = { upserts: 0, deletions: 0 };
  if (!options.pullOnly) {
    const outgoing = await changesSince(db, state.lastPushedAt, at);
    if (outgoing.upserts.length + outgoing.deletions.length > 0) {
      await transport.push(outgoing);
    }
    pushed = { upserts: outgoing.upserts.length, deletions: outgoing.deletions.length };
  }

  const next: SyncState = {
    id: transport.peerId,
    // Their clock for the pull bound, ours for the push bound. Mixing them
    // up is the classic way to silently skip records when clocks differ.
    lastPulledAt: incoming.until,
    lastPushedAt: options.pullOnly ? state.lastPushedAt : at,
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
