/**
 * The sync identity and relay list: what is stored, and where.
 *
 * **Not in the collection.** The key and the relay list live in
 * `localStorage`, not in IndexedDB, and that is deliberate on two counts.
 * The collection is the thing that gets exported, backed up and — now —
 * synced; an identity stored inside it would ride along in every one of
 * those, so a backup file handed to someone else would carry the secret
 * key that unlocks the sync history. Keeping identity beside the
 * collection rather than inside it means export stays safe by
 * construction rather than by remembering to filter.
 *
 * **The honest caveat.** A secret key in `localStorage` is readable by
 * anything that can run script in this origin. There is no way around
 * that in a web app without an extension, which is precisely why
 * `Nip07Signer` exists and is preferred when one is present. Where it
 * isn't — iOS Safari, which is this app's main target — the local key is
 * the only option, and the settings screen says so in as many words
 * rather than implying a safety it does not have.
 *
 * The storage is injectable so the tests do not need a browser, and so a
 * caller can substitute something else without this module caring.
 */

import { toPublicKeyHex, toSecretKeyHex } from '../nostr/nip19.js';
import { bytesToHex, generateSecretKey, getPublicKey, hexToBytes } from '../nostr/secp256k1.js';
import { detectNip07, LocalSigner, Nip07Signer, type Signer } from '../nostr/signer.js';

const KEY_SECRET = 'flashy.sync.secretKey';
const KEY_PUBLIC = 'flashy.sync.publicKey';
const KEY_RELAYS = 'flashy.sync.relays';
const KEY_MODE = 'flashy.sync.mode';
const KEY_AUTO = 'flashy.sync.auto';

/** The minimal `localStorage` surface, so tests can pass a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** An in-memory stand-in, used when `localStorage` is unavailable. */
export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * Safari in private browsing throws on `localStorage.setItem`, and an
 * iframe with storage blocked throws on the getter itself. Neither should
 * take the app down; sync is simply unavailable there.
 */
export function defaultStore(): KeyValueStore {
  try {
    const store = globalThis.localStorage;
    if (!store) return memoryStore();
    const probe = '__flashy_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return memoryStore();
  }
}

export type SyncMode = 'off' | 'local' | 'extension';

/**
 * Relays that carry arbitrary kinds and are widely reachable.
 *
 * Offered as a starting point, not a recommendation: every one of them is
 * a third party who will see that this key syncs and how often. The
 * settings screen makes the list editable and says what a relay learns.
 */
export const SUGGESTED_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
] as const;

export interface SyncAccount {
  mode: SyncMode;
  /** Hex public key, when one is known. */
  publicKey: string | null;
  relays: string[];
  /** Sync automatically after study sessions and edits. */
  auto: boolean;
  /** True when a secret key is held in this browser. */
  hasLocalKey: boolean;
}

export function readAccount(store: KeyValueStore = defaultStore()): SyncAccount {
  const mode = store.getItem(KEY_MODE);
  return {
    mode: mode === 'local' || mode === 'extension' ? mode : 'off',
    publicKey: store.getItem(KEY_PUBLIC),
    relays: readRelays(store),
    auto: store.getItem(KEY_AUTO) === 'true',
    hasLocalKey: store.getItem(KEY_SECRET) !== null,
  };
}

function readRelays(store: KeyValueStore): string[] {
  const raw = store.getItem(KEY_RELAYS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((url): url is string => typeof url === 'string' && isRelayUrl(url));
  } catch {
    return [];
  }
}

/**
 * A relay URL must be `wss:` (or `ws:` on localhost, for development).
 *
 * Plain `ws:` to a remote host would put the ciphertext on the wire
 * without transport security. The payload is encrypted either way, but
 * everything around it — the pubkey, the timing, the volume — would be in
 * the clear to anyone on the path, and there is no reason to allow it.
 */
export function isRelayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'wss:') return true;
  return url.protocol === 'ws:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export function setRelays(relays: readonly string[], store: KeyValueStore = defaultStore()): string[] {
  const cleaned: string[] = [];
  for (const relay of relays) {
    const trimmed = relay.trim();
    if (isRelayUrl(trimmed) && !cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  store.setItem(KEY_RELAYS, JSON.stringify(cleaned));
  return cleaned;
}

export function setAuto(auto: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(KEY_AUTO, auto ? 'true' : 'false');
}

/** Mint a new identity and store it. Returns the hex public key. */
export function createLocalKey(store: KeyValueStore = defaultStore()): string {
  return storeSecretKey(bytesToHex(generateSecretKey()), store);
}

/**
 * Store a key someone pasted.
 *
 * Accepts `nsec1…` or hex, and throws on anything else — including an
 * `npub`, which `toSecretKeyHex` refuses rather than helpfully deriving
 * from, because someone pasting a public key into a secret key field has
 * made a mistake worth surfacing.
 */
export function importLocalKey(input: string, store: KeyValueStore = defaultStore()): string {
  const hex = toSecretKeyHex(input);
  if (!hex) throw new Error('That is not a secret key. Paste an nsec1… value.');
  return storeSecretKey(hex, store);
}

function storeSecretKey(hex: string, store: KeyValueStore): string {
  const publicKey = bytesToHex(getPublicKey(hexToBytes(hex)));
  store.setItem(KEY_SECRET, hex);
  store.setItem(KEY_PUBLIC, publicKey);
  store.setItem(KEY_MODE, 'local');
  return publicKey;
}

/** The stored secret, for showing it once so it can be written down. */
export function revealSecretKey(store: KeyValueStore = defaultStore()): string | null {
  return store.getItem(KEY_SECRET);
}

/** Use an extension instead. The pubkey is recorded so the UI can show it. */
export function useExtension(publicKey: string, store: KeyValueStore = defaultStore()): void {
  const hex = toPublicKeyHex(publicKey);
  if (!hex) throw new Error('The extension returned something that is not a public key.');
  // Any locally held secret is dropped: keeping a second key around that
  // nothing uses is a liability with no upside.
  store.removeItem(KEY_SECRET);
  store.setItem(KEY_PUBLIC, hex);
  store.setItem(KEY_MODE, 'extension');
}

/**
 * Forget the identity.
 *
 * The relay list survives, because it is not secret and re-typing three
 * URLs after switching keys is pure friction. The watermarks in the
 * `syncState` store are the caller's to clear: they are per-peer, and the
 * peer id contains the public key, so a new identity starts from zero
 * without touching them.
 */
export function forgetIdentity(store: KeyValueStore = defaultStore()): void {
  store.removeItem(KEY_SECRET);
  store.removeItem(KEY_PUBLIC);
  store.setItem(KEY_MODE, 'off');
}

/** Build the signer the current settings call for, or null if sync is off. */
export function signerFor(
  account: SyncAccount,
  store: KeyValueStore = defaultStore(),
  scope: unknown = globalThis,
): Signer | null {
  if (account.mode === 'extension') {
    const provider = detectNip07(scope);
    return provider ? new Nip07Signer(provider) : null;
  }
  if (account.mode === 'local') {
    const secret = store.getItem(KEY_SECRET);
    return secret ? new LocalSigner(hexToBytes(secret)) : null;
  }
  return null;
}

/** Everything needed to run a round, or a reason why not. */
export type SyncReadiness =
  | { ready: true; signer: Signer; relays: string[] }
  | { ready: false; reason: string };

export function readiness(
  account: SyncAccount,
  store: KeyValueStore = defaultStore(),
  scope: unknown = globalThis,
): SyncReadiness {
  if (account.mode === 'off') return { ready: false, reason: 'Sync is turned off.' };
  if (account.relays.length === 0) {
    return { ready: false, reason: 'Add at least one relay before syncing.' };
  }
  const signer = signerFor(account, store, scope);
  if (!signer) {
    return {
      ready: false,
      reason:
        account.mode === 'extension'
          ? 'No nostr extension was found in this browser.'
          : 'No key is stored in this browser.',
    };
  }
  return { ready: true, signer, relays: account.relays };
}
