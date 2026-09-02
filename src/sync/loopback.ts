/**
 * A transport that talks to another database in the same process.
 *
 * Its job is to make the engine testable without a network: two `Db`
 * instances stand in for two devices, and a full round trip is a function
 * call. It is also the reference every other transport is measured
 * against — if a behaviour holds over loopback and not over the wire, the
 * wire is wrong.
 */

import { changesSince, type ChangeSet, type Db } from '../storage/index.js';
import { applyChanges } from './merge.js';
import type { SyncTransport } from './types.js';

export interface LoopbackOptions {
  peerId?: string;
  /** The peer's clock, if it differs from ours. */
  now?: () => number;
}

export function loopbackTransport(peer: Db, options: LoopbackOptions = {}): SyncTransport {
  const now = options.now ?? (() => Date.now());
  return {
    peerId: options.peerId ?? 'loopback',
    async pull(since: number): Promise<ChangeSet> {
      return changesSince(peer, since, now());
    },
    async push(changes: ChangeSet): Promise<void> {
      await applyChanges(peer, changes);
    },
  };
}
