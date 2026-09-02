import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offlineSupported, resetOfflineCopy } from './offline.js';

/** A browser stand-in, with only the bits this module touches. */
function fakeScope(options: {
  registrations?: Array<{ unregister(): Promise<boolean> }>;
  cacheKeys?: string[];
  controller?: { postMessage(data: unknown): void } | null;
  failRegistrations?: boolean;
  failCaches?: boolean;
} = {}) {
  const deleted: string[] = [];
  const messages: unknown[] = [];
  const keys = options.cacheKeys ?? [];

  const scope = {
    navigator: {
      serviceWorker: {
        controller: options.controller === undefined ? null : options.controller,
        async getRegistrations() {
          if (options.failRegistrations) throw new Error('blocked');
          return options.registrations ?? [];
        },
      },
    },
    caches: {
      async keys() {
        if (options.failCaches) throw new Error('blocked');
        return keys;
      },
      async delete(key: string) {
        deleted.push(key);
        return keys.includes(key);
      },
    },
  };
  return { scope: scope as unknown as typeof globalThis, deleted, messages };
}

test('a browser with neither workers nor caches has nothing to offer', () => {
  const bare = { navigator: {} } as unknown as typeof globalThis;
  assert.equal(offlineSupported(bare), false);
  assert.equal(offlineSupported(fakeScope().scope), true);
});

test('every worker is unregistered and every cache deleted', async () => {
  let unregistered = 0;
  const { scope, deleted } = fakeScope({
    registrations: [
      { async unregister() { unregistered += 1; return true; } },
      { async unregister() { unregistered += 1; return true; } },
    ],
    cacheKeys: ['flashy-v3', 'flashy-v4'],
  });

  const result = await resetOfflineCopy(scope);

  assert.equal(unregistered, 2);
  assert.equal(result.workers, 2);
  assert.deepEqual(deleted, ['flashy-v3', 'flashy-v4']);
  assert.equal(result.caches, 2);
});

test('the controlling worker is asked to stand down first', async () => {
  const sent: unknown[] = [];
  const { scope } = fakeScope({
    controller: { postMessage: (data) => sent.push(data) },
    cacheKeys: ['flashy-v4'],
  });

  await resetOfflineCopy(scope);

  assert.deepEqual(sent, [{ type: 'flashy-reset' }]);
});

test('a browser that refuses to list registrations still gets its caches cleared', async () => {
  // A partial reset beats none: the point of the button is recovery.
  const { scope, deleted } = fakeScope({ failRegistrations: true, cacheKeys: ['flashy-v4'] });

  const result = await resetOfflineCopy(scope);

  assert.equal(result.workers, 0);
  assert.deepEqual(deleted, ['flashy-v4']);
});

test('a browser that refuses to list caches still unregisters its workers', async () => {
  const { scope } = fakeScope({
    registrations: [{ async unregister() { return true; } }],
    failCaches: true,
  });

  const result = await resetOfflineCopy(scope);

  assert.equal(result.workers, 1);
  assert.equal(result.caches, 0);
});
