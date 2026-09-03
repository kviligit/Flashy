import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_SYMBOLS, insertAt, SYMBOL_GROUPS } from './symbols.js';

test('a symbol lands at the caret, not at either end', () => {
  const { value, caret } = insertAt('x  y', 2, 2, '∈');
  assert.equal(value, 'x ∈ y');
  // The caret follows the symbol, because the user is mid-sentence and
  // about to keep typing.
  assert.equal(caret, 3);
});

test('a selection is replaced', () => {
  // "A subset B": the word spans 2..8, so the spaces around it survive.
  const { value, caret } = insertAt('A subset B', 2, 8, '⊆');
  assert.equal(value, 'A ⊆ B');
  assert.equal(caret, 3);
});

test('a backwards selection is handled the same way', () => {
  // Dragging right-to-left gives selectionStart > selectionEnd in some
  // browsers; clamping here is cheaper than making every caller careful.
  assert.deepEqual(insertAt('A subset B', 8, 2, '⊆'), { value: 'A ⊆ B', caret: 3 });
});

test('an empty field is fine', () => {
  assert.deepEqual(insertAt('', 0, 0, '∅'), { value: '∅', caret: 1 });
});

test('out-of-range and nonsense positions are clamped rather than throwing', () => {
  // A detached textarea reports 0, and a stale caret can outrun the value.
  assert.deepEqual(insertAt('ab', 99, 99, '∪'), { value: 'ab∪', caret: 3 });
  assert.deepEqual(insertAt('ab', -5, -5, '∪'), { value: '∪ab', caret: 1 });
  assert.deepEqual(insertAt('ab', NaN, NaN, '∪'), { value: '∪ab', caret: 1 });
});

test('inserting twice builds up, rather than replacing', () => {
  const first = insertAt('', 0, 0, '∀');
  const second = insertAt(first.value, first.caret, first.caret, 'x');
  const third = insertAt(second.value, second.caret, second.caret, '∈');
  assert.equal(third.value, '∀x∈');
});

// --- the palette itself ---------------------------------------------------

test('every symbol is a single visible character with a name', () => {
  for (const symbol of ALL_SYMBOLS) {
    assert.ok(symbol.char.length > 0, 'a symbol needs a character');
    assert.ok(symbol.name.length > 0, `${symbol.char} needs a name for its tooltip`);
    assert.ok(!/\s/.test(symbol.char), `${JSON.stringify(symbol.char)} contains whitespace`);
    // One glyph, though a few live outside the basic plane and so are two
    // UTF-16 code units — 𝒫 among them.
    assert.equal(
      [...symbol.char].length,
      1,
      `${symbol.char} is ${[...symbol.char].length} characters, not one`,
    );
  }
});

test('no symbol appears in two groups', () => {
  const seen = new Map<string, string>();
  for (const group of SYMBOL_GROUPS) {
    for (const symbol of group.symbols) {
      const previous = seen.get(symbol.char);
      assert.equal(previous, undefined, `${symbol.char} is in both ${previous} and ${group.name}`);
      seen.set(symbol.char, group.name);
    }
  }
});

test('the set-theory basics are all present', () => {
  // The reason the feature exists: mengdelære. If a refactor drops one of
  // these the palette has stopped doing its job.
  const chars = new Set(ALL_SYMBOLS.map((symbol) => symbol.char));
  for (const required of ['∈', '∉', '⊆', '⊂', '∪', '∩', '∖', '∅', '×', 'ℕ', 'ℤ', 'ℚ', 'ℝ']) {
    assert.ok(chars.has(required), `${required} is missing from the palette`);
  }
});

test('the groups are non-empty and named', () => {
  assert.ok(SYMBOL_GROUPS.length > 0);
  for (const group of SYMBOL_GROUPS) {
    assert.ok(group.name.length > 0);
    assert.ok(group.symbols.length > 0, `${group.name} is empty`);
  }
});
