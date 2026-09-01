import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  installInstructions,
  isIos,
  isIosSafari,
  isStandalone,
  storageOutlook,
  StorageOutlook,
  type PlatformInputs,
} from './platform.js';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_SAFARI = IPAD_DESKTOP_UA;
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const at = (partial: Partial<PlatformInputs>): PlatformInputs => ({
  userAgent: '',
  maxTouchPoints: 0,
  navigatorStandalone: false,
  displayModeStandalone: false,
  ...partial,
});

test('iPhone and iPad are recognised as iOS', () => {
  assert.ok(isIos(at({ userAgent: IPHONE_SAFARI })));
  assert.ok(isIos(at({ userAgent: IPHONE_CHROME })));
  assert.ok(!isIos(at({ userAgent: ANDROID_CHROME })));
});

test('an iPad claiming to be a Mac is caught by its touch points', () => {
  // iPadOS 13+ sends a desktop user agent; only maxTouchPoints tells them apart.
  assert.ok(isIos(at({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })));
  assert.ok(!isIos(at({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })), 'a real Mac is not iOS');
});

test('only Safari can add to the Home Screen', () => {
  assert.ok(isIosSafari(at({ userAgent: IPHONE_SAFARI })));
  assert.ok(!isIosSafari(at({ userAgent: IPHONE_CHROME })), 'Chrome on iOS has no share-sheet install');
  assert.ok(!isIosSafari(at({ userAgent: ANDROID_CHROME })));
});

test('standalone is detected from either signal', () => {
  assert.ok(!isStandalone(at({ userAgent: IPHONE_SAFARI })));
  assert.ok(isStandalone(at({ userAgent: IPHONE_SAFARI, navigatorStandalone: true })), 'iOS signal');
  assert.ok(isStandalone(at({ userAgent: ANDROID_CHROME, displayModeStandalone: true })), 'standard signal');
});

test('the storage outlook reflects what actually decides it on each platform', () => {
  assert.equal(
    storageOutlook(at({ userAgent: IPHONE_SAFARI })),
    StorageOutlook.IosBrowser,
    'a Safari tab is where the storage cap applies',
  );
  assert.equal(
    storageOutlook(at({ userAgent: IPHONE_SAFARI, navigatorStandalone: true })),
    StorageOutlook.IosInstalled,
    'a Home Screen app is exempt',
  );
  assert.equal(storageOutlook(at({ userAgent: ANDROID_CHROME })), StorageOutlook.Other);
});

test('install instructions are Safari-specific, and absent once installed', () => {
  const safari = installInstructions(at({ userAgent: IPHONE_SAFARI }));
  assert.ok(safari);
  assert.match(safari.join(' '), /Add to Home Screen/);

  const chrome = installInstructions(at({ userAgent: IPHONE_CHROME }));
  assert.ok(chrome);
  assert.match(chrome.join(' '), /Safari/, 'other iOS browsers are told to switch');

  assert.equal(
    installInstructions(at({ userAgent: IPHONE_SAFARI, navigatorStandalone: true })),
    null,
    'nothing to say once it is installed',
  );
  assert.equal(installInstructions(at({ userAgent: ANDROID_CHROME })), null);
});
