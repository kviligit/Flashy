/**
 * A `SyncTransport` over nostr relays.
 *
 * The shape of the thing: a device's collection changes, the change set is
 * chunked, each chunk is encrypted to the user's *own* key and published
 * as an event. The user's other devices ask their relays for events by
 * that same key, decrypt them, and merge. The relay carries ciphertext it
 * cannot read and hands it to whoever holds the key — which is only ever
 * the user.
 *
 * Encrypting to yourself is the point, not a placeholder. A flashcard
 * collection is a detailed record of what someone is studying, how often
 * they get it wrong, and when they are awake. Publishing that in the clear
 * on public infrastructure would be indefensible. NIP-44 with the
 * conversation key derived from the user's own secret and public key gives
 * a payload only that key can open.
 *
 * What a relay still learns is unavoidable and is worth stating plainly:
 * that this pubkey syncs, from how many devices, how often, and roughly
 * how much data. Nothing here hides that, and nothing pretends to.
 *
 * ## Decisions taken here, and why
 *
 * **Kind 9078.** A regular event, so relays store it rather than replacing
 * it — a change feed is a log, and a replaceable kind would keep only the
 * most recent chunk. 9078 echoes NIP-78's 30078 ("application-specific
 * data") while staying in the regular range. Relays are free to refuse
 * kinds they do not recognise; that shows up as a rejected publish with
 * the relay's own reason attached, rather than as silence.
 *
 * **Seconds, with a lookback.** NIP-01 filters on `created_at`, which is
 * in seconds, while the change feed's watermarks are in milliseconds.
 * Rather than keep two clocks, the transport asks the relay for a window
 * that starts a day earlier than it needs and filters precisely itself.
 * A day is the same bound the merge layer already allows for clock skew,
 * and re-fetching a day of events costs bandwidth rather than
 * correctness: applying a change twice is a no-op by construction.
 *
 * **Chunks are independent.** Each is a complete change set over a subset
 * of records. A device applies whichever ones it has; the rest arrive on
 * a later round. There is no partial state to hold and nothing to
 * reassemble, which is what makes an unreliable relay merely slow.
 *
 * **A device ignores its own events.** They carry the device id in a tag,
 * so a device filters out its own echo at the relay rather than merging
 * its own changes back into itself.
 */

import type { ChangeSet } from '../storage/index.js';
import { tagValue, type NostrEvent, type UnsignedEvent } from '../nostr/index.js';
import type { Filter, Relay } from '../nostr/relay.js';
import type { Signer } from '../nostr/signer.js';
import type { SyncTransport } from './types.js';
import {
  chunkChangeSet,
  decodeChangeSet,
  MAX_CHUNK_BYTES,
  type Oversized,
} from './wire.js';

/** The event kind this app publishes. See the note above. */
export const FLASHY_KIND = 9078;

/** Tag names. Single letters are the ones relays index and can filter on. */
export const DEVICE_TAG = 'd';
export const APP_TAG = 'l';
export const APP_NAME = 'flashy-sync-v1';

/**
 * How far back to widen the relay query, in seconds.
 *
 * Covers both the seconds/milliseconds rounding and a peer whose clock is
 * behind ours. Matches the merge layer's own skew allowance so the two do
 * not disagree about what "too old to be real" means.
 */
export const LOOKBACK_SECONDS = 24 * 60 * 60;

export interface NostrTransportOptions {
  /**
   * Who holds the key. An extension signer never lets the secret into this
   * page, which is the difference between a stolen key and a stolen
   * session if anything ever does manage to run script here.
   */
  signer: Signer;
  /** The signer's public key, resolved once by `openTransport`. */
  pubkey: string;
  /** This device's id, so its own events can be filtered out. */
  deviceId: string;
  /** Connected relays. A push goes to all of them; a pull unions them. */
  relays: Relay[];
  /** Overrides the `peerId` used for watermarks. */
  peerId?: string;
  /** Chunk size, exposed so tests can force chunking without huge data. */
  maxChunkBytes?: number;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Called for records too large to send, and for per-relay failures. */
  onProblem?: (problem: TransportProblem) => void;
}

export type TransportProblem =
  | { kind: 'oversized'; record: Oversized }
  | { kind: 'relay-failed'; url: string; error: Error }
  | { kind: 'undecodable'; eventId: string; reason: string };

/**
 * A transport is bound to one key, one device and a set of relays.
 *
 * `pull` and `push` are the whole interface. Everything above — the sync
 * engine, the merge policy, the scheduler replay — is unchanged and does
 * not know a relay exists.
 */
export class NostrTransport implements SyncTransport {
  readonly peerId: string;
  readonly pubkey: string;
  private readonly signer: Signer;
  private readonly deviceId: string;
  private readonly relays: Relay[];
  private readonly maxChunkBytes: number;
  private readonly now: () => number;
  private readonly onProblem: (problem: TransportProblem) => void;

  /** Records left behind on the most recent push, for the caller to show. */
  lastOversized: Oversized[] = [];

  constructor(options: NostrTransportOptions) {
    this.signer = options.signer;
    this.pubkey = options.pubkey;
    this.deviceId = options.deviceId;
    this.relays = options.relays;
    this.maxChunkBytes = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.onProblem = options.onProblem ?? (() => {});
    // Watermarks are per peer, and the peer here is the account, not any
    // one relay: moving a device between relays must not re-sync from zero.
    this.peerId = options.peerId ?? `nostr:${this.pubkey}`;
  }

  /**
   * Everything our other devices have published since `since`.
   *
   * Relays are queried in parallel and their answers unioned by event id,
   * so a relay that has half the events and a relay that has the other
   * half together have all of them. A relay that fails is reported and
   * skipped: partial results are useful, and one broken relay in a list
   * of five should not stop a sync.
   */
  async pull(since: number): Promise<ChangeSet> {
    const filter: Filter = {
      kinds: [FLASHY_KIND],
      authors: [this.pubkey],
      '#l': [APP_NAME],
      since: Math.max(0, Math.floor(since / 1000) - LOOKBACK_SECONDS),
    };

    const results = await Promise.all(
      this.relays.map(async (relay) => {
        try {
          return await relay.query([filter]);
        } catch (error) {
          this.onProblem({
            kind: 'relay-failed',
            url: relay.url,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return [] as NostrEvent[];
        }
      }),
    );

    const byId = new Map<string, NostrEvent>();
    for (const events of results) for (const event of events) byId.set(event.id, event);

    const merged: ChangeSet = { since, until: since, upserts: [], deletions: [] };
    let highest = since;

    for (const event of byId.values()) {
      // Our own echo. The relay was asked not to send it; relays are not
      // required to be obedient, so it is checked again here.
      if (tagValue(event, DEVICE_TAG) === this.deviceId) continue;

      let chunk: ChangeSet & { device: string };
      try {
        const plaintext = await this.signer.decrypt(this.pubkey, event.content);
        chunk = decodeChangeSet(JSON.parse(plaintext));
      } catch (error) {
        // One bad event must not fail the round. A peer running unreleased
        // code, or a truncated payload, should cost that chunk and nothing
        // more.
        this.onProblem({
          kind: 'undecodable',
          eventId: event.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (chunk.device === this.deviceId) continue;
      // The window is widened to cover skew, so the precise cut is made
      // here, on the millisecond watermarks the change feed actually uses.
      if (chunk.until <= since) continue;

      merged.upserts.push(...chunk.upserts);
      merged.deletions.push(...chunk.deletions);
      if (chunk.until > highest) highest = chunk.until;
    }

    // Applying in version order keeps the merge deterministic regardless of
    // the order relays happened to answer in.
    merged.upserts.sort((a, b) => a.version - b.version);
    merged.until = highest;
    return merged;
  }

  /**
   * Publish a change set.
   *
   * Every chunk must reach at least one relay. A chunk that reaches none
   * is a failure of the whole push, because the engine advances its push
   * watermark on success and would never offer those records again.
   */
  async push(changes: ChangeSet): Promise<void> {
    const { chunks, oversized } = chunkChangeSet(changes, this.deviceId, this.maxChunkBytes);
    this.lastOversized = oversized;
    for (const record of oversized) this.onProblem({ kind: 'oversized', record });
    if (chunks.length === 0) return;

    const createdAt = Math.floor(this.now() / 1000);

    for (const chunk of chunks) {
      const content = await this.signer.encrypt(this.pubkey, JSON.stringify(chunk));
      const unsigned: UnsignedEvent = {
        pubkey: this.pubkey,
        created_at: createdAt,
        kind: FLASHY_KIND,
        tags: [
          [DEVICE_TAG, this.deviceId],
          [APP_TAG, APP_NAME],
        ],
        content,
      };
      const event = await this.signer.signEvent(unsigned);

      const failures: Error[] = [];
      let delivered = 0;
      await Promise.all(
        this.relays.map(async (relay) => {
          try {
            await relay.publish(event);
            delivered += 1;
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failures.push(failure);
            this.onProblem({ kind: 'relay-failed', url: relay.url, error: failure });
          }
        }),
      );

      if (delivered === 0) {
        const why = failures.map((error) => error.message).join('; ') || 'no relays configured';
        throw new Error(`no relay accepted chunk ${chunk.seq + 1}/${chunk.of}: ${why}`);
      }
    }
  }
}

/**
 * Build a transport, resolving the signer's public key first.
 *
 * With an extension signer, asking for the public key can prompt the user,
 * so it happens once here rather than inside every pull and push.
 */
export async function openTransport(
  options: Omit<NostrTransportOptions, 'pubkey'>,
): Promise<NostrTransport> {
  const pubkey = await options.signer.getPublicKey();
  return new NostrTransport({ ...options, pubkey });
}
