import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nsecEncode, npubEncode } from '../nostr/nip19.js';
import { bytesToHex, generateSecretKey, getPublicKey, hexToBytes } from '../nostr/secp256k1.js';
import {
  createLocalKey,
  forgetIdentity,
  importLocalKey,
  isRelayUrl,
  memoryStore,
  readAccount,
  readiness,
  revealSecretKey,
  setAuto,
  setRelays,
  signerFor,
  useExtension,
} from './account.js';

const secretHex = bytesToHex(generateSecretKey());
const publicHex = bytesToHex(getPublicKey(hexToBytes(secretHex)));

test('a fresh browser has no identity and sync is off', () => {
  const account = readAccount(memoryStore());
  assert.equal(account.mode, 'off');
  assert.equal(account.publicKey, null);
  assert.deepEqual(account.relays, []);
  assert.equal(account.hasLocalKey, false);
});

test('creating a key switches the mode and records the public half', () => {
  const store = memoryStore();
  const pubkey = createLocalKey(store);

  const account = readAccount(store);
  assert.equal(account.mode, 'local');
  assert.equal(account.publicKey, pubkey);
  assert.equal(account.hasLocalKey, true);
  assert.equal(revealSecretKey(store)?.length, 64);
});

test('an nsec can be imported, and the public key is derived rather than asked for', () => {
  const store = memoryStore();
  assert.equal(importLocalKey(nsecEncode(secretHex), store), publicHex);
  assert.equal(revealSecretKey(store), secretHex);
  assert.equal(importLocalKey(secretHex, store), publicHex, 'bare hex works too');
});

test('an npub pasted into the secret key field is refused', () => {
  const store = memoryStore();
  assert.throws(() => importLocalKey(npubEncode(publicHex), store), /not a secret key/);
  assert.throws(() => importLocalKey('nonsense', store), /not a secret key/);
  assert.equal(revealSecretKey(store), null, 'and nothing was stored');
});

test('switching to an extension drops the local secret', () => {
  const store = memoryStore();
  createLocalKey(store);
  assert.ok(revealSecretKey(store));

  useExtension(publicHex, store);

  const account = readAccount(store);
  assert.equal(account.mode, 'extension');
  assert.equal(account.publicKey, publicHex);
  assert.equal(account.hasLocalKey, false, 'an unused key left behind is a liability');
  assert.equal(revealSecretKey(store), null);
});

test('forgetting the identity keeps the relay list', () => {
  const store = memoryStore();
  createLocalKey(store);
  setRelays(['wss://relay.example'], store);

  forgetIdentity(store);

  const account = readAccount(store);
  assert.equal(account.mode, 'off');
  assert.equal(account.publicKey, null);
  assert.equal(revealSecretKey(store), null);
  assert.deepEqual(account.relays, ['wss://relay.example'], 'not secret, and tedious to retype');
});

test('relay URLs must be wss, except on localhost', () => {
  assert.ok(isRelayUrl('wss://relay.example'));
  assert.ok(isRelayUrl('wss://relay.example/nostr'));
  assert.ok(isRelayUrl('ws://localhost:7777'), 'development');
  assert.ok(isRelayUrl('ws://127.0.0.1:7777'));

  // Plain ws to a remote host leaves the pubkey, timing and volume in the
  // clear to anyone on the path, for no gain.
  assert.ok(!isRelayUrl('ws://relay.example'));
  assert.ok(!isRelayUrl('https://relay.example'));
  assert.ok(!isRelayUrl('relay.example'));
  assert.ok(!isRelayUrl(''));
});

test('the relay list is cleaned, deduplicated and order-preserving', () => {
  const store = memoryStore();
  const saved = setRelays(
    ['  wss://b.example  ', 'wss://a.example', 'wss://b.example', 'not a url', 'ws://evil.example'],
    store,
  );

  assert.deepEqual(saved, ['wss://b.example', 'wss://a.example']);
  assert.deepEqual(readAccount(store).relays, saved);
});

test('a corrupted relay list reads as empty rather than throwing', () => {
  const store = memoryStore();
  store.setItem('flashy.sync.relays', '{oh no');
  assert.deepEqual(readAccount(store).relays, []);
  store.setItem('flashy.sync.relays', '"a string"');
  assert.deepEqual(readAccount(store).relays, []);
  store.setItem('flashy.sync.relays', '[1, null, "wss://ok.example"]');
  assert.deepEqual(readAccount(store).relays, ['wss://ok.example']);
});

test('auto-sync is off unless it was turned on', () => {
  const store = memoryStore();
  assert.equal(readAccount(store).auto, false);
  setAuto(true, store);
  assert.equal(readAccount(store).auto, true);
  setAuto(false, store);
  assert.equal(readAccount(store).auto, false);
});

test('a signer is built for the stored mode, and only then', () => {
  const store = memoryStore();
  assert.equal(signerFor(readAccount(store), store, {}), null, 'off');

  createLocalKey(store);
  assert.equal(signerFor(readAccount(store), store, {})?.kind, 'local');

  useExtension(publicHex, store);
  assert.equal(signerFor(readAccount(store), store, {}), null, 'no extension present');
  assert.equal(
    signerFor(readAccount(store), store, {
      nostr: { getPublicKey: () => {}, signEvent: () => {} },
    })?.kind,
    'extension',
  );
});

test('readiness explains exactly what is missing', () => {
  const store = memoryStore();
  assert.match(check(store).reason ?? '', /turned off/);

  createLocalKey(store);
  assert.match(check(store).reason ?? '', /at least one relay/);

  setRelays(['wss://relay.example'], store);
  const ready = readiness(readAccount(store), store, {});
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.ready && ready.relays, ['wss://relay.example']);

  useExtension(publicHex, store);
  assert.match(check(store).reason ?? '', /No nostr extension/);

  function check(s: ReturnType<typeof memoryStore>) {
    const result = readiness(readAccount(s), s, {});
    return { reason: result.ready ? null : result.reason };
  }
});
