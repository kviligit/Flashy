/**
 * Deck names are paths: `Spanish::Verbs::Irregular`. These helpers turn the
 * flat list the database stores into the tree the UI shows.
 */

import type { Deck } from './types.js';

export const DECK_SEPARATOR = '::';

export function deckParts(name: string): string[] {
  return name.split(DECK_SEPARATOR).filter((part) => part.length > 0);
}

/** Just the last component: `Spanish::Verbs` -> `Verbs`. */
export function deckBaseName(name: string): string {
  const parts = deckParts(name);
  return parts[parts.length - 1] ?? name;
}

/** The parent path, or null for a top-level deck. */
export function deckParentName(name: string): string | null {
  const parts = deckParts(name);
  return parts.length <= 1 ? null : parts.slice(0, -1).join(DECK_SEPARATOR);
}

export function deckDepth(name: string): number {
  return Math.max(0, deckParts(name).length - 1);
}

/** True when `candidate` is `name` itself or nested inside it. */
export function isDeckOrDescendant(candidate: string, name: string): boolean {
  return candidate === name || candidate.startsWith(name + DECK_SEPARATOR);
}

/** Every deck in the subtree rooted at `deck`, including `deck`. */
export function deckSubtree(decks: readonly Deck[], deck: Deck): Deck[] {
  return decks.filter((d) => isDeckOrDescendant(d.name, deck.name));
}

export interface DeckNode {
  deck: Deck;
  children: DeckNode[];
  depth: number;
}

/**
 * Build the deck forest, sorted alphabetically at each level. Decks whose
 * parent is missing are treated as top-level rather than dropped.
 */
export function buildDeckTree(decks: readonly Deck[]): DeckNode[] {
  const sorted = [...decks].sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(sorted.map((d) => [d.name, d]));
  const nodes = new Map<string, DeckNode>();
  const roots: DeckNode[] = [];

  for (const deck of sorted) {
    const node: DeckNode = { deck, children: [], depth: deckDepth(deck.name) };
    nodes.set(deck.name, node);

    const parentName = deckParentName(deck.name);
    const parent = parentName !== null && byName.has(parentName) ? nodes.get(parentName) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/** Flatten a tree back to a list, parents before children, skipping collapsed subtrees. */
export function flattenDeckTree(nodes: readonly DeckNode[], respectCollapsed = true): DeckNode[] {
  const out: DeckNode[] = [];
  const walk = (list: readonly DeckNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (!respectCollapsed || !node.deck.collapsed) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every ancestor path implied by a deck name, outermost first. */
export function ancestorNames(name: string): string[] {
  const parts = deckParts(name);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(DECK_SEPARATOR));
  return out;
}

/** Normalise a user-typed deck name. */
export function normaliseDeckName(raw: string): string {
  return deckParts(raw.trim())
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(DECK_SEPARATOR);
}

/**
 * The tag that stands for a deck.
 *
 * Tags are split on whitespace and commas, so a deck called "Discrete
 * Maths" cannot be a tag as it stands — it would arrive as two. Each
 * level of the name has its separators collapsed to a hyphen, and the
 * levels are rejoined with `::`, which is what a nested tag looks like in
 * Anki too. "Maths::Set theory" becomes "Maths::Set-theory", so filtering
 * by `tag:Maths` still finds everything underneath it.
 *
 * Returns an empty string when nothing survives, which the caller should
 * read as "no tag for this deck" rather than as a tag.
 */
export function deckTag(name: string): string {
  return deckParts(name)
    .map((part) => part.trim().replace(/[\s,]+/g, '-'))
    .filter((part) => part.length > 0)
    .join(DECK_SEPARATOR);
}
