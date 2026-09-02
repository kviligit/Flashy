import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDb, seedIfEmpty, withChangeTracking } from '../storage/index.js';
import { addMedia, cleanupUnusedMedia, MAX_FILE_BYTES, mediaTotalBytes, mediaUsage, referencedMediaIds } from './media.js';
import { addNote, updateNote } from './notes.js';
import { mediaUrl } from '../domain/media.js';
import type { NoteType } from '../domain/types.js';

const png = (seed: number) => {
  const bytes = new Uint8Array(64);
  bytes.fill(seed);
  return bytes.buffer;
};

async function setup() {
  const now = Date.parse('2026-05-01T10:00:00Z');
  const db = withChangeTracking(new MemoryDb());
  await seedIfEmpty(db, now);
  const types = await db.noteTypes.getAll();
  const basic = types.find((t) => t.name === 'Basic') as NoteType;
  const deck = (await db.decks.getAll())[0]!;
  return { db, basic, deck, now };
}

test('adding a file stores it and returns markup to insert', async () => {
  const { db } = await setup();
  const result = await addMedia(db, { filename: 'cat.png', mime: 'image/png', data: png(1) });

  assert.equal(result.deduplicated, false);
  assert.equal(result.kind, 'image');
  assert.equal(result.file.size, 64);
  assert.match(result.tag, /^<img src="flashy-media:[0-9a-f]{32}" alt="cat">$/);
  assert.equal(await db.media.count(), 1);
});

test('the same bytes are stored once, whatever the file was called', async () => {
  const { db } = await setup();
  const first = await addMedia(db, { filename: 'cat.png', mime: 'image/png', data: png(7) });
  const second = await addMedia(db, { filename: 'copy-of-cat.png', mime: 'image/png', data: png(7) });

  assert.equal(second.deduplicated, true);
  assert.equal(second.file.id, first.file.id);
  assert.equal(await db.media.count(), 1, 'twenty cards sharing a diagram must not cost twenty copies');
  assert.equal(second.file.filename, 'cat.png', 'the first name added wins');
});

test('different bytes are stored separately', async () => {
  const { db } = await setup();
  await addMedia(db, { filename: 'a.png', mime: 'image/png', data: png(1) });
  await addMedia(db, { filename: 'b.png', mime: 'image/png', data: png(2) });
  assert.equal(await db.media.count(), 2);
});

test('audio is accepted and gets a playable tag', async () => {
  const { db } = await setup();
  const result = await addMedia(db, { filename: 'bonjour.mp3', mime: 'audio/mpeg', data: png(3) });
  assert.equal(result.kind, 'audio');
  assert.match(result.tag, /<audio .*controls/);
});

test('files that are the wrong type, empty or too large are refused', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => addMedia(db, { filename: 'notes.pdf', mime: 'application/pdf', data: png(1) }),
    /not an image or a sound/,
  );
  await assert.rejects(
    () => addMedia(db, { filename: 'empty.png', mime: 'image/png', data: new ArrayBuffer(0) }),
    /is empty/,
  );
  await assert.rejects(
    () =>
      addMedia(db, {
        filename: 'huge.png',
        mime: 'image/png',
        data: new ArrayBuffer(MAX_FILE_BYTES + 1),
      }),
    /too large/,
  );
  assert.equal(await db.media.count(), 0, 'nothing was stored');
});

test('usage is derived from the notes, not from a stored count', async () => {
  const { db, basic, deck } = await setup();
  const image = await addMedia(db, { filename: 'shared.png', mime: 'image/png', data: png(5) });

  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: `<img src="${mediaUrl(image.file.id)}">`, Back: 'one' },
  });
  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: `<img src="${mediaUrl(image.file.id)}">`, Back: 'two' },
  });

  const usage = await mediaUsage(db);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.noteCount, 2, 'both notes count');

  const referenced = await referencedMediaIds(db);
  assert.ok(referenced.has(image.file.id));
});

test('cleanup removes only files no note mentions', async () => {
  const { db, basic, deck } = await setup();
  const used = await addMedia(db, { filename: 'used.png', mime: 'image/png', data: png(1) });
  const orphan = await addMedia(db, { filename: 'orphan.png', mime: 'image/png', data: png(2) });

  await addNote(db, {
    noteTypeId: basic.id,
    deckId: deck.id,
    fields: { Front: `<img src="${mediaUrl(used.file.id)}">`, Back: 'x' },
  });

  const result = await cleanupUnusedMedia(db);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.ids, [orphan.file.id]);
  assert.equal(result.bytesReclaimed, 64);
  assert.ok(await db.media.get(used.file.id), 'the referenced file survives');
  assert.equal(await db.media.get(orphan.file.id), null);
});

test('a file shared by two notes survives deleting one of them', async () => {
  const { db, basic, deck } = await setup();
  const image = await addMedia(db, { filename: 'shared.png', mime: 'image/png', data: png(9) });
  const html = `<img src="${mediaUrl(image.file.id)}">`;

  const first = await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: html, Back: '1' } });
  await addNote(db, { noteTypeId: basic.id, deckId: deck.id, fields: { Front: html, Back: '2' } });

  // Remove the reference from the first note only.
  await updateNote(db, first.note.id, { fields: { Front: 'no image now', Back: '1' } });

  const afterOne = await cleanupUnusedMedia(db);
  assert.equal(afterOne.removed, 0, 'the second note still uses it');
  assert.ok(await db.media.get(image.file.id));
});

test('cleanup tombstones what it deletes, so a peer can follow', async () => {
  const { db } = await setup();
  const orphan = await addMedia(db, { filename: 'orphan.png', mime: 'image/png', data: png(4) });
  await cleanupUnusedMedia(db);

  const tombstones = await db.deletions.byIndex('store', 'media');
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0]?.recordId, orphan.file.id);
});

test('total size adds up', async () => {
  const { db } = await setup();
  assert.equal(await mediaTotalBytes(db), 0);
  await addMedia(db, { filename: 'a.png', mime: 'image/png', data: png(1) });
  await addMedia(db, { filename: 'b.png', mime: 'image/png', data: png(2) });
  assert.equal(await mediaTotalBytes(db), 128);
});

test('stored bytes survive a round trip through the database', async () => {
  const { db } = await setup();
  const original = new Uint8Array([0, 255, 128, 1, 254]);
  const added = await addMedia(db, { filename: 'x.png', mime: 'image/png', data: original.buffer });
  const back = await db.media.get(added.file.id);
  assert.deepEqual(new Uint8Array(back!.data), original);
});
