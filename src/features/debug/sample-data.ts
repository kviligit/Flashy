/**
 * Generates a plausible collection with review history, so the stats page
 * and the browser can be exercised without months of real studying.
 *
 * Development aid only — it writes straight into the collection, so it asks
 * before touching anything.
 */

import { button, el, input, render } from '../../ui/dom.js';
import { confirmModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { addNote } from '../../collection/notes.js';
import { makeDeck } from '../../domain/defaults.js';
import { newId } from '../../domain/id.js';
import type { Card, Deck, ReviewLog } from '../../domain/types.js';
import { Rating, State, answer, withDefaults } from '../../fsrs/index.js';
import { DAY_MS, dayStart, elapsedStudyDays } from '../../scheduler/index.js';

const WORDS: Array<[string, string]> = [
  ['bonjour', 'hello'], ['merci', 'thank you'], ['chien', 'dog'], ['chat', 'cat'],
  ['maison', 'house'], ['livre', 'book'], ['eau', 'water'], ['pain', 'bread'],
  ['ville', 'city'], ['temps', 'time'], ['ami', 'friend'], ['travail', 'work'],
  ['jour', 'day'], ['nuit', 'night'], ['pomme', 'apple'], ['voiture', 'car'],
  ['fenêtre', 'window'], ['porte', 'door'], ['arbre', 'tree'], ['fleur', 'flower'],
  ['soleil', 'sun'], ['lune', 'moon'], ['mer', 'sea'], ['montagne', 'mountain'],
  ['route', 'road'], ['train', 'train'], ['argent', 'money'], ['heure', 'hour'],
  ['semaine', 'week'], ['année', 'year'], ['enfant', 'child'], ['famille', 'family'],
  ['cuisine', 'kitchen'], ['table', 'table'], ['chaise', 'chair'], ['lit', 'bed'],
  ['froid', 'cold'], ['chaud', 'hot'], ['grand', 'big'], ['petit', 'small'],
];

export function sampleData(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  let noteCount = 40;
  let days = 60;
  let accuracy = 0.85;
  let running = false;

  const draw = (status: string): void => {
    render(
      root,
      el('h1', { text: 'Sample data' }),
      el('p.muted', {
        text:
          'Creates a deck of vocabulary notes and simulates studying them, so the stats page and browser have something to show.',
      }),
      el(
        'div.card.col',
        {},
        el(
          'div.row',
          {},
          numberField('Notes', noteCount, 1, WORDS.length, (v) => (noteCount = v)),
          numberField('Days of history', days, 1, 365, (v) => (days = v)),
          numberField('Accuracy %', Math.round(accuracy * 100), 10, 100, (v) => (accuracy = v / 100)),
        ),
        el(
          'div.row',
          {},
          button(running ? 'Generating…' : 'Generate', () => void generate(), {
            class: 'primary',
            disabled: running,
          }),
          button('Wipe collection', () => void wipe(), { class: 'danger', disabled: running }),
        ),
        status ? el('p', { text: status }) : null,
      ),
    );
  };

  const generate = async (): Promise<void> => {
    running = true;
    draw('Working…');
    try {
      const created = await buildSample(ctx, noteCount, days, accuracy);
      toast(`Created ${created.notes} notes and ${created.reviews} reviews.`, 'success');
      running = false;
      draw(`Done: ${created.notes} notes, ${created.cards} cards, ${created.reviews} reviews.`);
    } catch (error) {
      running = false;
      draw(error instanceof Error ? error.message : String(error));
    }
  };

  const wipe = async (): Promise<void> => {
    const ok = await confirmModal(
      'Wipe collection',
      el('p', { text: 'Delete every deck, note, card and review log? This cannot be undone.' }),
      'Wipe',
      true,
    );
    if (!ok) return;
    await ctx.db.clear();
    toast('Collection wiped. Reloading…', 'info');
    window.location.hash = '#/';
    window.location.reload();
  };

  draw('');
  return root;
}

function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
): HTMLElement {
  const control = input({
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    onInput: (ev: Event) => {
      const parsed = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
    },
  });
  return el('label.field', {}, el('span', { text: label }), control);
}

interface SampleResult {
  notes: number;
  cards: number;
  reviews: number;
}

async function buildSample(
  ctx: AppContext,
  noteCount: number,
  days: number,
  accuracy: number,
): Promise<SampleResult> {
  const now = Date.now();
  const cutoff = ctx.scheduler.dayCutoffHour;

  const noteTypes = await ctx.db.noteTypes.getAll();
  const basic = noteTypes.find((nt) => nt.name === 'Basic') ?? noteTypes[0];
  if (!basic) throw new Error('No note types in the collection.');

  const configs = await ctx.db.deckConfigs.getAll();
  const config = configs[0];
  if (!config) throw new Error('No deck config in the collection.');

  const decks = await ctx.db.decks.getAll();
  let deck: Deck | undefined = decks.find((d) => d.name === 'French');
  if (!deck) {
    deck = makeDeck('French', config.id, now - days * DAY_MS);
    await ctx.db.decks.put(deck);
  }

  // Deterministic, so a run is reproducible.
  let seed = 987654321;
  const rng = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const created: Card[] = [];
  for (let i = 0; i < noteCount; i++) {
    const [front, back] = WORDS[i % WORDS.length]!;
    const result = await addNote(ctx.db, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: front, Back: `${back}${i >= WORDS.length ? ` (${i})` : ''}` },
      tags: ['sample', i % 3 === 0 ? 'noun' : 'core'],
      now: now - days * DAY_MS,
    });
    created.push(...result.cards);
  }

  const fsrsConfig = withDefaults({
    params: config.params,
    desiredRetention: config.desiredRetention,
    learningSteps: config.learningSteps,
    relearningSteps: config.relearningSteps,
    maximumInterval: config.maximumInterval,
    enableFuzz: true,
  });

  // Walk each card forward through the history window, answering whenever
  // it came due. This produces exactly the logs a real study run would.
  const logs: ReviewLog[] = [];
  const finalCards: Card[] = [];
  const perDay = Math.max(1, Math.ceil(created.length / Math.max(1, days - 5)));

  for (const [index, original] of created.entries()) {
    let card = original;
    // Stagger introductions so the review-history chart is not one spike.
    const introDay = Math.min(days - 1, Math.floor(index / perDay));
    let clock = dayStart(now - (days - introDay) * DAY_MS, cutoff) + 10 * 3_600_000;

    for (let guard = 0; guard < 400; guard++) {
      const due = Date.parse(card.due);
      const at = Math.max(clock, due);
      if (at > now) break;

      const rating: Rating =
        rng() < accuracy ? (rng() < 0.2 ? Rating.Easy : Rating.Good) : Rating.Again;
      const elapsedDays = elapsedStudyDays(card.lastReview, at, cutoff);
      const result = answer(fsrsConfig, toScheduling(card), rating, {
        now: at,
        elapsedDays,
        random: rng,
      });

      const lastInterval = card.lastReview
        ? Math.max(0, (Date.parse(card.due) - Date.parse(card.lastReview)) / DAY_MS)
        : 0;

      logs.push({
        id: newId(),
        cardId: card.id,
        reviewedAt: at,
        rating,
        stateBefore: card.state,
        stateAfter: result.card.state,
        intervalDays: result.intervalDays,
        lastIntervalDays: lastInterval,
        elapsedDays,
        stability: result.card.memory?.stability ?? 0,
        difficulty: result.card.memory?.difficulty ?? 0,
        timeTakenMs: 2500 + Math.floor(rng() * 9000),
        snapshot: card,
        siblingsBuried: [],
      });

      card = {
        ...card,
        state: result.card.state,
        memory: result.card.memory,
        due: result.card.due,
        lastReview: result.card.lastReview,
        step: result.card.step,
        reps: result.card.reps,
        lapses: result.card.lapses,
        modified: at,
      };
      clock = at + 30_000;
    }

    finalCards.push(card);
  }

  await ctx.db.cards.putMany(finalCards);
  await ctx.db.reviewLogs.putMany(logs);

  return { notes: noteCount, cards: created.length, reviews: logs.length };
}

function toScheduling(card: Card) {
  return {
    state: card.state as State,
    memory: card.memory,
    lastReview: card.lastReview,
    due: card.due,
    step: card.step,
    lapses: card.lapses,
    reps: card.reps,
  };
}
