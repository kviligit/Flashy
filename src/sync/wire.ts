/**
 * Turning a `ChangeSet` into something that fits through a relay.
 *
 * Three problems, all of them the transport's rather than the merge
 * layer's, which is why they are solved here and not there:
 *
 * 1. JSON cannot carry an `ArrayBuffer`. `JSON.stringify` renders one as
 *    `{}` — silently, with no error — so a media file would arrive as an
 *    empty object and overwrite the real one. Binary is tagged and
 *    base64-encoded on the way out and restored on the way in.
 * 2. NIP-44 caps a plaintext at 65535 bytes. A change set from a real
 *    collection is far larger than that, so it is cut into chunks.
 * 3. A single record can exceed the cap on its own. Chunking cannot help
 *    there, so those records are left behind and *counted*, because a
 *    sync that silently drops an image is worse than one that says it did.
 *
 * Chunks are deliberately independent. Each is a complete, valid change
 * set over a subset of the records, so a receiver applies whichever ones
 * arrive without waiting for the rest and without holding partial state.
 * Merging is idempotent and order-independent, which is what makes that
 * safe — the missing chunk arrives on a later round and applies then.
 */

import { fromBase64, toBase64 } from '../domain/media.js';
import type { Deletion, Entity } from '../domain/types.js';
import { CONTENT_STORES, type ContentStore } from '../storage/index.js';
import type { ChangeSet, Upsert } from '../storage/index.js';

/**
 * The largest plaintext this app's NIP-44 implementation handles.
 *
 * Not the spec's limit: NIP-44 v2 allows up to 4294967295 bytes, using a
 * six-byte length prefix above 65536. This implementation only writes the
 * two-byte form, so it can neither produce nor read anything larger. That
 * is a compatibility limit of ours, not a property of the protocol, and it
 * is written down as such so nobody later "fixes" a chunk size against a
 * number that was never in the specification.
 */
export const MAX_PLAINTEXT_BYTES = 65_535;

/**
 * How large one chunk's JSON is allowed to be.
 *
 * Below the NIP-44 cap with room to spare: the padding scheme rounds a
 * plaintext up to the next power-of-two-ish boundary, and the envelope
 * fields cost a few hundred bytes on top of the records.
 */
export const MAX_CHUNK_BYTES = 48 * 1024;

/** The wire format version, so an old device can recognise a new one. */
export const WIRE_VERSION = 1;

/** How a tagged binary value appears on the wire. */
interface WireBinary {
  $bin: string;
}

/** One chunk, as it appears inside the encrypted payload. */
export interface WireChangeSet {
  v: number;
  /** The device that produced it, so a device can ignore its own echo. */
  device: string;
  since: number;
  until: number;
  /** Position in the batch. Diagnostic only: chunks apply independently. */
  seq: number;
  of: number;
  upserts: WireUpsert[];
  deletions: Deletion[];
}

export interface WireUpsert {
  store: ContentStore;
  version: number;
  record: unknown;
}

/** Records too large to send, reported rather than dropped in silence. */
export interface Oversized {
  store: ContentStore;
  id: string;
  bytes: number;
}

export interface ChunkResult {
  chunks: WireChangeSet[];
  oversized: Oversized[];
}

const CONTENT_STORE_SET = new Set<string>(CONTENT_STORES);

function isContentStore(value: unknown): value is ContentStore {
  return typeof value === 'string' && CONTENT_STORE_SET.has(value);
}

/**
 * Replace binary with a tagged base64 string, everywhere it appears.
 *
 * Written as a general walk rather than a special case for `media.data`.
 * The specific case would be shorter and would break the first time a
 * record grows a second binary field, which is exactly the kind of
 * silent, data-losing break this whole module exists to prevent.
 */
export function encodeBinary(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { $bin: toBase64(value) } satisfies WireBinary;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    // slice() on a SharedArrayBuffer gives back a SharedArrayBuffer, which
    // is not what the rest of the app means by binary; copying through a
    // fresh Uint8Array normalises both cases to a plain ArrayBuffer.
    const copy = new Uint8Array(
      new Uint8Array(view.buffer as ArrayBufferLike, view.byteOffset, view.byteLength),
    );
    return { $bin: toBase64(copy.buffer as ArrayBuffer) } satisfies WireBinary;
  }
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeBinary(item);
    }
    return out;
  }
  return value;
}

/** The inverse. A malformed `$bin` throws rather than yielding empty bytes. */
export function decodeBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const tagged = record['$bin'];
    if (typeof tagged === 'string' && Object.keys(record).length === 1) {
      // A relay cannot forge this — the payload is authenticated — but a
      // buggy peer can, and an ArrayBuffer of the wrong length is worse
      // than an error.
      return fromBase64(tagged);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      // `out['__proto__'] = x` reassigns the object's prototype rather than
      // adding a property. JSON.parse happily produces that key, so a peer
      // could hand us a record whose prototype it chose. No field in this
      // app is called that, so dropping it costs nothing.
      if (key === '__proto__') continue;
      out[key] = decodeBinary(item);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * A lower bound on a record's encoded size, computed without encoding it.
 *
 * Only binary is measured, because binary is the only thing that gets
 * large: base64 turns three bytes into four, so the raw length is already
 * a lower bound on what the encoded record will cost. Text fields are
 * ignored here and caught by the exact check afterwards.
 */
function rawByteEstimate(value: unknown, depth = 0): number {
  if (depth > 8) return 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += rawByteEstimate(item, depth + 1);
    return total;
  }
  if (value && typeof value === 'object') {
    let total = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      total += rawByteEstimate(item, depth + 1);
    }
    return total;
  }
  return 0;
}

/**
 * Cut a change set into independently applicable chunks.
 *
 * Deletions are packed first: they are tiny, and a tombstone that arrives
 * a round later than the record it removes means a deleted card briefly
 * reappears on the other device. Cheap to avoid, confusing to explain.
 */
export function chunkChangeSet(
  changes: ChangeSet,
  device: string,
  maxBytes = MAX_CHUNK_BYTES,
): ChunkResult {
  const oversized: Oversized[] = [];
  const overhead = byteLength({
    v: WIRE_VERSION,
    device,
    since: changes.since,
    until: changes.until,
    seq: 0,
    of: 0,
    upserts: [],
    deletions: [],
  });
  // Room left for records once the envelope has taken its share. A limit
  // so small that nothing fits would loop forever, so it is floored.
  const budget = Math.max(1024, maxBytes - overhead);

  type Item =
    | { kind: 'deletion'; value: Deletion; bytes: number }
    | { kind: 'upsert'; value: WireUpsert; bytes: number };

  const items: Item[] = [];

  for (const deletion of changes.deletions) {
    items.push({ kind: 'deletion', value: deletion, bytes: byteLength(deletion) + 1 });
  }

  for (const upsert of changes.upserts) {
    // Cheap rejection first. Base64-encoding a 32MB image to discover it is
    // 43MB and therefore too large costs three seconds of frozen UI thread,
    // and the raw byte count already answers the question: base64 only ever
    // grows a record, so anything whose binary alone exceeds the budget
    // cannot fit however it is encoded.
    const raw = rawByteEstimate(upsert.record);
    if (raw > budget) {
      oversized.push({ store: upsert.store, id: String(upsert.record.id), bytes: raw });
      continue;
    }

    const wire: WireUpsert = {
      store: upsert.store,
      version: upsert.version,
      record: encodeBinary(upsert.record),
    };
    const bytes = byteLength(wire) + 1;
    if (bytes > budget) {
      oversized.push({ store: upsert.store, id: String(upsert.record.id), bytes });
      continue;
    }
    items.push({ kind: 'upsert', value: wire, bytes });
  }

  const chunks: WireChangeSet[] = [];
  let current: WireChangeSet | null = null;
  let used = 0;

  const start = (): WireChangeSet => ({
    v: WIRE_VERSION,
    device,
    since: changes.since,
    until: changes.until,
    seq: chunks.length,
    of: 0,
    upserts: [],
    deletions: [],
  });

  for (const item of items) {
    if (!current || used + item.bytes > budget) {
      if (current) chunks.push(current);
      current = start();
      used = 0;
    }
    if (item.kind === 'deletion') current.deletions.push(item.value);
    else current.upserts.push(item.value);
    used += item.bytes;
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) chunk.of = chunks.length;
  return { chunks, oversized };
}

/**
 * Read a chunk back, refusing anything that is not one.
 *
 * The payload is authenticated, so this is not defending against a relay.
 * It is defending against a peer running different code — a future
 * version, a half-finished one, or someone else's implementation
 * entirely — which is the case that actually corrupts a collection.
 * Anything unrecognised is rejected here rather than being handed to the
 * merge layer to interpret.
 */
export function decodeChangeSet(value: unknown): ChangeSet & { device: string } {
  if (!value || typeof value !== 'object') throw new Error('payload is not an object');
  const wire = value as Record<string, unknown>;

  if (wire['v'] !== WIRE_VERSION) {
    throw new Error(`unsupported wire version ${String(wire['v'])}`);
  }
  const device = typeof wire['device'] === 'string' ? wire['device'] : '';
  const since = timestamp(wire['since'], 'since');
  const until = timestamp(wire['until'], 'until');

  const upserts: Upsert[] = [];
  for (const raw of expectArray(wire['upserts'], 'upserts')) {
    if (!raw || typeof raw !== 'object') throw new Error('upsert is not an object');
    const item = raw as Record<string, unknown>;
    if (!isContentStore(item['store'])) {
      throw new Error(`unknown store ${JSON.stringify(item['store'])}`);
    }
    const record = decodeBinary(item['record']);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('upsert record is not an object');
    }
    if (typeof (record as { id?: unknown }).id !== 'string') {
      throw new Error('upsert record has no id');
    }
    upserts.push({
      store: item['store'],
      record: record as Entity,
      version: finite(item['version'], 'version'),
    });
  }

  const deletions: Deletion[] = [];
  for (const raw of expectArray(wire['deletions'], 'deletions')) {
    if (!raw || typeof raw !== 'object') throw new Error('deletion is not an object');
    const item = raw as Record<string, unknown>;
    if (!isContentStore(item['store'])) {
      throw new Error(`unknown store ${JSON.stringify(item['store'])}`);
    }
    if (typeof item['id'] !== 'string') throw new Error('deletion has no id');
    if (typeof item['recordId'] !== 'string') throw new Error('deletion has no recordId');
    // The id is "<store>:<recordId>" by construction. A peer that sends
    // the two disagreeing is either buggy or aiming a tombstone at a
    // record other than the one it names, and neither is worth applying.
    if (item['id'] !== `${item['store']}:${item['recordId']}`) {
      throw new Error('deletion id does not match its store and record');
    }
    deletions.push({
      id: item['id'],
      store: item['store'],
      recordId: item['recordId'],
      deletedAt: finite(item['deletedAt'], 'deletedAt'),
    });
  }

  return { since, until, upserts, deletions, device };
}

function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is not a finite number`);
  }
  return value;
}

/**
 * The year 2000, and roughly the year 2500, in epoch milliseconds.
 *
 * A watermark is a number this device will later compare against its own
 * clock, so a peer that sends 1e308 is not sending a timestamp — it is
 * setting a bound nothing will ever exceed. The transport clamps as well;
 * this refuses the payload outright, because a value outside these bounds
 * is not a clock reading under any interpretation.
 */
export const MIN_TIMESTAMP_MS = 946_684_800_000;
export const MAX_TIMESTAMP_MS = 16_725_225_600_000;

function timestamp(value: unknown, name: string): number {
  const number = finite(value, name);
  if (number < 0 || number > MAX_TIMESTAMP_MS) {
    throw new Error(`${name} is not a plausible timestamp`);
  }
  return number;
}
