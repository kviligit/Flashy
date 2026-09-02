import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking, type Db } from '../storage/index.js';
import { addNote, deleteNotes, updateNote } from '../collection/notes.js';
import { addMedia } from '../collection/media.js';
import { Scheduler } from '../scheduler/index.js';
import { Rating } from '../fsrs/index.js';
import type { DeckConfig, NoteType } from '../domain/types.js';
import { bytesToHex, generateSecretKey, getPublicKey } from '../nostr/secp256k1.js';
import { LocalSigner } from '../nostr/signer.js';
import { FakeRelay } from '../nostr/fake-relay.js';
import { Relay } from '../nostr/relay.js';
import { readSyncState, syncWith } from './engine.js';
import { NostrTransport, type TransportProblem } from './nostr-transport.js';

/**
 * One key pair stands for one user; the devices under it are told apart by
 * their device ids. That is the real topology — a person's phone and
 * laptop are the same nostr identity — and it is why the transport has to
 * filter its own events out rather than relying on the author.
 */
const secretKey = generateSecretKey();
const signer = new LocalSigner(secretKey);
const pubkey = bytesToHex(getPublicKey(secretKey));

function makeClock(start = Date.now() + 60_000) {
  let value = start;
  return () => (value += 1000);
}

async function twoDevices() {
  const tick = makeClock();
  const a = withChangeTracking(new MemoryDb(), { now: tick });
  await seedIfEmpty(a, tick());

  const b = withChangeTracking(new MemoryDb(), { now: tick });
  for (const store of ['decks', 'deckConfigs', 'noteTypes', 'meta'] as const) {
    const records = await a[store].getAll();
    await (b[store] as { putMany(items: readonly never[]): Promise<void> }).putMany(
      records as never[],
    );
  }

  const noteTypes = await a.noteTypes.getAll();
  const basic = noteTypes.find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await a.decks.getAll())[0]!;
  const config = (await a.deckConfigs.getAll())[0] as DeckConfig;
  return { a, b, basic, deck, config, tick };
}

interface Wired {
  relay: FakeRelay;
  transportFor(device: string, options?: Partial<Options>): NostrTransport;
  problems: TransportProblem[];
}

interface Options {
  maxChunkBytes: number;
  now: () => number;
}

function wire(tick: () => number, relay = new FakeRelay()): Wired {
  const problems: TransportProblem[] = [];
  return {
    relay,
    problems,
    transportFor(device, options = {}) {
      return new NostrTransport({
        signer,
        pubkey,
        deviceId: device,
        relays: [new Relay(relay.url, { socket: relay.connect, timeoutMs: 2000 })],
        now: options.now ?? tick,
        ...(options.maxChunkBytes === undefined ? {} : { maxChunkBytes: options.maxChunkBytes }),
        onProblem: (problem) => problems.push(problem),
      });
    },
  };
}

/**
 * A full round trip through the relay, in both directions, twice.
 *
 * Twice because a relay is a shared log rather than a direct link: A's
 * changes only reach B after A has published them, and B's reply only
 * reaches A after B has.
 */
async function syncBothWays(a: Db, b: Db, wired: Wired, tick: () => number) {
  await syncWith(a, wired.transportFor('device-a'), { now: tick });
  await syncWith(b, wired.transportFor('device-b'), { now: tick });
  await syncWith(a, wired.transportFor('device-a'), { now: tick });
}

test('a note published by one device arrives at the other through a relay', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  const { note } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'bonjour', Back: 'hello' },
    now: tick(),
  });

  await syncBothWays(a, b, wired, tick);

  const arrived = await b.notes.get(note.id);
  assert.ok(arrived, 'the note crossed');
  assert.equal(arrived.fields['Front'], 'bonjour');
  assert.equal((await b.cards.byIndex('noteId', note.id)).length, 1, 'and so did its card');
  assert.deepEqual(wired.problems, []);
});

test('the relay never sees the contents', async () => {
  const { a, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'a very distinctive phrase', Back: '' },
    now: tick(),
  });

  await syncWith(a, wired.transportFor('device-a'), { now: tick });

  assert.ok(wired.relay.events.length > 0, 'something was published');
  const stored = JSON.stringify(wired.relay.events);
  assert.ok(!stored.includes('a very distinctive phrase'), 'the field text is not in the clear');
  assert.ok(!stored.includes('bonjour'));
  // The tags are metadata and deliberately readable: the relay has to be
  // able to filter on them.
  assert.ok(stored.includes('flashy-sync-v1'));
});

test('a device does not merge back its own events', async () => {
  const { a, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'mine' }, now: tick() });

  await syncWith(a, wired.transportFor('device-a'), { now: tick });
  const second = await syncWith(a, wired.transportFor('device-a'), { now: tick });

  assert.equal(second.pulled.applied, 0);
  assert.equal(second.pulled.skipped, 0);
});

test('syncing again moves nothing', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' }, now: tick() });
  await syncBothWays(a, b, wired, tick);

  const again = await syncWith(b, wired.transportFor('device-b'), { now: tick });
  assert.equal(again.pulled.applied, 0, 'nothing new to take');
});

test('a deletion crosses as a tombstone', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  const { note } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'doomed' },
    now: tick(),
  });
  await syncBothWays(a, b, wired, tick);
  assert.ok(await b.notes.get(note.id), 'arrived first');

  tick();
  await deleteNotes(a, [note.id]);
  await syncBothWays(a, b, wired, tick);

  assert.ok(!(await b.notes.get(note.id)), 'and then left');
});

test('review history crosses and rebuilds the schedule', async () => {
  const { a, b, basic, deck, config, tick } = await twoDevices();
  const wired = wire(tick);
  const { cards } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'q', Back: 'a' },
    now: tick(),
  });
  const cardId = cards[0]!.id;

  const at = tick();
  const scheduler = new Scheduler(a, { now: () => at, random: () => 0.5 });
  await scheduler.load();
  await scheduler.answerCard((await a.cards.get(cardId))!, Rating.Good, config, 2000);

  await syncBothWays(a, b, wired, tick);

  const logs = await b.reviewLogs.byIndex('cardId', cardId);
  assert.equal(logs.length, 1, 'the answer crossed');
  const arrived = await b.cards.get(cardId);
  assert.ok(arrived);
  assert.ok(arrived.memory, 'and the card carries memory state, not a blank schedule');
  assert.ok(arrived.reps > 0);
});

test('a large change set is chunked and every chunk arrives', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  for (let i = 0; i < 60; i += 1) {
    await addNote(a, {
      noteTypeId: basic.id,
      deckId: deck.id,
      fields: { Front: `question ${i}`, Back: 'x'.repeat(200) },
      now: tick(),
    });
  }

  // Small enough that the notes cannot possibly fit in one event.
  await syncWith(a, wired.transportFor('device-a', { maxChunkBytes: 2048 }), { now: tick });
  assert.ok(wired.relay.events.length > 1, 'it really was chunked');

  await syncWith(b, wired.transportFor('device-b'), { now: tick });

  assert.equal((await b.notes.getAll()).length, 60);
  assert.deepEqual(wired.problems, []);
});

test('a record too large for one event is reported, not dropped in silence', async () => {
  const { a, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'small' }, now: tick() });
  await addMedia(a, {
    filename: 'big.png',
    mime: 'image/png',
    data: new Uint8Array(8000).fill(7).buffer,
    now: tick(),
  });

  await syncWith(a, wired.transportFor('device-a', { maxChunkBytes: 4096 }), { now: tick });

  const oversized = wired.problems.filter((problem) => problem.kind === 'oversized');
  assert.equal(oversized.length, 1, 'the caller is told which record did not fit');
  assert.equal(oversized[0]?.kind === 'oversized' && oversized[0].record.store, 'media');
  assert.ok(wired.relay.events.length > 0, 'and everything that did fit still went');
});

test('media that fits crosses with its bytes intact', async () => {
  const { a, b, tick } = await twoDevices();
  const wired = wire(tick);
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
  const { file } = await addMedia(a, {
    filename: 'small.png',
    mime: 'image/png',
    data: bytes.buffer,
    now: tick(),
  });

  await syncBothWays(a, b, wired, tick);

  const arrived = await b.media.get(file.id);
  assert.ok(arrived, 'the file crossed');
  assert.ok(arrived.data instanceof ArrayBuffer, 'as bytes, not as an empty object');
  assert.deepEqual(new Uint8Array(arrived.data), bytes);
});

test('a relay that fails a query does not fail the round', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const good = new FakeRelay('wss://good.test');
  const bad = new FakeRelay('wss://bad.test');
  bad.faults.closeSubscriptions = 'rate-limited';
  const problems: TransportProblem[] = [];

  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'resilient' }, now: tick() });

  const transport = (device: string) =>
    new NostrTransport({
      signer,
      pubkey,
      deviceId: device,
      relays: [
        new Relay(good.url, { socket: good.connect, timeoutMs: 2000 }),
        new Relay(bad.url, { socket: bad.connect, timeoutMs: 2000 }),
      ],
      now: tick,
      onProblem: (problem) => problems.push(problem),
    });

  await syncWith(a, transport('device-a'), { now: tick });
  await syncWith(b, transport('device-b'), { now: tick });

  assert.equal((await b.notes.getAll()).length, 1, 'the good relay carried it');
  assert.ok(
    problems.some((problem) => problem.kind === 'relay-failed' && problem.url === bad.url),
    'and the bad one was reported',
  );
});

test('a push that no relay accepts throws rather than losing the records', async () => {
  const { a, basic, deck, tick } = await twoDevices();
  const relay = new FakeRelay();
  relay.faults.rejectPublish = 'blocked: not on the allow list';
  const wired = wire(tick, relay);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' }, now: tick() });

  // Silently advancing the push watermark here would mean these records
  // were never offered again — a permanent, invisible data loss.
  await assert.rejects(
    () => syncWith(a, wired.transportFor('device-a'), { now: tick }),
    /no relay accepted chunk/,
  );
});

test('a tampering relay contributes nothing, and says so rather than looking idle', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'authentic' }, now: tick() });
  await syncWith(a, wired.transportFor('device-a'), { now: tick });

  wired.relay.faults.tamper = true;

  // Nothing it sends can be read, including our own push read back — so
  // the round fails loudly. A relay that alters events is not a relay this
  // device can use, and reporting "up to date" would be a lie.
  await assert.rejects(
    () => syncWith(b, wired.transportFor('device-b'), { now: tick }),
    /can be read back|no relay accepted/,
  );
  assert.equal((await b.notes.getAll()).length, 0, 'the altered events never reached the merge');
});

test('a relay that acknowledges a push and stores nothing is caught', async () => {
  const { a, basic, deck, tick } = await twoDevices();
  const relay = new FakeRelay('wss://relay.test');
  relay.faults.acceptAndDiscard = true;
  const wired = wire(tick, relay);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' }, now: tick() });

  // Without the read-back this reported "7 sent", advanced the push
  // watermark, and never offered those records again — a permanent,
  // invisible hole in the backup the feature exists to provide.
  await assert.rejects(
    () => syncWith(a, wired.transportFor('device-a'), { now: tick }),
    /can be read back/,
  );

  const state = await readSyncState(a, wired.transportFor('device-a').peerId);
  assert.equal(state.lastPushedAt, 0, 'and the watermark did not move');
});

test('the pull watermark advances only past what was actually read', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'first' }, now: tick() });
  await syncWith(a, wired.transportFor('device-a'), { now: tick });

  const first = await syncWith(b, wired.transportFor('device-b'), { now: tick });
  assert.ok(first.lastPulledAt > 0);

  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'second' }, now: tick() });
  await syncWith(a, wired.transportFor('device-a'), { now: tick });

  const second = await syncWith(b, wired.transportFor('device-b'), { now: tick });
  assert.ok(second.lastPulledAt > first.lastPulledAt, 'and keeps advancing');
  assert.equal((await b.notes.getAll()).length, 2);
});

test('an edit made on the second device travels back', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const wired = wire(tick);
  const { note } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'original', Back: '' },
    now: tick(),
  });
  await syncBothWays(a, b, wired, tick);

  await updateNote(b, note.id, { fields: { Front: 'edited on B', Back: '' }, now: tick() });
  await syncBothWays(a, b, wired, tick);

  const back = await a.notes.get(note.id);
  assert.equal(back?.fields['Front'], 'edited on B');
});
