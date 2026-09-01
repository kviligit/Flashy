/**
 * Queue building: deciding what to study next, and how much of it.
 *
 * Kept separate from the service that performs answers so the policy is
 * testable against a plain array of cards, with no database involved.
 */

import type { Card, DeckConfig } from '../domain/types.js';
import { NewCardOrder, ReviewOrder } from '../domain/types.js';
import { State } from '../fsrs/index.js';

/** How far ahead of its due time a learning card may be shown, in minutes. */
export const LEARN_AHEAD_MINUTES = 20;

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
}

export interface QueueLimits {
  /** New cards still allowed today. */
  new: number;
  /** Reviews still allowed today. */
  review: number;
}

export interface BuiltQueue {
  counts: QueueCounts;
  /** New cards, already limited and ordered. */
  newCards: Card[];
  /** Learning and relearning cards, ordered by due time. */
  learningCards: Card[];
  /** Review cards, already limited and ordered. */
  reviewCards: Card[];
}

export interface QueueContext {
  now: number;
  /** Study day boundary: review cards due before this count as due today. */
  dayEnd: number;
  config: DeckConfig;
  limits: QueueLimits;
  /** Randomness for the shuffling orders. Injected so tests are stable. */
  random?: () => number;
}

/** A card that is neither suspended nor currently buried. */
export function isAvailable(card: Card, now: number): boolean {
  if (card.suspended) return false;
  if (card.buriedUntil && Date.parse(card.buriedUntil) > now) return false;
  return true;
}

function dueMs(card: Card): number {
  const parsed = Date.parse(card.due);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Split the deck's cards into the three queues, apply the daily limits, and
 * order each queue according to the deck config.
 */
export function buildQueue(cards: readonly Card[], ctx: QueueContext): BuiltQueue {
  const { now, dayEnd, config, limits } = ctx;
  const random = ctx.random ?? Math.random;
  const learnAheadCutoff = now + LEARN_AHEAD_MINUTES * 60_000;

  const newCards: Card[] = [];
  const learningCards: Card[] = [];
  const reviewCards: Card[] = [];

  for (const card of cards) {
    if (!isAvailable(card, now)) continue;

    switch (card.state) {
      case State.New:
        newCards.push(card);
        break;
      case State.Learning:
      case State.Relearning:
        // Learning steps are intraday, so "due" means due by the clock,
        // with a small look-ahead so a session can be finished off.
        if (dueMs(card) <= learnAheadCutoff) learningCards.push(card);
        break;
      case State.Review:
        if (dueMs(card) < dayEnd) reviewCards.push(card);
        break;
    }
  }

  learningCards.sort((a, b) => dueMs(a) - dueMs(b));
  orderNew(newCards, config, random);
  orderReviews(reviewCards, config, now, random);

  const limitedNew = newCards.slice(0, Math.max(0, limits.new));
  const limitedReviews = reviewCards.slice(0, Math.max(0, limits.review));

  return {
    counts: {
      new: limitedNew.length,
      learning: learningCards.length,
      review: limitedReviews.length,
    },
    newCards: limitedNew,
    learningCards,
    reviewCards: limitedReviews,
  };
}

function orderNew(cards: Card[], config: DeckConfig, random: () => number): void {
  if (config.newCardOrder === NewCardOrder.Random) shuffle(cards, random);
  else cards.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function orderReviews(
  cards: Card[],
  config: DeckConfig,
  now: number,
  random: () => number,
): void {
  switch (config.reviewOrder) {
    case ReviewOrder.Random:
      shuffle(cards, random);
      break;
    case ReviewOrder.DifficultyDescending:
      cards.sort(
        (a, b) => (b.memory?.difficulty ?? 0) - (a.memory?.difficulty ?? 0) || dueMs(a) - dueMs(b),
      );
      break;
    case ReviewOrder.DueFirst:
    default:
      // Most overdue first, so nothing rots at the back of the queue.
      cards.sort((a, b) => dueMs(a) - dueMs(b) || a.id.localeCompare(b.id));
      break;
  }
  void now;
}

/** Fisher-Yates, with an injected random source. */
export function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
}

/**
 * Pick the next card to show.
 *
 * Priority: a learning card that is actually due, then reviews and new cards
 * interleaved, then a learning card that is due soon (so the last few
 * seconds of a session are not spent waiting). Interleaving keeps new cards
 * from all arriving in one clump at the start.
 */
export function pickNext(queue: BuiltQueue, now: number, random: () => number = Math.random): Card | null {
  const dueLearning = queue.learningCards.find((card) => dueMs(card) <= now);
  if (dueLearning) return dueLearning;

  const remainingNew = queue.newCards.length;
  const remainingReviews = queue.reviewCards.length;

  if (remainingNew > 0 && remainingReviews > 0) {
    const newShare = remainingNew / (remainingNew + remainingReviews);
    return random() < newShare ? queue.newCards[0]! : queue.reviewCards[0]!;
  }
  if (remainingReviews > 0) return queue.reviewCards[0]!;
  if (remainingNew > 0) return queue.newCards[0]!;

  // Nothing is due yet, but a learning card is close enough to show early.
  return queue.learningCards[0] ?? null;
}

/** Remove a card from whichever queue holds it. */
export function removeFromQueue(queue: BuiltQueue, cardId: string): void {
  for (const list of [queue.newCards, queue.learningCards, queue.reviewCards]) {
    const index = list.findIndex((card) => card.id === cardId);
    if (index >= 0) list.splice(index, 1);
  }
  queue.counts = {
    new: queue.newCards.length,
    learning: queue.learningCards.length,
    review: queue.reviewCards.length,
  };
}
