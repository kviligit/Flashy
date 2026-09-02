import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import type { NoteType } from '../domain/types.js';
import { FakeRelay } from '../nostr/fake-relay.js';
import { createLocalKey, memoryStore, setAuto, setRelays } from './account.js';
import { AUTO_INTERVAL_MS, maybeAutoSync, resetAutoSync } from './auto.js';

function makeClock(start = Date.now() + 60_000) {
  let value = start;
  return { tick: () => (value += 1000), advance: (ms: number) => (value += ms) };
}

async function collection(tick: () => number) {
  const db = withChangeTracking(new MemoryDb(), { now: tick });
  await seedIfEmpty(db, tick());
  const basic = (await db.noteTypes.getAll()).find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  return { db, basic, deck };
}

function configured(relay: FakeRelay, auto: boolean) {
  const store = memoryStore();
  createLocalKey(store);
  setRelays([relay.url], store);
  setAuto(auto, store);
  return store;
}

test('nothing happens unless it was switched on', async () => {
  resetAutoSync();
  const clock = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const store = configured(relay, false);
  const { db } = await collection(clock.tick);

  assert.equal(
    await maybeAutoSync(db, { store, scope: {}, socket: relay.connect, now: clock.tick, deviceId: 'a' }),
    false,
  );
  assert.equal(relay.events.length, 0);
});

test('switched on, a session end sends what was answered', async () => {
  resetAutoSync();
  const clock = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const store = configured(relay, true);
  const { db, basic, deck } = await collection(clock.tick);
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' }, now: clock.tick() });

  const summaries: string[] = [];
  const ran = await maybeAutoSync(db, {
    store,
    scope: {},
    socket: relay.connect,
    now: clock.tick,
    deviceId: 'a',
    onFinished: (summary) => summaries.push(summary),
  });

  assert.equal(ran, true);
  assert.ok(relay.events.length > 0);
  assert.match(summaries[0] ?? '', /sent/);
});

test('two sessions in a row do not mean two rounds', async () => {
  resetAutoSync();
  const clock = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const store = configured(relay, true);
  const { db } = await collection(clock.tick);
  const options = {
    store,
    scope: {},
    socket: relay.connect,
    now: clock.tick,
    deviceId: 'a',
  };

  assert.equal(await maybeAutoSync(db, options), true);
  assert.equal(await maybeAutoSync(db, options), false, 'throttled');

  clock.advance(AUTO_INTERVAL_MS);
  assert.equal(await maybeAutoSync(db, options), true, 'and allowed again later');
});

test('a failing sync says so once, rather than failing quietly for a week', async () => {
  resetAutoSync();
  const clock = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  relay.faults.rejectPublish = 'blocked';
  const store = configured(relay, true);
  const { db, basic, deck } = await collection(clock.tick);
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' }, now: clock.tick() });

  const notices: Array<[string, string]> = [];
  await maybeAutoSync(db, {
    store,
    scope: {},
    socket: relay.connect,
    now: clock.tick,
    deviceId: 'a',
    timeoutMs: 500,
    notify: (message, kind) => notices.push([message, kind]),
  });

  assert.equal(notices.length, 1);
  assert.match(notices[0]![0], /Sync failed/);
  assert.equal(notices[0]![1], 'error');
});

test('a successful round says nothing at all', async () => {
  resetAutoSync();
  const clock = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const store = configured(relay, true);
  const { db } = await collection(clock.tick);

  const notices: string[] = [];
  await maybeAutoSync(db, {
    store,
    scope: {},
    socket: relay.connect,
    now: clock.tick,
    deviceId: 'a',
    notify: (message) => notices.push(message),
  });

  assert.deepEqual(notices, [], 'interrupting to report success is worse than silence');
});
