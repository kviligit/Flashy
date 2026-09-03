import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyEvent, type UnsignedEvent } from './event.js';
import { bytesToHex, generateSecretKey, getPublicKey } from './primitives.js';
import { detectNip07, LocalSigner, Nip07Signer, type Nip07Provider } from './signer.js';

const secretKey = generateSecretKey();
const pubkey = bytesToHex(getPublicKey(secretKey));

function unsigned(pk: string): UnsignedEvent {
  return { pubkey: pk, created_at: 1_700_000_000, kind: 9078, tags: [], content: 'x' };
}

test('a local signer signs events that verify', async () => {
  const signer = new LocalSigner(secretKey);
  assert.equal(await signer.getPublicKey(), pubkey);

  const event = await signer.signEvent(unsigned(pubkey));
  const result = await verifyEvent(event);
  assert.equal(result.ok, true);
});

test('a local signer round-trips its own ciphertext', async () => {
  const signer = new LocalSigner(secretKey);
  const ciphertext = await signer.encrypt(pubkey, 'a secret about verb conjugation');

  assert.ok(!ciphertext.includes('conjugation'));
  assert.equal(await signer.decrypt(pubkey, ciphertext), 'a secret about verb conjugation');
});

test('a key of the wrong length is refused at construction', () => {
  assert.throws(() => new LocalSigner(new Uint8Array(31)), /32 bytes/);
});

test('an extension signer delegates and never sees a secret key', async () => {
  const calls: string[] = [];
  const provider: Nip07Provider = {
    async getPublicKey() {
      calls.push('getPublicKey');
      return pubkey;
    },
    async signEvent(event) {
      calls.push('signEvent');
      return new LocalSigner(secretKey).signEvent(event);
    },
    nip44: {
      async encrypt(_pk, plaintext) {
        calls.push('encrypt');
        return `sealed:${plaintext}`;
      },
      async decrypt(_pk, ciphertext) {
        calls.push('decrypt');
        return ciphertext.replace('sealed:', '');
      },
    },
  };

  const signer = new Nip07Signer(provider);
  assert.equal(signer.kind, 'extension');
  assert.equal(await signer.getPublicKey(), pubkey);
  assert.equal(await signer.encrypt(pubkey, 'hello'), 'sealed:hello');
  assert.equal(await signer.decrypt(pubkey, 'sealed:hello'), 'hello');
  const event = await signer.signEvent(unsigned(pubkey));
  assert.equal((await verifyEvent(event)).ok, true);

  assert.deepEqual(calls, ['getPublicKey', 'encrypt', 'decrypt', 'signEvent']);
});

test('an extension without NIP-44 fails loudly rather than syncing in the clear', async () => {
  const signer = new Nip07Signer({
    async getPublicKey() {
      return pubkey;
    },
    async signEvent(event) {
      return new LocalSigner(secretKey).signEvent(event);
    },
  });

  await assert.rejects(() => signer.encrypt(pubkey, 'hello'), /cannot encrypt with NIP-44/);
  await assert.rejects(() => signer.decrypt(pubkey, 'hello'), /cannot encrypt with NIP-44/);
});

test('detectNip07 recognises a provider and rejects a half-built one', () => {
  assert.equal(detectNip07({}), null);
  assert.equal(detectNip07({ nostr: {} }), null);
  assert.equal(detectNip07({ nostr: { getPublicKey: () => {} } }), null, 'signEvent is required');

  const provider = { getPublicKey: () => {}, signEvent: () => {} };
  assert.equal(detectNip07({ nostr: provider }), provider as unknown as Nip07Provider);
});
