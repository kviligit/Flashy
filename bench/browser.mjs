/**
 * The same measurements against real IndexedDB in a real browser, with the
 * CPU throttled to something phone-like.
 *
 * The in-memory numbers show algorithmic cost; these show what a person
 * actually waits for. They are the ones that decide whether anything needs
 * optimising.
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const NOTES = Number(process.argv[2] ?? 5000);
const THROTTLE = Number(process.argv[3] ?? 4);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto('http://127.0.0.1:5173/index.html#/');
await page.waitForSelector('.deck-row', { timeout: 20000 });

// An iPhone SE is roughly 4x slower than this machine for single-threaded
// work; the multiplier is a blunt instrument but better than pretending a
// dev machine is a phone.
const session = await context.newCDPSession(page);
await session.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

const result = await page.evaluate(async (noteCount) => {
  const { IdbDb, deleteDatabase, changesSince } = await import('/dist/storage/index.js');
  const { Scheduler } = await import('/dist/scheduler/index.js');
  const { cardCounts, dueForecast, reviewHistory } = await import('/dist/collection/stats.js');
  const { seedIfEmpty, withChangeTracking } = await import('/dist/storage/index.js');
  const { makeCard } = await import('/dist/domain/cards.js');
  const { makeDeck } = await import('/dist/domain/defaults.js');
  const { newId } = await import('/dist/domain/id.js');

  const NAME = 'flashy-bench';
  await deleteDatabase(NAME);
  const raw = await IdbDb.open(NAME);
  const db = withChangeTracking(raw);
  const now = Date.now();
  const DAY = 86400000;
  await seedIfEmpty(db, now);

  const config = (await db.deckConfigs.getAll())[0];
  const basic = (await db.noteTypes.getAll()).find((n) => n.name === 'Basic');
  const decks = [(await db.decks.getAll())[0]];
  for (let i = 1; i < 8; i++) decks.push(makeDeck(`Deck ${i}`, config.id, now));
  await db.decks.putMany(decks.slice(1));

  let seed = 999;
  const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const notes = [], cards = [], logs = [];
  for (let i = 0; i < noteCount; i++) {
    const note = {
      id: newId(), noteTypeId: basic.id,
      fields: { Front: `Front ${i}`, Back: `Back ${i} with a longer answer` },
      tags: [], created: now, modified: now - Math.floor(rng() * 30) * DAY,
    };
    notes.push(note);
    const card = makeCard({ noteId: note.id, deckId: decks[i % decks.length].id, ord: 0, position: i, now });
    const interval = Math.max(1, Math.floor(rng() * 180));
    const last = now - Math.floor(rng() * interval) * DAY;
    cards.push({ ...card, state: 2, memory: { stability: interval, difficulty: 5 },
      lastReview: new Date(last).toISOString(), due: new Date(last + interval * DAY).toISOString(),
      reps: 5, modified: last });
    for (let l = 0; l < 5; l++) {
      logs.push({ id: newId(), cardId: card.id, reviewedAt: last - l * DAY, rating: 3,
        stateBefore: 2, stateAfter: 2, intervalDays: interval, lastIntervalDays: interval,
        elapsedDays: 1, stability: interval, difficulty: 5, timeTakenMs: 3000,
        snapshot: card, siblingsBuried: [] });
    }
  }

  const t0 = performance.now();
  await db.notes.putMany(notes);
  await db.cards.putMany(cards);
  await db.reviewLogs.putMany(logs);
  const seedMs = performance.now() - t0;

  const scheduler = new Scheduler(db, { now: () => now });
  await scheduler.load();

  const timed = async (label, fn) => {
    const start = performance.now();
    await fn();
    return { label, ms: Math.round(performance.now() - start) };
  };

  const out = [{ label: 'write the whole collection', ms: Math.round(seedMs) }];
  out.push(await timed('deck list counts', () => scheduler.allDeckCounts()));
  out.push(await timed('start a study session', () => scheduler.startSession(decks[0].id)));
  out.push(await timed('browse: load all rows', () => Promise.all([
    db.cards.getAll(), db.notes.getAll(), db.noteTypes.getAll(), db.decks.getAll(),
  ])));
  const allCards = await db.cards.getAll();
  const allLogs = await db.reviewLogs.getAll();
  out.push(await timed('stats: read every log', () => db.reviewLogs.getAll()));
  out.push(await timed('stats: compute', async () => {
    cardCounts(allCards, now); dueForecast(allCards, now, 4, 90); reviewHistory(allLogs, now, 4, 365);
  }));
  out.push(await timed('sync: changes since 0', () => changesSince(db, 0, now)));

  raw.close();
  await deleteDatabase(NAME);
  return { counts: { notes: notes.length, cards: cards.length, logs: logs.length }, out };
}, NOTES);

console.log(`\n=== IndexedDB, CPU throttled ${THROTTLE}x ===`);
console.log(`${result.counts.notes} notes / ${result.counts.cards} cards / ${result.counts.logs} logs\n`);
for (const row of result.out) {
  const flag = row.ms > 1000 ? '  <-- SLOW' : row.ms > 300 ? '  <-- noticeable' : '';
  console.log(`  ${row.label.padEnd(28)} ${String(row.ms).padStart(6)} ms${flag}`);
}
await browser.close();
