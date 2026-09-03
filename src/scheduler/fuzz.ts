/**
 * Deterministic fuzz, so the answer buttons do not lie.
 *
 * FSRS spreads intervals by a few per cent so that cards learned on the
 * same day do not all come back on the same day. That spread has to be a
 * *function of the card*, not a fresh coin flip, because the interval is
 * computed twice: once to label the answer buttons, and again when the
 * button is pressed. With `Math.random` those are two independent rolls,
 * so the button would say "8 days" and the card would get 7 — measured at
 * seven times out of ten on a new card.
 *
 * Seeding from the card's id and review count gives the same answer to
 * both calls, and a different one on the next review of the same card.
 * Anki fuzzes deterministically per card for the same reason.
 */

/**
 * FNV-1a. Small, fast, and good enough to turn an id into a seed — this
 * is spreading review dates, not generating anything anyone relies on.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a compact PRNG with a well-distributed 32-bit state. */
export function seededRandom(seed: string): () => number {
  let state = hashString(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The fuzz source for one card at one point in its history.
 *
 * `reps` is in the seed so the spread changes from one review to the
 * next; without it a card would land on the same offset for ever.
 */
export function fuzzFor(card: { id: string; reps: number }): () => number {
  return seededRandom(`${card.id}:${card.reps}`);
}
