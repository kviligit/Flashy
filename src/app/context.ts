/**
 * The application's single shared context: an open collection, a scheduler
 * bound to it, and the note types the editor needs.
 *
 * Features receive this rather than reaching for globals, which is what
 * lets tests and the debug pages build one over an in-memory database.
 */

import { Scheduler } from '../scheduler/index.js';
import {
  openCollection,
  seedIfEmpty,
  type Db,
  type StorageStatus,
} from '../storage/index.js';

export interface AppContext {
  db: Db;
  scheduler: Scheduler;
  /** False when the collection lives only in memory for this page load. */
  persistent: boolean;
  storageWarning?: string;
  /**
   * Whether the browser agreed not to evict the collection. Reported rather
   * than enforced: the app works either way, but on a phone the difference
   * is whether a low-storage moment can silently take the review history.
   */
  storage?: StorageStatus;
}

export async function bootstrap(): Promise<AppContext> {
  const opened = await openCollection();
  await seedIfEmpty(opened.db);

  const scheduler = new Scheduler(opened.db);
  await scheduler.load();

  const context: AppContext = {
    db: opened.db,
    scheduler,
    persistent: opened.persistent,
  };
  if (opened.reason) context.storageWarning = opened.reason;
  if (opened.storage) context.storage = opened.storage;
  return context;
}
