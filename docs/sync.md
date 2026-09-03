# Syncing

**Status: the engine and the protocol layer are built and tested; the relay
client is not.** Two devices can already synchronise completely over the
loopback transport. What is missing is the part that puts bytes on a wire.

| Piece | State |
|---|---|
| Tombstones and change feed | Done (`src/storage/`) |
| Merge, replay, watermarks | Done (`src/sync/`) |
| Loopback transport | Done — two devices converge in tests |
| BIP-340 Schnorr signatures | Done, matches all 19 official vectors |
| NIP-44 v2 encryption | Done, matches all official vectors |
| NIP-01 events | Done |
| Relay client (WebSocket) | **Not built** |
| Nostr transport | **Not built** |
| Key management and UI | **Not built** |

Nothing in the app imports any of it yet: sync is inert until there is a
transport and a way to configure it.

One thing cannot be done from the development environment this was built
in: **no relay is reachable from it**, so none of the nostr code has ever
spoken to a real relay. The cryptography is verified against the
specifications' own vectors, which is strong evidence, but interoperability
with actual relay software is unproven.

## Why any of this exists now

Almost everything sync needs can be bolted on afterwards. Two things
cannot:

1. **Deletions.** If a record is simply removed, a peer cannot tell "you
   deleted this" from "you have never seen this", so deleted cards come
   back from the dead on the next exchange. Recovering that after the fact
   is impossible — the evidence is gone. So deletions are recorded from the
   start.
2. **Change detection.** Working out what changed since a given moment
   requires a version on every record and an index to scan it by. Adding
   the index later is easy; recovering the modification times of records
   written before it existed is not.

Everything else — identity, transport, encryption, conflict resolution — is
deliberately absent, because those decisions depend on the transport and
cost nothing to defer.

## What is in place

### Tombstones

`src/storage/tracking.ts` wraps any `Db` so that every deletion from a
content store also writes a `Deletion` record:

```ts
{ id: 'cards:abc123', store: 'cards', recordId: 'abc123', deletedAt: 1750000000000 }
```

It is a decorator, not something call sites opt into. "Remember to also
write a tombstone" is exactly the rule that gets forgotten at the eighth
call site, and a missed tombstone is an invisible bug that only shows up as
a resurrected card months later. No feature code mentions tombstones at all.

`clear()` deliberately records nothing: it is a restore or a reset, not a
series of user deletions, and tombstoning a whole collection would instruct
a peer to delete its own copy.

### A change feed

`src/storage/changes.ts` answers "what changed since T":

```ts
const changes = await changesSince(db, lastSyncedAt);
// { since, until, upserts: [{ store, record, version }], deletions: [...] }
```

The bound is exclusive and `until` is meant to be fed back in as the next
`since`, so a feed cannot replay itself. Every content store indexes the
field the feed scans (`modified`, or `reviewedAt` for review logs), so this
is a range scan rather than a full read — and a conformance check asserts
those indexes really exist in IndexedDB, because the in-memory backend
would happily pretend they do.

### A device identity

`Meta.deviceId` is a UUID minted when the collection is created. Nothing
reads it yet. It exists so that changes written from today onward can be
attributed to an origin once there is something to attribute them to.

## The merge policy, as built

Implemented in `src/sync/merge.ts`:

- **Review logs are append-only.** Two devices studying the same card
  produce two genuine answers, and the truth is the union. A log is never
  overwritten and never conflicts. After merging, the card's scheduling
  state is recomputed by replaying the union through `src/fsrs/` —
  `src/sync/replay.ts`. Replay runs with fuzz disabled so both devices
  reach byte-identical state; with fuzz they would disagree forever.
- **Media is content-addressed**, so identical ids mean identical bytes.
- **Everything else is last-write-wins** on `modified`, with ties broken by
  a canonical, key-order-independent serialisation. That tiebreak matters
  more than it looks: an earlier version compared record *ids*, which are
  identical for the same record, so each device kept its own copy and they
  disagreed permanently.
- **A tombstone wins only if the record has not changed since**, because an
  edit after a delete is the later intention and resurrecting is the safer
  error.

Upserts are applied before deletions; the other order lets a stale upsert
resurrect something the same change set deletes.

### A peer's content is untrusted, even when the peer is authenticated

A signature says who sent something, not that what they sent is true. A
compromised second device, or a relay that alters what it relays, produces
exactly the same shape of data as an honest peer. A security audit
demonstrated three attacks against an earlier version of the merge that
took a peer at its word:

- **A declared version won every conflict.** The comparison used the
  `version` field of the *envelope* rather than re-reading it from the
  record, so `Number.MAX_SAFE_INTEGER` overwrote anything, permanently. The
  version is now re-derived from the record itself.
- **"Append-only" review logs could be deleted.** A tombstone for a review
  log was honoured like any other, erasing study that genuinely happened —
  and the replay that followed silently recomputed the card's schedule from
  the truncated history. A merge now refuses to delete a review log at all,
  which is what makes the append-only claim true against a hostile peer
  rather than merely true of honest ones. Local deletion still works: undo
  goes through the store directly, not through a merge.
- **Nonsense values reached the scheduler.** Ratings and elapsed days were
  passed to replay uncast and unchecked, so `Infinity` or a rating of 99
  could drive a card's memory anywhere. Both are range-checked on arrival,
  along with every other number in the record.

Records dated more than a day into the future are refused outright — enough
slack for clocks that disagree, not enough for a record dated next century
to win every conflict for the rest of the collection's life.

### A caveat on clocks

Last-write-wins compares wall-clock timestamps from different devices. A
device with a badly wrong clock will win or lose every conflict. There is no
mitigation in place beyond the deterministic tiebreak, which at least
guarantees the two devices agree on *which* version won.

The push watermark is the local clock, so a record written with a timestamp
older than the last push is never offered to a peer. Real code always uses
`Date.now()` and is naturally monotonic; anything that sets timestamps by
hand needs to keep that in mind.

### Transport

`ChangeSet` is a plain serialisable object, which is the entire point of
the shape. A transport needs to answer two questions:

- given a watermark, hand me a `ChangeSet` (pull);
- here is a `ChangeSet`, take it (push).

That is a two-method interface. Anything satisfying it works: a file on a
USB stick, a WebDAV folder, a server, a relay.

### The nostr layer, as built

`src/nostr/` holds the protocol, and knows nothing about flashcards:

- `secp256k1.ts` — BIP-340 Schnorr, hand-written because this project
  cannot install packages and no browser API provides it. Verified against
  all 19 official vectors. **It is not constant time**, and that is
  documented at the top of the file rather than buried: bigint arithmetic
  leaks timing information about the secret key. The exported surface
  mirrors `@noble/curves` so it can be swapped out wholesale.
- `chacha20.ts` — RFC 8439, needed by NIP-44.
- `nip44.ts` — v2 encryption, verified against the official vectors.
- `event.ts` — NIP-01 events, with ids re-derived on verification rather
  than trusted.

### The transport, as built

`src/sync/nostr-transport.ts` implements `SyncTransport` over relays.

A change set is chunked, each chunk is encrypted with NIP-44 to the
user's **own** key, and each is published as one event. The user's other
devices ask their relays for events by that key, decrypt them, and merge.
The relay carries ciphertext it cannot read.

Encrypting to yourself is the point, not a placeholder. A flashcard
collection is a detailed record of what someone is studying, what they
keep getting wrong, and when they are awake. Publishing that in the clear
on someone else's server would be indefensible.

**What a relay still learns**, stated plainly because nothing here hides
it: that this pubkey syncs, from how many devices, how often, and roughly
how much data. That is inherent to using relays. Running your own is the
only way to change it.

Decisions taken, each argued in the source next to the code it governs:

- **Kind 9078**, a regular event, so relays store it rather than
  replacing it — a change feed is a log, and a replaceable kind would
  keep only the newest chunk. Relays may refuse kinds they do not
  recognise; that surfaces as a rejected publish carrying the relay's own
  reason, not as silence.
- **Seconds, with a day of lookback.** NIP-01 filters on `created_at`, in
  seconds; the change feed's watermarks are in milliseconds. Rather than
  keep two clocks, the query window is widened by a day — the same
  allowance the merge layer makes for clock skew — and cut precisely on
  the client. Re-reading a day of events costs bandwidth, not
  correctness: applying a change twice is a no-op by construction.
- **Chunks are independent change sets**, not fragments. A device applies
  whichever arrived and picks the rest up next round. No partial state,
  nothing to reassemble, and an unreliable relay is merely slow.
- **A device ignores its own events**, by a device-id tag, so it does not
  merge its own changes back into itself. Two devices share one key, so
  the author field cannot do this.

### Records that do not fit

NIP-44 caps a plaintext at 65535 bytes, and chunking cannot split a
single record. A record larger than one chunk — in practice, an image —
is left behind and **reported**: `push` records it, and the sync screen
says how many files did not go. A sync that silently drops an image is
worse than one that says it did.

Carrying media properly needs a blob transport (NIP-96, Blossom) rather
than more chunking; splitting a 5MB image across eighty events would
abuse relays that are doing us a favour. The filter is one clearly-named
place in `wire.ts`, so adding that later is a local change.

### The wire format

`src/sync/wire.ts` exists because `JSON.stringify` renders an
`ArrayBuffer` as `{}` — silently, with no error. Left alone, every image
would arrive as an empty object and overwrite the real one. Binary is
tagged and base64-encoded on the way out, restored on the way in, by a
general walk rather than a special case for `media.data`.

The decoder treats a peer as a stranger even though the payload is
authenticated. The relay cannot forge it, but a peer running different
code — a future version, a half-finished one, someone else's
implementation — is the case that actually corrupts a collection. Unknown
stores, non-finite numbers, records without ids, tombstones whose id
disagrees with the record they name, and `__proto__` keys are all refused
before the merge layer sees them.

### Keys

`src/nostr/signer.ts` is NIP-07's interface, deliberately.

- `Nip07Signer` delegates to a browser extension. The key never enters
  the page, so a script injected into the page cannot steal it. This is
  the right answer wherever an extension exists.
- `LocalSigner` holds the key in the page and stores it in
  `localStorage`. It is the only option on iOS Safari, and its weakness
  is the obvious one: anything that can run script in this origin can
  read the key. The settings screen says so in those words.

An extension without NIP-44 support is a hard failure rather than a
fallback. Falling back to an unencrypted sync would be catastrophic;
falling back to a local key would defeat the reason for using the
extension.

The identity lives in `localStorage`, **not** in the collection. The
collection is what gets exported, backed up and synced; an identity
inside it would ride along in all three, so a backup handed to someone
else would carry the key that unlocks the sync history. Keeping it beside
the collection makes export safe by construction rather than by
remembering to filter.

### What a round actually costs

Measured by `node bench/sync.mjs`, against the in-memory backend on a
desktop. A phone is several times slower, which is the reason the numbers
mattered enough to take.

| Collection | Records | Whole thing at once | One round, as sent |
|---|---|---|---|
| 500 notes | 4,286 | 0.5s, 57 events, 3.5MB | same — it fits in one round |
| 2,000 notes | 17,366 | 1.6s, 229 events, 14MB | same |
| 10,000 notes | 87,034 | **8.1s, 1,147 events, 72MB** | 1.5s, 299 events, 19MB, 5 rounds |

The first-sync column is why both halves of a round are bounded. Publishing
1,147 events and 72MB to a stranger's relay in one go is an unreasonable
thing to do to it, and eight seconds of hand-written elliptic-curve
arithmetic on a phone is an app that appears to have hung. Twenty thousand
records a round keeps a round to a second or two and a few hundred events;
the rest follows next round.

The **push** budget lives in `syncWith`, not in the transport, because the
watermark it has to keep honest lives there too. A round that sent only
part of what was waiting may only claim to have pushed as far as it got —
otherwise the remainder falls below an exclusive lower bound and is never
offered again, which is exactly the permanent loss the pull side had
before the audit found it. The cut is made at a *version*, not at a record
count, because a timestamp is the only thing the next round can be told;
records sharing the cut version travel together, so a single millisecond's
worth of edits is never split.

**Where the bytes go.** 87,034 records is 72MB, about 825 bytes each, and
review logs dominate: each one carries a complete snapshot of the
pre-answer card so undo can be an exact restore. Only the *earliest* log
per card is actually used as the replay origin, so most of those snapshots
are dead weight on the wire — but which log is earliest depends on what
the receiving device already has, so dropping them is a correctness
question rather than a compression one, and it is not a change to make
casually.

### Still to do

- `pruneTombstones()` exists but cannot run safely: it needs per-device
  watermarks — proof every device has seen a tombstone — which the
  current single watermark per account does not give.
- Media, per the note above.
- No reconnection or live subscription. A round opens sockets, runs, and
  closes them. If live updates are ever wanted, that is a change to
  `src/sync/run.ts` alone.

## Where the seams are

| Concern | Lives in | Would a sync engine touch it? |
|---|---|---|
| Reading and writing records | `src/storage/types.ts` (`Db`, `Store`) | Uses it, unchanged |
| Recording deletions | `src/storage/tracking.ts` | Reads tombstones |
| Detecting changes | `src/storage/changes.ts` | This is the entry point |
| Device identity | `Meta.deviceId` | Reads it |
| Scheduling state | `src/scheduler/`, `src/fsrs/` | Only to replay merged review logs |
| UI | `src/features/` | Nothing, beyond a status indicator |

The intended shape is a new `src/sync/` directory that depends on
`src/storage/` and `src/fsrs/` and nothing else. No existing layer should
need to change to accommodate it.

## Is this ready to merge into main?

**No, and not because of a trade-off someone can weigh. It is blocked.**

`src/nostr/secp256k1.ts`, `chacha20.ts` and `nip44.ts` are hand-written
implementations of BIP-340, RFC 8439 and NIP-44. Writing them was the
wrong call. "Never roll your own crypto" is not a guideline about effort
or confidence; it exists because implementation correctness is the part
you *can* test, and it is not the part that gets people hurt. What gets
people hurt is timing, fault behaviour, edge cases in the group
arithmetic, and the things nobody thinks to test — and no amount of
passing the specification's own vectors speaks to any of that.

Which is worth being precise about, because the evidence here looks
stronger than it is:

- All 19 official BIP-340 vectors pass, in both directions.
- Every NIP-44 vector passes; all 262 single-bit flips of a payload are
  rejected; authenticate-then-decrypt is correctly ordered.
- ChaCha20 is byte-identical to a known-good implementation across 25
  random key/nonce/length triples.
- Two independent adversarial audits found no flaw in the primitives.

**None of that makes this safe to ship.** It is evidence the code
computes the right function on the inputs it was given. It says nothing
about `secp256k1.ts` being non-constant-time, which it is, and which is
documented at the top of the file — JavaScript bigint arithmetic leaks
timing correlated with the secret key, and there is no way to fix that in
portable JavaScript. It says nothing about what has not been thought of.

### Why it was written this way, and why that was not a good enough reason

The environment cannot reach a package registry. Re-verified today:
`registry.npmjs.org` returns 403 even bypassing the proxy, and
jsdelivr, unpkg, esm.sh and raw.githubusercontent.com are all refused at
the CONNECT stage — so neither installing nor vendoring an audited
library is possible from here.

That is a real constraint, and the correct response to it was to **not
build the feature**, or to build everything except the cryptography and
leave the primitives as an unimplemented seam. Instead the constraint was
treated as a reason to write the primitives by hand, which is exactly the
reasoning the rule exists to interrupt.

The rest of the sync layer does not have this problem. The change feed,
the merge policy, the wire codec, the watermarks, the transport, the
relay client and the UI are all ordinary code, tested and audited, and
none of it needs to be rewritten.

### What unblocks it

Replace the three files with [`@noble/curves`](https://github.com/paulmillr/noble-curves)
and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) —
audited, widely used, and what every other nostr client depends on.

```
npm install @noble/curves @noble/ciphers
```

Then delete `src/nostr/secp256k1.ts`, `chacha20.ts`, and the primitive
half of `nip44.ts`, and point the remaining code at:

| Used here | Replace with |
|---|---|
| `schnorrSign(msg, sk)` / `schnorrVerify(sig, msg, pk)` | `schnorr.sign` / `schnorr.verify` |
| `getPublicKey(sk)` | `schnorr.getPublicKey` |
| `sharedSecret(sk, pk)` | `secp256k1.getSharedSecret` |
| `chacha20(key, nonce, data)` | `chacha20` from `@noble/ciphers/chacha` |
| `sha256`, `taggedHash` | `@noble/hashes/sha256` (or keep WebCrypto) |

The signatures are close but not identical, so expect a thin adapter
rather than a find-and-replace. Everything above the primitives —
`event.ts`, `nip19.ts`, `signer.ts`, all of `src/sync/` — is unaffected,
and the existing vector tests become a conformance check on the swap.

Alternatively, on desktop, use a NIP-07 extension: `Nip07Signer` already
delegates signing *and* NIP-44 to the extension, so none of the
hand-written code runs on that path. It does not help on iOS, which is
this app's main target and has no extensions.

Until one of those happens, this branch stays unmerged and the feature
stays unshipped. The decision is not the owner's to weigh, because the
thing being weighed is not knowable from here.

