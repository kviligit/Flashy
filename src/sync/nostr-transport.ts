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
import { MAX_CLOCK_SKEW_MS } from './merge.js';
import { tagValue, toPublicKeyHex, type NostrEvent, type UnsignedEvent } from '../nostr/index.js';
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

/**
 * Records one round will take before stopping and asking to be run again.
 *
 * Chosen against the collection sizes the benchmarks cover rather than a
 * round number: 20,000 records is a large collection's worth of changes,
 * and holding that many decoded upserts is tens of megabytes, not hundreds.
 */
export const DEFAULT_MAX_RECORDS_PER_ROUND = 20_000;

/**
 * How many of a push's events to read back afterwards.
 *
 * A sample, not the lot: the point is to catch a relay that stored nothing
 * at all, and one query is enough for that. Reading back every event of a
 * large push would double the round's cost to re-confirm what the first
 * few already established.
 */
export const CONFIRM_SAMPLE = 20;

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
  /**
   * Most records one round will take.
   *
   * A relay holding a large history can answer a first sync with far more
   * than a phone can hold at once. Past this the round stops early and
   * declines to advance its watermark, so the remainder arrives next time.
   */
  maxRecordsPerRound?: number;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Called for records too large to send, and for per-relay failures. */
  onProblem?: (problem: TransportProblem) => void;
}

export type TransportProblem =
  | { kind: 'oversized'; record: Oversized }
  | { kind: 'relay-failed'; url: string; error: Error }
  | { kind: 'undecodable'; eventId: string; reason: string }
  /** Something a relay said about itself. Diagnostic, not an event. */
  | { kind: 'relay-notice'; url: string; message: string };

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
  private readonly maxRecordsPerRound: number;
  private readonly now: () => number;
  private readonly onProblem: (problem: TransportProblem) => void;

  /** Records left behind on the most recent push, for the caller to show. */
  lastOversized: Oversized[] = [];
  /**
   * True when the last pull did not see everything it asked for.
   *
   * The engine still stores a watermark, so this is how a caller learns
   * that "nothing came back" meant "nothing was reachable" rather than
   * "nothing has changed".
   */
  incomplete = false;

  constructor(options: NostrTransportOptions) {
    this.signer = options.signer;
    this.pubkey = options.pubkey;
    this.deviceId = options.deviceId;
    this.relays = options.relays;
    this.maxChunkBytes = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
    this.maxRecordsPerRound = options.maxRecordsPerRound ?? DEFAULT_MAX_RECORDS_PER_ROUND;
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

    let everyRelayAnswered = this.relays.length > 0;
    const results = await Promise.all(
      this.relays.map(async (relay) => {
        try {
          return await relay.query([filter]);
        } catch (error) {
          everyRelayAnswered = false;
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
    let records = 0;
    let truncated = false;

    // The relay window is widened by a day to cover skew and the
    // seconds/milliseconds rounding, and the client-side cut has to be
    // widened by the same amount or it throws away everything the window
    // just went to the trouble of re-fetching. Re-applying a change is a
    // no-op by construction; losing one is permanent, so the asymmetry
    // decides which way to err.
    const cut = since - LOOKBACK_SECONDS * 1000;

    for (const event of byId.values()) {
      // Our own echo. Nothing in the filter excludes it — two devices share
      // one key, so the author field cannot tell them apart — so this is
      // where it is actually dropped, not at the relay.
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
      if (chunk.until <= cut) continue;

      // A round has to fit in memory on a phone. Past the budget we stop
      // taking records and refuse to advance the watermark, so the rest
      // arrives on the next round rather than being lost.
      if (records + chunk.upserts.length + chunk.deletions.length > this.maxRecordsPerRound) {
        truncated = true;
        continue;
      }
      records += chunk.upserts.length + chunk.deletions.length;

      merged.upserts.push(...chunk.upserts);
      merged.deletions.push(...chunk.deletions);
      if (chunk.until > highest) highest = chunk.until;
    }

    // Applying in version order keeps the merge deterministic regardless of
    // the order relays happened to answer in.
    merged.upserts.sort((a, b) => a.version - b.version);

    // The watermark is a claim that everything before it has been seen, so
    // it may only move when that is actually true. A relay that timed out,
    // dropped the socket, or was cut short mid-answer leaves the round
    // incomplete, and advancing past it would put the events it still owes
    // us permanently below the cut.
    const complete = everyRelayAnswered && !truncated;
    if (!complete) {
      this.incomplete = true;
      merged.until = since;
      return merged;
    }
    this.incomplete = false;

    // A peer's clock is a peer's claim. Believing one that says next
    // century would deafen this device for ever, and there is no UI to
    // recover from that — so a timestamp beyond the skew allowance moves
    // the watermark no further than now.
    merged.until = Math.min(highest, this.now() + MAX_CLOCK_SKEW_MS);
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
    const published: string[] = [];

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
      published.push(event.id);
    }

    // An OK is a promise, not a receipt. Relays prune, run out of disk, and
    // drop kinds they do not recognise after accepting them — and the
    // engine advances its push watermark on the strength of this returning,
    // after which `changesSince` will never offer those records again. So
    // the last thing a push does is ask for what it just wrote back.
    await this.confirmPublished(published);
  }

  /**
   * Check that at least one relay actually kept what we just sent.
   *
   * Deliberately not per-event: a relay may legitimately not return every
   * id in one query, and failing a whole round over that would make sync
   * flap. What this catches is the case that matters — a relay that
   * acknowledges everything and stores nothing, which silently turns the
   * backup this feature exists to provide into an empty one.
   */
  private async confirmPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const wanted = ids.slice(-CONFIRM_SAMPLE);
    const found = new Set<string>();
    for (const relay of this.relays) {
      try {
        for (const event of await relay.query([{ ids: wanted }])) found.add(event.id);
      } catch (error) {
        this.onProblem({
          kind: 'relay-failed',
          url: relay.url,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    if (found.size === 0) {
      throw new Error(
        'the relays acknowledged this push but none of it can be read back; ' +
          'treating it as not sent rather than losing it',
      );
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
  const raw = await options.signer.getPublicKey();
  // Extensions are third-party code and some return an npub. Passing that
  // through unchecked yields a transport that connects, queries an author
  // nobody has ever published under, finds nothing, and reports success.
  const pubkey = toPublicKeyHex(raw);
  if (!pubkey) {
    throw new Error(`the signer returned "${raw}", which is not a public key`);
  }
  return new NostrTransport({ ...options, pubkey });
}
