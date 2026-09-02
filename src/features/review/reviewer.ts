/**
 * The review screen — where the whole app earns its keep.
 *
 * The queue is held in memory for the session and mutated as cards are
 * answered, rather than rebuilt from storage after every answer: the
 * scheduler service remains the source of truth for what an answer *does*,
 * but re-reading every card between questions would make a large collection
 * crawl.
 */

import { button, el, render } from '../../ui/dom.js';
import { modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { renderCard } from '../../domain/cards.js';
import { MediaResolver } from '../../ui/media-resolver.js';
import { deferMediaSrc } from '../../domain/media.js';
import { setSafeHtml } from '../../ui/safe-html.js';
import type { Card, Note, NoteType } from '../../domain/types.js';
import {
  RATING_LABEL,
  RATINGS,
  Rating,
  State,
  type SchedulingChoices,
} from '../../fsrs/index.js';
import { LEARN_AHEAD_MINUTES, removeFromQueue, type Session } from '../../scheduler/index.js';

const RATING_CLASS: Record<Rating, string> = {
  [Rating.Again]: 'again',
  [Rating.Hard]: 'hard',
  [Rating.Good]: 'good',
  [Rating.Easy]: 'easy',
};

interface Current {
  card: Card;
  note: Note;
  noteType: NoteType;
  question: string;
  answer: string;
  choices: SchedulingChoices;
  shownAt: number;
}

export function reviewer(ctx: AppContext, deckId: string): HTMLElement {
  const root = el('section.reviewer', {});
  void run(root, ctx, deckId);
  return root;
}

async function run(root: HTMLElement, ctx: AppContext, deckId: string): Promise<void> {
  let session: Session;
  try {
    session = await ctx.scheduler.startSession(deckId);
  } catch (error) {
    render(root, el('div.empty', { text: error instanceof Error ? error.message : String(error) }));
    return;
  }

  const startedCounts = { ...session.counts };
  // One resolver for the session: the same image on several cards costs a
  // single object URL, and everything is released when the screen goes.
  const media = new MediaResolver(ctx.db);
  let current: Current | null = null;
  let showingAnswer = false;
  let answered = 0;
  let againCount = 0;
  let totalMs = 0;
  const sessionStart = ctx.scheduler.now();

  // --- keyboard --------------------------------------------------------

  const onKey = (ev: KeyboardEvent): void => {
    // The router replaces the outlet's children on navigation; when that
    // happens this handler must retire itself, and the session's object
    // URLs go with it.
    if (!root.isConnected) {
      document.removeEventListener('keydown', onKey);
      media.dispose();
      return;
    }
    if (document.querySelector('.backdrop')) return; // a dialog owns the keyboard
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      if (!showingAnswer) reveal();
      else if (current) void grade(Rating.Good);
      return;
    }
    if (showingAnswer && ['1', '2', '3', '4'].includes(ev.key)) {
      ev.preventDefault();
      void grade(Number(ev.key) as Rating);
      return;
    }
    switch (ev.key.toLowerCase()) {
      case 'u':
        ev.preventDefault();
        void undo();
        break;
      case 'e':
        if (current) {
          ev.preventDefault();
          navigate(`/edit/${current.note.id}`);
        }
        break;
      case '-':
        ev.preventDefault();
        void buryCurrent();
        break;
      case '!':
        ev.preventDefault();
        void suspendCurrent();
        break;
      case '?':
        ev.preventDefault();
        void showShortcuts();
        break;
    }
  };
  document.addEventListener('keydown', onKey);

  // --- flow ------------------------------------------------------------

  const advance = async (): Promise<void> => {
    showingAnswer = false;
    const card = ctx.scheduler.nextCard(session);
    if (!card) {
      current = null;
      drawDone();
      return;
    }

    const note = await ctx.db.notes.get(card.noteId);
    const noteType = note ? await ctx.db.noteTypes.get(note.noteTypeId) : null;
    if (!note || !noteType) {
      // An orphaned card would wedge the session; drop it and move on.
      removeFromQueue(session.queue, card.id);
      await advance();
      return;
    }

    const { question, answer } = renderCard(noteType, note.fields, card.ord);
    current = {
      card,
      note,
      noteType,
      question,
      answer,
      choices: await ctx.scheduler.choicesFor(card, session.config),
      shownAt: ctx.scheduler.now(),
    };
    draw();
  };

  const reveal = (): void => {
    if (!current || showingAnswer) return;
    showingAnswer = true;
    draw();
  };

  const grade = async (rating: Rating): Promise<void> => {
    if (!current || !showingAnswer) return;
    const card = current.card;
    const timeTaken = Math.min(ctx.scheduler.now() - current.shownAt, 10 * 60_000);

    const result = await ctx.scheduler.answerCard(card, rating, session.config, timeTaken);

    answered += 1;
    totalMs += timeTaken;
    if (rating === Rating.Again) againCount += 1;
    if (result.becameLeech) {
      toast(
        session.config.leechAction === 'suspend'
          ? 'Leech: card suspended.'
          : 'Leech: note tagged.',
        'info',
      );
    }

    removeFromQueue(session.queue, card.id);
    requeue(session, result.card, ctx.scheduler.now());
    await advance();
  };

  const undo = async (): Promise<void> => {
    const restored = await ctx.scheduler.undoLast();
    if (!restored) {
      toast('Nothing to undo.', 'info');
      return;
    }
    // Rebuilding is cheap here and guarantees the queue matches storage.
    session = await ctx.scheduler.startSession(deckId);
    answered = Math.max(0, answered - 1);
    toast('Undone.', 'success');
    await advance();
  };

  const buryCurrent = async (): Promise<void> => {
    if (!current) return;
    await ctx.scheduler.bury([current.card.id]);
    removeFromQueue(session.queue, current.card.id);
    toast('Buried until tomorrow.', 'info');
    await advance();
  };

  const suspendCurrent = async (): Promise<void> => {
    if (!current) return;
    await ctx.scheduler.setSuspended([current.card.id], true);
    removeFromQueue(session.queue, current.card.id);
    toast('Suspended.', 'info');
    await advance();
  };

  // --- rendering -------------------------------------------------------

  const draw = (): void => {
    if (!current) return;

    const content = el('div.review-content', {
      'data-side': showingAnswer ? 'answer' : 'question',
    });
    setSafeHtml(content, deferMediaSrc(showingAnswer ? current.answer : current.question));
    void media.resolve(content);

    const counts = session.queue.counts;
    const remaining = counts.new + counts.learning + counts.review;
    const total = answered + remaining;
    const progress = total === 0 ? 1 : answered / total;

    render(
      root,
      el(
        'div.review-header',
        {},
        el('span.deck-name', { text: session.deckName }),
        el('div.spacer', {}),
        el('span.pill.new', { text: String(counts.new), title: 'New' }),
        el('span.pill.learn', { text: String(counts.learning), title: 'Learning' }),
        el('span.pill.review', { text: String(counts.review), title: 'To review' }),
        button('Finish', () => navigate('/'), { class: 'ghost' }),
      ),
      el('div.review-progress', {}, el('div', { style: { width: `${progress * 100}%` } })),
      el(
        'div.review-stage',
        {},
        content,
        showingAnswer ? answerBar(current.choices) : showAnswerButton(),
      ),
      el(
        'div.review-footer',
        {},
        button('Undo (U)', () => void undo(), { class: 'ghost' }),
        button('Edit (E)', () => navigate(`/edit/${current!.note.id}`), { class: 'ghost' }),
        button('Bury (-)', () => void buryCurrent(), { class: 'ghost' }),
        button('Suspend (!)', () => void suspendCurrent(), { class: 'ghost' }),
        button('Shortcuts (?)', () => void showShortcuts(), { class: 'ghost' }),
      ),
    );
  };

  const showAnswerButton = (): HTMLElement =>
    el(
      'div.answer-bar',
      {},
      button(
        [el('span.label', { text: 'Show answer' }), el('span.key', { text: 'Space' })],
        () => reveal(),
        { class: 'primary', 'data-action': 'show-answer' },
      ),
    );

  const answerBar = (choices: SchedulingChoices): HTMLElement =>
    el(
      'div.answer-bar',
      {},
      RATINGS.map((rating) =>
        button(
          [
            el('span.label', { text: RATING_LABEL[rating] }),
            el('span.ivl', { text: choices[rating].label }),
            el('span.key', { text: String(rating) }),
          ],
          () => void grade(rating),
          { class: RATING_CLASS[rating], 'data-rating': String(rating) },
        ),
      ),
    );

  const drawDone = (): void => {
    const elapsedMin = (ctx.scheduler.now() - sessionStart) / 60_000;
    const accuracy = answered === 0 ? 0 : ((answered - againCount) / answered) * 100;
    const secondsPerCard = answered === 0 ? 0 : totalMs / answered / 1000;

    const stat = (value: string, label: string) =>
      el('div.done-stat', {}, el('span.value', { text: value }), el('span.label', { text: label }));

    render(
      root,
      el(
        'div.done-panel',
        { 'data-done': 'true' },
        el('h2', { text: answered === 0 ? 'Nothing to study' : 'Deck finished' }),
        el('p.muted', {
          text:
            answered === 0
              ? startedCounts.new + startedCounts.learning + startedCounts.review === 0
                ? 'This deck has nothing due right now. Come back tomorrow, or add some notes.'
                : 'Everything here is done for today.'
              : 'Congratulations — that is everything due in this deck today.',
        }),
        answered === 0
          ? null
          : el(
              'div.done-stats',
              {},
              stat(String(answered), answered === 1 ? 'card' : 'cards'),
              stat(`${accuracy.toFixed(0)}%`, 'correct'),
              stat(`${secondsPerCard.toFixed(1)}s`, 'per card'),
              stat(`${elapsedMin.toFixed(1)}m`, 'elapsed'),
            ),
        el(
          'div.row',
          { style: { justifyContent: 'center' } },
          button('Back to decks', () => navigate('/'), { class: 'primary' }),
          button('Add notes', () => navigate(`/add?deck=${encodeURIComponent(deckId)}`), {}),
          answered > 0 ? button('Undo last (U)', () => void undo(), { class: 'ghost' }) : null,
        ),
      ),
    );
  };

  await advance();
}

/**
 * Put a just-answered card back into the session if it is still studiable
 * today — a card that dropped into learning has more steps to go.
 */
function requeue(session: Session, card: Card, now: number): void {
  const stillLearning = card.state === State.Learning || card.state === State.Relearning;
  if (!stillLearning) return;

  const due = Date.parse(card.due);
  if (!Number.isFinite(due)) return;
  if (due > now + LEARN_AHEAD_MINUTES * 60_000) return;

  session.queue.learningCards.push(card);
  session.queue.learningCards.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  session.queue.counts.learning = session.queue.learningCards.length;
}

function showShortcuts(): Promise<void> {
  const row = (keys: string, what: string) =>
    el('tr', {}, el('td', {}, el('kbd', { text: keys })), el('td', { text: what }));

  return modal<void>({
    title: 'Keyboard shortcuts',
    dismissValue: undefined,
    actions: [{ label: 'Close', value: undefined, primary: true }],
    body: el(
      'table.shortcut-table',
      {},
      el(
        'tbody',
        {},
        row('Space', 'Show answer, then answer Good'),
        row('1 – 4', 'Again, Hard, Good, Easy'),
        row('U', 'Undo the last answer'),
        row('E', 'Edit this note'),
        row('-', 'Bury until tomorrow'),
        row('!', 'Suspend this card'),
        row('?', 'This list'),
      ),
    ),
  });
}
