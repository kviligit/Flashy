/**
 * NIP-19: the `npub1…` and `nsec1…` strings people actually paste.
 *
 * Nobody hands out a 64-character hex key. Every nostr client, profile and
 * backup uses bech32, and a sync setup screen that demanded hex would be
 * asking users to do a conversion by hand for no reason.
 *
 * Bech32 (BIP-173, the original constant — not bech32m) with a checksum,
 * which is the part that earns its keep: `nsec` and `npub` differ by four
 * characters, and pasting one where the other belongs is the single
 * easiest way to publish a secret key. The checksum plus the prefix check
 * turns that into an error message instead.
 */

const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARKEY = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) CHARKEY.set(ALPHABET[i]!, i);

const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) checksum ^= GENERATOR[i]!;
    }
  }
  return checksum;
}

function expandPrefix(prefix: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of prefix) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

/** Regroup bits, the operation bech32 is built on. */
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;

  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('value out of range');
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >> bits) & max);
    }
  }

  if (pad) {
    if (bits > 0) out.push((accumulator << (to - bits)) & max);
  } else if (bits >= from || ((accumulator << (to - bits)) & max) !== 0) {
    throw new Error('invalid padding');
  }
  return out;
}

function encodeBech32(prefix: string, data: number[]): string {
  const checksum = polymod([...expandPrefix(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail: number[] = [];
  for (let i = 0; i < 6; i += 1) tail.push((checksum >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...data, ...tail].map((value) => ALPHABET[value]).join('')}`;
}

function decodeBech32(encoded: string): { prefix: string; data: number[] } {
  // Mixed case is ambiguous under bech32's own rules, so it is rejected
  // rather than guessed at.
  const lower = encoded.toLowerCase();
  if (encoded !== lower && encoded !== encoded.toUpperCase()) {
    throw new Error('mixed case');
  }
  const split = lower.lastIndexOf('1');
  if (split < 1 || split + 7 > lower.length) throw new Error('not a bech32 string');

  const prefix = lower.slice(0, split);
  const body = lower.slice(split + 1);
  const data: number[] = [];
  for (const char of body) {
    const value = CHARKEY.get(char);
    if (value === undefined) throw new Error(`invalid character "${char}"`);
    data.push(value);
  }
  if (polymod([...expandPrefix(prefix), ...data]) !== 1) throw new Error('bad checksum');
  return { prefix, data: data.slice(0, -6) };
}

const HEX32 = /^[0-9a-f]{64}$/;

function toHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Encode a 32-byte hex key under the given prefix. */
function encodeKey(prefix: 'npub' | 'nsec', hex: string): string {
  if (!HEX32.test(hex)) throw new Error('a key is 32 bytes of lowercase hex');
  return encodeBech32(prefix, convertBits(fromHex(hex), 8, 5, true));
}

/** Decode, insisting on the expected prefix. */
function decodeKey(prefix: 'npub' | 'nsec', encoded: string): string {
  const { prefix: found, data } = decodeBech32(encoded.trim());
  if (found !== prefix) {
    // The whole reason the prefix exists. Saying which one arrived is what
    // stops someone pasting an nsec into a field expecting an npub and
    // seeing only "invalid key".
    throw new Error(`expected ${prefix}…, got ${found}…`);
  }
  const bytes = convertBits(data, 5, 8, false);
  if (bytes.length !== 32) throw new Error('a key is 32 bytes');
  return toHex(bytes);
}

export function npubEncode(hex: string): string {
  return encodeKey('npub', hex);
}

export function npubDecode(npub: string): string {
  return decodeKey('npub', npub);
}

export function nsecEncode(hex: string): string {
  return encodeKey('nsec', hex);
}

export function nsecDecode(nsec: string): string {
  return decodeKey('nsec', nsec);
}

/**
 * Accept whatever someone pasted: `npub1…` or bare hex.
 *
 * Returns hex, or null when it is neither. Deliberately refuses an nsec:
 * a field asking for a public key should never quietly accept a secret one
 * and derive the public half — that hides the fact that a secret was
 * pasted somewhere it did not belong.
 */
export function toPublicKeyHex(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (HEX32.test(trimmed)) return trimmed;
  try {
    return npubDecode(trimmed);
  } catch {
    return null;
  }
}

/** The same for a secret key: `nsec1…` or bare hex. */
export function toSecretKeyHex(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (HEX32.test(trimmed)) return trimmed;
  try {
    return nsecDecode(trimmed);
  } catch {
    return null;
  }
}

/** A short, recognisable form for display: `npub1abcd…wxyz`. */
export function abbreviate(encoded: string, keep = 8): string {
  if (encoded.length <= keep * 2 + 1) return encoded;
  return `${encoded.slice(0, keep + 4)}…${encoded.slice(-keep)}`;
}
