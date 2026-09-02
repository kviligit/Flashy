import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPrefix, SNIPPETS } from './snippets.js';

test('the Definer snippet exists and ends with a space to type after', () => {
  const definer = SNIPPETS.find((s) => s.label === 'Definer:');
  assert.ok(definer, 'the button the deck was built around');
  assert.equal(definer.text, 'Definer: ');
});

test('a prefix goes on the front of whatever is already there', () => {
  assert.equal(applyPrefix('', 'Definer: '), 'Definer: ');
  assert.equal(applyPrefix('entropi', 'Definer: '), 'Definer: entropi');
});

test('pressing the button twice does not double the prefix', () => {
  const once = applyPrefix('entropi', 'Definer: ');
  assert.equal(applyPrefix(once, 'Definer: '), once);
});

test('a field that is nothing but a half-typed opening is completed', () => {
  assert.equal(applyPrefix('Defin', 'Definer: '), 'Definer: ');
  assert.equal(applyPrefix('Definer', 'Definer: '), 'Definer: ');
  assert.equal(applyPrefix('Definer:', 'Definer: '), 'Definer: ');
  assert.equal(applyPrefix('Definer: entropi', 'Definer: '), 'Definer: entropi');
});

test('real content that happens to share the opening letters is not mangled', () => {
  // "Delfiner" begins with "De" too. Turning it into "Definer: lfiner"
  // would be far worse than a redundant prefix.
  assert.equal(applyPrefix('Delfiner er pattedyr', 'Definer: '), 'Definer: Delfiner er pattedyr');
  assert.equal(applyPrefix('Defin entropi', 'Definer: '), 'Definer: Defin entropi');
});

test('existing content with markup survives', () => {
  assert.equal(
    applyPrefix('<img src="flashy-media:abc">', 'Definer: '),
    'Definer: <img src="flashy-media:abc">',
  );
});
