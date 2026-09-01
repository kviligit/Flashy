/**
 * Turning a stability into an actual due date: rounding, clamping, fuzz and
 * human-readable labels. Separated from the memory model so the maths stays
 * free of presentation and randomness.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A source of randomness in [0, 1). Injected so tests can be deterministic. */
export type Random = () => number;

/**
 * Anki's fuzz bounds: an interval of `days` may be moved anywhere in the
 * returned inclusive range. Short intervals are left alone; longer ones get
 * proportionally more spread, capped by the diminishing band factors.
 */
export function fuzzBounds(days: number): [number, number] {
  if (days < 2.5) return [Math.round(days), Math.round(days)];

  const bands: Array<[number, number, number]> = [
    [2.5, 7.0, 0.15],
    [7.0, 20.0, 0.1],
    [20.0, Infinity, 0.05],
  ];

  let delta = 1.0;
  for (const [start, end, factor] of bands) {
    delta += factor * Math.max(Math.min(days, end) - start, 0);
  }

  const min = Math.max(Math.round(days - delta), 2);
  const max = Math.round(days + delta);
  return [Math.min(min, max), max];
}

/** Apply fuzz to an interval in days. */
export function applyFuzz(days: number, random: Random): number {
  const [min, max] = fuzzBounds(days);
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Round a raw FSRS interval into a whole number of days, clamped to
 * `[1, maximumInterval]`, optionally fuzzed.
 */
export function constrainInterval(
  rawDays: number,
  maximumInterval: number,
  fuzz: boolean,
  random: Random,
): number {
  const capped = Math.min(Math.max(rawDays, 1), maximumInterval);
  const days = fuzz ? applyFuzz(capped, random) : Math.round(capped);
  return Math.min(Math.max(days, 1), maximumInterval);
}

/** "10m", "3d", "2.4mo" — the text on an answer button. */
export function formatInterval(days: number): string {
  const seconds = days * 86_400;
  if (seconds < 60) return `${Math.max(Math.round(seconds), 1)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (days < 1) return `${round1(seconds / 3600)}h`;
  if (days < 30) return `${days < 10 ? round1(days) : Math.round(days)}d`;
  if (days < 365) return `${round1(days / 30.44)}mo`;
  return `${round1(days / 365.25)}y`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
