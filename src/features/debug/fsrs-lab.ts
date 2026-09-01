/**
 * A scratchpad for the algorithm: answer a simulated card over and over and
 * watch stability, difficulty and the four button intervals move. Useful for
 * sanity-checking parameter changes without touching real cards.
 */

import { el, button, field, input, render } from '../../ui/dom.js';
import {
  answer,
  cardRetrievability,
  DAY_MS,
  elapsedDaysOf,
  formatInterval,
  newCard,
  RATING_LABEL,
  RATINGS,
  Rating,
  schedule,
  STATE_LABEL,
  withDefaults,
  type FsrsConfig,
  type SchedulingCard,
} from '../../fsrs/index.js';

interface Entry {
  rating: Rating;
  elapsedDays: number;
  intervalDays: number;
  stability: number;
  difficulty: number;
  state: number;
}

const RATING_VAR: Record<Rating, string> = {
  [Rating.Again]: 'var(--again)',
  [Rating.Hard]: 'var(--hard)',
  [Rating.Good]: 'var(--good)',
  [Rating.Easy]: 'var(--easy)',
};

export function fsrsLab(): HTMLElement {
  let config: FsrsConfig = withDefaults({ enableFuzz: false });
  let now = Date.now();
  let card: SchedulingCard = newCard(now);
  let history: Entry[] = [];

  const root = el('section', {});

  const reset = () => {
    now = Date.now();
    card = newCard(now);
    history = [];
    draw();
  };

  const give = (rating: Rating) => {
    // Jump the clock to the moment the card came due, so the simulation
    // always represents an on-time reviewer.
    now = Math.max(now, Date.parse(card.due));
    const elapsed = elapsedDaysOf(card, now);
    const result = answer(config, card, rating, { now });
    history.push({
      rating,
      elapsedDays: elapsed,
      intervalDays: result.intervalDays,
      stability: result.card.memory?.stability ?? 0,
      difficulty: result.card.memory?.difficulty ?? 0,
      state: result.card.state,
    });
    card = result.card;
    draw();
  };

  const draw = () => {
    const choices = schedule(config, card, { now });
    const retention = cardRetrievability(config, card, now);

    const controls = el(
      'div.card.col',
      {},
      el('h3', { text: 'Configuration' }),
      el(
        'div.row',
        {},
        field(
          'Desired retention',
          input({
            type: 'number',
            min: '0.7',
            max: '0.99',
            step: '0.01',
            value: String(config.desiredRetention),
            onInput: (ev: Event) => {
              const value = Number((ev.target as HTMLInputElement).value);
              if (Number.isFinite(value)) {
                config = withDefaults({ ...config, desiredRetention: value });
                draw();
              }
            },
          }),
        ),
        field(
          'Learning steps (min)',
          input({
            value: config.learningSteps.join(', '),
            onChange: (ev: Event) => {
              config = withDefaults({
                ...config,
                learningSteps: parseSteps((ev.target as HTMLInputElement).value),
              });
              draw();
            },
          }),
        ),
        field(
          'Relearning steps (min)',
          input({
            value: config.relearningSteps.join(', '),
            onChange: (ev: Event) => {
              config = withDefaults({
                ...config,
                relearningSteps: parseSteps((ev.target as HTMLInputElement).value),
              });
              draw();
            },
          }),
        ),
      ),
    );

    const stats = el(
      'div.card',
      {},
      el('h3', { text: 'Card state' }),
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          statRow('State', STATE_LABEL[card.state as keyof typeof STATE_LABEL] ?? '—'),
          statRow('Stability', card.memory ? `${card.memory.stability.toFixed(3)} d` : '—'),
          statRow('Difficulty', card.memory ? card.memory.difficulty.toFixed(3) : '—'),
          statRow('Retrievability', retention === null ? '—' : `${(retention * 100).toFixed(1)}%`),
          statRow('Reps / lapses', `${card.reps} / ${card.lapses}`),
          statRow('Due', new Date(card.due).toLocaleString()),
          statRow('Simulated now', new Date(now).toLocaleString()),
        ),
      ),
    );

    const buttons = el(
      'div.row',
      {},
      RATINGS.map((rating) =>
        button(
          [
            el('div', { text: RATING_LABEL[rating] }),
            el('div.faint', { text: choices[rating].label }),
          ],
          () => give(rating),
          { style: { flex: '1', borderColor: RATING_VAR[rating], color: RATING_VAR[rating] } },
        ),
      ),
    );

    const rows = history.map((entry, i) =>
      el(
        'tr',
        {},
        el('td', { text: String(i + 1) }),
        el('td', { text: RATING_LABEL[entry.rating], style: { color: RATING_VAR[entry.rating] } }),
        el('td', { text: entry.elapsedDays === 0 ? 'same day' : `${entry.elapsedDays}d later` }),
        el('td', { text: formatInterval(entry.intervalDays) }),
        el('td', { text: entry.stability.toFixed(2) }),
        el('td', { text: entry.difficulty.toFixed(2) }),
      ),
    );

    const table = history.length
      ? el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              ['#', 'Rating', 'Elapsed', 'Next', 'Stability', 'Difficulty'].map((h) =>
                el('th', { text: h }),
              ),
            ),
          ),
          el('tbody', {}, rows),
        )
      : el('div.empty', { text: 'Answer the card to build a history.' });

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: 'FSRS lab' }),
        el('div.spacer', {}),
        button('Reset card', reset, { class: 'ghost' }),
      ),
      el('p.muted', {
        text:
          'A simulated card, reviewed exactly on time. Fuzz is off so intervals are reproducible.',
      }),
      el('div.col', {}, controls, stats, buttons, el('div.card', {}, table)),
    );
  };

  draw();
  return root;
}

function statRow(label: string, value: string): HTMLElement {
  return el('tr', {}, el('th', { text: label }), el('td', { text: value }));
}

function parseSteps(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Days between two epoch-ms timestamps, for display only. */
export function daysBetween(a: number, b: number): number {
  return (b - a) / DAY_MS;
}
