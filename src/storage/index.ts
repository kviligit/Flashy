/** Public surface of the storage layer. */

export type { ContentStore, Db, Key, QueryOptions, Range, Store, StoreName } from './types.js';
export { CONTENT_STORES, INDEXES, STORE_NAMES, VERSION_FIELD, compareKeys, inRange } from './types.js';
export { pruneTombstones, tombstoneId, withChangeTracking } from './tracking.js';
export { changeSetSize, changesSince, versionOf } from './changes.js';
export type { ChangeSet, Upsert } from './changes.js';
export { estimate, formatBytes, requestPersistence } from './persistence.js';
export type { StorageStatus } from './persistence.js';
export { MemoryDb, MemoryStore } from './memory.js';
export { IdbDb, DB_NAME, DB_VERSION, deleteDatabase, idbAvailable } from './indexeddb.js';
export { openCollection, seedIfEmpty } from './open.js';
export type { OpenResult } from './open.js';
export { CHECK_COUNT, runConformance } from './conformance.js';
export type { CheckResult } from './conformance.js';
