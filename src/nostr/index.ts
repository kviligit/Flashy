/**
 * The nostr protocol layer.
 *
 * Everything here is protocol, not application: signing, encrypting and
 * validating events. Nothing in it knows what a flashcard is, and nothing
 * above it needs to know what a curve point is.
 */

export {
  bigIntTo32Bytes,
  bytesToBigInt,
  bytesToHex,
  CURVE_ORDER,
  generateSecretKey,
  getPublicKey,
  hexToBytes,
  schnorrSign,
  schnorrVerify,
  sha256,
  sharedSecret,
  taggedHash,
} from './primitives.js';

export { chacha20 } from './primitives.js';

export {
  conversationKey,
  decrypt,
  encrypt,
  messageKeys,
  pad,
  paddedLength,
  unpad,
} from './nip44.js';
export type { MessageKeys } from './nip44.js';

export {
  eventId,
  isWellFormed,
  serialiseForId,
  signEvent,
  tagValue,
  verifyEvent,
} from './event.js';
export type { NostrEvent, UnsignedEvent, VerifyResult } from './event.js';

export { DEFAULT_MAX_EVENTS, DEFAULT_TIMEOUT_MS, matchesFilter, openRelay, Relay, RelayError } from './relay.js';
export type { Filter, RelayOptions, RelaySocket, SocketFactory } from './relay.js';
export { detectNip07, LocalSigner, Nip07Signer } from './signer.js';
export type { Nip07Provider, Signer } from './signer.js';
export {
  abbreviate,
  npubDecode,
  npubEncode,
  nsecDecode,
  nsecEncode,
  toPublicKeyHex,
  toSecretKeyHex,
} from './nip19.js';
