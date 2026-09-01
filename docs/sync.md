# Notes towards syncing

**Nothing here is implemented.** There is no sync engine, no transport and
no merge policy. This describes the seam that exists so one can be added
without disturbing the rest of the app, and records the decisions that
would otherwise have to be unpicked later.

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

## What is not in place, and what it would take

### Merge policy

There is none. The natural starting point is last-write-wins per record
using the existing `modified` field, which is adequate for everything here
except one case worth thinking about properly: **review logs are
append-only and must never be merged by overwriting**. Two devices studying
the same card produce two genuine logs; the correct result is both, in time
order, with the card's scheduling state recomputed from the merged history.
That is the one piece of real domain logic a sync engine needs, and
`ReviewLog.snapshot` plus a replay through `src/fsrs/` is enough to do it.

### Transport

`ChangeSet` is a plain serialisable object, which is the entire point of
the shape. A transport needs to answer two questions:

- given a watermark, hand me a `ChangeSet` (pull);
- here is a `ChangeSet`, take it (push).

That is a two-method interface. Anything satisfying it works: a file on a
USB stick, a WebDAV folder, a server, a relay.

### If the transport is nostr

Sketching this only to check the seam is the right shape, not to commit to
it:

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
