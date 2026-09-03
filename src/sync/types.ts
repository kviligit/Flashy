/**
 * The shape a sync transport has to satisfy.
 *
 * Two methods, both speaking in `ChangeSet`s, which are plain serialisable
 * objects. A file on a memory stick, a server, a nostr relay and the
 * loopback used in the tests are all the same thing from here.
 */

import type { ChangeSet } from '../storage/index.js';

export interface SyncTransport {
  /** A name for the peer, used as the key for watermarks. */
  readonly peerId: string;
  /** Everything the peer has recorded after `since`, on the peer's clock. */
  pull(since: number): Promise<ChangeSet>;
  /** Hand the peer our changes. */
  push(changes: ChangeSet): Promise<void>;
}

export interface MergeCounts {
  /** Records written because they were newer or new. */
  applied: number;
  /** Records ignored because the local copy was newer. */
  skipped: number;
  /** Records where both sides had changed since they last agreed. */
  conflicts: number;
  /**
   * Review logs added. Append-only, so these never conflict — and a merge
   * refuses to delete one, which is what makes that claim true against a
   * hostile peer rather than merely true of honest ones.
   */
  reviewLogs: number;
  /** Records removed by a tombstone. */
  deleted: number;
  /** Records refused outright as malformed or impossible. */
  rejected: number;
  /** Tombstones ignored because the record had been changed since. */
  deletionsRejected: number;
  /** Cards whose scheduling state was recomputed from merged history. */
  cardsReplayed: number;
  /**
   * Cards whose replay threw and was skipped.
   *
   * Never expected. It is counted rather than thrown because one bad card
   * must not abort a merge — a wrong schedule on one card is recoverable,
   * a device that can no longer complete a round is not.
   */
  replayFailures: number;
}

export interface SyncResult {
  peerId: string;
  pulled: MergeCounts;
  pushed: {
    upserts: number;
    deletions: number;
    /**
     * Records this round did not get to, because the push was capped.
     *
     * Non-zero means run another round; the watermark was left where those
     * records are still above it.
     */
    remaining: number;
  };
  /** Watermarks after this round. */
  lastPulledAt: number;
  lastPushedAt: number;
}

export function emptyCounts(): MergeCounts {
  return {
    applied: 0,
    skipped: 0,
    conflicts: 0,
    reviewLogs: 0,
    deleted: 0,
    rejected: 0,
    deletionsRejected: 0,
    cardsReplayed: 0,
    replayFailures: 0,
  };
}
