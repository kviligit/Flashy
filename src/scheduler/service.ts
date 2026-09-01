/**
 * The study service: the one place that mutates scheduling state.
 *
 * It owns the sequence "load card -> ask FSRS -> persist card -> append a
 * review log", plus everything that hangs off it: daily limits, sibling
 * burying, leech handling and undo. Nothing above this layer writes to the
 * cards store directly.
 */

import { newId } from '../domain/id.js';
import { isDeckOrDescendant } from '../domain/decks.js';
import {
  LeechAction,
  type Card,
  type Deck,
  type DeckConfig,
  type Note,
  type ReviewLog,
} from '../domain/types.js';
import {
  Rating,
  State,
  answer as fsrsAnswer,
  schedule as fsrsSchedule,
  withDefaults,
  type FsrsConfig,
  type SchedulingCard,
  type SchedulingChoices,
} from '../fsrs/index.js';
import type { Db } from '../storage/index.js';
import { dayStart, elapsedStudyDays, nextDayStart } from './day.js';
import {
  buildQueue,
  pickNext,
  removeFromQueue,
  type BuiltQueue,
  type QueueCounts,
} from './queue.js';

export const LEECH_TAG = 'leech';

export interface SchedulerOptions {
  /** Current time. Injected so tests can move the clock. */
  now?: () => number;
  /** Randomness for fuzz and queue shuffling. */
  random?: () => number;
}

export interface AnswerResult {
  card: Card;
  log: ReviewLog;
  intervalDays: number;
  /** True when this answer pushed the card over the leech threshold. */
  becameLeech: boolean;
}

export interface DeckCounts extends QueueCounts {
  deckId: string;
  /** Counts including every subdeck. */
  total: number;
}

/** A study session over one deck subtree. */
export interface Session {
  deckId: string;
  deckName: string;
  config: DeckConfig;
  queue: BuiltQueue;
  counts: QueueCounts;
}

export class Scheduler {
  private readonly nowFn: () => number;
  private readonly random: () => number;
  private cutoffHour = 4;

  constructor(
    private readonly db: Db,
    options: SchedulerOptions = {},
  ) {
    this.nowFn = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /** Read the collection's day-cutoff hour. Call once after opening. */
  async load(): Promise<void> {
    const meta = await this.db.meta.get('meta');
    if (meta) this.cutoffHour = meta.dayCutoffHour;
  }

  get dayCutoffHour(): number {
    return this.cutoffHour;
  }

  now(): number {
    return this.nowFn();
  }

  // --- configuration -----------------------------------------------------

  async configFor(deck: Deck): Promise<DeckConfig> {
    const config = await this.db.deckConfigs.get(deck.configId);
    if (config) return config;
    const all = await this.db.deckConfigs.getAll();
    const fallback = all[0];
    if (!fallback) throw new Error(`deck "${deck.name}" has no config and none exists`);
    return fallback;
  }

  /** The FSRS view of a deck config. */
  static fsrsConfig(config: DeckConfig): FsrsConfig {
    return withDefaults({
      params: config.params,
      desiredRetention: config.desiredRetention,
      learningSteps: config.learningSteps,
      relearningSteps: config.relearningSteps,
      maximumInterval: config.maximumInterval,
      enableFuzz: config.enableFuzz,
    });
  }

  // --- counts and sessions ----------------------------------------------

  /**
   * Due counts for every deck, each including its subdecks — what the deck
   * list shows. One pass over the cards, so it stays cheap as decks grow.
   */
  async allDeckCounts(): Promise<Map<string, DeckCounts>> {
    const now = this.now();
    const decks = await this.db.decks.getAll();
    const cards = await this.db.cards.getAll();
    const configs = new Map((await this.db.deckConfigs.getAll()).map((c) => [c.id, c]));

    const byDeck = new Map<string, Card[]>();
    for (const card of cards) {
      const list = byDeck.get(card.deckId);
      if (list) list.push(card);
      else byDeck.set(card.deckId, [card]);
    }

    const used = await this.usageByDeck(now);
    const result = new Map<string, DeckCounts>();

    for (const deck of decks) {
      const subtree = decks.filter((d) => isDeckOrDescendant(d.name, deck.name));
      const subtreeCards = subtree.flatMap((d) => byDeck.get(d.id) ?? []);
      const config = configs.get(deck.configId) ?? [...configs.values()][0];
      if (!config) continue;

      const spent = subtree.reduce(
        (acc, d) => {
          const u = used.get(d.id);
          return { new: acc.new + (u?.new ?? 0), review: acc.review + (u?.review ?? 0) };
        },
        { new: 0, review: 0 },
      );

      const queue = buildQueue(subtreeCards, {
        now,
        dayEnd: nextDayStart(now, this.cutoffHour),
        config,
        limits: {
          new: Math.max(0, config.newPerDay - spent.new),
          review: Math.max(0, config.reviewsPerDay - spent.review),
        },
        random: this.random,
      });

      result.set(deck.id, {
        deckId: deck.id,
        ...queue.counts,
        total: queue.counts.new + queue.counts.learning + queue.counts.review,
      });
    }

    return result;
  }

  /** Open a study session over a deck and everything under it. */
  async startSession(deckId: string): Promise<Session> {
    const deck = await this.db.decks.get(deckId);
    if (!deck) throw new Error(`no such deck: ${deckId}`);

    const now = this.now();
    const decks = await this.db.decks.getAll();
    const subtree = decks.filter((d) => isDeckOrDescendant(d.name, deck.name));
    const config = await this.configFor(deck);

    const cards: Card[] = [];
    for (const d of subtree) cards.push(...(await this.db.cards.byIndex('deckId', d.id)));

    const used = await this.usageByDeck(now);
    const spent = subtree.reduce(
      (acc, d) => {
        const u = used.get(d.id);
        return { new: acc.new + (u?.new ?? 0), review: acc.review + (u?.review ?? 0) };
      },
      { new: 0, review: 0 },
    );

    const queue = buildQueue(cards, {
      now,
      dayEnd: nextDayStart(now, this.cutoffHour),
      config,
      limits: {
        new: Math.max(0, config.newPerDay - spent.new),
        review: Math.max(0, config.reviewsPerDay - spent.review),
      },
      random: this.random,
    });

    return { deckId, deckName: deck.name, config, queue, counts: queue.counts };
  }

  /** The next card in a session, or null when the session is finished. */
  nextCard(session: Session): Card | null {
    return pickNext(session.queue, this.now(), this.random);
  }

  /** How many new cards and reviews each deck has already used today. */
  private async usageByDeck(now: number): Promise<Map<string, { new: number; review: number }>> {
    const start = dayStart(now, this.cutoffHour);
    const logs = await this.db.reviewLogs.byRange('reviewedAt', { lower: start });
    const used = new Map<string, { new: number; review: number }>();

    // Only the first answer of a card counts against the day's allowance;
    // re-answering a learning card must not consume another new-card slot.
    const seenNew = new Set<string>();
    const seenReview = new Set<string>();

    for (const log of logs) {
      const deckId = log.snapshot.deckId;
      const entry = used.get(deckId) ?? { new: 0, review: 0 };
      if (log.stateBefore === State.New && !seenNew.has(log.cardId)) {
        seenNew.add(log.cardId);
        entry.new += 1;
      } else if (log.stateBefore === State.Review && !seenReview.has(log.cardId)) {
        seenReview.add(log.cardId);
        entry.review += 1;
      }
      used.set(deckId, entry);
    }

    return used;
  }

  // --- answering ---------------------------------------------------------

  /** The four options for a card, for previewing on the answer buttons. */
  async choicesFor(card: Card, config: DeckConfig): Promise<SchedulingChoices> {
    const now = this.now();
    return fsrsSchedule(Scheduler.fsrsConfig(config), toSchedulingCard(card), {
      now,
      elapsedDays: elapsedStudyDays(card.lastReview, now, this.cutoffHour),
      random: this.random,
    });
  }

  /**
   * Answer a card: advance its scheduling state, persist it, append the
   * review log, and apply burying and leech handling.
   */
  async answerCard(
    card: Card,
    rating: Rating,
    config: DeckConfig,
    timeTakenMs = 0,
  ): Promise<AnswerResult> {
    const now = this.now();
    const elapsedDays = elapsedStudyDays(card.lastReview, now, this.cutoffHour);
    const lastIntervalDays = intervalOf(card, now);

    const result = fsrsAnswer(Scheduler.fsrsConfig(config), toSchedulingCard(card), rating, {
      now,
      elapsedDays,
      random: this.random,
    });

    let updated: Card = {
      ...card,
      state: result.card.state,
      memory: result.card.memory,
      due: result.card.due,
      lastReview: result.card.lastReview,
      step: result.card.step,
      reps: result.card.reps,
      lapses: result.card.lapses,
      modified: now,
    };

    // Leech handling, before the card is written, so a suspension lands in
    // the same update.
    const becameLeech =
      card.state === State.Review &&
      rating === Rating.Again &&
      config.leechThreshold > 0 &&
      updated.lapses >= config.leechThreshold &&
      // Only fire on the crossing, and then every half-threshold after, as
      // Anki does — otherwise every further lapse re-tags the note.
      (updated.lapses === config.leechThreshold ||
        (updated.lapses - config.leechThreshold) % Math.max(1, Math.floor(config.leechThreshold / 2)) === 0);

    if (becameLeech) {
      await this.tagAsLeech(card.noteId);
      if (config.leechAction === LeechAction.Suspend) updated = { ...updated, suspended: true };
    }

    const siblingsBuried = config.burySiblings ? await this.burySiblings(card, now) : [];

    const log: ReviewLog = {
      id: newId(),
      cardId: card.id,
      reviewedAt: now,
      rating,
      stateBefore: card.state,
      stateAfter: updated.state,
      intervalDays: result.intervalDays,
      lastIntervalDays,
      elapsedDays,
      stability: updated.memory?.stability ?? 0,
      difficulty: updated.memory?.difficulty ?? 0,
      timeTakenMs,
      snapshot: card,
      siblingsBuried,
    };

    await this.db.cards.put(updated);
    await this.db.reviewLogs.put(log);

    return { card: updated, log, intervalDays: result.intervalDays, becameLeech };
  }

  /**
   * Undo the most recent answer: restore the card exactly as it was, unbury
   * the siblings that answer buried, and drop the log entry.
   *
   * Returns the restored card, or null when there is nothing to undo.
   */
  async undoLast(): Promise<Card | null> {
    const [latest] = await this.db.reviewLogs.byRange(
      'reviewedAt',
      {},
      { descending: true, limit: 1 },
    );
    if (!latest) return null;

    await this.db.cards.put(latest.snapshot);

    if (latest.siblingsBuried.length > 0) {
      const siblings = await this.db.cards.getMany(latest.siblingsBuried);
      await this.db.cards.putMany(siblings.map((c) => ({ ...c, buriedUntil: null })));
    }

    await this.db.reviewLogs.delete(latest.id);
    return latest.snapshot;
  }

  /** A one-line description of what undo would revert, for the UI. */
  async undoDescription(): Promise<string | null> {
    const [latest] = await this.db.reviewLogs.byRange(
      'reviewedAt',
      {},
      { descending: true, limit: 1 },
    );
    return latest ? `Undo answer (${ratingName(latest.rating)})` : null;
  }

  // --- card actions ------------------------------------------------------

  async setSuspended(cardIds: readonly string[], suspended: boolean): Promise<void> {
    const now = this.now();
    const cards = await this.db.cards.getMany(cardIds);
    await this.db.cards.putMany(cards.map((c) => ({ ...c, suspended, modified: now })));
  }

  async setFlag(cardIds: readonly string[], flag: Card['flag']): Promise<void> {
    const now = this.now();
    const cards = await this.db.cards.getMany(cardIds);
    await this.db.cards.putMany(cards.map((c) => ({ ...c, flag, modified: now })));
  }

  /** Hide cards until the next study day. */
  async bury(cardIds: readonly string[]): Promise<void> {
    const now = this.now();
    const until = new Date(nextDayStart(now, this.cutoffHour)).toISOString();
    const cards = await this.db.cards.getMany(cardIds);
    await this.db.cards.putMany(cards.map((c) => ({ ...c, buriedUntil: until, modified: now })));
  }

  async unbury(cardIds: readonly string[]): Promise<void> {
    const now = this.now();
    const cards = await this.db.cards.getMany(cardIds);
    await this.db.cards.putMany(cards.map((c) => ({ ...c, buriedUntil: null, modified: now })));
  }

  /** Reset a card to New, discarding its memory state but keeping its logs. */
  async forget(cardIds: readonly string[]): Promise<void> {
    const now = this.now();
    const iso = new Date(now).toISOString();
    const cards = await this.db.cards.getMany(cardIds);
    await this.db.cards.putMany(
      cards.map((c) => ({
        ...c,
        state: State.New,
        memory: null,
        due: iso,
        lastReview: null,
        step: 0,
        reps: 0,
        lapses: 0,
        modified: now,
      })),
    );
  }

  /** Bury the other cards made from the same note. */
  private async burySiblings(card: Card, now: number): Promise<string[]> {
    const siblings = (await this.db.cards.byIndex('noteId', card.noteId)).filter(
      (c) => c.id !== card.id && !c.suspended && !c.buriedUntil,
    );
    if (siblings.length === 0) return [];

    const until = new Date(nextDayStart(now, this.cutoffHour)).toISOString();
    await this.db.cards.putMany(
      siblings.map((c) => ({ ...c, buriedUntil: until, modified: now })),
    );
    return siblings.map((c) => c.id);
  }

  private async tagAsLeech(noteId: string): Promise<void> {
    const note = await this.db.notes.get(noteId);
    if (!note || note.tags.includes(LEECH_TAG)) return;
    const updated: Note = { ...note, tags: [...note.tags, LEECH_TAG], modified: this.now() };
    await this.db.notes.put(updated);
  }
}

/** Project a stored card onto the shape the FSRS layer expects. */
export function toSchedulingCard(card: Card): SchedulingCard {
  return {
    state: card.state,
    memory: card.memory,
    lastReview: card.lastReview,
    due: card.due,
    step: card.step,
    lapses: card.lapses,
    reps: card.reps,
  };
}

/** The interval a card was sitting on, in days. */
function intervalOf(card: Card, now: number): number {
  if (!card.lastReview) return 0;
  const last = Date.parse(card.lastReview);
  const due = Date.parse(card.due);
  if (!Number.isFinite(last) || !Number.isFinite(due)) return 0;
  void now;
  return Math.max(0, (due - last) / 86_400_000);
}

function ratingName(rating: number): string {
  return ['', 'Again', 'Hard', 'Good', 'Easy'][rating] ?? String(rating);
}
