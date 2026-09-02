import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deferMediaSrc,
  formatFileSize,
  fromBase64,
  hashContent,
  MEDIA_SCHEME,
  mediaIdFrom,
  mediaKind,
  mediaRefsIn,
  mediaRefsInFields,
  mediaTag,
  mediaUrl,
  stripMediaRef,
  toBase64,
} from './media.js';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

test('media kinds are recognised from their mime type', () => {
  assert.equal(mediaKind('image/png'), 'image');
  assert.equal(mediaKind('IMAGE/JPEG'), 'image');
  assert.equal(mediaKind('image/jpeg; charset=binary'), 'image');
  assert.equal(mediaKind('audio/mpeg'), 'audio');
  assert.equal(mediaKind('image/avif'), 'image', 'unlisted image types still count as images');
  assert.equal(mediaKind('application/pdf'), null);
  assert.equal(mediaKind(''), null);
});

test('references round-trip through the custom scheme', () => {
  assert.equal(mediaUrl('abc'), `${MEDIA_SCHEME}abc`);
  assert.equal(mediaIdFrom(mediaUrl('abc')), 'abc');
  assert.equal(mediaIdFrom('https://example.com/x.png'), null, 'a real URL is not a reference');
  assert.equal(mediaIdFrom(MEDIA_SCHEME), null, 'an empty id is not a reference');
});

test('tags are well-formed and escape their alt text', () => {
  assert.equal(mediaTag('abc', 'image'), '<img src="flashy-media:abc" alt="">');
  assert.match(mediaTag('abc', 'audio'), /^<audio src="flashy-media:abc" controls preload="none"><\/audio>$/);

  const hostile = mediaTag('abc', 'image', '" onerror="alert(1)');
  assert.ok(!hostile.includes('onerror="alert'), 'a quote in the alt text must not break out');
  assert.match(hostile, /&quot;/);
});

test('references are found in markup, deduplicated, and ignore other URLs', () => {
  const html = '<img src="flashy-media:one"> text <audio src="flashy-media:two"></audio> <img src="flashy-media:one">';
  assert.deepEqual(mediaRefsIn(html), ['one', 'two']);
  assert.deepEqual(mediaRefsIn('<img src="https://example.com/a.png">'), []);
  assert.deepEqual(mediaRefsIn('no media at all'), []);
  assert.deepEqual(mediaRefsIn("<img src='flashy-media:quoted'>"), ['quoted'], 'single quotes');
});

test('references are gathered across every field of a note', () => {
  assert.deepEqual(
    mediaRefsInFields({ Front: '<img src="flashy-media:a">', Back: '<img src="flashy-media:b">', Extra: '' }),
    ['a', 'b'],
  );
  assert.deepEqual(mediaRefsInFields({ Front: 'plain' }), []);
});

test('stripping a reference removes its tag and leaves the rest alone', () => {
  const html = 'before <img src="flashy-media:gone" alt="x"> middle <img src="flashy-media:kept"> after';
  const stripped = stripMediaRef(html, 'gone');
  assert.ok(!stripped.includes('gone'));
  assert.ok(stripped.includes('flashy-media:kept'), 'the other reference survives');
  assert.ok(stripped.includes('before') && stripped.includes('after'));

  const audio = stripMediaRef('<audio src="flashy-media:snd" controls preload="none"></audio>x', 'snd');
  assert.equal(audio.trim(), 'x');
});

test('the content hash is stable, and different content hashes differently', async () => {
  const a = await hashContent(bytes(1, 2, 3));
  const b = await hashContent(bytes(1, 2, 3));
  const c = await hashContent(bytes(1, 2, 4));
  assert.equal(a, b, 'the same bytes must dedupe');
  assert.notEqual(a, c);
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]+$/);
});

test('base64 round-trips, including bytes that are not valid text', async () => {
  const original = new Uint8Array([0, 1, 127, 128, 255, 254]);
  const encoded = toBase64(original.buffer);
  assert.deepEqual(new Uint8Array(fromBase64(encoded)), original);

  // Something larger than the chunk size used internally.
  const big = new Uint8Array(100_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  assert.deepEqual(new Uint8Array(fromBase64(toBase64(big.buffer))), big);
});

test('file sizes read the way a person expects', () => {
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatFileSize(1024 * 1024 * 40), '40 MB');
});

test('deferMediaSrc parks references where the browser will not fetch them', () => {
  // Left in `src`, the browser immediately tries to load the custom scheme,
  // fails, and shows a broken element until the resolver catches up.
  const deferred = deferMediaSrc('<img src="flashy-media:abc" alt="x">');
  assert.ok(!deferred.includes('src="flashy-media'), 'no fetchable reference remains');
  assert.match(deferred, /data-media-src="abc"/);
  assert.match(deferred, /alt="x"/, 'other attributes survive');

  assert.equal(
    deferMediaSrc('<img src="https://example.com/a.png">'),
    '<img src="https://example.com/a.png">',
    'ordinary URLs are untouched',
  );

  const audio = deferMediaSrc('<audio src="flashy-media:snd" controls></audio>');
  assert.match(audio, /data-media-src="snd"/);
  assert.match(audio, /controls/);

  const many = deferMediaSrc('<img src="flashy-media:a"><img src="flashy-media:b">');
  assert.deepEqual(many.match(/data-media-src="[ab]"/g), ['data-media-src="a"', 'data-media-src="b"']);
});
