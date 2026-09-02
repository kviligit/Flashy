/**
 * Text snippets the editor can drop into a field.
 *
 * A card that always opens the same way — "Definer: …" for a definition
 * deck — is tedious to retype and easy to type inconsistently, which then
 * makes the deck harder to search. One button per stock opening fixes both.
 *
 * Adding one is a single entry here; nothing else needs to change.
 */

export interface Snippet {
  /** Button label. */
  label: string;
  /** Text inserted at the start of the field. */
  text: string;
  /** Tooltip. */
  title?: string;
}

export const SNIPPETS: readonly Snippet[] = [
  {
    label: 'Definer:',
    text: 'Definer: ',
    title: 'Start this card with "Definer: "',
  },
];

/**
 * Put `text` at the front of `value`, without duplicating it if it is
 * already there and without disturbing what follows.
 */
export function applyPrefix(value: string, text: string): string {
  if (value.startsWith(text)) return value;

  // Someone who started typing the opening by hand and then reached for
  // the button wants one opening, not "Definer: Defin". Only a field that
  // is *nothing but* a partial opening counts, though: "Delfiner er
  // pattedyr" also begins with "De", and mangling it into "Definer:
  // lfiner er pattedyr" would be far worse than a redundant prefix.
  const partial = value.trim();
  if (partial.length > 0 && text.trimEnd().startsWith(partial)) return text;

  return text + value;
}
