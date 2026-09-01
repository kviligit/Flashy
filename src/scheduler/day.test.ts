import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS, dayIndex, dayStart, daysBetween, elapsedStudyDays, nextDayStart } from './day.js';

/** Build a local-time instant, so these tests hold in any timezone. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test('the study day starts at the cutoff hour, not midnight', () => {
  const cutoff = 4;
  const start = dayStart(local(2026, 3, 15, 10, 0), cutoff);
  assert.equal(start, local(2026, 3, 15, 4, 0));
});

test('before the cutoff, you are still in yesterday’s study day', () => {
  const cutoff = 4;
  assert.equal(dayStart(local(2026, 3, 15, 1, 30), cutoff), local(2026, 3, 14, 4, 0));
  assert.equal(dayStart(local(2026, 3, 15, 3, 59), cutoff), local(2026, 3, 14, 4, 0));
  assert.equal(dayStart(local(2026, 3, 15, 4, 0), cutoff), local(2026, 3, 15, 4, 0));
});

test('a cutoff of 0 makes study days ordinary calendar days', () => {
  assert.equal(dayStart(local(2026, 3, 15, 0, 0), 0), local(2026, 3, 15, 0, 0));
  assert.equal(dayStart(local(2026, 3, 15, 23, 59), 0), local(2026, 3, 15, 0, 0));
});

test('nextDayStart is one study day later', () => {
  const cutoff = 4;
  assert.equal(nextDayStart(local(2026, 3, 15, 10, 0), cutoff), local(2026, 3, 16, 4, 0));
  assert.equal(nextDayStart(local(2026, 3, 15, 1, 0), cutoff), local(2026, 3, 15, 4, 0));
});

test('consecutive study days have consecutive indices', () => {
  const cutoff = 4;
  let previous = dayIndex(local(2026, 1, 1, 12), cutoff);
  for (let d = 2; d <= 60; d++) {
    const current = dayIndex(local(2026, 1, 1, 12) + (d - 1) * DAY_MS, cutoff);
    assert.equal(current - previous, 1, `day ${d} must be exactly one after day ${d - 1}`);
    previous = current;
  }
});

test('daysBetween counts boundary crossings, not elapsed hours', () => {
  const cutoff = 4;
  // 23 hours apart, but they straddle the 4am cutoff: that is one day.
  assert.equal(daysBetween(local(2026, 3, 15, 5, 0), local(2026, 3, 16, 4, 0), cutoff), 1);
  // 20 hours apart within one study day: zero days.
  assert.equal(daysBetween(local(2026, 3, 15, 5, 0), local(2026, 3, 16, 1, 0), cutoff), 0);
  assert.equal(daysBetween(local(2026, 3, 15, 12, 0), local(2026, 3, 15, 23, 0), cutoff), 0);
  // Backwards is negative.
  assert.equal(daysBetween(local(2026, 3, 16, 12, 0), local(2026, 3, 15, 12, 0), cutoff), -1);
});

test('elapsedStudyDays floors at zero and tolerates junk', () => {
  const cutoff = 4;
  const t = local(2026, 3, 15, 12, 0);
  assert.equal(elapsedStudyDays(null, t, cutoff), 0);
  assert.equal(elapsedStudyDays('not a date', t, cutoff), 0);
  assert.equal(elapsedStudyDays(new Date(t).toISOString(), t, cutoff), 0);
  assert.equal(elapsedStudyDays(new Date(t).toISOString(), t + 3 * DAY_MS, cutoff), 3);
  assert.equal(elapsedStudyDays(new Date(t + 3 * DAY_MS).toISOString(), t, cutoff), 0);
});

test('day indices survive a spring-forward DST transition', () => {
  // In most northern-hemisphere zones a day in March is only 23 hours long.
  // Whatever the local rules, day indices must still advance by exactly one.
  const cutoff = 4;
  for (let d = 1; d <= 28; d++) {
    const today = dayIndex(local(2026, 3, d, 12), cutoff);
    const tomorrow = dayIndex(local(2026, 3, d + 1, 12), cutoff);
    assert.equal(tomorrow - today, 1, `March ${d} -> ${d + 1}`);
  }
});
