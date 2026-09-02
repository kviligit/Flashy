/**
 * ChaCha20 (RFC 8439).
 *
 * Hand-written for the same reason as the curve: no browser API offers it
 * and this project cannot install packages. It is far simpler than elliptic
 * curve arithmetic — a fixed sequence of additions, XORs and rotations over
 * a 16-word state — and is verified transitively by the official NIP-44
 * vectors, which cannot pass unless the keystream is exactly right.
 *
 * As with the curve, this is not constant time in any guaranteed sense,
 * though the operations involved are far less data-dependent than bigint
 * arithmetic.
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotl(state[d]! ^ state[a]!, 16);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotl(state[b]! ^ state[c]!, 12);
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotl(state[d]! ^ state[a]!, 8);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotl(state[b]! ^ state[c]!, 7);
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) >>> 0) +
    bytes[offset + 3]! * 0x1000000
  );
}

/** One 64-byte keystream block for the given counter. */
function block(key: Uint8Array, nonce: Uint8Array, counter: number, out: Uint8Array): void {
  const state = new Uint32Array(16);
  state[0] = SIGMA[0];
  state[1] = SIGMA[1];
  state[2] = SIGMA[2];
  state[3] = SIGMA[3];
  for (let i = 0; i < 8; i++) state[4 + i] = readLe32(key, i * 4);
  state[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) state[13 + i] = readLe32(nonce, i * 4);

  const working = state.slice();
  for (let round = 0; round < 10; round++) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i++) {
    const word = (working[i]! + state[i]!) >>> 0;
    out[i * 4] = word & 0xff;
    out[i * 4 + 1] = (word >>> 8) & 0xff;
    out[i * 4 + 2] = (word >>> 16) & 0xff;
    out[i * 4 + 3] = (word >>> 24) & 0xff;
  }
}

/**
 * XOR `data` with the ChaCha20 keystream.
 *
 * NIP-44 starts the counter at 0. The AEAD construction in RFC 8439 starts
 * at 1 because block 0 is spent on the Poly1305 key; NIP-44 does not use
 * Poly1305, so block 0 is keystream like any other.
 */
export function chacha20(
  key: Uint8Array,
  nonce: Uint8Array,
  data: Uint8Array,
  counter = 0,
): Uint8Array {
  if (key.length !== 32) throw new Error('ChaCha20 key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('ChaCha20 nonce must be 12 bytes');

  const out = new Uint8Array(data.length);
  const keystream = new Uint8Array(64);

  for (let offset = 0; offset < data.length; offset += 64) {
    block(key, nonce, counter + offset / 64, keystream);
    const size = Math.min(64, data.length - offset);
    for (let i = 0; i < size; i++) out[offset + i] = data[offset + i]! ^ keystream[i]!;
  }
  return out;
}
