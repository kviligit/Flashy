/**
 * Who holds the secret key.
 *
 * Everything that needs the key goes through this interface, and there are
 * two implementations with very different security properties:
 *
 * - `Nip07Signer` delegates to a browser extension. The key never enters
 *   this page, so a script injected into the page cannot steal it. This is
 *   the right answer wherever an extension exists.
 * - `LocalSigner` holds the key in the page and stores it in IndexedDB.
 *   It is the only option on iOS Safari, where there are no extensions,
 *   and its weakness is exactly the one you would guess: anything that can
 *   run script in this origin can read the key. That is not a reason to
 *   avoid syncing — it is a reason the sanitiser matters — but it is
 *   stated here rather than left for someone to work out.
 *
 * The interface is NIP-07's, deliberately: `getPublicKey`, `signEvent`, and
 * `nip44.encrypt`/`decrypt`. Matching it means the extension case is a
 * pass-through rather than an adapter, and it is the surface every other
 * nostr app already speaks.
 */

import { signEvent as signLocally, type NostrEvent, type UnsignedEvent } from './event.js';
import { conversationKey, decrypt as decryptLocally, encrypt as encryptLocally } from './nip44.js';
import { bytesToHex, getPublicKey, hexToBytes } from './secp256k1.js';

export interface Signer {
  /** How the key is held, so the UI can say so honestly. */
  readonly kind: 'local' | 'extension';
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
  decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
}

/** A key held by this page. */
export class LocalSigner implements Signer {
  readonly kind = 'local';
  private readonly pubkey: string;
  private conversations = new Map<string, Uint8Array>();

  constructor(private readonly secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new Error('a secret key is 32 bytes');
    this.pubkey = bytesToHex(getPublicKey(secretKey));
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return signLocally(event, this.secretKey);
  }

  async encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return encryptLocally(plaintext, await this.conversationWith(recipientPubkey));
  }

  async decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return decryptLocally(ciphertext, await this.conversationWith(senderPubkey));
  }

  /**
   * Derived once per counterparty.
   *
   * The derivation is an elliptic-curve multiplication, and in this
   * hand-written implementation it is by far the slowest operation here.
   * A push of fifty chunks to the same key should pay for it once.
   */
  private async conversationWith(pubkey: string): Promise<Uint8Array> {
    const cached = this.conversations.get(pubkey);
    if (cached) return cached;
    const key = await conversationKey(this.secretKey, hexToBytes(pubkey));
    this.conversations.set(pubkey, key);
    return key;
  }
}

/** The subset of NIP-07 this app uses. */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/** A key held by a browser extension. */
export class Nip07Signer implements Signer {
  readonly kind = 'extension';

  constructor(private readonly provider: Nip07Provider) {}

  async getPublicKey(): Promise<string> {
    return this.provider.getPublicKey();
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return this.provider.signEvent(event);
  }

  async encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.nip44().encrypt(recipientPubkey, plaintext);
  }

  async decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.nip44().decrypt(senderPubkey, ciphertext);
  }

  private nip44(): NonNullable<Nip07Provider['nip44']> {
    const api = this.provider.nip44;
    if (!api) {
      // NIP-44 support is optional in NIP-07. Falling back to an unencrypted
      // sync would be a catastrophic default, and falling back to a local
      // key would defeat the reason for using the extension, so this fails.
      throw new Error('this extension cannot encrypt with NIP-44; sync needs it');
    }
    return api;
  }
}

/** The extension's provider, if this browser has one. */
export function detectNip07(scope: unknown = globalThis): Nip07Provider | null {
  const provider = (scope as { nostr?: Nip07Provider }).nostr;
  if (!provider || typeof provider.getPublicKey !== 'function') return null;
  if (typeof provider.signEvent !== 'function') return null;
  return provider;
}
