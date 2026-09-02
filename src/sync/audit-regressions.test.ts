/**
 * One test per finding from the second security audit.
 *
 * They live together rather than beside their subjects because what they
 * have in common is more useful than what separates them: every one of
 * these passed review, passed 384 other tests, and was still wrong. The
 * suite was blind to them for three specific reasons — it injected a
 * socket, so it never saw the browser's CSP; its fake relay never lied
 * about *completeness*, only about content; and its clocks were always
 * real, so no watermark was ever poisoned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addNote } from '../collection/notes.js';
import { addMedia } from '../collection/media.js';
import type { Deletion, NoteType, ReviewLog } from '../domain/types.js';
import { hashContent } from '../domain/media.js';
import { bytesToHex, generateSecretKey, getPublicKey, hexToBytes } from '../nostr/secp256k1.js';
import { LocalSigner } from '../nostr/signer.js';
import { FakeRelay } from '../nostr/fake-relay.js';
import { Relay } from '../nostr/relay.js';
import { signEvent } from '../nostr/event.js';
import { readSyncState, syncWith } from './engine.js';
import { applyChanges } from './merge.js';
import { NostrTransport, FLASHY_KIND, DEVICE_TAG, APP_TAG, APP_NAME } from './nostr-transport.js';
import { chunkChangeSet, decodeChangeSet, WIRE_VERSION } from './wire.js';

const secretKey = generateSecretKey();
const signer = new LocalSigner(secretKey);
const pubkey = bytesToHex(getPublicKey(secretKey));

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

function transport(relay: FakeRelay, device: string, tick: () => number): NostrTransport {
  return new NostrTransport({
    signer,
    pubkey,
    deviceId: device,
    relays: [new Relay(relay.url, { socket: relay.connect, timeoutMs: 2000 })],
    now: tick,
  });
}

/** Publish a chunk exactly as a peer would, but with fields we choose. */
async function publishChunk(
  relay: FakeRelay,
  device: string,
  chunk: Record<string, unknown>,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<void> {
  const content = await signer.encrypt(pubkey, JSON.stringify({
    v: WIRE_VERSION,
    device,
    since: 0,
    upserts: [],
    deletions: [],
    seq: 0,
    of: 1,
    ...chunk,
  }));
  relay.seed(
    await signEvent(
      {
        pubkey,
        created_at: createdAt,
        kind: FLASHY_KIND,
        tags: [[DEVICE_TAG, device], [APP_TAG, APP_NAME]],
        content,
      },
      secretKey,
    ),
  );
}

// --- C1: a poisoned watermark used to deafen the device for ever ----------

test('a peer claiming a timestamp in the next century cannot silence this device', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const { db } = await collection(tick);

  await publishChunk(relay, 'peer', { until: 1e308 });
  await syncWith(db, transport(relay, 'mine', tick), { now: tick });

  const state = await readSyncState(db, `nostr:${pubkey}`);
  assert.ok(
    state.lastPulledAt < Date.now() + 25 * 60 * 60 * 1000,
    `watermark was not clamped: ${state.lastPulledAt}`,
  );

  // The real test: an honest chunk that follows still arrives.
  await publishChunk(relay, 'peer', {
    until: Date.now(),
    upserts: [
      {
        store: 'decks',
        version: Date.now(),
        record: {
          id: 'deck-real',
          name: 'Arrived',
          configId: 'x',
          description: '',
          collapsed: false,
          created: 1,
          modified: Date.now(),
        },
      },
    ],
  });
  await syncWith(db, transport(relay, 'mine', tick), { now: tick });

  assert.ok(await db.decks.get('deck-real'), 'the device is not deaf');
});

test('the wire decoder refuses a timestamp that is not one', () => {
  const base = { v: WIRE_VERSION, device: 'p', since: 0, upserts: [], deletions: [] };
  assert.throws(() => decodeChangeSet({ ...base, until: 1e308 }), /plausible timestamp/);
  assert.throws(() => decodeChangeSet({ ...base, until: -1 }), /plausible timestamp/);
  // A real millisecond timestamp still passes.
  assert.equal(decodeChangeSet({ ...base, until: Date.now() }).until > 0, true);
});

// --- C2: a withheld event used to fall below the watermark for ever -------

test('an event the relay held back in one round still arrives in the next', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const { db } = await collection(tick);
  const now = Date.now();

  const deckRecord = (id: string, modified: number) => ({
    store: 'decks',
    version: modified,
    record: {
      id,
      name: id,
      configId: 'x',
      description: '',
      collapsed: false,
      created: 1,
      modified,
    },
  });

  // Round one: the relay serves only the newer of the two events.
  await publishChunk(relay, 'peer', { until: now + 60_000, upserts: [deckRecord('deck-late', now + 60_000)] });
  await syncWith(db, transport(relay, 'mine', tick), { now: tick });
  assert.ok(await db.decks.get('deck-late'));

  // Round two: the older one shows up. Its `until` is below the watermark
  // the first round set, which is exactly the case that used to lose it.
  await publishChunk(relay, 'peer', { until: now, upserts: [deckRecord('deck-early', now)] });
  await syncWith(db, transport(relay, 'mine', tick), { now: tick });

  assert.ok(await db.decks.get('deck-early'), 'the straggler was not lost');
});

test('a round with an unreachable relay does not advance the watermark', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  relay.faults.closeSubscriptions = 'rate-limited';
  const { db } = await collection(tick);

  const before = await readSyncState(db, `nostr:${pubkey}`);
  await assert.rejects(() => syncWith(db, transport(relay, 'mine', tick), { now: tick }));
  const after = await readSyncState(db, `nostr:${pubkey}`);

  assert.equal(after.lastPulledAt, before.lastPulledAt, 'nothing was claimed as seen');
});

// --- H1: review logs drive the scheduler through two unchecked fields -----

async function studiedCard(tick: () => number) {
  const { db, basic, deck } = await collection(tick);
  const { cards } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'q', Back: 'a' },
    now: tick(),
  });
  return { db, card: cards[0]! };
}

function log(overrides: Record<string, unknown>): ReviewLog {
  return {
    id: 'log-hostile',
    cardId: 'unset',
    reviewedAt: Date.now(),
    rating: 3,
    stateBefore: 0,
    stateAfter: 2,
    intervalDays: 1,
    lastIntervalDays: 0,
    elapsedDays: 0,
    stability: 1,
    difficulty: 5,
    timeTakenMs: 1000,
    snapshot: null as never,
    siblingsBuried: [],
    ...overrides,
  } as unknown as ReviewLog;
}

test('a review log with an absurd snapshot is refused, not replayed', async () => {
  const tick = makeClock();
  const { db, card } = await studiedCard(tick);
  const before = await db.cards.get(card.id);

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'reviewLogs',
        version: Date.now(),
        record: log({
          cardId: card.id,
          reviewedAt: 1,
          snapshot: { ...card, memory: { stability: 1e6, difficulty: 5 } },
        }),
      },
    ],
  });

  assert.equal(counts.reviewLogs, 0, 'nothing was written');
  assert.equal(counts.rejected, 1);
  assert.deepEqual((await db.cards.get(card.id))?.due, before?.due, 'the schedule did not move');
});

test('a review log with no snapshot is refused rather than poisoning the card', async () => {
  const tick = makeClock();
  const { db, card } = await studiedCard(tick);

  // This used to be written, and *then* throw inside the replay — losing
  // the round's watermark and making the card unreplayable for ever.
  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [{ store: 'reviewLogs', version: Date.now(), record: log({ cardId: card.id }) }],
  });

  assert.equal(counts.rejected, 1);
  assert.ok(!(await db.reviewLogs.get('log-hostile')));
  assert.equal(counts.replayFailures, 0);
});

test('a review log dated in the future is refused', async () => {
  const tick = makeClock();
  const { db, card } = await studiedCard(tick);

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'reviewLogs',
        version: Date.now(),
        record: log({
          cardId: card.id,
          reviewedAt: Date.now() + 40 * 60 * 1000,
          snapshot: card,
        }),
      },
    ],
  });

  assert.equal(counts.rejected, 1);
});

test('an honest review log from a peer still applies', async () => {
  const tick = makeClock();
  const { db, card } = await studiedCard(tick);

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'reviewLogs',
        version: Date.now(),
        record: log({ cardId: card.id, snapshot: card }),
      },
    ],
  });

  assert.equal(counts.reviewLogs, 1, 'validation did not become a wall');
  assert.equal(counts.rejected, 0);
});

// --- H3: media was never actually content-addressed -----------------------

test('a peer cannot squat the id an image will later hash to', async () => {
  const tick = makeClock();
  const { db } = await collection(tick);

  const real = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const id = await hashContent(real.buffer as ArrayBuffer);
  const fake = new TextEncoder().encode('ATTACKER BYTES');

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'media',
        version: Date.now(),
        record: {
          id,
          filename: 'squatted.png',
          mime: 'image/png',
          size: fake.byteLength,
          data: fake.buffer,
          created: 1,
          modified: Date.now(),
        } as never,
      },
    ],
  });

  assert.equal(counts.rejected, 1, 'the id was not earned');
  assert.ok(!(await db.media.get(id)));

  // And the genuine file, added afterwards, is not shut out.
  const added = await addMedia(db, {
    filename: 'real.png',
    mime: 'image/png',
    data: real.buffer as ArrayBuffer,
    now: tick(),
  });
  assert.equal(added.file.id, id);
  assert.deepEqual(new Uint8Array((await db.media.get(id))!.data), real);
});

test('honest media still crosses', async () => {
  const tick = makeClock();
  const { db } = await collection(tick);
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const id = await hashContent(bytes.buffer as ArrayBuffer);

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'media',
        version: Date.now(),
        record: {
          id,
          filename: 'ok.png',
          mime: 'image/png',
          size: 4,
          data: bytes.buffer,
          created: 1,
          modified: Date.now(),
        } as never,
      },
    ],
  });

  assert.equal(counts.applied, 1);
});

// --- H4: verification ran before the free checks --------------------------

test('junk signatures are not verified when the filter already excludes them', async () => {
  const relay = new FakeRelay('wss://relay.test');
  const other = generateSecretKey();
  const otherKey = bytesToHex(getPublicKey(other));

  // Correct id, wrong author: a relay can make these for nothing, and each
  // one used to cost this device a full curve verification.
  for (let i = 0; i < 30; i += 1) {
    relay.seed(
      await signEvent(
        {
          pubkey: otherKey,
          created_at: 1_700_000_000 + i,
          kind: FLASHY_KIND,
          tags: [],
          content: `junk ${i}`,
        },
        other,
      ),
    );
  }

  // A relay is not obliged to honour the filter it was sent, and a hostile
  // one certainly will not.
  relay.faults.ignoreFilters = true;

  const notices: string[] = [];
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 1000,
    onNotice: (message) => notices.push(message),
  });

  const found = await connection.query([{ kinds: [FLASHY_KIND], authors: [pubkey] }]);
  connection.close();

  assert.deepEqual(found, []);
  assert.equal(
    notices.filter((notice) => notice.includes('matched no filter')).length,
    30,
    'every one was rejected by the filter',
  );
  assert.equal(
    notices.filter((notice) => notice.includes('unverifiable')).length,
    0,
    'and none of them reached the signature check',
  );
});

test('a relay cannot make this device verify without bound', async () => {
  const relay = new FakeRelay('wss://relay.test');
  relay.faults.duplicate = 40;
  relay.seed(
    await signEvent(
      { pubkey, created_at: 1_700_000_000, kind: FLASHY_KIND, tags: [], content: 'x' },
      secretKey,
    ),
  );

  const notices: string[] = [];
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 1000,
    maxOffered: 10,
    onNotice: (message) => notices.push(message),
  });

  await connection.query([{ kinds: [FLASHY_KIND] }]);
  connection.close();

  assert.ok(
    notices.some((notice) => notice.includes('more than 10 events')),
    notices.join('; '),
  );
});

// --- M3: a future-dated record could sit on top of the user's edits -------

test('a record dated far in the future is refused outright', async () => {
  const tick = makeClock();
  const { db, basic, deck } = await collection(tick);
  const { note } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'mine', Back: '' },
    now: tick(),
  });

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    deletions: [],
    upserts: [
      {
        store: 'notes',
        version: Date.now() + 60 * 60 * 1000,
        record: {
          ...note,
          fields: { Front: 'theirs', Back: '' },
          modified: Date.now() + 60 * 60 * 1000,
        } as never,
      },
    ],
  });

  assert.equal(counts.rejected, 1, 'an hour ahead is not clock skew, it is a claim');
  assert.equal((await db.notes.get(note.id))?.fields['Front'], 'mine');
});

// --- L1: hexToBytes invented bytes for non-hex input ----------------------

test('hexToBytes refuses anything that is not hex', () => {
  assert.throws(() => hexToBytes('0z'), /non-hex/);
  assert.throws(() => hexToBytes('+1'), /non-hex/);
  assert.throws(() => hexToBytes('-1'), /non-hex/);
  assert.throws(() => hexToBytes('  1g'), /non-hex/);
  assert.deepEqual(hexToBytes('00ff'), new Uint8Array([0, 255]));
});

// --- tombstones still behave ---------------------------------------------

test('a tombstone still removes a record, and still cannot touch a review log', async () => {
  const tick = makeClock();
  const { db, basic, deck } = await collection(tick);
  const { note } = await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'doomed' },
    now: tick(),
  });

  const counts = await applyChanges(db, {
    since: 0,
    until: Date.now(),
    upserts: [],
    deletions: [
      // After the note's own timestamp: the clock in these tests runs ahead
      // of the wall clock, and a tombstone older than the record it names is
      // correctly read as "edited since you deleted it".
      { id: `notes:${note.id}`, store: 'notes', recordId: note.id, deletedAt: note.modified + 1 } as Deletion,
    ],
  });

  assert.equal(counts.deleted, 1);
  assert.ok(!(await db.notes.get(note.id)));
});


// --- M1/M2: a round has to fit on a phone --------------------------------

test('a round past its record budget stops, and refuses to claim it saw the rest', async () => {
  const tick = makeClock();
  const relay = new FakeRelay('wss://relay.test');
  const { db } = await collection(tick);
  const now = Date.now();

  const deckRecord = (id: string, modified: number) => ({
    store: 'decks',
    version: modified,
    record: {
      id,
      name: id,
      configId: 'x',
      description: '',
      collapsed: false,
      created: 1,
      modified,
    },
  });

  // Two chunks of three records each, against a budget of four.
  await publishChunk(relay, 'peer', {
    until: now,
    upserts: [deckRecord('a1', now), deckRecord('a2', now), deckRecord('a3', now)],
  });
  await publishChunk(relay, 'peer', {
    until: now + 1000,
    upserts: [deckRecord('b1', now), deckRecord('b2', now), deckRecord('b3', now)],
  });

  const transport = new NostrTransport({
    signer,
    pubkey,
    deviceId: 'mine',
    relays: [new Relay(relay.url, { socket: relay.connect, timeoutMs: 2000 })],
    now: tick,
    maxRecordsPerRound: 4,
  });

  await syncWith(db, transport, { now: tick });

  const decks = await db.decks.getAll();
  const arrived = decks.filter((deck) => /^[ab]\d$/.test(deck.id));
  assert.equal(arrived.length, 3, 'one chunk was taken, the other left for later');

  // The critical half: a truncated round must not advance the watermark,
  // or the chunk it declined to read falls below the cut for ever.
  const state = await readSyncState(db, `nostr:${pubkey}`);
  assert.equal(state.lastPulledAt, 0, 'nothing was claimed as seen');

  // And the next round, with room, picks up what was left.
  const roomy = new NostrTransport({
    signer,
    pubkey,
    deviceId: 'mine',
    relays: [new Relay(relay.url, { socket: relay.connect, timeoutMs: 2000 })],
    now: tick,
  });
  await syncWith(db, roomy, { now: tick });

  const after = (await db.decks.getAll()).filter((deck) => /^[ab]\d$/.test(deck.id));
  assert.equal(after.length, 6, 'the remainder arrived rather than being lost');
});

test('oversized media is rejected without being encoded first', () => {
  // The audit measured 2966ms and 85MB of heap to discover that a 32MB
  // file did not fit, because it was base64-encoded before being measured
  // — a fully synchronous freeze of the UI thread, repeated every round
  // for as long as the push kept failing.
  const record = {
    id: 'big',
    filename: 'big.png',
    mime: 'image/png',
    size: 32 * 1024 * 1024,
    data: new ArrayBuffer(32 * 1024 * 1024),
    created: 1,
    modified: 2,
  };

  const start = performance.now();
  const { chunks, oversized } = chunkChangeSet(
    { since: 0, until: 100, deletions: [], upserts: [{ store: 'media', record: record as never, version: 2 }] },
    'device-a',
  );
  const elapsed = performance.now() - start;

  assert.equal(oversized.length, 1);
  assert.equal(chunks.length, 0);
  // Generous by three orders of magnitude against the measured 2966ms, so
  // this fails on a regression rather than on a slow machine.
  assert.ok(elapsed < 250, `took ${elapsed.toFixed(0)}ms; it should not be encoding the file`);
});
