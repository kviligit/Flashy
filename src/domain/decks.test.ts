import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ancestorNames,
  buildDeckTree,
  deckBaseName,
  deckDepth,
  deckParentName,
  flattenDeckTree,
  isDeckOrDescendant,
  normaliseDeckName,
} from './decks.js';
import type { Deck } from './types.js';

function deck(name: string, collapsed = false): Deck {
  return { id: name, name, configId: 'cfg', description: '', collapsed, created: 0, modified: 0 };
}

test('deck paths split into base name, parent and depth', () => {
  assert.equal(deckBaseName('Spanish::Verbs::Irregular'), 'Irregular');
  assert.equal(deckBaseName('Spanish'), 'Spanish');
  assert.equal(deckParentName('Spanish::Verbs::Irregular'), 'Spanish::Verbs');
  assert.equal(deckParentName('Spanish'), null);
  assert.equal(deckDepth('Spanish'), 0);
  assert.equal(deckDepth('Spanish::Verbs::Irregular'), 2);
});

test('descendant test matches the subtree and not lookalike names', () => {
  assert.ok(isDeckOrDescendant('Spanish', 'Spanish'));
  assert.ok(isDeckOrDescendant('Spanish::Verbs', 'Spanish'));
  assert.ok(!isDeckOrDescendant('Spanish', 'Spanish::Verbs'));
  // The classic bug: a prefix match without the separator.
  assert.ok(!isDeckOrDescendant('Spanishy', 'Spanish'));
});

test('ancestorNames lists every implied parent, outermost first', () => {
  assert.deepEqual(ancestorNames('a::b::c'), ['a', 'a::b']);
  assert.deepEqual(ancestorNames('a'), []);
});

test('buildDeckTree nests children under parents, alphabetically', () => {
  const roots = buildDeckTree([
    deck('Spanish::Verbs'),
    deck('Default'),
    deck('Spanish'),
    deck('Spanish::Nouns'),
  ]);
  assert.deepEqual(roots.map((n) => n.deck.name), ['Default', 'Spanish']);
  assert.deepEqual(roots[1]?.children.map((n) => n.deck.name), ['Spanish::Nouns', 'Spanish::Verbs']);
});

test('a deck whose parent does not exist becomes a root rather than vanishing', () => {
  const roots = buildDeckTree([deck('Orphan::Child')]);
  assert.deepEqual(roots.map((n) => n.deck.name), ['Orphan::Child']);
});

test('flattenDeckTree respects the collapsed flag', () => {
  const tree = buildDeckTree([deck('A', true), deck('A::B'), deck('C')]);
  assert.deepEqual(flattenDeckTree(tree).map((n) => n.deck.name), ['A', 'C']);
  assert.deepEqual(flattenDeckTree(tree, false).map((n) => n.deck.name), ['A', 'A::B', 'C']);
});

test('normaliseDeckName trims and drops empty components', () => {
  assert.equal(normaliseDeckName('  Spanish :: Verbs  '), 'Spanish::Verbs');
  assert.equal(normaliseDeckName('Spanish::::Verbs'), 'Spanish::Verbs');
  assert.equal(normaliseDeckName('   '), '');
});
