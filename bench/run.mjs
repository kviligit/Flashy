/**
 * Measure the operations a user waits on, at several collection sizes.
 *
 * Against the in-memory backend, so what it measures is algorithmic cost
 * rather than IndexedDB's. That is the right thing to measure first: a
 * quadratic algorithm is quadratic on any backend, and IndexedDB only
 * multiplies the constant.
 */

import { buildCollection } from './seed.mjs';
import { Scheduler } from '../dist/scheduler/index.js';
import { cardCounts, dueForecast, reviewHistory, trueRetention } from '../dist/collection/stats.js';
import { mediaUsage } from '../dist/collection/media.js';
import { changesSince } from '../dist/storage/index.js';

const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = SIZES.length > 0 ? SIZES : [500, 2000, 10000];

async function time(label, fn) {
  const start = performance.now();
  const result = await fn();
  return { label, ms: performance.now() - start, result };
}

function pad(text, width) {
  return String(text).padEnd(width);
}

for (const notes of sizes) {
  const built = await buildCollection({ notes });
  const { db, decks } = built;
  const now = Date.now();

  const scheduler = new Scheduler(db, { now: () => now });
  await scheduler.load();

  const measurements = [];
  measurements.push(await time('deck list counts', () => scheduler.allDeckCounts()));
  measurements.push(await time('start a study session', () => scheduler.startSession(decks[0].id)));

  const cards = await db.cards.getAll();
  const logs = await db.reviewLogs.getAll();

  measurements.push(await time('browse: load all rows', async () => {
    const [c, n, t, d] = await Promise.all([
      db.cards.getAll(), db.notes.getAll(), db.noteTypes.getAll(), db.decks.getAll(),
    ]);
    return c.length + n.length + t.length + d.length;
  }));
  measurements.push(await time('stats: card counts', async () => cardCounts(cards, now)));
  measurements.push(await time('stats: due forecast', async () => dueForecast(cards, now, 4, 90)));
  measurements.push(await time('stats: review history', async () => reviewHistory(logs, now, 4, 365)));
  measurements.push(await time('stats: true retention', async () => trueRetention(logs)));
  measurements.push(await time('media usage scan', () => mediaUsage(db)));
  measurements.push(await time('sync: changes since 0', () => changesSince(db, 0, now)));

  console.log(`\n=== ${built.counts.notes} notes / ${built.counts.cards} cards / ${built.counts.logs} logs ===`);
  for (const m of measurements) {
    const flag = m.ms > 500 ? '  <-- SLOW' : m.ms > 150 ? '  <-- noticeable' : '';
    console.log(`  ${pad(m.label, 26)} ${m.ms.toFixed(0).padStart(6)} ms${flag}`);
  }
}
