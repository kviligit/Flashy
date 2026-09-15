import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canShareFile,
  deliverFile,
  isShareDismissal,
  textFile,
  type ShareCapableNavigator,
} from './deliver.js';

const file = (): File => textFile('notes.txt', 'Front\tBack\n', 'text/plain');

function sharingNavigator(behaviour: () => Promise<void>): ShareCapableNavigator {
  return { canShare: () => true, share: behaviour };
}

test('a file carries its name, its type and its contents', async () => {
  const f = file();
  assert.equal(f.name, 'notes.txt');
  assert.equal(f.type, 'text/plain;charset=utf-8');
  assert.equal(await f.text(), 'Front\tBack\n');
});

// --- deciding whether the share sheet is available -----------------------

test('sharing needs both halves of the API, not just one', () => {
  assert.ok(!canShareFile(file(), undefined), 'no navigator at all');
  assert.ok(!canShareFile(file(), {}), 'neither method');
  assert.ok(!canShareFile(file(), { canShare: () => true }), 'canShare without share');
  // Level 1 of the spec: share() exists but knows nothing about files.
  assert.ok(!canShareFile(file(), { share: async () => {} }), 'share without canShare');
  assert.ok(canShareFile(file(), sharingNavigator(async () => {})), 'both present');
});

test('a platform that refuses this particular file is believed', () => {
  assert.ok(!canShareFile(file(), { canShare: () => false, share: async () => {} }));
});

test('a canShare that throws counts as "cannot", not as a crash', () => {
  const nav: ShareCapableNavigator = {
    canShare: () => {
      throw new Error('nope');
    },
    share: async () => {},
  };
  assert.ok(!canShareFile(file(), nav));
});

test('canShare is asked about the actual file, not about files in general', () => {
  const seen: File[] = [];
  const nav: ShareCapableNavigator = {
    canShare: (data) => {
      seen.push(...(data.files ?? []));
      return true;
    },
    share: async () => {},
  };
  const f = file();
  canShareFile(f, nav);
  assert.deepEqual(seen, [f]);
});

// --- which route a device takes -----------------------------------------

test('where the share sheet exists, the file goes through it', async () => {
  const shared: File[] = [];
  let downloaded = 0;
  const result = await deliverFile(file(), {
    navigator: sharingNavigator(async () => {}),
    download: () => {
      downloaded += 1;
    },
  });
  assert.deepEqual(result, { method: 'share', completed: true });
  assert.equal(downloaded, 0, 'no second copy lands in Downloads');
  void shared;
});

test('the title travels with the file so the sheet has something to show', async () => {
  const seen: Array<{ files?: File[]; title?: string }> = [];
  await deliverFile(file(), {
    title: 'Flashy notes for Anki',
    navigator: {
      canShare: () => true,
      share: async (data) => {
        seen.push(data);
      },
    },
    download: () => {},
  });
  assert.equal(seen[0]?.title, 'Flashy notes for Anki');
  assert.equal(seen[0]?.files?.[0]?.name, 'notes.txt');
});

test('without a share sheet the file is downloaded instead', async () => {
  let downloaded: File | null = null;
  const result = await deliverFile(file(), {
    navigator: {},
    download: (f) => {
      downloaded = f;
    },
  });
  assert.deepEqual(result, { method: 'download', completed: true });
  assert.equal((downloaded as File | null)?.name, 'notes.txt');
});

// --- dismissal is not failure -------------------------------------------

test('closing the share sheet is reported as not completed, and nothing else happens', async () => {
  let downloaded = 0;
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const result = await deliverFile(file(), {
    navigator: sharingNavigator(async () => {
      throw abort;
    }),
    download: () => {
      downloaded += 1;
    },
  });
  assert.deepEqual(result, { method: 'share', completed: false });
  // Falling back here would push a file the user had just declined.
  assert.equal(downloaded, 0);
});

test('a share that genuinely breaks falls back to a download', async () => {
  let downloaded = 0;
  const result = await deliverFile(file(), {
    navigator: sharingNavigator(async () => {
      throw new Error('permission denied');
    }),
    download: () => {
      downloaded += 1;
    },
  });
  assert.deepEqual(result, { method: 'download', completed: true });
  assert.equal(downloaded, 1);
});

test('only AbortError means the user said no', () => {
  assert.ok(isShareDismissal(Object.assign(new Error('x'), { name: 'AbortError' })));
  assert.ok(!isShareDismissal(new Error('NotAllowedError')));
  assert.ok(!isShareDismissal('AbortError'));
  assert.ok(!isShareDismissal(undefined));
});
