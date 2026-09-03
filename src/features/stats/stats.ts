/** The statistics page. */

import { button, el, render, select } from '../../ui/dom.js';
import { proportionBar, stackedBarChart, type Series } from '../../ui/chart.js';
import type { AppContext } from '../../app/context.js';
import { isDeckOrDescendant } from '../../domain/decks.js';
import type { ReviewLog } from '../../domain/types.js';
import { RATING_LABEL, RATINGS } from '../../fsrs/index.js';
import {
  buttonUsage,
  cardCounts,
  daysAgo,
  difficultyHistogram,
  dueForecast,
  intervalHistogram,
  reviewHistory,
  studyStreak,
  trueRetention,
} from '../../collection/stats.js';

const RANGES = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
];

export function statsPage(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  let rangeDays = 30;
  let deckFilter = '';

  const draw = async (): Promise<void> => {
    const decks = (await ctx.db.decks.getAll()).sort((a, b) => a.name.localeCompare(b.name));
    let cards = await ctx.db.cards.getAll();
    let logs = await ctx.db.reviewLogs.getAll();

    if (deckFilter) {
      const scope = new Set(
        decks.filter((d) => isDeckOrDescendant(d.name, deckFilter)).map((d) => d.id),
      );
      cards = cards.filter((card) => scope.has(card.deckId));
      const cardIds = new Set(cards.map((card) => card.id));
      // Logs carry a snapshot, so a log for a since-deleted card still
      // knows which deck it belonged to.
      logs = logs.filter((log) => cardIds.has(log.cardId) || scope.has(log.snapshot.deckId));
    }

    const now = ctx.scheduler.now();
    const cutoff = ctx.scheduler.dayCutoffHour;
    const since = daysAgo(now, cutoff, rangeDays);
    const recentLogs = logs.filter((log) => log.reviewedAt >= since);

    const counts = cardCounts(cards, now);
    const retention = trueRetention(logs, since);
    const allTime = trueRetention(logs);
    const streak = studyStreak(logs, now, cutoff);
    const history = reviewHistory(logs, now, cutoff, rangeDays);
    const forecast = dueForecast(cards, now, cutoff, Math.min(rangeDays, 90));

    const studiedDays = history.filter((day) => day.total > 0).length;
    const dailyAverage = studiedDays === 0 ? 0 : recentLogs.length / studiedDays;

    const deckSelect = select(
      [{ value: '', label: 'Whole collection' }, ...decks.map((d) => ({ value: d.name, label: d.name }))],
      {
        onChange: (ev: Event) => {
          deckFilter = (ev.target as HTMLSelectElement).value;
          void draw();
        },
      },
    );
    deckSelect.value = deckFilter;

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: 'Stats', style: { margin: '0' } }),
        el('div.spacer', {}),
        deckSelect,
        el(
          'div.range-tabs',
          {},
          RANGES.map((range) =>
            button(range.label, () => {
                rangeDays = range.days;
                void draw();
              },
              { 'aria-pressed': rangeDays === range.days ? 'true' : 'false' },
            ),
          ),
        ),
      ),

      el(
        'div.stat-grid',
        {},
        tile(
          retention.rate === null ? '—' : `${(retention.rate * 100).toFixed(1)}%`,
          'True retention',
          retention.rate === null
            ? 'No reviews yet in this period'
            : `${retention.passed} of ${retention.reviews} reviews recalled`,
          'retention',
        ),
        tile(
          String(recentLogs.length),
          `Reviews in ${rangeDays} days`,
          `${dailyAverage.toFixed(1)} per day studied`,
          'reviews',
        ),
        tile(
          String(streak.current),
          'Day streak',
          `Longest ${streak.longest} · ${streak.daysStudied} days studied`,
          'streak',
        ),
        tile(
          formatDuration(recentLogs.reduce((sum, log) => sum + log.timeTakenMs, 0)),
          'Time studied',
          recentLogs.length === 0
            ? '—'
            : `${(recentLogs.reduce((s, l) => s + l.timeTakenMs, 0) / recentLogs.length / 1000).toFixed(1)}s per card`,
          'time',
        ),
      ),

      // --- collection composition ---
      el(
        'div.card.chart-card',
        {},
        el('h3', { text: 'Card counts' }),
        el('p.chart-note', {
          text: `${counts.total} cards — mature means an interval of 21 days or more.`,
        }),
        proportionBar([
          { label: 'New', value: counts.new, colour: 'var(--new)' },
          { label: 'Learning', value: counts.learning, colour: 'var(--learn)' },
          { label: 'Young', value: counts.young, colour: 'var(--good)' },
          { label: 'Mature', value: counts.mature, colour: 'var(--easy)' },
          { label: 'Suspended', value: counts.suspended, colour: 'var(--surface-3)' },
          { label: 'Buried', value: counts.buried, colour: 'var(--text-faint)' },
        ]),
        legend([
          ['New', 'var(--new)', counts.new],
          ['Learning', 'var(--learn)', counts.learning],
          ['Young', 'var(--good)', counts.young],
          ['Mature', 'var(--easy)', counts.mature],
          ['Suspended', 'var(--surface-3)', counts.suspended],
          ['Buried', 'var(--text-faint)', counts.buried],
        ]),
      ),

      // --- future due ---
      chartCard(
        'Future due',
        `Reviews already scheduled over the next ${forecast.length} days. Total ${forecast.reduce((s, d) => s + d.total, 0)}.`,
        stackedBarChart({
          labels: forecast.map((day) => (day.offset === 0 ? 'today' : `+${day.offset}`)),
          series: [
            { label: 'Young', colour: 'var(--good)', values: forecast.map((d) => d.young) },
            { label: 'Mature', colour: 'var(--easy)', values: forecast.map((d) => d.mature) },
          ],
          formatValue: (total, i) =>
            `${forecast[i]!.offset === 0 ? 'Today' : `In ${forecast[i]!.offset} days`}: ${total} due`,
        }),
        [
          ['Young', 'var(--good)'],
          ['Mature', 'var(--easy)'],
        ],
      ),

      // --- review history ---
      chartCard(
        'Reviews',
        `Answers per day over the last ${rangeDays} days.`,
        stackedBarChart({
          labels: history.map((day) => (day.offset === 0 ? 'today' : `-${day.offset}`)),
          series: [
            { label: 'Learning', colour: 'var(--learn)', values: history.map((d) => d.learning) },
            { label: 'Young', colour: 'var(--good)', values: history.map((d) => d.young) },
            { label: 'Mature', colour: 'var(--easy)', values: history.map((d) => d.mature) },
            { label: 'Relearning', colour: 'var(--again)', values: history.map((d) => d.relearning) },
          ],
          formatValue: (total, i) => {
            const day = history[i]!;
            return `${day.offset === 0 ? 'Today' : `${day.offset} days ago`}: ${total} reviews, ${formatDuration(day.timeMs)}`;
          },
        }),
        [
          ['Learning', 'var(--learn)'],
          ['Young', 'var(--good)'],
          ['Mature', 'var(--easy)'],
          ['Relearning', 'var(--again)'],
        ],
      ),

      // --- intervals ---
      histogramCard(
        'Review intervals',
        'How far apart your review cards are currently scheduled.',
        intervalHistogram(cards),
        'var(--easy)',
      ),

      // --- difficulty ---
      histogramCard(
        'Difficulty',
        'FSRS difficulty, 1 (easiest) to 10. A large right-hand tail means the deck is fighting you.',
        difficultyHistogram(cards),
        'var(--hard)',
      ),

      // --- answer buttons ---
      answerButtonsCard(logs, since),

      // --- all-time footer ---
      el(
        'p.faint',
        {},
        allTime.rate === null
          ? 'No reviews recorded yet.'
          : `All time: ${allTime.reviews} reviews, ${(allTime.rate * 100).toFixed(1)}% true retention, ${formatDuration(streak.totalTimeMs)} studied.`,
      ),
    );
  };

  void draw();
  return root;
}

// --- pieces --------------------------------------------------------------

function tile(value: string, label: string, sub: string, key: string): HTMLElement {
  return el(
    'div.stat-tile',
    { 'data-stat': key },
    el('div.value', { text: value }),
    el('div.label', { text: label }),
    el('div.sub', { text: sub }),
  );
}

function legend(entries: Array<[string, string, number?]>): HTMLElement {
  return el(
    'div.legend',
    {},
    entries.map(([label, colour, count]) =>
      el(
        'span',
        {},
        el('span.swatch', { style: { background: colour } }),
        el('span', { text: count === undefined ? label : `${label} ${count}` }),
      ),
    ),
  );
}

function chartCard(
  title: string,
  note: string,
  chart: SVGElement,
  legendEntries: Array<[string, string]>,
): HTMLElement {
  return el(
    'div.card.chart-card',
    { 'data-chart': title },
    el('h3', { text: title }),
    el('p.chart-note', { text: note }),
    chart,
    legend(legendEntries),
  );
}

function histogramCard(
  title: string,
  note: string,
  buckets: Array<{ label: string; count: number }>,
  colour: string,
): HTMLElement {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  return el(
    'div.card.chart-card',
    { 'data-chart': title },
    el('h3', { text: title }),
    el('p.chart-note', { text: note }),
    total === 0
      ? el('div.empty', { text: 'Nothing to show yet.' })
      : stackedBarChart({
          labels: buckets.map((b) => b.label),
          series: [{ label: title, colour, values: buckets.map((b) => b.count) } as Series],
          labelEvery: 1,
          formatValue: (value, i) => `${buckets[i]!.label}: ${value} cards`,
        }),
  );
}

function answerButtonsCard(logs: readonly ReviewLog[], since: number): HTMLElement {
  const usage = buttonUsage(logs.filter((log) => log.reviewedAt >= since));
  const total = usage.reduce((sum, u) => sum + u.total, 0);

  return el(
    'div.card.chart-card',
    { 'data-chart': 'Answer buttons' },
    el('h3', { text: 'Answer buttons' }),
    el('p.chart-note', { text: 'Which button you pressed, split by card maturity.' }),
    total === 0
      ? el('div.empty', { text: 'No answers yet in this period.' })
      : el(
          'table.stacks',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              ['Button', 'Learning', 'Young', 'Mature', 'Total', 'Share'].map((h) =>
                el('th', { text: h }),
              ),
            ),
          ),
          el(
            'tbody',
            {},
            RATINGS.map((rating) => {
              const row = usage[rating - 1]!;
              return el(
                'tr',
                {},
                el('td', { text: RATING_LABEL[rating] }),
                el('td', { 'data-label': 'Learning', text: String(row.learning) }),
                el('td', { 'data-label': 'Young', text: String(row.young) }),
                el('td', { 'data-label': 'Mature', text: String(row.mature) }),
                el('td', { 'data-label': 'Total', text: String(row.total) }),
                el('td.muted', {
                  'data-label': 'Share',
                  text: `${((row.total / total) * 100).toFixed(1)}%`,
                }),
              );
            }),
          ),
        ),
  );
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
