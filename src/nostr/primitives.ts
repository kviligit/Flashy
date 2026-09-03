/**
 * The one place the cryptographic primitives are chosen.
 *
 * ## Why this file exists
 *
 * The implementations behind it — `secp256k1.ts` and `chacha20.ts` — are
 * hand-written, and they should not be. "Never roll your own crypto" is
 * not advice about effort or confidence: implementation correctness is
 * the part you can test, and it is not the part that hurts people. These
 * pass every vector their specifications publish and that says nothing
 * about `secp256k1.ts` being non-constant-time, which it is, and which
 * cannot be fixed in portable JavaScript.
 *
 * They exist because this project's environment cannot reach a package
 * registry — not npm, not a CDN, not raw GitHub. That was a real
 * constraint and it was never a good enough reason. The right response
 * was to leave the primitives unimplemented and build everything else.
 *
 * ## What this file is for
 *
 * It makes that mistake reversible in one edit. Everything above the
 * primitives — `event.ts`, `nip44.ts`, `signer.ts`, `nip19.ts`, all of
 * `src/sync/` — imports from here and nowhere else, so replacing the
 * hand-written code with an audited library is a change to this file
 * plus a thin adapter, not a hunt through the tree.
 *
 * ## The replacement
 *
 * Wherever a registry is reachable:
 *
 *     npm install @noble/curves @noble/ciphers
 *
 * Then delete `secp256k1.ts` and `chacha20.ts`, and implement the exports
 * below in terms of:
 *
 *     import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
 *     import { chacha20 } from '@noble/ciphers/chacha';
 *
 * The mapping, with the differences that need an adapter rather than a
 * rename:
 *
 * | Export here      | noble equivalent                | Difference |
 * |------------------|---------------------------------|------------|
 * | `getPublicKey`   | `schnorr.getPublicKey`          | same — 32-byte x-only |
 * | `schnorrSign`    | `schnorr.sign(msg, priv)`       | same order |
 * | `schnorrVerify`  | `schnorr.verify(sig, msg, pub)` | same order |
 * | `sharedSecret`   | `secp256k1.getSharedSecret`     | noble returns 33 bytes with a prefix; NIP-44 wants the 32-byte x coordinate, so slice(1) |
 * | `chacha20`       | `chacha20(key, nonce, data)`    | noble's counter starts at 0; check against the NIP-44 vectors after swapping |
 * | `generateSecretKey` | `schnorr.utils.randomPrivateKey` | same |
 *
 * The existing vector tests in `secp256k1.test.ts` and `nip44.test.ts`
 * are the conformance check on that swap: point them at this module and
 * they verify the replacement the same way they verified the original.
 *
 * `sha256` and `taggedHash` stay where they are. They are WebCrypto, not
 * hand-written, and there is nothing to replace.
 */

export {
  chacha20,
} from './chacha20.js';

export {
  generateSecretKey,
  getPublicKey,
  schnorrSign,
  schnorrVerify,
  sharedSecret,
} from './secp256k1.js';

/**
 * Hashing and byte handling, which are not the risky part.
 *
 * `sha256` and `taggedHash` are `crypto.subtle`; the rest is hex and
 * bigint conversion. They are re-exported here so that callers have one
 * import site, not because they need replacing.
 */
export {
  bigIntTo32Bytes,
  bytesToBigInt,
  bytesToHex,
  CURVE_ORDER,
  hexToBytes,
  sha256,
  taggedHash,
} from './secp256k1.js';

/**
 * True while the primitives are hand-written.
 *
 * The UI reads this to decide how loudly to warn. Once an audited
 * library is in place, set it to false in the same edit — a warning that
 * outlives its reason teaches people to ignore warnings.
 */
export const PRIMITIVES_ARE_HAND_WRITTEN = true;
