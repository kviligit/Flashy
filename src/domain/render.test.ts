import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clozeOrdinals,
  fieldsReferenced,
  isBlankQuestion,
  renderCloze,
  renderTemplate,
  stripHtml,
} from './render.js';
import { cardPreview, generateOrds, renderCard } from './cards.js';
import { basicNoteType, basicReversedNoteType, clozeNoteType } from './defaults.js';

const F = { Front: 'bonjour', Back: 'hello' };

test('a field reference is replaced by its value', () => {
  assert.equal(renderTemplate('{{Front}}', { fields: F, ord: 0, side: 'question' }), 'bonjour');
  assert.equal(
    renderTemplate('{{Front}} = {{Back}}', { fields: F, ord: 0, side: 'question' }),
    'bonjour = hello',
  );
});

test('whitespace inside a reference is tolerated', () => {
  assert.equal(renderTemplate('{{ Front }}', { fields: F, ord: 0, side: 'question' }), 'bonjour');
});

test('an unknown field is left visible rather than silently blanked', () => {
  const out = renderTemplate('{{Nope}}', { fields: F, ord: 0, side: 'question' });
  assert.equal(out, '{{Nope}}', 'a typo in a template should be obvious');
});

test('an empty known field renders as nothing', () => {
  const out = renderTemplate('[{{Back}}]', { fields: { Front: 'x', Back: '' }, ord: 0, side: 'question' });
  assert.equal(out, '[]');
});

test('FrontSide expands on the answer only', () => {
  const answer = renderTemplate('{{FrontSide}}<hr>{{Back}}', {
    fields: F,
    ord: 0,
    side: 'answer',
    frontSide: 'bonjour',
  });
  assert.equal(answer, 'bonjour<hr>hello');
  assert.equal(renderTemplate('{{FrontSide}}', { fields: F, ord: 0, side: 'question' }), '');
});

test('the text: filter strips markup', () => {
  const fields = { Front: '<b>bon</b>jour<br>x' };
  assert.equal(
    renderTemplate('{{text:Front}}', { fields, ord: 0, side: 'question' }),
    'bonjour x',
  );
});

test('the hint: filter produces a disclosure, and nothing when empty', () => {
  const withHint = renderTemplate('{{hint:Back}}', { fields: F, ord: 0, side: 'question' });
  assert.match(withHint, /<details class="hint">/);
  assert.match(withHint, /hello/);
  assert.equal(
    renderTemplate('{{hint:Back}}', { fields: { Front: 'x', Back: '' }, ord: 0, side: 'question' }),
    '',
  );
});

test('conditional sections show and hide on emptiness', () => {
  const template = '{{#Back}}has back{{/Back}}{{^Back}}no back{{/Back}}';
  assert.equal(renderTemplate(template, { fields: F, ord: 0, side: 'question' }), 'has back');
  assert.equal(
    renderTemplate(template, { fields: { Front: 'x', Back: '' }, ord: 0, side: 'question' }),
    'no back',
  );
  // Whitespace-only counts as empty, as it does in Anki.
  assert.equal(
    renderTemplate(template, { fields: { Front: 'x', Back: '  <br> ' }, ord: 0, side: 'question' }),
    'no back',
  );
});

test('nested sections resolve from the inside out', () => {
  const template = '{{#Front}}A{{#Back}}B{{/Back}}C{{/Front}}';
  assert.equal(renderTemplate(template, { fields: F, ord: 0, side: 'question' }), 'ABC');
  assert.equal(
    renderTemplate(template, { fields: { Front: 'x', Back: '' }, ord: 0, side: 'question' }),
    'AC',
  );
  assert.equal(
    renderTemplate(template, { fields: { Front: '', Back: 'y' }, ord: 0, side: 'question' }),
    '',
  );
});

// --- cloze ---------------------------------------------------------------

test('cloze ordinals are found, deduplicated and sorted', () => {
  assert.deepEqual(clozeOrdinals('{{c1::a}} {{c3::b}} {{c1::c}}'), [1, 3]);
  assert.deepEqual(clozeOrdinals('no clozes here'), []);
  assert.deepEqual(clozeOrdinals('{{c2::x::hint}}'), [2]);
});

test('the card’s own cloze is blanked on the question and shown on the answer', () => {
  const text = 'The capital of {{c1::France}} is {{c2::Paris}}.';
  const q1 = renderCloze(text, 1, 'question');
  assert.match(q1, /\[\.\.\.\]/, 'c1 is blanked');
  assert.match(q1, /Paris/, 'c2 still reads normally');
  assert.ok(!q1.includes('France'), 'c1 must not leak the answer');

  const a1 = renderCloze(text, 1, 'answer');
  assert.match(a1, /<span class="cloze">France<\/span>/);
  assert.match(a1, /Paris/);
});

test('a cloze hint replaces the ellipsis', () => {
  const q = renderCloze('{{c1::Paris::the city}}', 1, 'question');
  assert.match(q, /\[the city\]/);
  assert.ok(!q.includes('Paris'));
});

test('cloze hints are escaped', () => {
  const q = renderCloze('{{c1::x::<script>bad()</script>}}', 1, 'question');
  assert.ok(!q.includes('<script>'), 'hint markup must be escaped');
});

// --- sanitising ----------------------------------------------------------

// Sanitising moved out of this module entirely: it cannot be done safely
// without a parser, and this layer is deliberately DOM-free. The security
// boundary is `setSafeHtml` in src/ui/safe-html.ts, tested in
// src/ui/safe-html.test.ts and end-to-end in a real browser.

test('rendering does not claim to sanitise', () => {
  // Rendering passes author HTML through unchanged. That is not a bug: it
  // is why every insertion point must use setSafeHtml. Pinning it here so
  // nobody later mistakes this layer for a safe one.
  const hostile = '<img src=x onerror="alert(1)">';
  assert.equal(
    renderTemplate('{{Front}}', { fields: { Front: hostile }, ord: 0, side: 'question' }),
    hostile,
  );
});

test('stripHtml flattens markup and whitespace', () => {
  assert.equal(stripHtml('<b>a</b><br><i>b</i>   c'), 'a b c');
  assert.equal(stripHtml('&amp;&lt;&gt;&nbsp;'), '&<>');
  assert.equal(stripHtml('   '), '');
});

test('isBlankQuestion sees through markup', () => {
  assert.ok(isBlankQuestion(''));
  assert.ok(isBlankQuestion('<br><div></div>  '));
  assert.ok(!isBlankQuestion('<b>x</b>'));
});

test('fieldsReferenced lists names once, ignoring filters and FrontSide', () => {
  const names = fieldsReferenced('{{Front}} {{text:Front}} {{#Back}}{{Back}}{{/Back}} {{FrontSide}}');
  assert.deepEqual(names.sort(), ['Back', 'Front']);
});

// --- card generation -----------------------------------------------------

test('Basic generates one card', () => {
  assert.deepEqual(generateOrds(basicNoteType(), F), [0]);
});

test('Basic (and reversed) generates two cards, or one when Back is empty', () => {
  const nt = basicReversedNoteType();
  assert.deepEqual(generateOrds(nt, F), [0, 1]);
  assert.deepEqual(
    generateOrds(nt, { Front: 'bonjour', Back: '' }),
    [0],
    'no reverse card without a Back',
  );
  assert.deepEqual(
    generateOrds(nt, { Front: '', Back: 'hello' }),
    [1],
    'only the reverse card when Front is empty',
  );
  assert.deepEqual(generateOrds(nt, { Front: '', Back: '' }), [], 'an empty note makes no cards');
});

test('Cloze generates one card per distinct deletion', () => {
  const nt = clozeNoteType();
  assert.deepEqual(
    generateOrds(nt, { Text: '{{c1::a}} and {{c2::b}} and {{c1::c}}', Extra: '' }),
    [1, 2],
  );
  assert.deepEqual(generateOrds(nt, { Text: 'no deletions', Extra: '' }), []);
});

test('renderCard produces both sides for the right ordinal', () => {
  const nt = basicReversedNoteType();
  const front = renderCard(nt, F, 0);
  assert.equal(front.question, 'bonjour');
  assert.equal(front.answer, 'bonjour<hr>hello');

  const back = renderCard(nt, F, 1);
  assert.equal(back.question, 'hello');
  assert.equal(back.answer, 'hello<hr>bonjour');
});

test('renderCard resolves cloze against the card’s ordinal', () => {
  const nt = clozeNoteType();
  const fields = { Text: '{{c1::alpha}} {{c2::beta}}', Extra: 'note' };
  const card2 = renderCard(nt, fields, 2);
  assert.match(card2.question, /alpha/, 'the other deletion reads normally');
  assert.ok(!card2.question.includes('beta'), 'this card’s deletion is hidden');
  assert.match(card2.answer, /beta/, 'and revealed on the answer');
});

test('cardPreview gives a plain-text one-liner', () => {
  assert.equal(cardPreview(basicNoteType(), { Front: '<b>bon</b>jour', Back: 'x' }, 0), 'bonjour');
});

test('knownFields decides whether an unknown reference is visible or empty', () => {
  const fields = { Front: 'x' };
  // No knownFields: a typo stays visible, so it is obvious while editing.
  assert.equal(renderTemplate('{{Typo}}', { fields, ord: 0, side: 'question' }), '{{Typo}}');

  // With knownFields: the field cannot ever hold content, so it renders as
  // nothing — which is what stops a stale reference keeping a card alive
  // after its field has been deleted.
  assert.equal(
    renderTemplate('{{Typo}}', {
      fields,
      ord: 0,
      side: 'question',
      knownFields: new Set(['Front']),
    }),
    '',
  );
});

test('a card is not generated from a template referencing a deleted field', () => {
  const nt = basicReversedNoteType();
  // Simulate "Back" having been removed from the note type while its
  // template still mentions it.
  const stripped = { ...nt, fields: [{ name: 'Front' }] };
  assert.deepEqual(generateOrds(stripped, { Front: 'a' }), [0]);
});

test('a question that is only an image is not blank', () => {
  // Stripping tags from an image-only card leaves nothing, and treating
  // that as blank would refuse to create the card at all.
  assert.ok(!isBlankQuestion('<img src="flashy-media:abc">'));
  assert.ok(!isBlankQuestion('<audio src="flashy-media:abc"></audio>'));
  assert.ok(!isBlankQuestion('  <img src="x.png">  '));
  assert.ok(isBlankQuestion('<div></div>'), 'an empty container still counts as blank');
});

test('a note whose only content is an image still generates a card', () => {
  const nt = basicNoteType();
  assert.deepEqual(generateOrds(nt, { Front: '<img src="flashy-media:abc">', Back: 'answer' }), [0]);
});
