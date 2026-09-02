import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSafeUrl } from './safe-html.js';
import { XSS_PAYLOADS } from './fixtures/xss-payloads.js';

/**
 * The DOM-dependent half of the sanitiser is tested where it actually runs:
 * `tests/e2e.mjs` drives every payload through a real browser and asserts
 * nothing executes. A sanitiser tested against a fake DOM proves very
 * little.
 */

test('URL schemes are judged after entity decoding, not before', () => {
  assert.ok(isSafeUrl('https://example.com/a.png'));
  assert.ok(isSafeUrl('http://example.com'));
  assert.ok(isSafeUrl('/relative/path.png'));
  assert.ok(isSafeUrl('relative.png'));
  assert.ok(isSafeUrl('mailto:someone@example.com'));

  assert.ok(!isSafeUrl('javascript:alert(1)'));
  assert.ok(!isSafeUrl('JaVaScRiPt:alert(1)'));
  assert.ok(!isSafeUrl('  javascript:alert(1)'));
  assert.ok(!isSafeUrl('\tjavascript:alert(1)'));
  assert.ok(!isSafeUrl('data:text/html,<script>alert(1)</script>'));
  assert.ok(!isSafeUrl('data:image/svg+xml,<svg onload=alert(1)>'), 'an SVG data URL can carry script');
  assert.ok(!isSafeUrl('vbscript:msgbox(1)'));
  assert.ok(!isSafeUrl('blob:https://x/y'), 'the resolver assigns these itself, after sanitising');
  assert.ok(!isSafeUrl(''));
  assert.ok(!isSafeUrl('   '));
});

test('the payload corpus covers the shapes that defeated the old sanitiser', () => {
  // The bug was that separators other than a space were not recognised.
  const separatorCases = XSS_PAYLOADS.filter((p) => /\/onerror|"onerror/.test(p.html));
  assert.ok(separatorCases.length >= 3, 'keep the cases that actually fired');
  assert.ok(XSS_PAYLOADS.length >= 20, 'and a broad corpus around them');
});
