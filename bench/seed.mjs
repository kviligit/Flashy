/**
 * Build a large collection in memory, for benchmarking.
 *
 * Deliberately shaped like a real one rather than uniform: several decks of
 * different sizes, a mix of note types, most cards already in review with a
 * spread of due dates, and a review history whose size is proportional to
 * the collection. A benchmark over uniform data measures the wrong thing.
 */

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../dist/storage/index.js';
import { makeCard } from '../dist/domain/cards.js';
import { makeDeck } from '../dist/domain/defaults.js';
import { newId } from '../dist/domain/id.js';
import { State } from '../dist/fsrs/index.js';

const DAY = 86_400_000;

export async function buildCollection({ notes, decks = 8, logsPerCard = 6, now = Date.now() }) {
  const db = withChangeTracking(new MemoryDb());
  await seedIfEmpty(db, now);

  const config = (await db.deckConfigs.getAll())[0];
  const noteTypes = await db.noteTypes.getAll();
  const basic = noteTypes.find((nt) => nt.name === 'Basic');
  const reversed = noteTypes.find((nt) => nt.name === 'Basic (and reversed card)');

  const deckList = [(await db.decks.getAll())[0]];
  for (let i = 1; i < decks; i++) {
    // A nested tree, so subdeck aggregation is exercised.
    const name = i % 3 === 0 ? `Deck ${i}` : `Deck ${i - (i % 3)}::Sub ${i}`;
    const deck = makeDeck(name, config.id, now);
    deckList.push(deck);
  }
  await db.decks.putMany(deckList.slice(1));

  let seed = 12345;
  const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const noteRecords = [];
  const cardRecords = [];
  const logRecords = [];
  let position = 0;

  for (let i = 0; i < notes; i++) {
    const useReversed = i % 5 === 0;
    const noteType = useReversed ? reversed : basic;
    const deck = deckList[i % deckList.length];

    const note = {
      id: newId(),
      noteTypeId: noteType.id,
      fields: { Front: `Front ${i}`, Back: `Back ${i} — some longer answer text for realism` },
      tags: i % 7 === 0 ? ['tagged', `chapter::${i % 20}`] : [],
      created: now - Math.floor(rng() * 365) * DAY,
      modified: now - Math.floor(rng() * 30) * DAY,
    };
    noteRecords.push(note);

    const ords = useReversed ? [0, 1] : [0];
    for (const ord of ords) {
      const card = makeCard({ noteId: note.id, deckId: deck.id, ord, position: position++, now });
      const roll = rng();
      if (roll < 0.1) {
        cardRecords.push(card);
      } else {
        const interval = Math.max(1, Math.floor(rng() * 180));
        const lastReview = now - Math.floor(rng() * interval) * DAY;
        const reviewed = {
          ...card,
          state: State.Review,
          memory: { stability: interval, difficulty: 1 + rng() * 9 },
          lastReview: new Date(lastReview).toISOString(),
          due: new Date(lastReview + interval * DAY).toISOString(),
          reps: 1 + Math.floor(rng() * 20),
          lapses: Math.floor(rng() * 3),
          modified: lastReview,
        };
        cardRecords.push(reviewed);

        for (let l = 0; l < logsPerCard; l++) {
          const at = lastReview - l * interval * DAY;
          logRecords.push({
            id: newId(),
            cardId: card.id,
            reviewedAt: at,
            rating: rng() < 0.85 ? 3 : 1,
            stateBefore: State.Review,
            stateAfter: State.Review,
            intervalDays: interval,
            lastIntervalDays: Math.max(1, interval / 2),
            elapsedDays: Math.floor(interval / 2),
            stability: interval,
            difficulty: 5,
            timeTakenMs: 2000 + Math.floor(rng() * 8000),
            snapshot: card,
            siblingsBuried: [],
          });
        }
      }
    }
  }

  await db.notes.putMany(noteRecords);
  await db.cards.putMany(cardRecords);
  await db.reviewLogs.putMany(logRecords);

  return {
    db,
    config,
    decks: deckList,
    counts: { notes: noteRecords.length, cards: cardRecords.length, logs: logRecords.length },
  };
}
