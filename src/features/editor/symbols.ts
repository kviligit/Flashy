/**
 * Mathematical symbols the editor can drop into a field.
 *
 * Set theory and the discrete-maths notation that travels with it. Typing
 * these on a phone means hunting through the emoji keyboard or copying
 * them from somewhere else, which is enough friction to make people write
 * "er delmengde av" instead — and then the deck is inconsistent and
 * harder to search, which is the same problem the stock openings solve.
 *
 * Grouped because a flat wall of fifty glyphs is harder to scan than four
 * short rows, and because the groups are how the notation is taught.
 *
 * Adding one is a single entry here.
 */

export interface MathSymbol {
  /** The button's label. */
  char: string;
  /** What it means, shown as a tooltip. */
  name: string;
  /**
   * What is actually inserted, when that differs from the label.
   *
   * Only the angle brackets need this. Note fields are rendered as HTML —
   * that is how an attached image becomes an `<img>` — so a typed `<`
   * followed by a letter is markup, and `<a,b>` is parsed as an anchor
   * tag and vanishes entirely. Inserting the entity puts a literal
   * bracket on the card while the button still shows the character the
   * user is looking for.
   */
  insert?: string;
}

/** What a button puts in the field. */
export function textFor(symbol: MathSymbol): string {
  return symbol.insert ?? symbol.char;
}

export interface SymbolGroup {
  name: string;
  symbols: readonly MathSymbol[];
}

export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    name: 'Sets',
    symbols: [
      { char: '∈', name: 'is an element of' },
      { char: '∉', name: 'is not an element of' },
      { char: '⊆', name: 'is a subset of' },
      { char: '⊈', name: 'is not a subset of' },
      { char: '⊂', name: 'is a proper subset of' },
      { char: '⊇', name: 'is a superset of' },
      { char: '⊃', name: 'is a proper superset of' },
      { char: '∪', name: 'union' },
      { char: '∩', name: 'intersection' },
      { char: '∖', name: 'set difference' },
      { char: '△', name: 'symmetric difference' },
      { char: '×', name: 'Cartesian product' },
      { char: '∅', name: 'empty set' },
      { char: '𝒫', name: 'power set' },
      // ASCII, not U+2223: it is what a keyboard produces, what people
      // already type for a|b, and it reads identically. A second,
      // indistinguishable bar button would be a coin toss on a phone,
      // where there are no tooltips to tell them apart.
      { char: '|', name: 'cardinality, "such that", or divides' },
    ],
  },
  {
    name: 'Number sets',
    symbols: [
      { char: 'ℕ', name: 'natural numbers' },
      { char: 'ℤ', name: 'integers' },
      { char: 'ℚ', name: 'rational numbers' },
      { char: 'ℝ', name: 'real numbers' },
      { char: 'ℂ', name: 'complex numbers' },
    ],
  },
  {
    name: 'Logic',
    symbols: [
      { char: '¬', name: 'not' },
      { char: '∧', name: 'and' },
      { char: '∨', name: 'or' },
      { char: '⊕', name: 'exclusive or' },
      { char: '→', name: 'implies' },
      { char: '↔', name: 'if and only if' },
      { char: '⇒', name: 'implies (double)' },
      { char: '⇔', name: 'if and only if (double)' },
      { char: '∀', name: 'for all' },
      { char: '∃', name: 'there exists' },
      { char: '∄', name: 'there does not exist' },
    ],
  },
  {
    name: 'Relations',
    symbols: [
      { char: '≠', name: 'not equal to' },
      { char: '≤', name: 'less than or equal to' },
      { char: '≥', name: 'greater than or equal to' },
      { char: '≡', name: 'is congruent to' },
      { char: '≈', name: 'approximately equal to' },
      { char: '≅', name: 'is isomorphic to' },
      { char: '∤', name: 'does not divide' },
    ],
  },
  {
    name: 'Other',
    symbols: [
      { char: '<', name: 'less than (literal, safe on a card)', insert: '&lt;' },
      { char: '>', name: 'greater than (literal, safe on a card)', insert: '&gt;' },
      { char: '…', name: 'ellipsis' },
      { char: '⟨', name: 'left angle bracket' },
      { char: '⟩', name: 'right angle bracket' },
      { char: '⌈', name: 'left ceiling' },
      { char: '⌉', name: 'right ceiling' },
      { char: '⌊', name: 'left floor' },
      { char: '⌋', name: 'right floor' },
      { char: '∑', name: 'sum' },
      { char: '∏', name: 'product' },
      { char: '∞', name: 'infinity' },
      { char: 'ℵ', name: 'aleph' },
    ],
  },
];

/** Every symbol, flattened — for tests and for lookups. */
export const ALL_SYMBOLS: readonly MathSymbol[] = SYMBOL_GROUPS.flatMap(
  (group) => group.symbols,
);

export interface Insertion {
  value: string;
  /** Where the caret should sit afterwards. */
  caret: number;
}

/**
 * Put `text` in at the caret, replacing any selection.
 *
 * Returns the caret position after the inserted text rather than leaving
 * it to the caller: someone inserting ∈ is mid-sentence and about to keep
 * typing, so putting the caret anywhere else — the end of the field, or
 * back at the start — makes the button worse than the emoji keyboard it
 * replaced.
 *
 * Out-of-range or reversed selections are tolerated because a detached
 * textarea reports `selectionStart` as 0 and a caller may pass whatever it
 * last saw; clamping is cheaper than making every call site careful.
 */
export function insertAt(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): Insertion {
  const start = clamp(Math.min(selectionStart, selectionEnd), 0, value.length);
  const end = clamp(Math.max(selectionStart, selectionEnd), 0, value.length);

  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}


/**
 * Whether a field looks like maths that HTML will eat.
 *
 * Note fields are HTML, so `<` followed by a letter starts a tag: `<a,b>`
 * is parsed as an anchor and disappears from the card completely, with no
 * error and nothing in the preview. That is a miserable thing to debug
 * from the outside, so it is named.
 *
 * The test is deliberately narrow — a tag-open followed by a name and a
 * comma — because that is the shape of an ordered pair and is not the
 * shape of any markup anyone writes. `<b>bold</b>` and an attached
 * `<img src="…">` do not match, so writing real HTML is not nagged at.
 */
export function looksLikeSwallowedMaths(value: string): boolean {
  return /<[A-Za-z][A-Za-z0-9]*\s*,/.test(value);
}
