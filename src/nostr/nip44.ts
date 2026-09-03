/**
 * NIP-44 v2 encryption.
 *
 * Everything this app puts on a relay is encrypted with it. A flashcard
 * collection is a detailed record of what someone is studying — a language,
 * a syllabus, a diagnosis — and relays are public infrastructure operated
 * by strangers. Publishing any of it in the clear would be indefensible.
 *
 * The scheme: ECDH to a shared secret, HKDF to a conversation key, then a
 * per-message key from a random 32-byte nonce, ChaCha20 for confidentiality
 * and HMAC-SHA256 over nonce-and-ciphertext for integrity. Plaintext is
 * padded to a power-of-two-ish boundary so that message length leaks little.
 *
 * What it does *not* provide, per the NIP itself: no forward secrecy, no
 * deniability, and the metadata (who talked to whom, and when) is visible
 * to the relay. For syncing a user's own devices to themselves that is an
 * acceptable trade; it would not be for a messenger.
 *
 * Verified against the official vectors from paulmillr/nip44.
 */

import { chacha20 } from './primitives.js';
import { sharedSecret } from './primitives.js';

const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 0xffff;
const SALT = new TextEncoder().encode('nip44-v2');

// --- HMAC and HKDF, over WebCrypto -----------------------------------------

async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', imported, message as unknown as BufferSource);
  return new Uint8Array(signature);
}

/** HKDF-Extract: a pseudorandom key from input keying material and a salt. */
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt, ikm);
}

/** HKDF-Expand to `length` bytes. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  let written = 0;

  for (let counter = 1; written < length; counter++) {
    const input = concat(previous, info, new Uint8Array([counter]));
    previous = new Uint8Array(await hmac(prk, input));
    const size = Math.min(previous.length, length - written);
    out.set(previous.subarray(0, size), written);
    written += size;
  }
  return out;
}

// --- keys ------------------------------------------------------------------

/**
 * The long-term key shared by two parties.
 *
 * Symmetric by construction: A's secret with B's public key gives the same
 * value as B's secret with A's public key.
 */
export async function conversationKey(
  secretKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  const shared = sharedSecret(secretKey, publicKey);
  return hkdfExtract(SALT, shared);
}

export interface MessageKeys {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
}

/** Per-message keys, derived from the conversation key and a fresh nonce. */
export async function messageKeys(
  conversation: Uint8Array,
  nonce: Uint8Array,
): Promise<MessageKeys> {
  if (conversation.length !== 32) throw new Error('conversation key must be 32 bytes');
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');

  const derived = await hkdfExpand(conversation, nonce, 76);
  return {
    chachaKey: derived.subarray(0, 32),
    chachaNonce: derived.subarray(32, 44),
    hmacKey: derived.subarray(44, 76),
  };
}

// --- padding ---------------------------------------------------------------

/**
 * The padded length for a plaintext.
 *
 * Padding to coarse boundaries means an observer learns roughly how long a
 * message is, rather than exactly.
 */
export function paddedLength(unpadded: number): number {
  if (unpadded <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpadded - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

export function pad(plaintext: string): Uint8Array {
  const unpadded = new TextEncoder().encode(plaintext);
  if (unpadded.length < MIN_PLAINTEXT || unpadded.length > MAX_PLAINTEXT) {
    throw new Error('invalid plaintext length');
  }
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, unpadded.length, false);
  const suffix = new Uint8Array(paddedLength(unpadded.length) - unpadded.length);
  return concat(prefix, unpadded, suffix);
}

export function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error('invalid padding');
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const unpadded = padded.subarray(2, 2 + length);
  if (
    length < MIN_PLAINTEXT ||
    unpadded.length !== length ||
    padded.length !== 2 + paddedLength(length)
  ) {
    throw new Error('invalid padding');
  }
  return new TextDecoder().decode(unpadded);
}

// --- encryption ------------------------------------------------------------

export async function encrypt(
  plaintext: string,
  conversation: Uint8Array,
  nonce?: Uint8Array,
): Promise<string> {
  const messageNonce = nonce ?? crypto.getRandomValues(new Uint8Array(32));
  const keys = await messageKeys(conversation, messageNonce);
  const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, pad(plaintext));
  const mac = await hmac(keys.hmacKey, concat(messageNonce, ciphertext));
  return toBase64(concat(new Uint8Array([2]), messageNonce, ciphertext, mac));
}

export async function decrypt(payload: string, conversation: Uint8Array): Promise<string> {
  if (payload.length === 0 || payload.startsWith('#')) throw new Error('unknown version');
  if (payload.length < 132) throw new Error('invalid payload size');

  const data = fromBase64(payload);
  if (data.length < 99) throw new Error('invalid data size');
  if (data[0] !== 2) throw new Error(`unknown version ${data[0]}`);

  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);

  const keys = await messageKeys(conversation, nonce);
  const expected = await hmac(keys.hmacKey, concat(nonce, ciphertext));
  // Compared in constant time: a comparison that returns early would let an
  // attacker discover a valid MAC one byte at a time.
  if (!equalConstantTime(expected, mac)) throw new Error('invalid MAC');

  return unpad(chacha20(keys.chachaKey, keys.chachaNonce, ciphertext));
}

function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

// --- helpers ---------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
