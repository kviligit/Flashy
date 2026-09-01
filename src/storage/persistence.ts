/**
 * Asking the browser not to throw the collection away.
 *
 * By default a browser treats IndexedDB as "best effort" storage and may
 * evict it when the device runs low on space — which on a phone is a real
 * risk, and for this app means losing months of review history with no
 * warning and no way back. `navigator.storage.persist()` upgrades the
 * origin to durable storage, after which the data survives until the user
 * deletes it themselves.
 *
 * Browsers decide differently: some grant it silently, some grant it once
 * the app is installed or has been used a few times, some prompt, and some
 * do not implement it at all. So this reports what happened rather than
 * assuming, and the app works either way.
 */

export interface StorageStatus {
  /** Whether the origin currently has durable storage. */
  persisted: boolean;
  /** Whether the browser implements the API at all. */
  supported: boolean;
  /** Bytes used by this origin, if the browser will say. */
  usage?: number;
  /** Bytes this origin may use, if the browser will say. */
  quota?: number;
}

/**
 * Ask for durable storage, unless it has already been granted.
 *
 * Safe to call on every start: when persistence is already in place this
 * only reads the current state.
 */
export async function requestPersistence(): Promise<StorageStatus> {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') {
    return { persisted: false, supported: false };
  }

  try {
    let persisted =
      typeof storage.persisted === 'function' ? await storage.persisted() : false;
    if (!persisted) persisted = await storage.persist();
    return { persisted, supported: true, ...(await estimate()) };
  } catch {
    // A refusal is not an error worth surfacing; the app still works.
    return { persisted: false, supported: true };
  }
}

/** Current usage, where the browser reports it. */
export async function estimate(): Promise<{ usage?: number; quota?: number }> {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.estimate !== 'function') return {};
  try {
    const { usage, quota } = await storage.estimate();
    const out: { usage?: number; quota?: number } = {};
    if (typeof usage === 'number') out.usage = usage;
    if (typeof quota === 'number') out.quota = quota;
    return out;
  } catch {
    return {};
  }
}

/** "1.4 MB" — for the settings page. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
