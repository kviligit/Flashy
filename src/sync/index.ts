/** Public surface of the sync layer. */

export type { MergeCounts, SyncResult, SyncTransport } from './types.js';
export { emptyCounts } from './types.js';
export { applyChanges } from './merge.js';
export type { MergeOptions } from './merge.js';
export { replayCard, replayCards, replayScheduling } from './replay.js';
export { readSyncState, resetSyncState, syncWith } from './engine.js';
export type { SyncOptions } from './engine.js';
export { loopbackTransport } from './loopback.js';
export type { LoopbackOptions } from './loopback.js';
export {
  APP_NAME,
  APP_TAG,
  DEVICE_TAG,
  FLASHY_KIND,
  LOOKBACK_SECONDS,
  NostrTransport,
} from './nostr-transport.js';
export type { NostrTransportOptions, TransportProblem } from './nostr-transport.js';
export {
  chunkChangeSet,
  decodeChangeSet,
  MAX_CHUNK_BYTES,
  MAX_PLAINTEXT_BYTES,
  WIRE_VERSION,
} from './wire.js';
export type { ChunkResult, Oversized, WireChangeSet, WireUpsert } from './wire.js';
export {
  createLocalKey,
  defaultStore,
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
  SUGGESTED_RELAYS,
  useExtension,
} from './account.js';
export type { KeyValueStore, SyncAccount, SyncMode, SyncReadiness } from './account.js';
export { openTransport } from './nostr-transport.js';
