/**
 * Resetting the offline copy of the app.
 *
 * A service worker is an amplifier. Anything that can run script on this
 * origin can write into the Cache API, and what it writes is served back
 * after reloads and after whatever delivered it has been deleted. On an
 * installed app there is no address bar and no obvious "clear site data",
 * so without this button the only recovery is deleting and reinstalling
 * the app — which on iOS also takes the collection with it.
 *
 * So: unregister every worker, delete every cache, reload. The collection
 * lives in IndexedDB and is not touched.
 */

export interface ResetResult {
  workers: number;
  caches: number;
}

/** True when this browser has anything to reset. */
export function offlineSupported(scope: typeof globalThis = globalThis): boolean {
  return 'serviceWorker' in scope.navigator || 'caches' in scope;
}

export async function resetOfflineCopy(scope: typeof globalThis = globalThis): Promise<ResetResult> {
  const result: ResetResult = { workers: 0, caches: 0 };

  // Ask the controlling worker to take its own caches down first. It is
  // still serving requests until it is gone, and doing this from in there
  // closes the window where it could answer one more from a poisoned entry.
  const controller = scope.navigator.serviceWorker?.controller;
  if (controller) {
    controller.postMessage({ type: 'flashy-reset' });
    // Not awaited beyond a moment: a worker that ignores the message is
    // exactly the case this function has to survive.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if ('serviceWorker' in scope.navigator) {
    try {
      const registrations = await scope.navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        if (await registration.unregister()) result.workers += 1;
      }
    } catch {
      // A browser that refuses to list registrations still gets its caches
      // cleared below; a partial reset beats none.
    }
  }

  if ('caches' in scope) {
    try {
      for (const key of await scope.caches.keys()) {
        if (await scope.caches.delete(key)) result.caches += 1;
      }
    } catch {
      // As above.
    }
  }

  return result;
}
