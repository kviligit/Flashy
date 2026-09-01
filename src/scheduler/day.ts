/**
 * Study days, not calendar days.
 *
 * A study day begins at the collection's cutoff hour (Anki's default is
 * 4am), so reviewing at 1am counts toward the day that is ending, not the
 * one starting. Everything here works in the *local* timezone and via
 * calendar arithmetic, which keeps it correct across DST transitions.
 */

export const DAY_MS = 86_400_000;

/** Epoch ms at which the study day containing `now` began. */
export function dayStart(now: number, cutoffHour: number): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cutoffHour, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}

/** Epoch ms at which the next study day begins. */
export function nextDayStart(now: number, cutoffHour: number): number {
  const start = new Date(dayStart(now, cutoffHour));
  start.setDate(start.getDate() + 1);
  return start.getTime();
}

/**
 * A stable integer label for the study day containing `ms`. Consecutive
 * days differ by exactly 1, DST notwithstanding.
 */
export function dayIndex(ms: number, cutoffHour: number): number {
  const d = new Date(dayStart(ms, cutoffHour));
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Whole study days between two instants; negative if `b` precedes `a`. */
export function daysBetween(a: number, b: number, cutoffHour: number): number {
  return dayIndex(b, cutoffHour) - dayIndex(a, cutoffHour);
}

/** Whole study days a card has waited, floored at 0. */
export function elapsedStudyDays(
  lastReview: string | null,
  now: number,
  cutoffHour: number,
): number {
  if (!lastReview) return 0;
  const last = Date.parse(lastReview);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, daysBetween(last, now, cutoffHour));
}
