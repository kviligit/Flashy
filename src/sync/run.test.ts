import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import type { NoteType } from '../domain/types.js';
import { FakeRelay } from '../nostr/fake-relay.js';
import { createLocalKey, memoryStore, setRelays } from './account.js';
import { describeOutcome, runSync } from './run.js';

function makeClock(start = Date.now() + 60_000) {
  let value = start;
  return () => (value += 1000);
}

async function collection(tick: () => number) {
  const db = withChangeTracking(new MemoryDb(), { now: tick });
  await seedIfEmpty(db, tick());
  const basic = (await db.noteTypes.getAll()).find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  return { db, basic, deck };
}

/** A configured browser: a key, a relay, and sync switched on. */
function configured(relay: FakeRelay) {
  const store = memoryStore();
  createLocalKey(store);
  setRelays([relay.url.replace('wss://', 'wss://')], store);
  return store;
}

test('a configured round pushes, and a second device pulls', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const store = configured(relay);

  const a = await collection(tick);
  await addNote(a.db, {
    noteTypeId: a.basic.id,
    deckId: a.deck.id,
    fields: { Front: 'over the wire' },
    now: tick(),
  });

  const pushed = await runSync(a.db, {
    store,
    scope: {},
    socket: relay.connect,
    now: tick,
    deviceId: 'device-a',
  });
  assert.equal(pushed.ok, true);
  assert.ok(pushed.ok && pushed.result.pushed.upserts > 0);

  const b = await collection(tick);
  const pulled = await runSync(b.db, {
    store,
    scope: {},
    socket: relay.connect,
    now: tick,
    deviceId: 'device-b',
  });

  assert.equal(pulled.ok, true);
  assert.ok(pulled.ok && pulled.result.pulled.applied > 0);
  assert.ok((await b.db.notes.getAll()).some((note) => note.fields['Front'] === 'over the wire'));
});

test('an unconfigured browser is told what is missing, not shown an error', async () => {
  const tick = makeClock();
  const { db } = await collection(tick);
  const store = memoryStore();

  const off = await runSync(db, { store, scope: {}, deviceId: 'device-a' });
  assert.equal(off.ok, false);
  assert.match(off.ok ? '' : off.reason, /turned off/);

  createLocalKey(store);
  const noRelays = await runSync(db, { store, scope: {}, deviceId: 'device-a' });
  assert.match(noRelays.ok ? '' : noRelays.reason, /at least one relay/);
});

test('a relay that rejects everything is reported as a failure, not a success', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  relay.faults.rejectPublish = 'blocked: unknown kind';
  const store = configured(relay);
  const { db, basic, deck } = await collection(tick);
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'x' },
    now: tick(),
  });

  const outcome = await runSync(db, {
    store,
    scope: {},
    socket: relay.connect,
    now: tick,
    deviceId: 'device-a',
    timeoutMs: 500,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? '' : outcome.reason, /no relay accepted/);
});

test('describeOutcome says something a person can read', () => {
  assert.equal(
    describeOutcome({ ok: false, reason: 'Sync is turned off.', problems: [] }),
    'Sync is turned off.',
  );

  const counts = {
    applied: 0,
    skipped: 0,
    conflicts: 0,
    reviewLogs: 0,
    deleted: 0,
    rejected: 0,
    deletionsRejected: 0,
    cardsReplayed: 0,
  };
  const base = {
    peerId: 'p',
    pulled: counts,
    pushed: { upserts: 0, deletions: 0 },
    lastPulledAt: 0,
    lastPushedAt: 0,
  };

  assert.equal(describeOutcome({ ok: true, result: base, problems: [] }), 'Already up to date.');
  assert.equal(
    describeOutcome({
      ok: true,
      result: { ...base, pulled: { ...counts, applied: 1 } },
      problems: [],
    }),
    '1 change received.',
  );
  assert.equal(
    describeOutcome({
      ok: true,
      result: {
        ...base,
        pulled: { ...counts, applied: 3, conflicts: 1 },
        pushed: { upserts: 2, deletions: 1 },
      },
      problems: [],
    }),
    '3 changes received, 3 sent, 1 resolved in favour of the later edit.',
  );
});
