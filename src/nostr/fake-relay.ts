/**
 * A NIP-01 relay running in this process, behind a fake WebSocket.
 *
 * No relay is reachable from the environment this project is built in, and
 * even where one is, testing against someone else's server makes the tests
 * a report on their uptime. This is a real relay in the only sense that
 * matters here — it speaks the wire protocol, stores events, and answers
 * filters — with the network replaced by a queued callback.
 *
 * It is also where hostile behaviour is rehearsed. A relay that tampers
 * with events, answers a filter with something else entirely, floods a
 * subscription, or never says EOSE is not a hypothetical; it is a Saturday
 * afternoon for anyone running a public relay. Each of those is a switch
 * here, and each has a test asserting the client survives it.
 *
 * Not part of the app. Nothing in `src/nostr/index.ts` exports it.
 */

import { isWellFormed, type NostrEvent } from './event.js';
import { matchesFilter, type Filter, type RelaySocket } from './relay.js';

/** Ways a relay can misbehave, each switchable independently. */
export interface FakeRelayFaults {
  /** Answer every REQ with this many copies of an unrelated event. */
  injectUnrequested?: NostrEvent;
  /** Flip one character of every event's content before sending it. */
  tamper?: boolean;
  /** Accept REQ and send events, but never EOSE. */
  dropEose?: boolean;
  /** Accept EVENT but never send OK. */
  dropOk?: boolean;
  /** Reject every publish with this reason. */
  rejectPublish?: string;
  /** Send this many copies of each stored event, to test the event cap. */
  duplicate?: number;
  /** Send a CLOSED instead of answering a REQ. */
  closeSubscriptions?: string;
  /** Answer every REQ with everything stored, filter or no filter. */
  ignoreFilters?: boolean;
  /**
   * Answer every publish with OK true and store nothing.
   *
   * Not a hypothetical: relays prune, fill their disks, and drop kinds
   * they do not recognise after having accepted them.
   */
  acceptAndDiscard?: boolean;
}

/** The store behind one or more connections. */
export class FakeRelay {
  readonly events: NostrEvent[] = [];
  readonly notices: string[] = [];
  faults: FakeRelayFaults = {};
  /** Every message a client has sent, in order, for assertions. */
  readonly received: unknown[][] = [];

  constructor(readonly url = 'wss://relay.test') {}

  /** Put an event in the store without going through the wire. */
  seed(event: NostrEvent): void {
    if (!this.events.some((stored) => stored.id === event.id)) this.events.push(event);
  }

  /** A socket factory to hand to `Relay`. */
  connect = (): RelaySocket => new FakeSocket(this);

  matching(filters: Filter[]): NostrEvent[] {
    const seen = new Set<string>();
    const found: NostrEvent[] = [];
    for (const filter of filters) {
      const hits = this.events.filter((event) => matchesFilter(event, filter));
      // NIP-01 says `limit` applies to the newest events, so sort before
      // truncating rather than after.
      hits.sort((a, b) => b.created_at - a.created_at);
      const limited = filter.limit === undefined ? hits : hits.slice(0, filter.limit);
      for (const event of limited) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        found.push(event);
      }
    }
    return found;
  }
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * The fake socket.
 *
 * Delivery is deferred with `queueMicrotask` so that a caller which sends
 * and then awaits behaves the way it does over a real socket: nothing is
 * ever delivered synchronously inside `send()`. Tests that pass only
 * because a reply arrived before the sender finished are worthless.
 */
class FakeSocket implements RelaySocket {
  readyState: number = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(private readonly relay: FakeRelay) {
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('socket is not open');
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.deliver(['NOTICE', 'invalid JSON']);
      return;
    }
    if (!Array.isArray(message)) return;
    this.relay.received.push(message);

    if (message[0] === 'EVENT') this.handlePublish(message[1]);
    else if (message[0] === 'REQ') this.handleRequest(message);
    // CLOSE needs no reply: the client has already stopped listening.
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.onclose?.({}));
  }

  private handlePublish(event: unknown): void {
    const faults = this.relay.faults;
    if (!isWellFormed(event)) {
      this.deliver(['OK', '', false, 'invalid: malformed event']);
      return;
    }
    if (faults.rejectPublish !== undefined) {
      this.deliver(['OK', event.id, false, faults.rejectPublish]);
      return;
    }
    if (!faults.acceptAndDiscard) this.relay.seed(event);
    if (faults.dropOk) return;
    this.deliver(['OK', event.id, true, '']);
  }

  private handleRequest(message: unknown[]): void {
    const id = message[1];
    if (typeof id !== 'string') return;
    const faults = this.relay.faults;

    if (faults.closeSubscriptions !== undefined) {
      this.deliver(['CLOSED', id, faults.closeSubscriptions]);
      return;
    }

    const filters = message.slice(2) as Filter[];
    if (faults.injectUnrequested) this.deliver(['EVENT', id, faults.injectUnrequested]);

    const copies = Math.max(1, faults.duplicate ?? 1);
    const answer = faults.ignoreFilters ? this.relay.events : this.relay.matching(filters);
    for (const event of answer) {
      const sent = faults.tamper ? tamper(event) : event;
      for (let i = 0; i < copies; i += 1) this.deliver(['EVENT', id, sent]);
    }

    if (!faults.dropEose) this.deliver(['EOSE', id]);
  }

  private deliver(message: unknown[]): void {
    queueMicrotask(() => {
      if (this.readyState !== OPEN) return;
      this.onmessage?.({ data: JSON.stringify(message) });
    });
  }
}

/**
 * Alter an event's content without touching its id or signature.
 *
 * This is the substitution a relay is in a position to attempt, and the
 * reason the client re-derives the id rather than trusting it.
 */
function tamper(event: NostrEvent): NostrEvent {
  return { ...event, content: `${event.content}!` };
}
