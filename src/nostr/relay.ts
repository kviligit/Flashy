/**
 * A NIP-01 relay client.
 *
 * A relay is a WebSocket that carries JSON arrays in both directions. The
 * protocol is small enough to write out in full:
 *
 * - we send `["EVENT", <event>]` to publish, `["REQ", <subId>, <filter>…]`
 *   to ask for events, `["CLOSE", <subId>]` to stop asking;
 * - it sends `["EVENT", <subId>, <event>]`, `["OK", <id>, <bool>, <msg>]`,
 *   `["EOSE", <subId>]`, `["CLOSED", <subId>, <msg>]` and
 *   `["NOTICE", <msg>]`.
 *
 * A relay is untrusted infrastructure operated by a stranger. It can drop
 * events, invent events, replay old ones, reorder anything and lie about
 * all of it. The two defences that matter are both here: every event is
 * verified (id re-derived, signature checked) before it reaches a caller,
 * and every event is checked against the filter that asked for it, because
 * a relay answering "give me kind 9078 from author X" with something else
 * is either broken or hostile and there is no reason to find out which.
 *
 * What a relay cannot do is read the contents: those are encrypted a layer
 * up, in the transport. It does learn metadata — that this pubkey syncs,
 * how often, and roughly how much. That is inherent to using a relay and
 * is written down in docs/sync.md rather than glossed over.
 *
 * No automatic reconnection. A sync round is a short-lived, explicitly
 * driven thing: open, do the round, close. Reconnect logic belongs to
 * whatever decides that rounds should keep happening, not here.
 */

import { isWellFormed, verifyEvent, type NostrEvent } from './event.js';

/**
 * The part of a WebSocket this client uses.
 *
 * A browser `WebSocket` satisfies it as-is; so does the in-process fake
 * relay used by the tests, without implementing the rest of the DOM
 * interface.
 */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RelaySocket;

/** A NIP-01 subscription filter. Tag filters go in as `#e`, `#d` and so on. */
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  /** Inclusive lower bound on `created_at`, in seconds. */
  since?: number;
  /** Inclusive upper bound on `created_at`, in seconds. */
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined | number[] | number | string[];
}

export interface RelayOptions {
  /** How a socket is created. Defaults to the global `WebSocket`. */
  socket?: SocketFactory;
  /** How long to wait for the connection, a publish, or an EOSE. */
  timeoutMs?: number;
  /**
   * Most events one query may return.
   *
   * A relay can answer any query with an unbounded stream. Without a cap,
   * one hostile relay is an out-of-memory crash, so a query that exceeds
   * this stops early rather than growing forever.
   */
  maxEvents?: number;
  /** Largest single relay message accepted, in characters. */
  maxMessageChars?: number;
  /**
   * Most events one subscription may be *offered*, accepted or not.
   *
   * `maxEvents` bounds what a query returns; this bounds what a relay can
   * make the device look at. Without it, a relay that sends nothing
   * matching the filter is unbounded, because nothing it sends counts.
   */
  maxOffered?: number;
  /** Called with anything the relay says on NOTICE, for diagnostics. */
  onNotice?: (message: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_EVENTS = 5_000;
/**
 * 512KB of characters. Relays commonly cap events around 256KB; twice that
 * leaves room for the envelope without letting a stream of one enormous
 * message exhaust memory.
 */
export const DEFAULT_MAX_MESSAGE_CHARS = 512 * 1024;
/** Ten times the accept cap: generous for duplicates, closed to a flood. */
export const DEFAULT_MAX_OFFERED = 50_000;

export class RelayError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  filters: Filter[];
  events: NostrEvent[];
  seen: Set<string>;
  /** Everything the relay sent for this subscription, accepted or not. */
  offered: number;
  resolve: (events: NostrEvent[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultSocketFactory(url: string): RelaySocket {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!ctor) throw new RelayError('no WebSocket implementation available', url);
  return new ctor(url) as unknown as RelaySocket;
}

/**
 * True when `event` is one the filter actually asked for.
 *
 * Applied to everything a relay sends. A relay that ignores a filter is
 * not usable, and quietly merging its answers into the collection is how a
 * stranger's data ends up in someone's deck.
 */
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(wanted)) continue;
    const name = key.slice(1);
    const values = event.tags
      .filter((tag) => tag[0] === name && typeof tag[1] === 'string')
      .map((tag) => tag[1] as string);
    if (!values.some((value) => (wanted as string[]).includes(value))) return false;
  }
  return true;
}

/** One connection to one relay. */
export class Relay {
  private socket: RelaySocket | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private nextId = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly publishes = new Map<string, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly timeoutMs: number;
  private readonly maxEvents: number;
  private readonly maxMessageChars: number;
  private readonly maxOffered: number;
  private readonly factory: SocketFactory;
  private readonly onNotice: (message: string) => void;

  constructor(
    readonly url: string,
    options: RelayOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.maxOffered = options.maxOffered ?? DEFAULT_MAX_OFFERED;
    this.factory = options.socket ?? defaultSocketFactory;
    this.onNotice = options.onNotice ?? (() => {});
  }

  /** Connect, or return the connection already being made. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new RelayError('relay is closed', this.url));
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      let socket: RelaySocket;
      try {
        socket = this.factory(this.url);
      } catch (error) {
        reject(new RelayError(`could not open ${this.url}: ${String(error)}`, this.url));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        this.fail(new RelayError('timed out connecting', this.url));
      }, this.timeoutMs);

      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onmessage = (event) => this.receive(event.data);
      socket.onerror = () => {
        clearTimeout(timer);
        const error = new RelayError('socket error', this.url);
        reject(error);
        this.fail(error);
      };
      socket.onclose = () => {
        clearTimeout(timer);
        const error = new RelayError('connection closed', this.url);
        reject(error);
        this.fail(error);
      };
    });

    // A rejected connect() that nobody awaited must not become an unhandled
    // rejection; every caller goes through connect() and will see it.
    this.opening.catch(() => {});
    return this.opening;
  }

  /**
   * Publish one event and wait for the relay's OK.
   *
   * Resolves only on `["OK", id, true, …]`. A relay that accepts the socket
   * write and then says nothing is a failure, not a success: the whole
   * point of waiting is to know the event was stored.
   */
  async publish(event: NostrEvent): Promise<void> {
    await this.connect();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.publishes.delete(event.id);
        reject(new RelayError('timed out waiting for OK', this.url));
      }, this.timeoutMs);
      this.publishes.set(event.id, { resolve, reject, timer });
      this.send(['EVENT', event]);
    });
  }

  /**
   * Ask for everything matching `filters` and resolve at EOSE.
   *
   * "Everything stored" is what EOSE means; events arriving after it are
   * live updates, which a sync round has no use for, so the subscription
   * is closed there.
   */
  async query(filters: Filter[]): Promise<NostrEvent[]> {
    await this.connect();
    const id = `f${this.nextId++}`;

    return new Promise<NostrEvent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const subscription = this.subscriptions.get(id);
        this.subscriptions.delete(id);
        this.trySend(['CLOSE', id]);
        // A relay that never sends EOSE has still sent real, verified
        // events; throwing them away would make a slow relay a broken one.
        if (subscription && subscription.events.length > 0) resolve(subscription.events);
        else reject(new RelayError('timed out waiting for EOSE', this.url));
      }, this.timeoutMs);

      this.subscriptions.set(id, {
        filters,
        events: [],
        seen: new Set(),
        offered: 0,
        resolve,
        reject,
        timer,
      });
      this.send(['REQ', id, ...filters]);
    });
  }

  /** Close the socket and fail anything still waiting. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Closing an already-dead socket is not an error worth reporting.
    }
    this.settleAll(new RelayError('relay closed locally', this.url));
  }

  private send(message: unknown[]): void {
    const socket = this.socket;
    if (!socket) throw new RelayError('not connected', this.url);
    socket.send(JSON.stringify(message));
  }

  private trySend(message: unknown[]): void {
    try {
      this.send(message);
    } catch {
      // Best-effort teardown; the caller is already unwinding.
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // As above.
    }
    this.settleAll(error);
  }

  private settleAll(error: Error): void {
    for (const pending of this.publishes.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.publishes.clear();
    for (const subscription of this.subscriptions.values()) {
      clearTimeout(subscription.timer);
      // Events already verified are worth keeping even if the socket died
      // before EOSE; a partial pull is safe because merging is idempotent.
      if (subscription.events.length > 0) subscription.resolve(subscription.events);
      else subscription.reject(error);
    }
    this.subscriptions.clear();
  }

  /**
   * Messages are handled strictly in the order they arrived.
   *
   * Verifying an event is asynchronous — a signature check involves curve
   * arithmetic — while EOSE is handled synchronously. Without this queue,
   * the EOSE that a relay sends immediately after a batch of events
   * resolves the subscription while those events are still being verified,
   * and the query returns empty. The relay is behaving correctly; the
   * client would be losing the answer.
   */
  private receive(data: unknown): void {
    this.queue = this.queue.then(() => this.dispatch(data)).catch(() => {});
  }

  private async dispatch(data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    if (data.length > this.maxMessageChars) {
      this.onNotice(`oversized message (${data.length} chars) discarded`);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.onNotice('unparseable message discarded');
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== 'string') return;

    switch (message[0]) {
      case 'OK':
        this.handleOk(message);
        return;
      case 'EVENT':
        await this.handleEvent(message);
        return;
      case 'EOSE':
        this.handleEose(message);
        return;
      case 'CLOSED':
        this.handleClosed(message);
        return;
      case 'NOTICE':
        if (typeof message[1] === 'string') this.onNotice(message[1]);
        return;
      default:
        return;
    }
  }

  private handleOk(message: unknown[]): void {
    const [, id, accepted, reason] = message;
    if (typeof id !== 'string') return;
    const pending = this.publishes.get(id);
    if (!pending) return;
    this.publishes.delete(id);
    clearTimeout(pending.timer);
    if (accepted === true) pending.resolve();
    else {
      const why = typeof reason === 'string' && reason ? reason : 'no reason given';
      pending.reject(new RelayError(`relay rejected event: ${why}`, this.url));
    }
  }

  /**
   * The order of these checks is the whole defence against a relay
   * grinding the device to a halt.
   *
   * Verifying a signature is two scalar multiplications on a curve, in
   * JavaScript bigints — about seven milliseconds. Everything else here is
   * free. So the free checks run first: the id must be new, and the event
   * must match a filter we actually sent. A relay can compute correct ids
   * (it only needs SHA-256) and attach junk signatures, so verifying
   * before filtering let it choose how much CPU this device spent. The
   * accepted-event cap did not bound that, because it only counted events
   * that had already passed.
   *
   * Filtering unverified data is safe as long as nothing is *believed*
   * before verification, and nothing is: an event that clears the filter
   * still has to verify before it reaches `events`, and every field the
   * filter reads is covered by the signature.
   */
  private async handleEvent(message: unknown[]): Promise<void> {
    const [, id, event] = message;
    if (typeof id !== 'string') return;
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;

    // A relay is allowed to be wrong, not to be unbounded. Everything it
    // sends counts against this, verified or not.
    subscription.offered += 1;
    if (subscription.offered > this.maxOffered) {
      this.subscriptions.delete(id);
      clearTimeout(subscription.timer);
      this.trySend(['CLOSE', id]);
      this.onNotice(`relay sent more than ${this.maxOffered} events; stopping`);
      subscription.resolve(subscription.events);
      return;
    }

    if (!isWellFormed(event)) {
      this.onNotice('discarded an unverifiable event: malformed');
      return;
    }
    if (subscription.seen.has(event.id)) return;
    if (!subscription.filters.some((filter) => matchesFilter(event, filter))) {
      this.onNotice('discarded an event that matched no filter');
      return;
    }
    // Claimed now, before the await, so a relay cannot get the same id
    // verified many times over by sending it faster than we verify it.
    subscription.seen.add(event.id);

    const verification = await verifyEvent(event);
    if (!verification.ok) {
      this.onNotice(`discarded an unverifiable event: ${verification.reason}`);
      return;
    }
    const verified = verification.event;

    // The subscription may have ended while the signature was being
    // checked; re-read rather than using the reference captured above.
    const live = this.subscriptions.get(id);
    if (!live) return;

    live.events.push(verified);

    if (live.events.length >= this.maxEvents) {
      this.subscriptions.delete(id);
      clearTimeout(live.timer);
      this.trySend(['CLOSE', id]);
      live.resolve(live.events);
    }
  }

  private handleEose(message: unknown[]): void {
    const id = message[1];
    if (typeof id !== 'string') return;
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    clearTimeout(subscription.timer);
    this.trySend(['CLOSE', id]);
    subscription.resolve(subscription.events);
  }

  private handleClosed(message: unknown[]): void {
    const [, id, reason] = message;
    if (typeof id !== 'string') return;
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    clearTimeout(subscription.timer);
    if (subscription.events.length > 0) subscription.resolve(subscription.events);
    else {
      const why = typeof reason === 'string' && reason ? reason : 'no reason given';
      subscription.reject(new RelayError(`relay closed the subscription: ${why}`, this.url));
    }
  }
}

/** Open a relay and wait until it is connected. */
export async function openRelay(url: string, options: RelayOptions = {}): Promise<Relay> {
  const relay = new Relay(url, options);
  await relay.connect();
  return relay;
}
