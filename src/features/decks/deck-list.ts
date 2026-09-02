/**
 * The deck list: the app's home screen. A tree of decks with their due
 * counts, and the actions that operate on a whole deck.
 */

import { button, el, render } from '../../ui/dom.js';
import { confirmModal, promptModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import {
  ancestorNames,
  buildDeckTree,
  deckBaseName,
  flattenDeckTree,
  isDeckOrDescendant,
  normaliseDeckName,
  type DeckNode,
} from '../../domain/decks.js';
import { makeDeck } from '../../domain/defaults.js';
import type { Deck } from '../../domain/types.js';
import type { DeckCounts } from '../../scheduler/index.js';
import { installHint } from './install-hint.js';

export function deckList(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  void draw(root, ctx);
  return root;
}

/** See the note in the browser: a slow draw must not overwrite a newer one. */
let deckDrawToken = 0;

async function draw(root: HTMLElement, ctx: AppContext): Promise<void> {
  const token = ++deckDrawToken;
  const decks = await ctx.db.decks.getAll();
  const counts = await ctx.scheduler.allDeckCounts();
  if (token !== deckDrawToken) return;
  const tree = buildDeckTree(decks);
  const visible = flattenDeckTree(tree);

  const refresh = () => void draw(root, ctx);

  const header = el(
    'div.row',
    {},
    el('h1', { text: 'Decks', style: { margin: '0' } }),
    el('div.spacer', {}),
    button('Add note', () => navigate('/add'), {}),
    button('Create deck', () => void createDeck(ctx, refresh), { class: 'primary' }),
  );

  const totals = [...counts.values()].reduce(
    (acc, c) => ({
      new: acc.new + (isTopLevel(decks, c.deckId) ? c.new : 0),
      learning: acc.learning + (isTopLevel(decks, c.deckId) ? c.learning : 0),
      review: acc.review + (isTopLevel(decks, c.deckId) ? c.review : 0),
    }),
    { new: 0, learning: 0, review: 0 },
  );

  const body = visible.length
    ? el('div.card', { style: { padding: '0' } }, visible.map((node) => deckRow(ctx, node, counts, refresh)))
    : el('div.empty', { text: 'No decks yet. Create one to get started.' });

  render(
    root,
    installHint(refresh),
    ctx.persistent
      ? null
      : el('div.banner', {
          text: `Storage is not persistent — nothing will survive a reload. ${ctx.storageWarning ?? ''}`,
        }),
    header,
    el('p.muted', {
      text:
        totals.new + totals.learning + totals.review === 0
          ? 'Nothing due right now.'
          : `${totals.new} new · ${totals.learning} learning · ${totals.review} to review`,
    }),
    body,
  );
}

function isTopLevel(decks: readonly Deck[], deckId: string): boolean {
  const deck = decks.find((d) => d.id === deckId);
  if (!deck) return false;
  // Only count each card once: a card in a subdeck is already included in
  // its ancestors' counts.
  return !ancestorNames(deck.name).some((name) => decks.some((d) => d.name === name));
}

function deckRow(
  ctx: AppContext,
  node: DeckNode,
  counts: Map<string, DeckCounts>,
  refresh: () => void,
): HTMLElement {
  const { deck } = node;
  const c = counts.get(deck.id) ?? { new: 0, learning: 0, review: 0, total: 0, deckId: deck.id };
  const hasChildren = node.children.length > 0;

  const twisty = button(
    hasChildren ? (deck.collapsed ? '▸' : '▾') : '•',
    () => {
      void ctx.db.decks.put({ ...deck, collapsed: !deck.collapsed, modified: Date.now() }).then(refresh);
    },
    {
      class: hasChildren ? 'twisty' : 'twisty leaf',
      'aria-label': deck.collapsed ? 'Expand' : 'Collapse',
      disabled: !hasChildren,
    },
  );

  const name = button(deckBaseName(deck.name), () => navigate(`/study/${deck.id}`), {
    class: 'ghost name',
    style: { textAlign: 'left', marginLeft: `${node.depth * 18}px` },
    title: deck.name,
  });

  const row = el(
    'div.deck-row',
    { class: c.total === 0 ? 'zero' : '', 'data-deck': deck.name },
    twisty,
    name,
    el(
      'div.deck-counts',
      {},
      countPill(c.new, 'new'),
      countPill(c.learning, 'learn'),
      countPill(c.review, 'review'),
    ),
    el(
      'div.deck-actions',
      {},
      button('Study', () => navigate(`/study/${deck.id}`), { disabled: c.total === 0 }),
      button('Rename', () => void renameDeck(ctx, deck, refresh), { class: 'ghost' }),
      button('Options', () => navigate(`/settings/deck/${deck.id}`), { class: 'ghost' }),
      button('Delete', () => void deleteDeck(ctx, deck, refresh), { class: 'ghost' }),
    ),
  );

  return row;
}

function countPill(value: number, kind: string): HTMLElement {
  return el(`span.pill.${value === 0 ? 'zero' : kind}`, {
    text: String(value),
    title: kind,
  });
}

// --- actions -------------------------------------------------------------

async function createDeck(ctx: AppContext, refresh: () => void): Promise<void> {
  const raw = await promptModal(
    'Create deck',
    'Name — use :: to nest, e.g. Spanish::Verbs',
    '',
    'Create',
  );
  if (raw === null) return;

  const name = normaliseDeckName(raw);
  if (!name) return;

  const existing = await ctx.db.decks.getAll();
  if (existing.some((d) => d.name === name)) {
    toast(`A deck named "${name}" already exists.`, 'error');
    return;
  }

  const configs = await ctx.db.deckConfigs.getAll();
  const configId = configs[0]?.id;
  if (!configId) {
    toast('No deck preset found.', 'error');
    return;
  }

  // Nesting under a deck that does not exist would strand the new deck, so
  // create the missing ancestors too, exactly as Anki does.
  const toCreate = [...ancestorNames(name), name].filter(
    (candidate) => !existing.some((d) => d.name === candidate),
  );
  await ctx.db.decks.putMany(toCreate.map((n) => makeDeck(n, configId)));

  toast(`Created "${name}".`, 'success');
  refresh();
}

async function renameDeck(ctx: AppContext, deck: Deck, refresh: () => void): Promise<void> {
  const raw = await promptModal('Rename deck', 'New name', deck.name, 'Rename');
  if (raw === null) return;

  const name = normaliseDeckName(raw);
  if (!name || name === deck.name) return;

  const all = await ctx.db.decks.getAll();
  if (all.some((d) => d.name === name && d.id !== deck.id)) {
    toast(`A deck named "${name}" already exists.`, 'error');
    return;
  }

  // Renaming a deck renames everything under it, or the children would be
  // orphaned into new top-level decks.
  const subtree = all.filter((d) => isDeckOrDescendant(d.name, deck.name));
  const now = Date.now();
  await ctx.db.decks.putMany(
    subtree.map((d) => ({ ...d, name: name + d.name.slice(deck.name.length), modified: now })),
  );

  const missing = ancestorNames(name).filter((n) => !all.some((d) => d.name === n));
  if (missing.length > 0) {
    const configId = deck.configId;
    await ctx.db.decks.putMany(missing.map((n) => makeDeck(n, configId)));
  }

  toast(`Renamed to "${name}".`, 'success');
  refresh();
}

async function deleteDeck(ctx: AppContext, deck: Deck, refresh: () => void): Promise<void> {
  const all = await ctx.db.decks.getAll();
  const subtree = all.filter((d) => isDeckOrDescendant(d.name, deck.name));
  const deckIds = new Set(subtree.map((d) => d.id));

  const cards = (await ctx.db.cards.getAll()).filter((card) => deckIds.has(card.deckId));
  const noteIds = new Set(cards.map((card) => card.noteId));

  const detail = subtree.length > 1 ? ` and ${subtree.length - 1} subdeck(s)` : '';
  const ok = await confirmModal(
    'Delete deck',
    el(
      'div',
      {},
      el('p', { text: `Delete "${deck.name}"${detail}?` }),
      el('p.muted', {
        text: `${cards.length} card(s) and ${noteIds.size} note(s) will be deleted. This cannot be undone.`,
      }),
    ),
    'Delete',
    true,
  );
  if (!ok) return;

  // Only delete notes that have no cards left anywhere else.
  const survivingNoteIds = new Set(
    (await ctx.db.cards.getAll())
      .filter((card) => !deckIds.has(card.deckId))
      .map((card) => card.noteId),
  );
  const orphanedNotes = [...noteIds].filter((id) => !survivingNoteIds.has(id));

  await ctx.db.cards.deleteMany(cards.map((card) => card.id));
  await ctx.db.notes.deleteMany(orphanedNotes);
  await ctx.db.decks.deleteMany([...deckIds]);

  toast(`Deleted "${deck.name}".`, 'success');
  refresh();
}
