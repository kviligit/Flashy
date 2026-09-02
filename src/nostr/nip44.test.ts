import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, getPublicKey, hexToBytes } from './secp256k1.js';
import {
  conversationKey,
  decrypt,
  encrypt,
  messageKeys,
  paddedLength,
  pad,
  unpad,
} from './nip44.js';
import { chacha20 } from './chacha20.js';
import { NIP44_VECTORS } from './fixtures/nip44-vectors.js';

/**
 * The official vectors are the whole basis for trusting this code. They
 * exercise the curve, HKDF, ChaCha20, the padding scheme and the MAC
 * together: a payload cannot match byte for byte unless every one of those
 * is exactly right.
 */

test('conversation keys match the specification', async () => {
  for (const vector of NIP44_VECTORS.conversationKeys) {
    const key = await conversationKey(hexToBytes(vector.sec1), hexToBytes(vector.pub2));
    assert.equal(bytesToHex(key), vector.conversation_key);
  }
});

test('message keys match the specification', async () => {
  const conversation = hexToBytes(NIP44_VECTORS.messageKeys.conversationKey);
  for (const vector of NIP44_VECTORS.messageKeys.keys) {
    const keys = await messageKeys(conversation, hexToBytes(vector.nonce));
    assert.equal(bytesToHex(keys.chachaKey), vector.chacha_key);
    assert.equal(bytesToHex(keys.chachaNonce), vector.chacha_nonce);
    assert.equal(bytesToHex(keys.hmacKey), vector.hmac_key);
  }
});

test('padded lengths match the specification', () => {
  for (const [unpadded, expected] of NIP44_VECTORS.paddedLengths) {
    assert.equal(paddedLength(unpadded), expected, `for ${unpadded}`);
  }
});

test('encryption reproduces the specification’s payloads byte for byte', async () => {
  for (const vector of NIP44_VECTORS.encryptDecrypt) {
    // The vectors give both parties' *secret* keys; the second party's
    // public key has to be derived, which also checks the two directions
    // agree.
    const pub2 = getPublicKey(hexToBytes(vector.sec2));
    const derived = await conversationKey(hexToBytes(vector.sec1), pub2);
    assert.equal(bytesToHex(derived), vector.conversation_key, 'conversation key first');

    const pub1 = getPublicKey(hexToBytes(vector.sec1));
    const reverse = await conversationKey(hexToBytes(vector.sec2), pub1);
    assert.deepEqual(reverse, derived, 'both parties derive the same key');

    const payload = await encrypt(vector.plaintext, derived, hexToBytes(vector.nonce));
    assert.equal(payload, vector.payload);
    assert.equal(await decrypt(payload, derived), vector.plaintext, 'round trip');
  }
});

test('decryption rejects every invalid payload in the specification', async () => {
  for (const vector of NIP44_VECTORS.invalidDecrypt) {
    await assert.rejects(
      () => decrypt(vector.payload as string, hexToBytes(vector.conversation_key as string)),
      `should have rejected: ${vector.note ?? ''}`,
    );
  }
});

test('invalid conversation keys are refused', async () => {
  for (const vector of NIP44_VECTORS.invalidConversationKeys) {
    await assert.rejects(
      async () => conversationKey(hexToBytes(vector.sec1 as string), hexToBytes(vector.pub2 as string)),
      `should have refused: ${vector.note ?? ''}`,
    );
  }
});

test('plaintexts outside the allowed lengths are refused', async () => {
  const key = new Uint8Array(32).fill(1);
  for (const length of NIP44_VECTORS.invalidLengths) {
    await assert.rejects(() => encrypt('a'.repeat(length as number), key), `length ${length}`);
  }
});

// --- properties beyond the vectors ---------------------------------------

test('padding round-trips for every awkward length', () => {
  for (const length of [1, 2, 31, 32, 33, 63, 64, 65, 255, 256, 257, 1000, 65535]) {
    const text = 'x'.repeat(length);
    assert.equal(unpad(pad(text)), text, `length ${length}`);
  }
});

test('padding hides exact length', () => {
  assert.equal(pad('a').length, pad('x'.repeat(30)).length, 'short messages look alike');
  assert.equal(paddedLength(33), paddedLength(60), 'so do these');
});

test('unicode survives encryption unchanged', async () => {
  const key = new Uint8Array(32).fill(7);
  for (const text of ['Definer: entropi', 'Ω≈ç√∫˜µ≤', '日本語のテキスト', '🇳🇴 flagg']) {
    assert.equal(await decrypt(await encrypt(text, key), key), text);
  }
});

test('a tampered ciphertext is rejected, not silently decrypted', async () => {
  const key = new Uint8Array(32).fill(3);
  const payload = await encrypt('secret study material', key);
  const bytes = atob(payload).split('');
  bytes[40] = String.fromCharCode(bytes[40]!.charCodeAt(0) ^ 1);
  const tampered = btoa(bytes.join(''));
  await assert.rejects(() => decrypt(tampered, key), /invalid MAC/);
});

test('the wrong key does not decrypt', async () => {
  const payload = await encrypt('hello', new Uint8Array(32).fill(1));
  await assert.rejects(() => decrypt(payload, new Uint8Array(32).fill(2)), /invalid MAC/);
});

test('each encryption uses a fresh nonce', async () => {
  const key = new Uint8Array(32).fill(5);
  const first = await encrypt('same message', key);
  const second = await encrypt('same message', key);
  assert.notEqual(first, second, 'identical plaintexts must not produce identical payloads');
});

test('ChaCha20 is its own inverse and rejects bad parameters', () => {
  const key = new Uint8Array(32).fill(9);
  const nonce = new Uint8Array(12).fill(4);
  const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog, twice over');

  const encrypted = chacha20(key, nonce, data);
  assert.notDeepEqual(encrypted, data);
  assert.deepEqual(chacha20(key, nonce, encrypted), data);

  // Longer than one 64-byte block, to exercise the counter.
  const long = new Uint8Array(200).map((_, i) => i % 251);
  assert.deepEqual(chacha20(key, nonce, chacha20(key, nonce, long)), long);

  assert.throws(() => chacha20(new Uint8Array(31), nonce, data), /32 bytes/);
  assert.throws(() => chacha20(key, new Uint8Array(11), data), /12 bytes/);
});
