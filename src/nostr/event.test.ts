import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, generateSecretKey, getPublicKey } from './secp256k1.js';
import {
  eventId,
  isWellFormed,
  serialiseForId,
  signEvent,
  tagValue,
  verifyEvent,
  type UnsignedEvent,
} from './event.js';

function draft(pubkey: string, overrides: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    pubkey,
    created_at: 1_780_000_000,
    kind: 30078,
    tags: [['d', 'flashy-sync']],
    content: 'payload',
    ...overrides,
  };
}

test('the id serialisation is exactly what NIP-01 specifies', () => {
  const event = draft('a'.repeat(64));
  assert.equal(
    serialiseForId(event),
    '[0,"' + 'a'.repeat(64) + '",1780000000,30078,[["d","flashy-sync"]],"payload"]',
  );
  // No whitespace: two implementations must produce identical bytes or
  // their ids disagree and nothing interoperates.
  assert.ok(!serialiseForId(event).includes(' '));
});

test('the id changes when any field changes', async () => {
  const pubkey = 'a'.repeat(64);
  const base = await eventId(draft(pubkey));
  for (const change of [
    { created_at: 1_780_000_001 },
    { kind: 1 },
    { content: 'payload ' },
    { tags: [['d', 'other']] },
  ] as Partial<UnsignedEvent>[]) {
    assert.notEqual(await eventId(draft(pubkey, change)), base, JSON.stringify(change));
  }
});

test('a signed event verifies', async () => {
  const secret = generateSecretKey();
  const pubkey = bytesToHex(getPublicKey(secret));
  const event = await signEvent(draft(pubkey), secret);

  assert.equal(event.id.length, 64);
  assert.equal(event.sig.length, 128);
  assert.deepEqual(await verifyEvent(event), { ok: true });
});

test('signing under someone else’s key is refused up front', async () => {
  const secret = generateSecretKey();
  await assert.rejects(
    () => signEvent(draft('b'.repeat(64)), secret),
    /pubkey does not match/,
  );
});

test('an altered event fails verification', async () => {
  const secret = generateSecretKey();
  const pubkey = bytesToHex(getPublicKey(secret));
  const event = await signEvent(draft(pubkey), secret);

  // A relay that rewrites the content must not be able to pass it off: the
  // id no longer matches what it claims to be a hash of.
  const rewritten = { ...event, content: 'tampered' };
  assert.deepEqual(await verifyEvent(rewritten), { ok: false, reason: 'bad-id' });

  // Recomputing the id does not help without the key.
  const reIded = { ...rewritten, id: await eventId(rewritten) };
  assert.deepEqual(await verifyEvent(reIded), { ok: false, reason: 'bad-signature' });
});

test('a signature lifted from another event does not transfer', async () => {
  const secret = generateSecretKey();
  const pubkey = bytesToHex(getPublicKey(secret));
  const first = await signEvent(draft(pubkey, { content: 'one' }), secret);
  const second = await signEvent(draft(pubkey, { content: 'two' }), secret);

  const spliced = { ...second, sig: first.sig };
  assert.deepEqual(await verifyEvent(spliced), { ok: false, reason: 'bad-signature' });
});

test('malformed input is rejected without throwing', async () => {
  for (const value of [
    null,
    'not an event',
    {},
    { id: 'short' },
    { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(127) },
    { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), created_at: 'soon' },
    { id: 'A'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), created_at: 1, kind: 1, tags: [], content: '' },
  ]) {
    assert.deepEqual(await verifyEvent(value), { ok: false, reason: 'malformed' }, JSON.stringify(value));
  }
});

test('tags with non-string members are rejected', () => {
  assert.ok(
    !isWellFormed({
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      sig: 'c'.repeat(128),
      created_at: 1,
      kind: 1,
      tags: [['d', 42]],
      content: '',
    }),
  );
});

test('tagValue finds the first matching tag', () => {
  const event = draft('a'.repeat(64), { tags: [['e', 'first'], ['d', 'wanted'], ['d', 'second']] });
  assert.equal(tagValue(event, 'd'), 'wanted');
  assert.equal(tagValue(event, 'e'), 'first');
  assert.equal(tagValue(event, 'missing'), null);
  assert.equal(tagValue(draft('a'.repeat(64), { tags: [['d']] }), 'd'), null, 'a tag with no value');
});
