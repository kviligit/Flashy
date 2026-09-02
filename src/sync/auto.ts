/**
 * Syncing without being asked.
 *
 * Deliberately narrow. It runs after a study session and nowhere else,
 * because that is the moment there is something worth sending — a batch of
 * answers — and the moment the user is not in the middle of anything.
 * Syncing on every keystroke, or on a timer, would mean a phone reaching
 * for the network while someone is reading a card.
 *
 * It never reports success and never blocks. A background sync that
 * interrupts with "3 changes received" is worse than one that says
 * nothing; a background sync that keeps a done screen from rendering is
 * worse still. Failures are surfaced once, quietly, because a sync that
 * has been silently failing for a week is the thing people actually get
 * hurt by.
 */

import type { Db } from '../storage/index.js';
import { toast } from '../ui/toast.js';
import { readAccount, readiness } from './account.js';
import { describeOutcome, runSync, type RunSyncOptions } from './run.js';

/** Milliseconds between automatic rounds, however often it is triggered. */
export const AUTO_INTERVAL_MS = 5 * 60_000;

let lastRunAt = 0;
let running = false;

/** Reset the throttle. Tests use it; nothing else should need it. */
export function resetAutoSync(): void {
  lastRunAt = 0;
  running = false;
}

export interface AutoSyncOptions extends RunSyncOptions {
  /** Called after a round that actually ran, with a one-line summary. */
  onFinished?: (summary: string, ok: boolean) => void;
  notify?: (message: string, kind: 'info' | 'success' | 'error') => void;
}

/**
 * Run a round if the settings ask for one and one is not already going.
 *
 * Returns whether it ran, which is what makes it testable — the caller in
 * the reviewer ignores it, because there is nothing useful to do with the
 * answer there.
 */
export async function maybeAutoSync(db: Db, options: AutoSyncOptions = {}): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const account = options.account ?? readAccount(options.store);
  if (!account.auto) return false;
  if (!readiness(account, options.store, options.scope ?? globalThis).ready) return false;

  // Two sessions finished in quick succession should not mean two rounds:
  // the second would have nothing to carry and would still cost a
  // connection on a phone.
  if (running || now() - lastRunAt < AUTO_INTERVAL_MS) return false;

  running = true;
  lastRunAt = now();
  try {
    const outcome = await runSync(db, { ...options, account });
    const summary = describeOutcome(outcome);
    options.onFinished?.(summary, outcome.ok);
    if (!outcome.ok) {
      // The only thing worth interrupting for. Silence here is how a sync
      // that has not worked in a week goes unnoticed.
      (options.notify ?? toast)(`Sync failed: ${summary}`, 'error');
    }
    return true;
  } catch {
    // runSync already turns failures into outcomes; anything reaching here
    // is a bug, and a background task is not the place to surface it.
    return true;
  } finally {
    running = false;
  }
}
