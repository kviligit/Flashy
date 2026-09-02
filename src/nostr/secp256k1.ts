/**
 * secp256k1 and BIP-340 Schnorr signatures.
 *
 * ---------------------------------------------------------------------
 * THIS IS HAND-WRITTEN CRYPTOGRAPHY. READ THIS BEFORE RELYING ON IT.
 *
 * Every real project should use an audited library — @noble/curves is the
 * standard choice. This exists only because this project cannot install
 * packages, and nostr requires Schnorr signatures that no browser API
 * provides.
 *
 * What has been established: sign and verify agree with all 19 official
 * BIP-340 test vectors, including the negative cases (see secp256k1.test.ts).
 * That is meaningful evidence of functional correctness.
 *
 * What has NOT been established, and is a real limitation:
 *
 *   - **It is not constant time.** JavaScript bigint operations branch and
 *     allocate in ways that depend on the values involved, so the running
 *     time leaks information about the secret key. An attacker able to
 *     measure timing precisely could in principle recover it. In this app
 *     the key never leaves the user's own device, which is a much weaker
 *     threat model than a server signing for many users — but it is not
 *     nothing, and it cannot be fixed in portable JavaScript.
 *   - It has not been audited or fuzzed beyond the official vectors.
 *
 * If packages ever become installable here, replacing this file with
 * @noble/curves should be a drop-in change: the exported surface is
 * deliberately the same shape.
 * ---------------------------------------------------------------------
 */

/** Field modulus. */
const P = 2n ** 256n - 2n ** 32n - 977n;
/** Group order. */
export const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export interface Point {
  x: bigint;
  y: bigint;
}

const G: Point = { x: Gx, y: Gy };

// --- field arithmetic ----------------------------------------------------

function mod(a: bigint, m = P): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

function powMod(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** Modular inverse via Fermat's little theorem; `m` must be prime. */
function inverse(a: bigint, m = P): bigint {
  return powMod(a, m - 2n, m);
}

/** Square root mod p. Valid because p ≡ 3 (mod 4). */
function sqrtMod(a: bigint): bigint {
  return powMod(a, (P + 1n) / 4n, P);
}

// --- point arithmetic ----------------------------------------------------
//
// Jacobian coordinates, so scalar multiplication needs one inversion at the
// end rather than one per bit.

interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint;
}

const JACOBIAN_ZERO: Jacobian = { x: 0n, y: 1n, z: 0n };

function toJacobian(point: Point): Jacobian {
  return { x: point.x, y: point.y, z: 1n };
}

function fromJacobian(point: Jacobian): Point | null {
  if (point.z === 0n) return null;
  const zInv = inverse(point.z);
  const zInv2 = mod(zInv * zInv);
  return { x: mod(point.x * zInv2), y: mod(point.y * zInv2 * zInv) };
}

function jacobianDouble(a: Jacobian): Jacobian {
  if (a.y === 0n || a.z === 0n) return JACOBIAN_ZERO;
  const ySquared = mod(a.y * a.y);
  const s = mod(4n * a.x * ySquared);
  const m = mod(3n * a.x * a.x); // curve coefficient a = 0
  const x = mod(m * m - 2n * s);
  return {
    x,
    y: mod(m * (s - x) - 8n * ySquared * ySquared),
    z: mod(2n * a.y * a.z),
  };
}

function jacobianAdd(a: Jacobian, b: Jacobian): Jacobian {
  if (a.z === 0n) return b;
  if (b.z === 0n) return a;

  const az2 = mod(a.z * a.z);
  const bz2 = mod(b.z * b.z);
  const u1 = mod(a.x * bz2);
  const u2 = mod(b.x * az2);
  const s1 = mod(a.y * bz2 * b.z);
  const s2 = mod(b.y * az2 * a.z);
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);

  if (h === 0n) return r === 0n ? jacobianDouble(a) : JACOBIAN_ZERO;

  const h2 = mod(h * h);
  const h3 = mod(h2 * h);
  const u1h2 = mod(u1 * h2);
  const x = mod(r * r - h3 - 2n * u1h2);
  return {
    x,
    y: mod(r * (u1h2 - x) - s1 * h3),
    z: mod(h * a.z * b.z),
  };
}

/** `scalar * point`, or null for the point at infinity. */
export function multiply(scalar: bigint, point: Point = G): Point | null {
  let k = mod(scalar, CURVE_ORDER);
  if (k === 0n) return null;

  let result = JACOBIAN_ZERO;
  let addend = toJacobian(point);
  while (k > 0n) {
    if (k & 1n) result = jacobianAdd(result, addend);
    addend = jacobianDouble(addend);
    k >>= 1n;
  }
  return fromJacobian(result);
}

function add(a: Point | null, b: Point | null): Point | null {
  if (!a) return b;
  if (!b) return a;
  const sum = jacobianAdd(toJacobian(a), toJacobian(b));
  return fromJacobian(sum);
}

function negate(point: Point | null): Point | null {
  return point ? { x: point.x, y: mod(-point.y) } : null;
}

/**
 * The point with the given x coordinate and even y — BIP-340's `lift_x`.
 * Returns null when x is not on the curve.
 */
export function liftX(x: bigint): Point | null {
  if (x <= 0n || x >= P) return null;
  const ySquared = mod(x * x * x + 7n);
  const y = sqrtMod(ySquared);
  if (mod(y * y) !== ySquared) return null;
  return { x, y: (y & 1n) === 0n ? y : P - y };
}

function hasEvenY(point: Point): boolean {
  return (point.y & 1n) === 0n;
}

// --- byte helpers --------------------------------------------------------

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex string contains a non-hex character');
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

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

// --- hashing -------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(digest);
}

const tagCache = new Map<string, Uint8Array>();

/** BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export async function taggedHash(tag: string, ...messages: Uint8Array[]): Promise<Uint8Array> {
  let prefix = tagCache.get(tag);
  if (!prefix) {
    const tagHash = await sha256(new TextEncoder().encode(tag));
    prefix = concat(tagHash, tagHash);
    tagCache.set(tag, prefix);
  }
  return sha256(concat(prefix, ...messages));
}

// --- public keys ---------------------------------------------------------

/** The 32-byte x-only public key for a secret key. */
export function getPublicKey(secretKey: Uint8Array): Uint8Array {
  const d = bytesToBigInt(secretKey);
  if (d <= 0n || d >= CURVE_ORDER) throw new Error('secret key is out of range');
  const point = multiply(d);
  if (!point) throw new Error('secret key produced the point at infinity');
  return bigIntTo32Bytes(point.x);
}

/** A uniformly random secret key in [1, n-1]. */
export function generateSecretKey(): Uint8Array {
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = new Uint8Array(32);
    crypto.getRandomValues(candidate);
    const value = bytesToBigInt(candidate);
    if (value > 0n && value < CURVE_ORDER) return candidate;
  }
  throw new Error('could not generate a secret key');
}

// --- BIP-340 -------------------------------------------------------------

/**
 * Sign a 32-byte message.
 *
 * `auxRand` is the auxiliary randomness from BIP-340. It defaults to fresh
 * random bytes; the tests pass the vectors' fixed values so signatures are
 * reproducible.
 */
export async function schnorrSign(
  message: Uint8Array,
  secretKey: Uint8Array,
  auxRand?: Uint8Array,
): Promise<Uint8Array> {
  const d0 = bytesToBigInt(secretKey);
  if (d0 <= 0n || d0 >= CURVE_ORDER) throw new Error('secret key is out of range');

  const publicPoint = multiply(d0);
  if (!publicPoint) throw new Error('secret key produced the point at infinity');

  // The signing key is negated when the public point has odd y, so that
  // the x-only public key is unambiguous.
  const d = hasEvenY(publicPoint) ? d0 : CURVE_ORDER - d0;

  const aux = auxRand ?? crypto.getRandomValues(new Uint8Array(32));
  const auxHash = await taggedHash('BIP0340/aux', aux);
  const t = bigIntTo32Bytes(d ^ bytesToBigInt(auxHash));

  const rand = await taggedHash('BIP0340/nonce', t, bigIntTo32Bytes(publicPoint.x), message);
  const k0 = mod(bytesToBigInt(rand), CURVE_ORDER);
  if (k0 === 0n) throw new Error('nonce was zero; retry with different aux randomness');

  const noncePoint = multiply(k0);
  if (!noncePoint) throw new Error('nonce produced the point at infinity');
  const k = hasEvenY(noncePoint) ? k0 : CURVE_ORDER - k0;

  const challenge = await taggedHash(
    'BIP0340/challenge',
    bigIntTo32Bytes(noncePoint.x),
    bigIntTo32Bytes(publicPoint.x),
    message,
  );
  const e = mod(bytesToBigInt(challenge), CURVE_ORDER);

  const signature = concat(
    bigIntTo32Bytes(noncePoint.x),
    bigIntTo32Bytes(mod(k + e * d, CURVE_ORDER)),
  );

  // A signature this implementation cannot verify is one nobody can trust.
  if (!(await schnorrVerify(signature, message, bigIntTo32Bytes(publicPoint.x)))) {
    throw new Error('produced a signature that does not verify');
  }
  return signature;
}

/** Verify a 64-byte signature against a 32-byte x-only public key. */
export async function schnorrVerify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    if (signature.length !== 64 || publicKey.length !== 32) return false;

    const point = liftX(bytesToBigInt(publicKey));
    if (!point) return false;

    const r = bytesToBigInt(signature.subarray(0, 32));
    const s = bytesToBigInt(signature.subarray(32, 64));
    if (r >= P || s >= CURVE_ORDER) return false;

    const challenge = await taggedHash(
      'BIP0340/challenge',
      signature.subarray(0, 32),
      publicKey,
      message,
    );
    const e = mod(bytesToBigInt(challenge), CURVE_ORDER);

    // R = s*G - e*P
    const result = add(multiply(s), negate(multiply(e, point)));
    if (!result) return false;
    return hasEvenY(result) && result.x === r;
  } catch {
    return false;
  }
}

/**
 * The x coordinate of `secretKey * theirPublicKey` — the ECDH shared secret
 * nostr's encryption schemes are built on.
 */
export function sharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const d = bytesToBigInt(secretKey);
  if (d <= 0n || d >= CURVE_ORDER) throw new Error('secret key is out of range');
  const point = liftX(bytesToBigInt(publicKey));
  if (!point) throw new Error('public key is not a valid curve point');
  const shared = multiply(d, point);
  if (!shared) throw new Error('shared secret is the point at infinity');
  return bigIntTo32Bytes(shared.x);
}
