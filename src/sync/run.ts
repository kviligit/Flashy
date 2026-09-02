/**
 * One button's worth of work: open the relays, run a round, close them.
 *
 * Kept apart from the settings screen so the whole path — read the
 * account, build a signer, connect, sync, report — can be exercised
 * without a DOM, and so a future background sync can call exactly what
 * the button calls.
 *
 * Sockets are opened per round rather than held open. A round is short and
 * explicit; a persistent connection would mean reconnection logic, backoff
 * and a socket kept alive on a phone in someone's pocket, all to save a
 * handshake. If live updates are ever wanted, that is the moment to keep
 * the connection, and it is a change to this file alone.
 */

import type { Db } from '../storage/index.js';
import { Relay, type SocketFactory } from '../nostr/relay.js';
import { readAccount, readiness, type KeyValueStore, type SyncAccount } from './account.js';
import { openTransport, type TransportProblem } from './nostr-transport.js';
import { syncWith } from './engine.js';
import type { SyncResult } from './types.js';

export interface RunSyncOptions {
  /** Defaults to whatever is stored. */
  account?: SyncAccount;
  store?: KeyValueStore;
  /** Where `window.nostr` is looked for. */
  scope?: unknown;
  /** Injected in tests; production uses the global WebSocket. */
  socket?: SocketFactory;
  deviceId?: string;
  now?: () => number;
  timeoutMs?: number;
}

export type RunOutcome =
  | { ok: true; result: SyncResult; problems: TransportProblem[] }
  | { ok: false; reason: string; problems: TransportProblem[] };

export async function runSync(db: Db, options: RunSyncOptions = {}): Promise<RunOutcome> {
  const account = options.account ?? readAccount(options.store);
  const state = readiness(account, options.store, options.scope ?? globalThis);
  const problems: TransportProblem[] = [];
  if (!state.ready) return { ok: false, reason: state.reason, problems };

  // The device id is the collection's, not the account's: two devices
  // share one key and must still be able to tell their events apart.
  const deviceId = options.deviceId ?? (await db.meta.get('meta'))?.deviceId;
  if (!deviceId) return { ok: false, reason: 'This collection has no device id.', problems };

  const relays = state.relays.map(
    (url) =>
      new Relay(url, {
        ...(options.socket ? { socket: options.socket } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        onNotice: (message) => problems.push({ kind: 'undecodable', eventId: url, reason: message }),
      }),
  );

  try {
    const transport = await openTransport({
      signer: state.signer,
      deviceId,
      relays,
      ...(options.now ? { now: options.now } : {}),
      onProblem: (problem) => problems.push(problem),
    });
    const result = await syncWith(db, transport, options.now ? { now: options.now } : {});
    return { ok: true, result, problems };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      problems,
    };
  } finally {
    // Whatever happened, do not leave sockets open.
    for (const relay of relays) relay.close();
  }
}

/** A one-line summary of a round, for a status area. */
export function describeOutcome(outcome: RunOutcome): string {
  if (!outcome.ok) return outcome.reason;

  const { pulled, pushed } = outcome.result;
  const taken = pulled.applied + pulled.reviewLogs + pulled.deleted;
  const sent = pushed.upserts + pushed.deletions;

  if (taken === 0 && sent === 0) return 'Already up to date.';

  const parts: string[] = [];
  if (taken > 0) parts.push(`${taken} ${taken === 1 ? 'change' : 'changes'} received`);
  if (sent > 0) parts.push(`${sent} sent`);
  if (pulled.conflicts > 0) {
    parts.push(`${pulled.conflicts} resolved in favour of the later edit`);
  }
  if (pulled.rejected > 0) parts.push(`${pulled.rejected} refused`);
  return `${parts.join(', ')}.`;
}
