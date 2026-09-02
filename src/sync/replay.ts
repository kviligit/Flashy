/**
 * Recomputing a card's scheduling state from its review history.
 *
 * This is the one piece of real domain logic a merge needs. Review logs are
 * append-only and two devices can each hold answers the other has never
 * seen, so after a merge the card's stored state reflects only one side's
 * history. Taking the newer card record would silently throw away the other
 * device's studying; the correct result is the state that the union of both
 * histories produces.
 *
 * Replay is deterministic on purpose: fuzz is disabled, so two devices
 * given the same set of logs arrive at exactly the same card. Without that
 * they would disagree forever, each convinced the other was out of date.
 */

import { answer, withDefaults, type FsrsConfig } from '../fsrs/index.js';
import { toSchedulingCard } from '../scheduler/index.js';
import type { Card, DeckConfig, ReviewLog } from '../domain/types.js';
import type { Db } from '../storage/index.js';

/** The middle of any fuzz range — never used, since fuzz is off. */
const FIXED_RANDOM = (): number => 0.5;

function replayConfig(config: DeckConfig): FsrsConfig {
  return withDefaults({
    params: config.params,
    desiredRetention: config.desiredRetention,
    learningSteps: config.learningSteps,
    relearningSteps: config.relearningSteps,
    maximumInterval: config.maximumInterval,
    enableFuzz: false,
  });
}

/**
 * The scheduling state a card reaches by replaying `logs` in time order.
 *
 * Identity and user-set flags come from `card`; only the scheduling fields
 * are recomputed. The starting point is the snapshot stored on the earliest
 * log, which is the card as it was before anyone answered it.
 */
export function replayScheduling(
  card: Card,
  logs: readonly ReviewLog[],
  config: DeckConfig,
): Card {
  if (logs.length === 0) return card;

  const ordered = [...logs].sort((a, b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id));
  const fsrs = replayConfig(config);

  const origin = ordered[0]!.snapshot;
  let state = toSchedulingCard(origin);
  let lapses = origin.lapses;
  let reps = origin.reps;

  for (const log of ordered) {
    const result = answer(fsrs, { ...state, lapses, reps }, log.rating as 1 | 2 | 3 | 4, {
      now: log.reviewedAt,
      elapsedDays: Math.max(0, Math.round(log.elapsedDays)),
      random: FIXED_RANDOM,
    });
    state = result.card;
    lapses = result.card.lapses;
    reps = result.card.reps;
  }

  return {
    ...card,
    state: state.state,
    memory: state.memory,
    due: state.due,
    lastReview: state.lastReview,
    step: state.step,
    reps,
    lapses,
  };
}

/** Replay one card from whatever logs the collection now holds. */
export async function replayCard(db: Db, cardId: string): Promise<Card | null> {
  const card = await db.cards.get(cardId);
  if (!card) return null;

  const logs = await db.reviewLogs.byIndex('cardId', cardId);
  if (logs.length === 0) return card;

  const config = await configForCard(db, card);
  if (!config) return card;

  const replayed = replayScheduling(card, logs, config);
  await db.cards.put(replayed);
  return replayed;
}

export interface ReplayOutcome {
  /** Cards whose schedule actually moved. */
  changed: number;
  /** Cards whose replay threw, with the reason, rather than aborting all. */
  failed: Array<{ cardId: string; reason: string }>;
}

/**
 * Replay several cards.
 *
 * One card's failure must not abort the rest, and must not abort the merge
 * that called this. Before that was true, a single malformed review log —
 * which had already been written to the database by the time the replay
 * ran — threw out of `applyChanges`, lost the round's watermark, and then
 * threw again on every subsequent round, permanently. A card that cannot
 * be replayed is a card with a wrong schedule; a merge that cannot
 * complete is a device that has stopped syncing.
 */
export async function replayCards(db: Db, cardIds: Iterable<string>): Promise<ReplayOutcome> {
  let changed = 0;
  const failed: Array<{ cardId: string; reason: string }> = [];

  for (const id of cardIds) {
    const before = await db.cards.get(id);
    if (!before) continue;
    try {
      const after = await replayCard(db, id);
      if (after && (after.due !== before.due || after.reps !== before.reps)) changed += 1;
    } catch (error) {
      failed.push({
        cardId: id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { changed, failed };
}

async function configForCard(db: Db, card: Card): Promise<DeckConfig | null> {
  const deck = await db.decks.get(card.deckId);
  if (!deck) return null;
  const config = await db.deckConfigs.get(deck.configId);
  if (config) return config;
  const [fallback] = await db.deckConfigs.getAll();
  return fallback ?? null;
}
