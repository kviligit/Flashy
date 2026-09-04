import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deckTag } from './decks.js';
import { replaceTag } from '../collection/notes.js';

test('a simple deck name is its own tag', () => {
  assert.equal(deckTag('Default'), 'Default');
  assert.equal(deckTag('Norsk'), 'Norsk');
});

test('spaces become hyphens, because tags are split on whitespace', () => {
  // Left alone, "Discrete Maths" would arrive as two tags.
  assert.equal(deckTag('Discrete Maths'), 'Discrete-Maths');
  assert.equal(deckTag('  Discrete   Maths  '), 'Discrete-Maths');
});

test('commas too, since the editor splits on those as well', () => {
  assert.equal(deckTag('Logic, sets'), 'Logic-sets');
});

test('nesting is preserved, so tag:Maths still finds the subdecks', () => {
  assert.equal(deckTag('Maths::Sets'), 'Maths::Sets');
  assert.equal(deckTag('Maths::Set theory'), 'Maths::Set-theory');
  assert.equal(deckTag('Maths::Sets::Cardinality'), 'Maths::Sets::Cardinality');
});

test('a name with nothing usable in it yields no tag', () => {
  assert.equal(deckTag(''), '');
  assert.equal(deckTag('   '), '');
  assert.equal(deckTag('::'), '');
});

// --- swapping the tag when the deck changes -------------------------------

test('the old deck tag goes and the new one arrives', () => {
  assert.equal(replaceTag('Maths verb', 'Maths', 'Norsk'), 'verb Norsk');
});

test('what the user typed keeps its place', () => {
  assert.equal(replaceTag('verb noun Maths', 'Maths', 'Norsk'), 'verb noun Norsk');
});

test('switching away and back does not leave a duplicate', () => {
  const once = replaceTag('', '', 'Maths');
  const away = replaceTag(once, 'Maths', 'Norsk');
  const back = replaceTag(away, 'Norsk', 'Maths');
  assert.equal(back, 'Maths');
});

test('a tag the user already typed is not added twice', () => {
  assert.equal(replaceTag('Norsk verb', '', 'Norsk'), 'Norsk verb');
});

test('removal is by whole tag, not by prefix', () => {
  // A deck tag of "Maths" must not eat a hand-typed "Maths::Exam".
  assert.equal(replaceTag('Maths::Exam Maths', 'Maths', 'Norsk'), 'Maths::Exam Norsk');
});

test('commas and runs of spaces in the field are tolerated', () => {
  assert.equal(replaceTag('a,  b ,c', 'b', 'd'), 'a c d');
});

test('an empty replacement just removes', () => {
  assert.equal(replaceTag('Maths verb', 'Maths', ''), 'verb');
});

test('an empty field with nothing to add stays empty', () => {
  assert.equal(replaceTag('', '', ''), '');
});
