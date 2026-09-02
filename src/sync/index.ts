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
