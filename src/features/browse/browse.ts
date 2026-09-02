/**
 * The card browser: find cards, inspect their state, and act on a selection.
 */

import { button, el, input, render, select } from '../../ui/dom.js';
import { confirmModal, modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { cardPreview, renderCard } from '../../domain/cards.js';
import { MediaResolver } from '../../ui/media-resolver.js';
import { deferMediaSrc } from '../../domain/media.js';
import { deleteNotes, setCardDeck } from '../../collection/notes.js';
import { stripHtml } from '../../domain/render.js';
import type { Card, Deck, Note, NoteType } from '../../domain/types.js';
import { State, formatInterval } from '../../fsrs/index.js';

interface Row {
  card: Card;
  note: Note;
  noteType: NoteType;
  deck: Deck;
  question: string;
}

const STATE_CLASS: Record<number, string> = {
  [State.New]: 'new',
  [State.Learning]: 'learn',
  [State.Review]: 'review',
  [State.Relearning]: 'relearn',
};

const STATE_NAME: Record<number, string> = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
};

export function browse(ctx: AppContext, initialQuery = ''): HTMLElement {
  const root = el('section', {});
  let query = initialQuery;
  let deckFilter = '';
  /**
   * The selection is mutated in place and never replaced.
   *
   * Each row's checkbox handler closes over this object, so swapping in a
   * new Set on every draw would strand the handlers of any row rendered
   * before the swap: ticking a box would mutate a Set nothing reads any
   * more, and the tick would vanish. Bulk actions then operate on a
   * selection that is not the one on screen — which, for delete, means
   * removing the wrong notes.
   */
  const selected = new Set<string>();

  /**
   * Drawing reads the database, so two draws started in quick succession —
   * ticking two checkboxes, say — can finish out of order and leave the
   * screen showing the older one's state. That is not merely cosmetic
   * here: the bulk actions act on the selection captured by whichever
   * render is on screen, so a stale render means deleting the wrong notes.
   * A token makes the loser of a race stand down.
   */
  let drawToken = 0;

  const refresh = (): void => void draw();

  const draw = async (): Promise<void> => {
    const token = ++drawToken;
    const rows = await loadRows(ctx);
    if (token !== drawToken) return;
    const visible = rows.filter((row) => matches(row, query, deckFilter));
    // Drop selections the current filter hides, so bulk actions only ever
    // touch what the user can see — pruned in place, never replaced.
    for (const id of [...selected]) {
      if (!visible.some((row) => row.card.id === id)) selected.delete(id);
    }

    const decks = [...new Set(rows.map((row) => row.deck.name))].sort();

    const searchBox = input({
      type: 'search',
      value: query,
      placeholder: 'Search text, tags (tag:verb), or state (is:new, is:due, is:suspended)',
      onInput: (ev: Event) => {
        query = (ev.target as HTMLInputElement).value;
        refresh();
      },
    });

    const deckSelect = select(
      [{ value: '', label: 'All decks' }, ...decks.map((name) => ({ value: name, label: name }))],
      {
        onChange: (ev: Event) => {
          deckFilter = (ev.target as HTMLSelectElement).value;
          refresh();
        },
      },
    );
    deckSelect.value = deckFilter;

    const selectionCount = selected.size;
    const act = (fn: (ids: string[]) => Promise<void>) => async () => {
      await fn([...selected]);
      refresh();
    };

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: 'Browse', style: { margin: '0' } }),
        el('div.spacer', {}),
        button('Add note', () => navigate('/add'), { class: 'primary' }),
      ),
      el(
        'div.browse-toolbar',
        {},
        searchBox,
        deckSelect,
        el('span.muted', {
          'data-count': String(visible.length),
          text: `${visible.length} of ${rows.length} cards`,
        }),
      ),
      selectionCount > 0
        ? el(
            'div.browse-toolbar',
            {},
            el('strong', { text: `${selectionCount} selected` }),
            button('Suspend', act((ids) => ctx.scheduler.setSuspended(ids, true))),
            button('Unsuspend', act((ids) => ctx.scheduler.setSuspended(ids, false))),
            button('Bury', act((ids) => ctx.scheduler.bury(ids))),
            button('Forget', act((ids) => ctx.scheduler.forget(ids))),
            button('Move to deck…', () => void moveCards(ctx, [...selected], refresh)),
            button('Delete notes…', () => void deleteSelected(ctx, visible, selected, refresh), {
              class: 'danger',
            }),
            button('Clear', () => {
              selected.clear();
              refresh();
            }, { class: 'ghost' }),
          )
        : null,
      visible.length === 0
        ? el('div.empty', { text: rows.length === 0 ? 'No cards yet.' : 'Nothing matches that search.' })
        : el(
            'div.card',
            { style: { padding: '0', overflowX: 'auto' } },
            el(
              'table.browse',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', { style: { width: '2em' } }),
                  el('th', { text: 'Question' }),
                  el('th', { text: 'Deck' }),
                  el('th', { text: 'State' }),
                  el('th', { text: 'Due' }),
                  el('th', { text: 'Interval' }),
                  el('th', { text: 'Reps' }),
                  el('th', { text: 'Tags' }),
                  el('th', {}),
                ),
              ),
              el('tbody', {}, visible.map((row) => rowView(ctx, row, selected, refresh))),
            ),
          ),
    );
  };

  refresh();
  return root;
}

function rowView(
  ctx: AppContext,
  row: Row,
  selected: Set<string>,
  refresh: () => void,
): HTMLElement {
  const checkbox = input({
    type: 'checkbox',
    checked: selected.has(row.card.id),
    'aria-label': 'Select card',
    style: { width: 'auto' },
    onChange: (ev: Event) => {
      if ((ev.target as HTMLInputElement).checked) selected.add(row.card.id);
      else selected.delete(row.card.id);
      refresh();
    },
  });

  const interval =
    row.card.state === State.New || !row.card.lastReview
      ? '—'
      : formatInterval(
          Math.max(0, (Date.parse(row.card.due) - Date.parse(row.card.lastReview)) / 86_400_000),
        );

  return el(
    'tr',
    { class: selected.has(row.card.id) ? 'selected' : '', 'data-card': row.card.id },
    el('td', {}, checkbox),
    el('td.q', {
      class: row.card.suspended ? 'suspended' : '',
      text: row.question || '(blank)',
      title: row.question,
    }),
    el('td.muted', { text: row.deck.name }),
    el(
      'td',
      {},
      el(`span.state-dot.${STATE_CLASS[row.card.state] ?? 'new'}`, {}),
      el('span', { text: row.card.suspended ? 'Suspended' : (STATE_NAME[row.card.state] ?? '?') }),
    ),
    el('td.muted', {
      text: row.card.state === State.New ? '—' : new Date(row.card.due).toLocaleDateString(),
    }),
    el('td.muted', { text: interval }),
    el('td.muted', { text: `${row.card.reps}${row.card.lapses ? ` / ${row.card.lapses}✕` : ''}` }),
    el('td', {}, row.note.tags.map((tag) => el('span.tag-chip', { text: tag }))),
    el(
      'td',
      {},
      button('Edit', () => navigate(`/edit/${row.note.id}`), { class: 'ghost' }),
      button('Info', () => void cardInfo(ctx, row), { class: 'ghost' }),
    ),
  );
}

async function loadRows(ctx: AppContext): Promise<Row[]> {
  const [cards, notes, noteTypes, decks] = await Promise.all([
    ctx.db.cards.getAll(),
    ctx.db.notes.getAll(),
    ctx.db.noteTypes.getAll(),
    ctx.db.decks.getAll(),
  ]);
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const typeById = new Map(noteTypes.map((nt) => [nt.id, nt]));
  const deckById = new Map(decks.map((d) => [d.id, d]));

  const rows: Row[] = [];
  for (const card of cards) {
    const note = noteById.get(card.noteId);
    const deck = deckById.get(card.deckId);
    if (!note || !deck) continue; // orphan; nothing sensible to show
    const noteType = typeById.get(note.noteTypeId);
    if (!noteType) continue;
    rows.push({
      card,
      note,
      noteType,
      deck,
      question: cardPreview(noteType, note.fields, card.ord),
    });
  }

  rows.sort((a, b) => b.note.modified - a.note.modified || a.card.ord - b.card.ord);
  return rows;
}

/**
 * Search: bare words match the card text and tags; `tag:`, `deck:` and `is:`
 * narrow by metadata. Every term must match.
 */
export function matches(row: Row, query: string, deckFilter: string): boolean {
  if (deckFilter && row.deck.name !== deckFilter) return false;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [
    row.question,
    ...Object.values(row.note.fields).map(stripHtml),
    ...row.note.tags,
    row.deck.name,
  ]
    .join(' ')
    .toLowerCase();

  const now = Date.now();

  return terms.every((term) => {
    if (term.startsWith('tag:')) {
      const wanted = term.slice(4);
      return row.note.tags.some((tag) => tag.toLowerCase().includes(wanted));
    }
    if (term.startsWith('deck:')) return row.deck.name.toLowerCase().includes(term.slice(5));
    if (term.startsWith('is:')) {
      switch (term.slice(3)) {
        case 'new':
          return row.card.state === State.New;
        case 'learn':
          return row.card.state === State.Learning || row.card.state === State.Relearning;
        case 'review':
          return row.card.state === State.Review;
        case 'due':
          return row.card.state !== State.New && Date.parse(row.card.due) <= now;
        case 'suspended':
          return row.card.suspended;
        case 'buried':
          return Boolean(row.card.buriedUntil && Date.parse(row.card.buriedUntil) > now);
        case 'leech':
          return row.note.tags.includes('leech');
        default:
          return false;
      }
    }
    return haystack.includes(term);
  });
}

// --- actions -------------------------------------------------------------

async function moveCards(ctx: AppContext, cardIds: string[], refresh: () => void): Promise<void> {
  const decks = (await ctx.db.decks.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  if (decks.length === 0) return;

  const picker = select(decks.map((d) => ({ value: d.id, label: d.name })));
  const chosen = await modal<boolean>({
    title: `Move ${cardIds.length} card(s)`,
    body: el('label.field', {}, el('span', { text: 'Deck' }), picker),
    dismissValue: false,
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Move', value: true, primary: true },
    ],
  });
  if (!chosen) return;

  await setCardDeck(ctx.db, cardIds, picker.value);
  toast(`Moved ${cardIds.length} card(s).`, 'success');
  refresh();
}

async function deleteSelected(
  ctx: AppContext,
  rows: Row[],
  selected: Set<string>,
  refresh: () => void,
): Promise<void> {
  const noteIds = [
    ...new Set(rows.filter((row) => selected.has(row.card.id)).map((row) => row.note.id)),
  ];
  if (noteIds.length === 0) return;

  const affected = (await ctx.db.cards.getAll()).filter((card) => noteIds.includes(card.noteId));
  const ok = await confirmModal(
    'Delete notes',
    el(
      'div',
      {},
      el('p', { text: `Delete ${noteIds.length} note(s)?` }),
      el('p.muted', {
        text: `${affected.length} card(s) and their review history will be removed. This cannot be undone.`,
      }),
    ),
    'Delete',
    true,
  );
  if (!ok) return;

  await deleteNotes(ctx.db, noteIds);
  selected.clear();
  toast(`Deleted ${noteIds.length} note(s).`, 'success');
  refresh();
}

async function cardInfo(ctx: AppContext, row: Row): Promise<void> {
  const logs = (await ctx.db.reviewLogs.byIndex('cardId', row.card.id)).sort(
    (a, b) => b.reviewedAt - a.reviewedAt,
  );

  // A rendered preview, with any attached media resolved for the dialog's
  // lifetime and released when it closes.
  const media = new MediaResolver(ctx.db);
  const rendered = renderCard(row.noteType, row.note.fields, row.card.ord);
  const preview = el(
    'div.col',
    {},
    el('div.preview-label', { text: 'Front' }),
    el('div.preview-card', { html: deferMediaSrc(rendered.question) }),
    el('div.preview-label', { text: 'Back' }),
    el('div.preview-card', { html: deferMediaSrc(rendered.answer) }),
  );
  void media.resolve(preview);

  const stat = (label: string, value: string) =>
    el('tr', {}, el('th', { text: label }), el('td', { text: value }));

  await modal<void>({
    title: 'Card info',
    wide: true,
    dismissValue: undefined,
    actions: [{ label: 'Close', value: undefined, primary: true }],
    body: el(
      'div.col',
      {},
      preview,
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          stat('Deck', row.deck.name),
          stat('Note type', row.noteType.name),
          stat('Card', row.noteType.kind === 'cloze' ? `Cloze ${row.card.ord}` : (row.noteType.templates[row.card.ord]?.name ?? '—')),
          stat('State', STATE_NAME[row.card.state] ?? '?'),
          stat('Due', row.card.state === State.New ? '—' : new Date(row.card.due).toLocaleString()),
          stat('Stability', row.card.memory ? `${row.card.memory.stability.toFixed(2)} d` : '—'),
          stat('Difficulty', row.card.memory ? row.card.memory.difficulty.toFixed(2) : '—'),
          stat('Reviews', String(row.card.reps)),
          stat('Lapses', String(row.card.lapses)),
          stat('Position', String(row.card.position)),
        ),
      ),
      el('h3', { text: `Review history (${logs.length})` }),
      logs.length === 0
        ? el('div.empty', { text: 'Never reviewed.' })
        : el(
            'div',
            { style: { maxHeight: '260px', overflow: 'auto' } },
            el(
              'table',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  ['When', 'Rating', 'Interval', 'Stability', 'Time'].map((h) => el('th', { text: h })),
                ),
              ),
              el(
                'tbody',
                {},
                logs.map((log) =>
                  el(
                    'tr',
                    {},
                    el('td', { text: new Date(log.reviewedAt).toLocaleString() }),
                    el('td', { text: ['', 'Again', 'Hard', 'Good', 'Easy'][log.rating] ?? '?' }),
                    el('td', { text: formatInterval(log.intervalDays) }),
                    el('td', { text: log.stability.toFixed(2) }),
                    el('td', { text: `${(log.timeTakenMs / 1000).toFixed(1)}s` }),
                  ),
                ),
              ),
            ),
          ),
    ),
  });

  media.dispose();
}
