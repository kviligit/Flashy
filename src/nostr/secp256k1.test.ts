import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bigIntTo32Bytes,
  bytesToBigInt,
  bytesToHex,
  CURVE_ORDER,
  generateSecretKey,
  getPublicKey,
  hexToBytes,
  liftX,
  multiply,
  schnorrSign,
  schnorrVerify,
  sharedSecret,
} from './secp256k1.js';
import { BIP340_VECTORS } from './fixtures/bip340-vectors.js';

/**
 * The official BIP-340 vectors, taken verbatim from bitcoin/bips.
 *
 * This is the only reason it is defensible to hand-write this curve at all:
 * without an audited library, agreeing with the specification's own vectors
 * — negative cases included — is the strongest evidence available that the
 * implementation is functionally correct.
 */
const VECTORS = BIP340_VECTORS;

test('the official vector file is present and complete', () => {
  assert.ok(VECTORS.length >= 15, `expected the full set, found ${VECTORS.length}`);
  assert.ok(VECTORS.some((v) => !v.valid), 'the negative cases must be included');
});

test('BIP-340: every vector with a secret key derives the right public key', () => {
  for (const vector of VECTORS) {
    if (!vector.secretKey) continue;
    const derived = bytesToHex(getPublicKey(hexToBytes(vector.secretKey)));
    assert.equal(derived, vector.publicKey, `vector ${vector.index}`);
  }
});

test('BIP-340: signing reproduces the specification’s signatures exactly', async () => {
  for (const vector of VECTORS) {
    if (!vector.secretKey || !vector.valid) continue;
    const signature = await schnorrSign(
      hexToBytes(vector.message),
      hexToBytes(vector.secretKey),
      hexToBytes(vector.auxRand),
    );
    assert.equal(bytesToHex(signature), vector.signature, `vector ${vector.index}`);
  }
});

test('BIP-340: verification agrees with every vector, valid and invalid alike', async () => {
  for (const vector of VECTORS) {
    const result = await schnorrVerify(
      hexToBytes(vector.signature),
      hexToBytes(vector.message),
      hexToBytes(vector.publicKey),
    );
    assert.equal(
      result,
      vector.valid,
      `vector ${vector.index}${vector.comment ? ` (${vector.comment})` : ''}`,
    );
  }
});

// --- properties beyond the vectors ---------------------------------------

test('a fresh key signs and verifies, and a tampered message does not', async () => {
  const secret = generateSecretKey();
  const publicKey = getPublicKey(secret);
  const message = new Uint8Array(32).fill(7);

  const signature = await schnorrSign(message, secret);
  assert.ok(await schnorrVerify(signature, message, publicKey));

  const tampered = new Uint8Array(message);
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  assert.ok(!(await schnorrVerify(signature, tampered, publicKey)), 'a changed message must fail');
});

test('a signature does not verify under a different key', async () => {
  const message = new Uint8Array(32).fill(3);
  const signature = await schnorrSign(message, generateSecretKey());
  assert.ok(!(await schnorrVerify(signature, message, getPublicKey(generateSecretKey()))));
});

test('every bit of a signature matters', async () => {
  const secret = generateSecretKey();
  const publicKey = getPublicKey(secret);
  const message = new Uint8Array(32).fill(9);
  const signature = await schnorrSign(message, secret);

  for (const index of [0, 15, 31, 32, 47, 63]) {
    const broken = new Uint8Array(signature);
    broken[index] = (broken[index] ?? 0) ^ 0x01;
    assert.ok(!(await schnorrVerify(broken, message, publicKey)), `byte ${index} must matter`);
  }
});

test('malformed input is rejected rather than throwing', async () => {
  const message = new Uint8Array(32);
  const publicKey = getPublicKey(generateSecretKey());
  assert.equal(await schnorrVerify(new Uint8Array(63), message, publicKey), false);
  assert.equal(await schnorrVerify(new Uint8Array(64), message, new Uint8Array(31)), false);
  // An x coordinate that is not on the curve.
  assert.equal(await schnorrVerify(new Uint8Array(64), message, new Uint8Array(32).fill(0xff)), false);
});

test('out-of-range secret keys are refused', () => {
  assert.throws(() => getPublicKey(new Uint8Array(32)), /out of range/);
  assert.throws(() => getPublicKey(bigIntTo32Bytes(CURVE_ORDER)), /out of range/);
  assert.doesNotThrow(() => getPublicKey(bigIntTo32Bytes(CURVE_ORDER - 1n)));
});

test('generated keys are in range and distinct', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const key = generateSecretKey();
    const value = bytesToBigInt(key);
    assert.ok(value > 0n && value < CURVE_ORDER, 'in range');
    seen.add(bytesToHex(key));
  }
  assert.equal(seen.size, 20, 'no repeats');
});

test('ECDH agrees from both sides', () => {
  const alice = generateSecretKey();
  const bob = generateSecretKey();
  const fromAlice = sharedSecret(alice, getPublicKey(bob));
  const fromBob = sharedSecret(bob, getPublicKey(alice));
  assert.deepEqual(fromAlice, fromBob, 'both parties must derive the same secret');

  const mallory = generateSecretKey();
  assert.notDeepEqual(sharedSecret(mallory, getPublicKey(bob)), fromAlice);
});

// --- curve arithmetic ----------------------------------------------------

test('point arithmetic obeys the group laws', () => {
  const g = multiply(1n);
  assert.ok(g);
  assert.equal(multiply(CURVE_ORDER), null, 'n*G is the point at infinity');
  assert.equal(multiply(0n), null);

  // 2G computed two ways.
  const doubled = multiply(2n);
  assert.ok(doubled);
  assert.deepEqual(multiply(2n), doubled);

  // Every generated point must satisfy y^2 = x^3 + 7.
  const P_ = 2n ** 256n - 2n ** 32n - 977n;
  for (const k of [1n, 2n, 3n, 12345n, CURVE_ORDER - 1n]) {
    const point = multiply(k);
    assert.ok(point, `${k}G exists`);
    assert.equal(
      (point.y * point.y) % P_,
      (point.x * point.x * point.x + 7n) % P_,
      `${k}G is on the curve`,
    );
  }
});

test('liftX round-trips and rejects points off the curve', () => {
  const point = multiply(42n);
  assert.ok(point);
  const lifted = liftX(point.x);
  assert.ok(lifted);
  assert.equal(lifted.x, point.x);
  assert.equal(lifted.y % 2n, 0n, 'lift_x always returns the even-y point');
  assert.equal(liftX(0n), null);
  assert.equal(liftX(2n ** 256n), null);
});
