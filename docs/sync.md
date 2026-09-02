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

### What a nostr transport still needs

- The user's key pair is the identity; `deviceId` distinguishes their
  devices from each other.
- A `ChangeSet` becomes one or more events, encrypted to the user's own
  key. **Collection contents must never be published in the clear** — a
  flashcard deck is a detailed record of what someone is learning, and
  relays are public infrastructure.
- Relays are untrusted and unordered, so events need to carry the same
  watermark information the change feed already produces, and the merge has
  to be idempotent and order-independent. Last-write-wins on `modified`
  plus append-only review logs satisfies that.
- Relay message size limits will force large collections to be chunked;
  the change feed's `since`/`until` window is the natural chunk boundary.
- `pruneTombstones()` exists so tombstones do not accumulate forever, but
  it can only run once every device is known to have seen them — which
  needs per-device watermarks that do not exist yet.

None of this constrains the app. It is one implementation of a two-method
interface over a shape that already exists.

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
