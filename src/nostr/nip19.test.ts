import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abbreviate,
  npubDecode,
  npubEncode,
  nsecDecode,
  nsecEncode,
  toPublicKeyHex,
  toSecretKeyHex,
} from './nip19.js';
import { bytesToHex, generateSecretKey, getPublicKey } from './secp256k1.js';

/**
 * The vectors from NIP-19 itself.
 *
 * A checksum implementation that round-trips with itself round-trips with
 * nothing else; these are what make the encoding the same one every other
 * nostr client uses.
 */
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const NSEC_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';

/** The second worked example from the spec's own prose. */
const NPUB2 = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
const NPUB2_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';

test('the NIP-19 vectors decode to the documented keys', () => {
  assert.equal(npubDecode(NPUB), NPUB_HEX);
  assert.equal(nsecDecode(NSEC), NSEC_HEX);
  assert.equal(npubDecode(NPUB2), NPUB2_HEX);
});

test('and encode back to the documented strings', () => {
  assert.equal(npubEncode(NPUB_HEX), NPUB);
  assert.equal(nsecEncode(NSEC_HEX), NSEC);
  assert.equal(npubEncode(NPUB2_HEX), NPUB2);
});

test('a real generated key round-trips', () => {
  const secret = bytesToHex(generateSecretKey());
  const secretKey = new Uint8Array(
    (secret.match(/../g) ?? []).map((byte) => parseInt(byte, 16)),
  );
  const publicHex = bytesToHex(getPublicKey(secretKey));

  assert.equal(nsecDecode(nsecEncode(secret)), secret);
  assert.equal(npubDecode(npubEncode(publicHex)), publicHex);
});

test('an nsec pasted where an npub belongs is caught by the prefix', () => {
  // The mistake this encoding exists to prevent, and the reason the error
  // names both prefixes rather than saying "invalid".
  assert.throws(() => npubDecode(NSEC), /expected npub…, got nsec…/);
  assert.throws(() => nsecDecode(NPUB), /expected nsec…, got npub…/);
});

test('a typo is caught by the checksum rather than decoding to another key', () => {
  const typo = `${NPUB.slice(0, -1)}${NPUB.endsWith('g') ? 'f' : 'g'}`;
  assert.throws(() => npubDecode(typo), /bad checksum/);
});

test('malformed input is rejected, each for its own reason', () => {
  assert.throws(() => npubDecode(''), /not a bech32 string/);
  assert.throws(() => npubDecode('npub1'), /not a bech32 string/);
  assert.throws(() => npubDecode('nPuB1qqqqqqqqq'), /mixed case/);
  assert.throws(() => npubDecode('npub1bbbbbbbbbbbbbbbb'), /invalid character "b"/);
  assert.throws(() => npubEncode('not hex'), /32 bytes of lowercase hex/);
  assert.throws(() => npubEncode(NPUB_HEX.toUpperCase()), /lowercase/);
});

test('a bech32 string of the right shape but the wrong length is refused', () => {
  // Correct prefix, correct checksum, 31 bytes of payload.
  const short = npubEncode(NPUB_HEX).replace(/.$/, '');
  assert.throws(() => npubDecode(short));
});

test('the paste helpers take either form, and never mistake one key for the other', () => {
  assert.equal(toPublicKeyHex(NPUB), NPUB_HEX);
  assert.equal(toPublicKeyHex(`  ${NPUB.toUpperCase()}  `), NPUB_HEX);
  assert.equal(toPublicKeyHex(NPUB_HEX), NPUB_HEX);
  assert.equal(toSecretKeyHex(NSEC), NSEC_HEX);
  assert.equal(toSecretKeyHex(NSEC_HEX), NSEC_HEX);

  // A secret key must never be silently accepted as a public one.
  assert.equal(toPublicKeyHex(NSEC), null);
  assert.equal(toSecretKeyHex(NPUB), null);
  assert.equal(toPublicKeyHex('nonsense'), null);
});

test('abbreviate keeps both ends, which is what people compare', () => {
  const short = abbreviate(NPUB);
  assert.ok(short.startsWith('npub1'));
  assert.ok(short.endsWith(NPUB.slice(-8)));
  assert.ok(short.length < NPUB.length);
  assert.equal(abbreviate('npub1short'), 'npub1short');
});
