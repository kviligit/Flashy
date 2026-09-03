/**
 * What a real sync round costs, at real collection sizes.
 *
 * The rest of the benchmarks measure the app. This one measures the thing
 * nobody had measured: chunking a full collection, encrypting every chunk
 * with hand-written NIP-44, and merging the result back on the far side.
 *
 * It matters because the cryptography here is written in JavaScript
 * bigints rather than called out to a native library. If a first sync of a
 * large collection costs minutes of frozen main thread on a phone, the
 * feature does not work, and "the unit tests pass" would never have said
 * so — they sync three notes.
 */

import { buildCollection } from './seed.mjs';
import { changesSince, MemoryDb, withChangeTracking } from '../dist/storage/index.js';
import { chunkChangeSet } from '../dist/sync/wire.js';
import { applyChanges } from '../dist/sync/merge.js';
import { DEFAULT_MAX_RECORDS_PER_PUSH } from '../dist/sync/engine.js';
import { LocalSigner } from '../dist/nostr/signer.js';
import { generateSecretKey, getPublicKey, bytesToHex } from '../dist/nostr/secp256k1.js';

const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = SIZES.length > 0 ? SIZES : [500, 2000, 10000];

const secretKey = generateSecretKey();
const signer = new LocalSigner(secretKey);
const pubkey = bytesToHex(getPublicKey(secretKey));

async function time(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

function row(label, ms, note = '') {
  const slow = ms > 3000 ? '  <-- SLOW' : '';
  console.log(`  ${String(label).padEnd(30)}${String(Math.round(ms)).padStart(6)} ms  ${note}${slow}`);
}

for (const notes of sizes) {
  const { db } = await buildCollection({ notes });
  const counts = {
    notes: (await db.notes.getAll()).length,
    cards: (await db.cards.getAll()).length,
    logs: (await db.reviewLogs.getAll()).length,
  };
  console.log(`\n=== ${counts.notes} notes / ${counts.cards} cards / ${counts.logs} logs ===`);

  // --- push -------------------------------------------------------------
  const feed = await time(() => changesSince(db, 0, Date.now()));
  row('read the whole change feed', feed.ms, `${feed.result.upserts.length} records`);

  const chunked = await time(async () => chunkChangeSet(feed.result, 'device-a'));
  row('chunk it', chunked.ms, `${chunked.result.chunks.length} chunks`);

  // The expensive half, and the one that is hand-written.
  const encrypted = await time(async () => {
    const out = [];
    for (const chunk of chunked.result.chunks) {
      out.push(await signer.encrypt(pubkey, JSON.stringify(chunk)));
    }
    return out;
  });
  row('encrypt every chunk', encrypted.ms, `${(encrypted.result.join('').length / 1024 / 1024).toFixed(1)} MB on the wire`);

  const decrypted = await time(async () => {
    const out = [];
    for (const payload of encrypted.result) out.push(await signer.decrypt(pubkey, payload));
    return out;
  });
  row('decrypt every chunk', decrypted.ms);

  // --- merge on the far side --------------------------------------------
  const peer = withChangeTracking(new MemoryDb());
  const merged = await time(() => applyChanges(peer, feed.result, { replay: false }));
  row('merge into an empty peer', merged.ms, `${merged.result.applied + merged.result.reviewLogs} applied`);

  const total =
    feed.ms + chunked.ms + encrypted.ms + decrypted.ms + merged.ms;
  row('— the whole collection at once', total);

  // What the app actually does. The engine caps a round, so a large first
  // sync is several rounds rather than one enormous one — which is the
  // difference between a few seconds of work and a phone that appears to
  // have hung, and between a few hundred events and a relay hanging up.
  const rounds = Math.ceil(
    (feed.result.upserts.length + feed.result.deletions.length) / DEFAULT_MAX_RECORDS_PER_PUSH,
  );
  const perRound = { ...feed.result };
  perRound.upserts = feed.result.upserts.slice(0, DEFAULT_MAX_RECORDS_PER_PUSH);
  perRound.deletions = [];

  const roundChunks = await time(async () => chunkChangeSet(perRound, 'device-a'));
  const roundEncrypt = await time(async () => {
    let bytes = 0;
    for (const chunk of roundChunks.result.chunks) {
      bytes += (await signer.encrypt(pubkey, JSON.stringify(chunk))).length;
    }
    return bytes;
  });
  row(
    '— one round, as the app sends it',
    roundChunks.ms + roundEncrypt.ms,
    `${roundChunks.result.chunks.length} events, ${(roundEncrypt.result / 1024 / 1024).toFixed(1)} MB, ${rounds} round${rounds === 1 ? '' : 's'} to drain`,
  );
}
