import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChangeSet } from '../storage/index.js';
import type { Deletion, MediaFile, Note } from '../domain/types.js';
import { chunkChangeSet, decodeChangeSet, encodeBinary, WIRE_VERSION } from './wire.js';

function note(id: string, front: string): Note {
  return {
    id,
    noteTypeId: 'nt',
    fields: { Front: front, Back: '' },
    tags: [],
    checksum: 0,
    created: 1,
    modified: 2,
  } as Note;
}

function media(id: string, bytes: Uint8Array): MediaFile {
  return {
    id,
    filename: `${id}.png`,
    mime: 'image/png',
    size: bytes.byteLength,
    data: bytes.buffer.slice(0) as ArrayBuffer,
    created: 1,
    modified: 2,
  };
}

function set(partial: Partial<ChangeSet>): ChangeSet {
  return { since: 0, until: 100, upserts: [], deletions: [], ...partial };
}

/** The wire is JSON, so a round trip has to go through it to mean anything. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test('a change set survives the round trip', () => {
  const changes = set({
    upserts: [{ store: 'notes', record: note('n1', 'hello'), version: 2 }],
    deletions: [{ id: 'notes:n2', store: 'notes', recordId: 'n2', deletedAt: 50 } as Deletion],
  });

  const { chunks, oversized } = chunkChangeSet(changes, 'device-a');
  assert.equal(chunks.length, 1);
  assert.deepEqual(oversized, []);

  const decoded = decodeChangeSet(roundTrip(chunks[0]));
  assert.equal(decoded.device, 'device-a');
  assert.equal(decoded.until, 100);
  assert.deepEqual(decoded.upserts[0]?.record, note('n1', 'hello'));
  assert.deepEqual(decoded.deletions, changes.deletions);
});

test('binary survives as bytes, where plain JSON would silently empty it', () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const file = media('m1', bytes);

  // The failure this guards against, shown rather than described.
  assert.deepEqual(roundTrip({ data: file.data }), { data: {} });

  const { chunks } = chunkChangeSet(set({
    upserts: [{ store: 'media', record: file, version: 2 }],
  }), 'device-a');
  const decoded = decodeChangeSet(roundTrip(chunks[0]));
  const restored = decoded.upserts[0]?.record as MediaFile;

  assert.ok(restored.data instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(restored.data), bytes);
});

test('encodeBinary reaches binary wherever it is nested', () => {
  const encoded = encodeBinary({
    a: [{ b: new Uint8Array([1, 2, 3]) }],
    c: new ArrayBuffer(2),
    d: 'left alone',
  }) as Record<string, unknown>;

  assert.equal(typeof (encoded['a'] as [{ b: { $bin: string } }])[0].b.$bin, 'string');
  assert.equal(typeof (encoded['c'] as { $bin: string }).$bin, 'string');
  assert.equal(encoded['d'], 'left alone');
});

test('chunks are independently applicable, and cover every record exactly once', () => {
  const upserts = Array.from({ length: 50 }, (_, i) => ({
    store: 'notes' as const,
    record: note(`n${i}`, 'x'.repeat(100)),
    version: i,
  }));

  const { chunks } = chunkChangeSet(set({ upserts }), 'device-a', 2048);
  assert.ok(chunks.length > 1, 'it split');

  const ids: string[] = [];
  for (const chunk of chunks) {
    const decoded = decodeChangeSet(roundTrip(chunk));
    // Each chunk is a complete change set in its own right — same window,
    // same version, valid on its own.
    assert.equal(decoded.since, 0);
    assert.equal(decoded.until, 100);
    for (const upsert of decoded.upserts) ids.push(upsert.record.id);
  }

  assert.deepEqual(ids.sort(), upserts.map((u) => u.record.id).sort());
  assert.equal(new Set(ids).size, ids.length, 'and nothing was sent twice');
});

test('deletions are packed before upserts, so a tombstone is never the straggler', () => {
  const { chunks } = chunkChangeSet(set({
    upserts: Array.from({ length: 30 }, (_, i) => ({
      store: 'notes' as const,
      record: note(`n${i}`, 'x'.repeat(200)),
      version: i,
    })),
    deletions: [{ id: 'notes:gone', store: 'notes', recordId: 'gone', deletedAt: 9 } as Deletion],
  }), 'device-a', 2048);

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]?.deletions.length, 1);
});

test('a record larger than one chunk is reported rather than sent broken', () => {
  const { chunks, oversized } = chunkChangeSet(set({
    upserts: [
      { store: 'notes', record: note('small', 'x'), version: 1 },
      { store: 'media', record: media('huge', new Uint8Array(20_000)), version: 2 },
    ],
  }), 'device-a', 4096);

  assert.equal(oversized.length, 1);
  assert.equal(oversized[0]?.store, 'media');
  assert.equal(oversized[0]?.id, 'huge');
  assert.equal(chunks.length, 1, 'and the rest still went');
  assert.equal(chunks[0]?.upserts.length, 1);
});

test('an empty change set produces no chunks at all', () => {
  assert.deepEqual(chunkChangeSet(set({}), 'device-a').chunks, []);
});

test('chunks are numbered, for diagnostics', () => {
  const { chunks } = chunkChangeSet(set({
    upserts: Array.from({ length: 20 }, (_, i) => ({
      store: 'notes' as const,
      record: note(`n${i}`, 'x'.repeat(200)),
      version: i,
    })),
  }), 'device-a', 2048);

  chunks.forEach((chunk, index) => {
    assert.equal(chunk.seq, index);
    assert.equal(chunk.of, chunks.length);
  });
});

// --- what a peer running different code can hand us ------------------------

test('a payload from a future wire version is refused, not guessed at', () => {
  assert.throws(
    () => decodeChangeSet({ v: WIRE_VERSION + 1, device: 'x', since: 0, until: 1, upserts: [], deletions: [] }),
    /unsupported wire version/,
  );
});

test('malformed payloads are refused one by one', () => {
  const base = { v: WIRE_VERSION, device: 'x', since: 0, until: 1, upserts: [], deletions: [] };

  assert.throws(() => decodeChangeSet(null), /not an object/);
  assert.throws(() => decodeChangeSet({ ...base, since: 'soon' }), /since is not a finite number/);
  assert.throws(() => decodeChangeSet({ ...base, until: Infinity }), /until is not a finite number/);
  assert.throws(() => decodeChangeSet({ ...base, upserts: {} }), /upserts is not an array/);
  assert.throws(
    () => decodeChangeSet({ ...base, upserts: [{ store: 'syncState', record: { id: 'x' }, version: 1 }] }),
    /unknown store/,
  );
  assert.throws(
    () => decodeChangeSet({ ...base, upserts: [{ store: 'notes', record: { id: 'x' }, version: NaN }] }),
    /version is not a finite number/,
  );
  assert.throws(
    () => decodeChangeSet({ ...base, upserts: [{ store: 'notes', record: 'not a record', version: 1 }] }),
    /record is not an object/,
  );
  assert.throws(
    () => decodeChangeSet({ ...base, upserts: [{ store: 'notes', record: { noId: true }, version: 1 }] }),
    /record has no id/,
  );
});

test('a tombstone whose id disagrees with the record it names is refused', () => {
  const base = { v: WIRE_VERSION, device: 'x', since: 0, until: 1, upserts: [] };

  // Aimed at a different record than the one it claims to be about: the
  // shape a hostile peer would use to delete something it was not asked to.
  assert.throws(
    () =>
      decodeChangeSet({
        ...base,
        deletions: [{ id: 'notes:innocent', store: 'notes', recordId: 'target', deletedAt: 1 }],
      }),
    /does not match its store and record/,
  );

  assert.throws(
    () => decodeChangeSet({ ...base, deletions: [{ id: 'notes:x', store: 'notes', deletedAt: 1 }] }),
    /no recordId/,
  );
});

test('a decoded record is a plain object, carrying no prototype from the wire', () => {
  const decoded = decodeChangeSet({
    v: WIRE_VERSION,
    device: 'x',
    since: 0,
    until: 1,
    deletions: [],
    upserts: [{ store: 'notes', record: JSON.parse('{"id":"n1","__proto__":{"polluted":true}}'), version: 1 }],
  });

  const record = decoded.upserts[0]?.record as unknown as Record<string, unknown>;
  assert.equal(record['id'], 'n1');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing leaked onto Object');
  // The weaker check passes even when the key has been assigned, because
  // assigning it changes only this object's prototype. This is the check
  // that fails if `__proto__` is copied through.
  assert.equal(Object.getPrototypeOf(record), Object.prototype, 'and not onto the record either');
  assert.equal(record['polluted'], undefined);
});
