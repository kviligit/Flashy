/**
 * The application's single shared context: an open collection, a scheduler
 * bound to it, and the note types the editor needs.
 *
 * Features receive this rather than reaching for globals, which is what
 * lets tests and the debug pages build one over an in-memory database.
 */

import { Scheduler } from '../scheduler/index.js';
import { openCollection, seedIfEmpty, type Db } from '../storage/index.js';

export interface AppContext {
  db: Db;
  scheduler: Scheduler;
  /** False when the collection lives only in memory for this page load. */
  persistent: boolean;
  storageWarning?: string;
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
  return context;
}
