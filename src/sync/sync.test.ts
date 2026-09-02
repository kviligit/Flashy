import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking, type Db } from '../storage/index.js';
import { addNote, deleteNotes, updateNote } from '../collection/notes.js';
import { addMedia } from '../collection/media.js';
import { Scheduler } from '../scheduler/index.js';
import { Rating, State } from '../fsrs/index.js';
import type { DeckConfig, NoteType } from '../domain/types.js';
import { loopbackTransport, readSyncState, replayScheduling, syncWith } from './index.js';

/**
 * A monotonic clock, one per test.
 *
 * Every timestamp — edits, answers and the sync rounds themselves — comes
 * from here. That matters: the push watermark is this device's own clock,
 * so anything written with a timestamp earlier than the last push will
 * never be offered to a peer. Real code always uses Date.now() and so is
 * naturally monotonic; a test that picks timestamps by hand can easily
 * write into the past and then wonder why nothing syncs.
 */
function makeClock(start = Date.now() + 60_000) {
  let value = start;
  return () => (value += 1000);
}

/**
 * Two devices holding the same collection.
 *
 * They are seeded from one export so their decks, configs and note types
 * share ids — which is what a real pair of devices would have after the
 * first sync, and what makes divergent edits meaningful rather than just
 * two unrelated collections.
 */
async function twoDevices() {
  const tick = makeClock();
  // The tracking decorator takes the same clock, so tombstones are stamped
  // on the same timeline as the records they delete. Mixing a real clock
  // with an injected one makes every record look newer than every
  // tombstone, and deletions are then rejected as "edited since".
  const a = withChangeTracking(new MemoryDb(), { now: tick });
  await seedIfEmpty(a, tick());

  const b = withChangeTracking(new MemoryDb(), { now: tick });
  for (const store of ['decks', 'deckConfigs', 'noteTypes', 'meta'] as const) {
    const records = await a[store].getAll();
    await (b[store] as { putMany(items: readonly never[]): Promise<void> }).putMany(records as never[]);
  }

  const noteTypes = await a.noteTypes.getAll();
  const basic = noteTypes.find((nt) => nt.name === 'Basic') as NoteType;
  const deck = (await a.decks.getAll())[0]!;
  const config = (await a.deckConfigs.getAll())[0] as DeckConfig;

  return { a, b, basic, deck, config, tick };
}

/** Sync a to b and back, until nothing more moves. */
async function syncBothWays(a: Db, b: Db, tick: () => number) {
  await syncWith(a, loopbackTransport(b, { peerId: 'b', now: tick }), { now: tick });
  await syncWith(b, loopbackTransport(a, { peerId: 'a', now: tick }), { now: tick });
  await syncWith(a, loopbackTransport(b, { peerId: 'b', now: tick }), { now: tick });
}

// --- basics ---------------------------------------------------------------

test('a note created on one device arrives on the other', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'bonjour', Back: 'hello' },
  });

  await syncBothWays(a, b, tick);

  const arrived = await b.notes.get(note.id);
  assert.ok(arrived, 'the note crossed');
  assert.equal(arrived.fields['Front'], 'bonjour');
  assert.equal((await b.cards.byIndex('noteId', note.id)).length, 1, 'and so did its card');
});

test('syncing twice moves nothing the second time', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  await syncBothWays(a, b, tick);

  const again = await syncWith(a, loopbackTransport(b, { peerId: 'b', now: tick }), { now: tick });
  assert.equal(again.pulled.applied, 0, 'nothing new to take');
  assert.equal(again.pulled.reviewLogs, 0);
});

test('watermarks are stored per peer and advance', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });

  const before = await readSyncState(a, 'b');
  assert.equal(before.lastPulledAt, 0);

  await syncWith(a, loopbackTransport(b, { peerId: 'b', now: tick }), { now: tick });
  const after = await readSyncState(a, 'b');
  assert.ok(after.lastPulledAt > 0);
  assert.ok(after.lastPushedAt > 0);
});

// --- conflicts ------------------------------------------------------------

test('the later edit wins when both devices change the same note', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'original', Back: '' },
  });
  await syncBothWays(a, b, tick);

  const earlier = tick();
  const later = tick();
  await updateNote(a, note.id, { fields: { Front: 'edited on A', Back: '' }, now: earlier });
  await updateNote(b, note.id, { fields: { Front: 'edited on B', Back: '' }, now: later });

  await syncBothWays(a, b, tick);

  assert.equal((await a.notes.get(note.id))?.fields['Front'], 'edited on B', 'B edited later');
  assert.equal((await b.notes.get(note.id))?.fields['Front'], 'edited on B');
});

test('both devices reach the same answer on a tie', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  await syncBothWays(a, b, tick);

  // Identical timestamps: without a deterministic tiebreak the two would
  // disagree forever, each convinced the other was behind.
  const sameMoment = tick();
  await updateNote(a, note.id, { fields: { Front: 'from A' }, now: sameMoment });
  await updateNote(b, note.id, { fields: { Front: 'from B' }, now: sameMoment });

  await syncBothWays(a, b, tick);
  assert.equal(
    (await a.notes.get(note.id))?.fields['Front'],
    (await b.notes.get(note.id))?.fields['Front'],
    'converged',
  );
});

// --- deletions ------------------------------------------------------------

test('a deletion on one device removes the note on the other', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'doomed' } });
  await syncBothWays(a, b, tick);
  assert.ok(await b.notes.get(note.id));

  await deleteNotes(a, [note.id]);
  await syncBothWays(a, b, tick);

  assert.equal(await b.notes.get(note.id), null, 'gone on B too');
  assert.equal((await b.cards.byIndex('noteId', note.id)).length, 0, 'and its cards with it');
});

test('a deleted note does not come back on the next sync', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  await syncBothWays(a, b, tick);
  await deleteNotes(a, [note.id]);
  await syncBothWays(a, b, tick);
  await syncBothWays(a, b, tick);

  assert.equal(await a.notes.get(note.id), null, 'still gone on A');
  assert.equal(await b.notes.get(note.id), null, 'still gone on B');
});

test('an edit made after a delete wins over the tombstone', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { note } = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  await syncBothWays(a, b, tick);

  // A deletes it, then B edits it later. The edit is the later intention,
  // and resurrecting is the safer error.
  await deleteNotes(a, [note.id]);
  const tombstone = (await a.deletions.getAll())[0]!;
  await updateNote(b, note.id, { fields: { Front: 'still wanted' }, now: tombstone.deletedAt + 5000 });

  await syncBothWays(a, b, tick);
  assert.ok(await b.notes.get(note.id), 'the edit survived on B');
});

// --- review history -------------------------------------------------------

test('answers given on both devices are merged, not overwritten', async () => {
  const { a, b, basic, deck, config, tick } = await twoDevices();
  const { note, cards } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'merge me', Back: 'x' },
  });
  const cardId = cards[0]!.id;
  await syncBothWays(a, b, tick);

  // Each device studies the same card, without seeing the other.
  const tA = tick();
  const schedulerA = new Scheduler(a, { now: () => tA, random: () => 0.5 });
  await schedulerA.load();
  await schedulerA.answerCard((await a.cards.get(cardId))!, Rating.Good, config, 2000);

  const tB = tick();
  const schedulerB = new Scheduler(b, { now: () => tB, random: () => 0.5 });
  await schedulerB.load();
  await schedulerB.answerCard((await b.cards.get(cardId))!, Rating.Again, config, 3000);

  await syncBothWays(a, b, tick);

  const logsA = await a.reviewLogs.byIndex('cardId', cardId);
  const logsB = await b.reviewLogs.byIndex('cardId', cardId);
  assert.equal(logsA.length, 2, 'A has both answers');
  assert.equal(logsB.length, 2, 'B has both answers');
  assert.deepEqual(
    logsA.map((l) => l.id).sort(),
    logsB.map((l) => l.id).sort(),
    'the same two answers',
  );
  void note;
});

test('after merging histories both devices agree on the card', async () => {
  const { a, b, basic, deck, config, tick } = await twoDevices();
  const { cards } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'converge', Back: 'x' },
  });
  const cardId = cards[0]!.id;
  await syncBothWays(a, b, tick);

  const tA = tick();
  const schedulerA = new Scheduler(a, { now: () => tA, random: () => 0.5 });
  await schedulerA.load();
  await schedulerA.answerCard((await a.cards.get(cardId))!, Rating.Good, config, 1000);

  const tB = tick();
  const schedulerB = new Scheduler(b, { now: () => tB, random: () => 0.5 });
  await schedulerB.load();
  await schedulerB.answerCard((await b.cards.get(cardId))!, Rating.Hard, config, 1000);

  await syncBothWays(a, b, tick);

  const cardA = await a.cards.get(cardId);
  const cardB = await b.cards.get(cardId);
  assert.ok(cardA && cardB);
  assert.equal(cardA.reps, cardB.reps, 'same number of answers');
  assert.equal(cardA.due, cardB.due, 'same due date');
  assert.equal(cardA.state, cardB.state);
  assert.deepEqual(cardA.memory, cardB.memory, 'same memory state');
  assert.equal(cardA.reps, 2, 'both answers counted, neither overwritten');
});

test('replay is deterministic and independent of the order logs arrive in', async () => {
  const { a, basic, deck, config, tick } = await twoDevices();
  const { cards } = await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: 'x', Back: 'y' },
  });
  const card = cards[0]!;

  const firstAt = tick();
  const scheduler = new Scheduler(a, { now: () => firstAt, random: () => 0.5 });
  await scheduler.load();
  const first = await scheduler.answerCard(card, Rating.Good, config, 0);
  const secondAt = firstAt + 86_400_000;
  const second = await new Scheduler(a, { now: () => secondAt, random: () => 0.5 })
    .answerCard(first.card, Rating.Good, config, 0);

  const logs = await a.reviewLogs.byIndex('cardId', card.id);
  const forwards = replayScheduling(second.card, logs, config);
  const backwards = replayScheduling(second.card, [...logs].reverse(), config);

  assert.equal(forwards.due, backwards.due, 'log order must not matter');
  assert.deepEqual(forwards.memory, backwards.memory);
  assert.equal(forwards.reps, 2);
});

// --- media ----------------------------------------------------------------

test('attached files cross with their notes', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const file = await addMedia(a, { filename: 'x.png', mime: 'image/png', data: bytes.buffer });
  await addNote(a, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: file.tag, Back: 'has an image' },
  });

  await syncBothWays(a, b, tick);

  const arrived = await b.media.get(file.file.id);
  assert.ok(arrived, 'the file crossed');
  assert.deepEqual(new Uint8Array(arrived.data), bytes, 'byte for byte');
});

// --- both directions at once ---------------------------------------------

test('changes made on both devices at once all survive', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();

  const onA = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'from A' } });
  const onB = await addNote(b, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'from B' } });

  await syncBothWays(a, b, tick);

  for (const [name, db] of [['A', a], ['B', b]] as const) {
    assert.ok(await db.notes.get(onA.note.id), `${name} has A's note`);
    assert.ok(await db.notes.get(onB.note.id), `${name} has B's note`);
    assert.equal(await db.notes.count(), 2, `${name} has exactly two`);
  }
});

test('a three-way exchange converges', async () => {
  // A and B both sync through nothing but each other; a third device C
  // joining later must end up with everything.
  const { a, b, basic, deck, tick } = await twoDevices();
  const c = withChangeTracking(new MemoryDb(), { now: tick });
  for (const store of ['decks', 'deckConfigs', 'noteTypes', 'meta'] as const) {
    const records = await a[store].getAll();
    await (c[store] as { putMany(items: readonly never[]): Promise<void> }).putMany(records as never[]);
  }

  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'a' } });
  await addNote(b, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'b' } });
  await syncBothWays(a, b, tick);

  await syncWith(c, loopbackTransport(a, { peerId: 'a', now: tick }), { now: tick });
  assert.equal(await c.notes.count(), 2, 'C picked up both notes through A');
});

test('pullOnly leaves the peer untouched', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'private' } });

  await syncWith(a, loopbackTransport(b, { peerId: 'b', now: tick }), { now: tick, pullOnly: true });
  assert.equal(await b.notes.count(), 0, 'nothing was sent');
  assert.equal((await readSyncState(a, 'b')).lastPushedAt, 0, 'and the push watermark did not move');
});

test('suspending on one device is reflected on the other', async () => {
  const { a, b, basic, deck, tick } = await twoDevices();
  const { cards } = await addNote(a, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: 'x' } });
  await syncBothWays(a, b, tick);

  const suspendedAt = tick();
  const scheduler = new Scheduler(a, { now: () => suspendedAt });
  await scheduler.load();
  await scheduler.setSuspended([cards[0]!.id], true);

  await syncBothWays(a, b, tick);
  assert.equal((await b.cards.get(cards[0]!.id))?.suspended, true);
  assert.equal((await b.cards.get(cards[0]!.id))?.state, State.New);
});
