/** Public surface of the storage layer. */

export type { Db, Key, QueryOptions, Range, Store, StoreName } from './types.js';
export { INDEXES, STORE_NAMES, compareKeys, inRange } from './types.js';
export { MemoryDb, MemoryStore } from './memory.js';
export { IdbDb, DB_NAME, DB_VERSION, deleteDatabase, idbAvailable } from './indexeddb.js';
export { openCollection, seedIfEmpty } from './open.js';
export type { OpenResult } from './open.js';
export { CHECK_COUNT, runConformance } from './conformance.js';
export type { CheckResult } from './conformance.js';
