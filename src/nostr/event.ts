/**
 * NIP-01 events: the only thing nostr relays actually carry.
 *
 * An event is a small JSON object whose id is the SHA-256 of a canonical
 * serialisation of its own contents, signed with the author's key. Both
 * properties matter here: the id makes an event self-identifying, so a
 * relay cannot substitute one for another, and the signature makes it
 * unforgeable, so a relay cannot invent one.
 *
 * Relays are untrusted infrastructure. Everything arriving from one is
 * verified before it is looked at.
 */

import {
  bytesToHex,
  getPublicKey,
  hexToBytes,
  schnorrSign,
  schnorrVerify,
  sha256,
} from './secp256k1.js';

/** An event before it has an id or a signature. */
export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

/**
 * The exact byte sequence an event id is the hash of.
 *
 * NIP-01 fixes this as a JSON array with no whitespace and a specific field
 * order. It is not "some serialisation of the event" — two implementations
 * must produce identical bytes or their ids disagree and nothing
 * interoperates.
 */
export function serialiseForId(event: UnsignedEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export async function eventId(event: UnsignedEvent): Promise<string> {
  const bytes = new TextEncoder().encode(serialiseForId(event));
  return bytesToHex(await sha256(bytes));
}

/** Compute the id and sign it. */
export async function signEvent(
  event: UnsignedEvent,
  secretKey: Uint8Array,
): Promise<NostrEvent> {
  const expectedPubkey = bytesToHex(getPublicKey(secretKey));
  if (event.pubkey !== expectedPubkey) {
    // Signing under someone else's pubkey produces an event that can never
    // verify; catching it here is far clearer than a mysterious rejection
    // from a relay.
    throw new Error('event pubkey does not match the signing key');
  }

  const id = await eventId(event);
  const sig = await schnorrSign(hexToBytes(id), secretKey);
  return { ...event, id, sig: bytesToHex(sig) };
}

export type VerifyFailure =
  | 'malformed'
  | 'bad-id'
  | 'bad-signature';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
}

/**
 * Check an event completely: shape, id and signature.
 *
 * The id must be re-derived rather than trusted. An event whose id does not
 * match its contents is one where a relay has altered the contents, and
 * checking only the signature against the claimed id would miss it.
 */
export async function verifyEvent(event: unknown): Promise<VerifyResult> {
  if (!isWellFormed(event)) return { ok: false, reason: 'malformed' };

  const expectedId = await eventId(event);
  if (expectedId !== event.id) return { ok: false, reason: 'bad-id' };

  const valid = await schnorrVerify(
    hexToBytes(event.sig),
    hexToBytes(event.id),
    hexToBytes(event.pubkey),
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

/** Structural checks, before any hashing or curve arithmetic is attempted. */
export function isWellFormed(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;

  if (typeof event['id'] !== 'string' || !HEX32.test(event['id'])) return false;
  if (typeof event['pubkey'] !== 'string' || !HEX32.test(event['pubkey'])) return false;
  if (typeof event['sig'] !== 'string' || !HEX64.test(event['sig'])) return false;
  if (typeof event['created_at'] !== 'number' || !Number.isInteger(event['created_at'])) return false;
  if (typeof event['kind'] !== 'number' || !Number.isInteger(event['kind'])) return false;
  if (typeof event['content'] !== 'string') return false;

  const tags = event['tags'];
  if (!Array.isArray(tags)) return false;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.some((item) => typeof item !== 'string')) return false;
  }
  return true;
}

/** The first value of the first tag with the given name. */
export function tagValue(event: UnsignedEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && tag.length > 1) return tag[1] ?? null;
  }
  return null;
}
