# Adversarial audit — `claude/nostr-sync` cross-device sync layer

Repository: `/home/user/Flashy`, branch `claude/nostr-sync` at `d7a76e8`.
Date: 2026-09-02.

---

## 1. Method

**Working copy.** Partway through the audit another process checked `main` out in
`/home/user/Flashy` and committed to it. To get a stable, genuinely read-only target I cloned
the repository to
`/tmp/claude-0/-home-user-Flashy/b37cd2a4-4c6a-5271-9d0b-7c888d7a0324/scratchpad/audit` and
checked out `claude/nostr-sync` there. **No file in `/home/user/Flashy` was modified.** All
line references below are to that branch and are identical in both trees.

**Baseline.** `npm run build` clean; `npm test` → **384 passing, 0 failing**, in both the
original tree and the clone. Everything below was found against that green build.

**Attack scripts.** Written against the *compiled* `dist/`, run with `node 22`, in
`.../scratchpad/atk/`. Browser findings used the Playwright/Chromium already on the box
(`/opt/node22/lib/node_modules/playwright`) via my own scripts; `tests/e2e.mjs` was not
touched. Specifications were read from `/home/user/nips/01.md`, `19.md`, `44.md`.

### Verified by execution

| # | What | Script |
|---|---|---|
| E1 | Watermark poisoning halts sync permanently | `atk/a1-watermark.mjs` |
| E2 | A withheld/reordered event is lost permanently | `atk/a2-withhold.mjs`, `a2b.mjs` |
| E3 | Unvalidated `snapshot` on a review log throws inside `applyChanges`, after the log is persisted | `atk/a3-poisonlog.mjs` |
| E4 | Unvalidated `snapshot` + `reviewedAt` rewrite a card's entire schedule | `atk/a3b-snapshot.mjs` |
| E5 | Forced signature verification, ~7.2 ms each, uncapped | `atk/d1-relaydos.mjs` |
| E6 | The shipped CSP blocks every relay WebSocket (real Chromium, real app) | `atk/csp/run.mjs`, `run2.mjs` |
| E7 | `decodeChangeSet`/merge accept arbitrary record shapes; media substitution + first-writer-wins poisoning; prototype pollution blocked | `atk/a5-wire.mjs` |
| E8 | Record resurrection; 24 h "frozen record" that silently eats local edits | `atk/a6-merge.mjs` |
| E9 | A relay that ACKs and discards makes pushed data vanish forever | `atk/a7-ack.mjs` |
| E10 | A round with every relay down reports `ok:true` / "Already up to date." | `atk/a8-silent.mjs` |
| E11 | 32 MB media = 3 s synchronous main-thread freeze inside `chunkChangeSet` | `atk/d2-chunkdos.mjs` |
| E12 | `pull` holds the union of every event; ~1 GB / ~56 s extrapolated at the client's own cap | `atk/d3-pullmem.mjs` |
| E13 | secp256k1 pubkey derivation + ECDH vs node's `createECDH`; ChaCha20 vs node's `chacha20`; `hexToBytes` leniency | `atk/c1-crypto.mjs` |
| E14 | bech32 injectivity (3000 keys) and malleability (1805 mutations) | `atk/c2-bech32.mjs` |
| E15 | NIP-44 key schedule vs node HKDF; all 262 single-bit flips rejected; nonce uniqueness; padding vs spec pseudocode for all 65535 lengths | `atk/c3-nip44.mjs`, `c4-vectors.mjs` |
| E16 | All 19 official BIP-340 vectors + adversarial `s`/`r`/pubkey edge cases | `atk/c5-bip340.mjs` |

### Established by reading only

Export contents (`src/collection/io.ts:81-106`), service-worker interaction, NIP-01
serialisation escaping rules, traffic-analysis/metadata exposure, the `Nip07Signer` pubkey
path, and every claim-versus-code comparison in §4.

---

## 2. Findings

### CRITICAL

---

#### C1 — A single peer chunk permanently and silently kills sync on every other device

`src/sync/nostr-transport.ts:174-212`, `src/sync/engine.ts:64`, `src/sync/wire.ts:250-251`

`decodeChangeSet` accepts any finite number for `until`. `pull` takes the maximum across
chunks and returns it; `syncWith` writes it straight into `SyncState.lastPulledAt` with no
clamp, no skew allowance and no sanity bound. Every later round then filters with
`chunk.until <= since` and discards everything.

**Demonstrated** (`a1-watermark.mjs`): one chunk with `until: 1e308` sets
`lastPulledAt: 1e+308`. A subsequent honest chunk carrying a real deck is fetched, verified,
decrypted, decoded — and dropped. The device reports "Already up to date." forever.

```
round 1 lastPulledAt = 1e+308
round 2 pulled       = {"applied":0,...}
deck present?        = null
=> device is permanently deaf: true
```

This needs no attacker. A second device whose clock is wrong sets
`until = changesSince(..., now)` from its own `Date.now()` (`src/storage/changes.ts:65`).
One phone with its clock set to 2099 permanently deafens the entire fleet. There is **no
recovery path in the UI**: `resetSyncState` exists (`engine.ts:81`) but nothing in
`src/features/` calls it, `syncState` is not in the export (`io.ts:82-91`) so restoring a
backup does not clear it, and only minting a new identity (which changes `peerId`) escapes.

**Fix.** Clamp on receipt: `lastPulledAt = Math.min(incoming.until, now + MAX_CLOCK_SKEW_MS)`,
and reject a chunk whose `until` is not in a plausible epoch-millisecond range in
`decodeChangeSet`. Separately, expose a "re-sync from scratch" button that calls
`resetSyncState`.

---

#### C2 — One round of relay reordering or withholding destroys data permanently

`src/sync/nostr-transport.ts:201` (`if (chunk.until <= since) continue;`), `engine.ts:64`

The watermark advances to the **highest** `until` seen in a round, not to a value every event
below which has been observed. Anything the relay did not hand over in that round is below the
new watermark for ever after.

**Demonstrated** (`a2-withhold.mjs`, `a2b.mjs`): the relay serves event B (`until = T+60s`)
in round 1 and both A (`until = T`) and B in round 2. `a2b.mjs` confirms the client *receives
and verifies both events* in round 2 and then keeps zero upserts. deck-A never arrives, in
round 2 or any later round, and nothing is reported.

```
relay handed the client 2 verified events for the round-2 filter
transport kept 0 upserts out of those 2 events
after 3 more rounds, deck-A present: false
```

This is not only a hostile relay. `Relay.query` resolves with **partial** results on both
timeout (`relay.ts:256`) and socket close (`relay.ts:322`), and `pull` swallows a failed relay
and continues (`nostr-transport.ts:159-167`). Any dropped connection mid-round silently
discards whatever had not arrived yet.

The 24 h `LOOKBACK_SECONDS` window does nothing here: it widens the relay filter so the events
*are* re-fetched, and then line 201 throws them away. The comment at
`nostr-transport.ts:31-37` claiming "re-fetching a day of events costs bandwidth rather than
correctness" is false.

**Fix.** Do not use a scalar high-water mark as the completeness test. Either (a) keep the
watermark at `since` unless the round terminated on a real EOSE from every relay, and apply the
same 24 h lookback slack to the millisecond cut (`chunk.until <= since - LOOKBACK_MS`), or
better (b) drop the millisecond cut entirely and dedup on `event.id` in a persisted set —
merging is already idempotent, so re-applying is free and losing an event is not.

---

#### C3 — The sync feature cannot work at all: the shipped CSP forbids relay WebSockets

`index.html:31-44` (`connect-src 'self'`)

`connect-src` governs WebSocket. `'self'` permits only the page's own origin, so every
`wss://relay.*` connection is refused by the browser. `index.html` was never touched by this
branch (`git log -1 -- index.html` → `3436186`, a pre-sync commit).

**Demonstrated in real Chromium**, twice. First with the exact CSP string in isolation:

```
Refused to connect to 'wss://relay.damus.io/' because it violates the following
Content Security Policy directive: "connect-src 'self'".
```

Then driving the actual app (`csp/run2.mjs`): create a key, add `wss://relay.damus.io`, press
**Sync now**:

```
npub shown:  npub1g5v2f9u…3qv0vpz4
status line: no relay accepted chunk 1/1: relay is closed
CSP violations seen: 1
```

The unit tests never see this because they inject a `SocketFactory`. The user gets "relay is
closed", which points nowhere near the cause.

I flag this as CRITICAL rather than "just a bug" for two reasons: the feature ships in a state
where it cannot function and no test detects that, and the error path degrades to a green
"Already up to date." as soon as there is nothing local to push (see M4/E10) — so the failure
becomes invisible.

**Fix.** Add the configured relay origins to `connect-src`. Since relays are user-editable, a
meta-tag CSP cannot enumerate them; either use `connect-src 'self' wss:` (weakens the policy
but is honest about what the app does) or hold the relay list in a build-time-known allowlist.
Whichever is chosen, add an e2e test that opens a real WebSocket from the page.

---

### HIGH

---

#### H1 — Review-log validation omits the two fields that actually drive the scheduler

`src/sync/merge.ts:95-106`, `src/sync/replay.ts:322-341`

`isAcceptable` checks `rating`, `elapsedDays`, `cardId` and `stateBefore`, above a comment
saying "These feed the scheduler through replay, so a nonsense value here does not merely look
wrong — it rewrites the card's future." It does **not** check `snapshot` or `reviewedAt`.
`replayScheduling` sorts by `reviewedAt` and uses `ordered[0].snapshot` as the origin of the
entire replay.

**Demonstrated (a) schedule rewrite** (`a3b-snapshot.mjs`): one injected log with
`reviewedAt: 1` and `snapshot.memory.stability = 1e6` moves a card's due date from two days
out to **2126**, reported to the user as one innocuous "review log received":

```
honest schedule: { state: 2, due: '2026-09-04T…', reps: 2, S: 2.3065 }
merge counts:    {"reviewLogs":1,"cardsReplayed":1,...}
after the peer:  { state: 2, due: '2126-08-09T…', reps: 3, S: 36500 }
```

The inverse works identically — a snapshot of a New card resets months of scheduling on any
card the peer names. Applied across the collection this is total destruction of the user's
scheduling state while every count the UI shows stays benign. The refusal to *delete* review
logs (`merge.ts:218-221`) is real and correctly implemented, but it does not deliver the
property `types.ts:112-115` claims ("append-only… which is what makes that claim true against a
hostile peer"): a peer that can *add* a log with a chosen origin owns the output.

**Demonstrated (b) crash + persistent poison** (`a3-poisonlog.mjs`): a log with `snapshot`
simply absent passes every check, is **written to the database**, and then
`toSchedulingCard(undefined)` throws out of `applyChanges`:

```
applyChanges THREW: TypeError - Cannot read properties of undefined (reading 'state')
poison log is now persisted: true
later honest log THREW: Cannot read properties of undefined (reading 'state')
```

The throw escapes `syncWith` before `db.syncState.put`, so the round's watermark is lost. The
card is thereafter unreplayable: every future round that touches it dies at the same point.

**Fix.** Validate `reviewedAt` as a finite, plausible epoch-ms value and validate `snapshot`
structurally (finite `state` in `STATES_ALLOWED`, finite `stability`/`difficulty` in sane
ranges, parseable `due`/`lastReview`, non-negative integer `reps`/`lapses`/`step`) inside
`isAcceptable`. Independently, wrap `replayCards` so a single bad card cannot abort a merge, and
seed the replay from the card's own known-good state rather than from a peer-supplied snapshot.

---

#### H2 — A relay that says "OK" and stores nothing makes pushed data vanish permanently

`src/nostr/relay.ts:379-391`, `src/sync/engine.ts:65`

`lastPushedAt` advances to the local clock on the strength of the relay's `["OK", id, true]`
alone. Nothing reads back what was written. `changesSince` uses an exclusive lower bound, so
those records are never offered again.

**Demonstrated** (`a7-ack.mjs`): a relay that ACKs everything and stores nothing.

```
round 1: pushed 7 upserts; relay acked 1 events; stored 0
round 2: pushed 0 upserts  <-- the note is never offered again
records still waiting to be sent: 0
```

The user is told "7 sent". This does not require malice: relays prune, run out of disk, and
drop unfamiliar kinds after accepting them. It is a permanent, silent hole in the backup the
feature exists to provide.

**Fix.** Either verify by reading back (query for the just-published event ids before advancing
the watermark), or keep a per-record "confirmed pushed" marker rather than a scalar clock, so
an unconfirmed record is re-offered.

---

#### H3 — Media is not content-addressed in any enforced sense, and first-writer-wins makes the corruption permanent

`src/sync/merge.ts:14-16, 167-176`

The comment reads: "Media is content-addressed, so two files with the same id have the same
bytes by construction. First writer wins; there is nothing to reconcile." **No code anywhere
verifies that a media record's id is the hash of its bytes.**

**Demonstrated** (`a5-wire.mjs` §6): a peer pushes 14 bytes of `ATTACKER BYTES` under the id
that the victim's real image will hash to. When the honest device later adds the genuine file,
the merge *skips* it (`local` exists) and the attacker's bytes stay for ever:

```
honest file merge counts: {"applied":0,"skipped":1,...}
bytes actually stored:    ATTACKER BYTES
```

Every note referencing that id renders the wrong content, permanently, with no way to correct
it through sync.

**Fix.** Recompute the content hash on arrival and reject a media record whose id does not
match. That makes the comment true and makes first-writer-wins safe.

---

#### H4 — A hostile relay can pin the main thread with forced signature verification

`src/nostr/relay.ts:393-427`

`verifyEvent` runs **before** the filter check (line 411) and **before** the dedup check
(line 417). `maxEvents` (line 421) counts only events that pass both, so it bounds nothing an
attacker cares about. A relay computes correct ids (it only needs SHA-256) with junk
signatures, forcing the full `schnorrVerify` — two JS bigint scalar multiplications.

**Demonstrated** (`d1-relaydos.mjs`):

```
cost of one forced signature check: 7.2 ms
=> events verifiable per 15s default timeout: ~2080
events the relay pushed through verification: 400
  (maxEvents was 5, and NONE of them matched the filter)
```

Three relays × 15 s default timeout = ~45 s of largely synchronous curve arithmetic per round,
and `maybeAutoSync` fires one round every 5 minutes after study sessions. On a phone this is a
visibly unusable app.

**Fix.** Check the filter and the `seen` set *before* verifying — both are free and both are
already available. Cap total events considered per subscription, not just accepted ones. Cap the
inbound message rate.

---

### MEDIUM

---

#### M1 — `pull` holds the union of every event with no bound on records or bytes

`src/nostr/relay.ts:85` (`DEFAULT_MAX_EVENTS = 5000`), `:91` (512 KB/message),
`src/sync/nostr-transport.ts:171-206`

Per-message and per-subscription caps exist; there is no cap on aggregate bytes, on decoded
records, or across relays (`byId` unions all of them, then `merged.upserts` accumulates every
upsert from every chunk before anything is applied).

**Demonstrated** (`d3-pullmem.mjs`), with 300 genuine 48 KB chunks — exactly what a relay
holding the user's own history can replay:

```
pull of 300 events: 3356 ms, 57000 upserts held at once, +56MB heap
extrapolated to the 5000-event cap: ~928MB, ~56s of main-thread work
```

Then `applyChanges` does ~950 000 sequential `get`/`put` round-trips against IndexedDB. On
mobile Safari this is an out-of-memory kill. The same shape occurs benignly on a first sync of
a large collection.

**Fix.** Stream: apply each chunk as it decodes rather than accumulating, and impose a byte
budget per round with an explicit "more to come, run again" result.

---

#### M2 — `chunkChangeSet` base64-encodes oversized media synchronously, then throws it away

`src/sync/wire.ts:187-199` — `encodeBinary` runs on every upsert, and `byteLength` stringifies
and UTF-8-encodes the result, *before* the size test on line 194.

**Demonstrated** (`d2-chunkdos.mjs`):

```
 1MB media:  102 ms, +6MB heap,  oversized=1
 8MB media:  747 ms, +37MB heap, oversized=1
32MB media: 2966 ms, +85MB heap, oversized=1
```

Fully synchronous — the UI thread is frozen for the duration. Ten such files is a 30-second
freeze, and it recurs on every round for as long as the push keeps failing (a failed push does
not advance `lastPushedAt`).

**Fix.** Test `upsert.record.data.byteLength` (or the raw record size) before encoding
anything.

---

#### M3 — A peer can freeze any record for 24 hours at a time and silently eat the user's edits

`src/sync/merge.ts:92` — `if (version > now + MAX_CLOCK_SKEW_MS) return false;`

The boundary is inclusive, so `now + 24h` exactly is accepted.

**Demonstrated** (`a6-merge.mjs` §B/§C):

```
after freeze: {"Front":"PEER TEXT"} modified is 86400000 ms in the future
user edits -> {"Front":"MY EDIT"}
after next sync -> {"Front":"PEER TEXT"} (user edit silently lost)
now + 86400000: applied=1 rejected=0
now + 86400001: applied=0 rejected=1
```

Re-sent each round with a refreshed timestamp, this is indefinite. The user's own edits are
applied locally, appear to stick, and are then overwritten with no conflict shown.

Relatedly (`a6-merge.mjs` §A): a peer resurrects any deleted record it knows the id of, simply
by claiming `modified = now + 1`. That one follows from the stated last-write-wins policy, so I
class it as expected rather than a defect, but it is worth knowing that "delete" is not durable
against a peer.

**Fix.** Clamp incoming versions to `min(version, now)` when writing, rather than rejecting
only beyond the skew allowance — a future-dated record should not be able to win against edits
made in the meantime.

---

#### M4 — A device that has lost every relay reports success

`src/sync/nostr-transport.ts:159-167`, `src/sync/run.ts:186-226`, `src/sync/auto.ts:308-315`,
`src/features/sync/sync-settings.ts:387-405`

`pull` catches per-relay failures and returns an empty change set. If there is nothing local to
push, `push` is never called, the round returns `ok: true`, and `describeOutcome` says
"Already up to date." — the steady state of any device that has synced once and made no edits.

**Demonstrated** (`a8-silent.mjs`), every socket erroring:

```
round 1 ok: false | no relay accepted chunk 1/1: relay is closed; relay is closed
round 2 ok: true  | Already up to date.
problems recorded: [ 'relay-failed', 'relay-failed' ]
```

`maybeAutoSync` is called from `reviewer.ts:298` with no options, so `onFinished` is undefined
and the only surfacing is a toast on `!ok`. The `relay-failed` problems are captured and
discarded. This is precisely the failure mode `auto.ts:258-261` says it exists to prevent
("a sync that has been silently failing for a week is the thing people actually get hurt by").

**Fix.** Treat "zero relays answered" as a failed round. Surface `relay-failed` in the auto path,
and record `lastSuccessfulSyncAt` so the settings screen can say "last reached a relay 9 days
ago".

---

#### M5 — `decodeChangeSet` validates the envelope and nothing inside a record

`src/sync/wire.ts:253-272`, `src/sync/merge.ts:89-108`

A record needs only a string `id`. Every other field is passed through to
`store.put` unexamined (the only content checks anywhere are the four review-log fields).

**Demonstrated** (`a5-wire.mjs` §4/§5): a `cards` record with `deckId: {}`, `noteId: null`,
`state: 'banana'`, `due: ['x']`, `memory: 'nope'`, `reps: -99` is accepted and written, counted
as `applied: 1`:

```
counts: {"applied":1,"rejected":0,...}
stored card: {"id":"c1","deckId":{},"noteId":null,"state":"banana","due":["x"],...}
```

`hasNonFiniteNumber` is the only structural gate and it is unreachable in practice: JSON cannot
carry `NaN`/`Infinity`, and it gives up below `depth > 8` anyway (`merge.ts:119`).

Note that card *content* reaching the DOM still goes through `setSafeHtml`
(`src/ui/safe-html.ts:192`), which is the same boundary as the import path, so this is a
data-integrity problem rather than an XSS one. Media MIME is likewise clamped at the blob sink
(`src/ui/media-resolver.ts:76`). Both of those are correct.

**Fix.** Per-store schema validation in `decodeChangeSet` — reject rather than write. It is the
one place that already knows which store a record claims to belong to.

---

#### M6 — Public, world-readable metadata under the user's real nostr identity

`src/sync/nostr-transport.ts:236-240`

Every event carries `['d', <device UUID>]` and `['l', 'flashy-sync-v1']` in cleartext, on a
regular (stored, indexed) kind. `d` and `l` are single-letter tags — relays index them
precisely so that anyone can query them. So *anybody*, not just the relay operator, can ask any
relay "give me kind 9078 `#l=flashy-sync-v1` from `<npub>`" and get a permanent timestamped
record of when this person studies, from how many distinct devices, and how much they changed
each time.

The UI actively encourages using a pre-existing identity — "Use an existing key", "Use my
extension" (`sync-settings.ts:123-128`) — which binds this study log to the user's public
social identity. The warning card (`sync-settings.ts:68-71`) says "A relay still learns…",
which understates it: the audience is the public, and the record is durable.

**Fix.** Say "anyone can look this up under your npub", and recommend a dedicated key rather
than presenting the extension as strictly safer. Consider dropping the `l` tag (it buys
nothing — the `authors` filter already scopes the query) and rotating or omitting the device
tag, which is a stable cross-session identifier published for no protocol reason.

---

### LOW

---

#### L1 — `hexToBytes` accepts non-hex input and silently produces wrong bytes

`src/nostr/secp256k1.ts:201-211`. `Number.parseInt` parses prefixes and signs.
**Demonstrated** (`c1-crypto.mjs`):

```
hexToBytes("0z") = 00      hexToBytes("1z") = 01
hexToBytes("+1") = 01      hexToBytes("-1") = ff
```

Not currently reachable: `verifyEvent` gates on `HEX32`/`HEX64` (`event.ts:114-124`),
`nip19` gates on `HEX32`, and the `LocalSigner` constructor gates on length. It is a loaded gun
sitting next to the key-handling code.
**Fix.** `if (!/^[0-9a-fA-F]*$/.test(clean)) throw`.

#### L2 — `openTransport` does not validate what a NIP-07 extension returns

`src/sync/nostr-transport.ts:276`. `useExtension` normalises through `toPublicKeyHex`
(`account.ts:315`) but `openTransport` uses the raw provider value, which goes into
`filter.authors` and `unsigned.pubkey`. An extension returning an `npub1…` (some do) yields a
sync that connects, queries, finds nothing, and reports success. Reasoned from reading.
**Fix.** `toPublicKeyHex` the result, throw if null.

#### L3 — Relay NOTICE text accumulates unboundedly and is then never shown

`src/sync/run.ts:202` pushes every NOTICE into `problems` with `eventId: url` — a field-name
confusion that also means `problemNotes` (`sync-settings.ts:388-403`) filters them out
entirely. So "discarded an event that matched no filter" and "oversized message discarded" —
the two signals that a relay is misbehaving — reach the user never, while the array they sit in
grows for the length of the round.

#### L4 — `Relay.receive` chains every inbound message onto one unbounded promise queue

`src/nostr/relay.ts:338-340`. Each pending message string (up to 512 KB) is retained in the
chain's closure until dispatch reaches it. The queue is bounded only by how fast a relay can
write for the duration of a round. Reasoned from reading; H4 is the sharper version of the same
weakness.

#### L5 — `chacha20` counter arithmetic

`src/nostr/chacha20.ts:234`, `counter + offset / 64`, wrapped by `>>> 0` in `block`. Wraps past
256 GB. Unreachable given the 65 535-byte plaintext cap. Noted for completeness.

---

### INFORMATIONAL — claims in comments that are not true

These matter because the code is written to be read, and each of these tells a reader
something is safe when it is not.

1. `src/nostr/signer.ts:10-11` — "`LocalSigner` holds the key in the page and **stores it in
   IndexedDB**." It stores it in `localStorage` (`account.ts:158, 302`). `account.ts` says so
   correctly; `signer.ts` does not.
2. `src/sync/merge.ts:14-16` — media content-addressing "by construction". Nothing verifies it
   (H3).
3. `src/sync/merge.ts:96-98` — the comment justifying review-log validation, above a check that
   omits `snapshot` and `reviewedAt` (H1).
4. `src/sync/wire.ts:29-30` — "NIP-44 caps a plaintext at 65535 bytes. It is a hard limit."
   `/home/user/nips/44.md` sets `max_plaintext_size` to 4 294 967 295, with a 6-byte length
   prefix above 65 536. 65 535 is *this implementation's* limit, and it means this client cannot
   decrypt a spec-compliant peer's larger payloads.
5. `src/features/sync/sync-settings.ts:396` — "relays cap one message at 64KB." Invented; the
   actual cause is (4).
6. `src/sync/nostr-transport.ts:31-37` — the lookback "costs bandwidth rather than correctness."
   It costs correctness: line 201 discards everything the lookback re-fetches (C2, proven in
   `a2b.mjs`).
7. `src/sync/nostr-transport.ts:44-46` — "a device filters out its own echo **at the relay**."
   The filter sent (lines 149-154) contains no device term; the filtering is entirely
   client-side, twice.
8. `src/sync/types.ts:112-115` — append-only review logs are what makes the guarantee "true
   against a hostile peer." The delete-refusal is real; the guarantee is not (H1).
9. `src/nostr/relay.ts:86-91` — the message cap stops "a stream of one enormous message"
   exhausting memory. Per-message, yes; in aggregate, no (M1).

Also informational: `serialiseForId` uses `JSON.stringify`, which escapes control characters
other than the seven NIP-01 names as `\u00XX` rather than "verbatim" (`/home/user/nips/01.md:48`).
Unreachable here — content is base64 and tags are a UUID and a fixed string — and it is what
every JS nostr library does. And `dist/nostr/fake-relay.js` is deployed to GitHub Pages; it is
never imported and grants nothing.

---

## 3. What I checked and found sound

Stated plainly, because the coverage matters:

- **BIP-340 / secp256k1.** All 19 official vectors pass, verification results and signing
  outputs both (`c5-bip340.mjs`). `getPublicKey` and `sharedSecret` agree with node's
  `createECDH('secp256k1')` on 25/25 random keys (`c1-crypto.mjs`). Adversarial cases behave:
  `s = n`, `s = n + s`, `s = 0`, `r = p`, `r = 0`, negated `s`, and pubkeys `0`, `1`, `p`,
  `2^256-1` are all rejected. `liftX` bounds-checks correctly; `schnorrVerify` range-checks
  `r < p` and `s < n`. The non-constant-time caveat in the header is honest and is a real,
  unfixable-in-JS limitation.
- **ChaCha20.** Byte-identical to node's `chacha20` on 25/25 random key/nonce/length triples,
  including non-multiple-of-64 lengths.
- **NIP-44 v2.** Conversation key equals `HMAC-SHA256('nip44-v2', shared_x)`; message keys equal
  HKDF-Expand(conv, nonce, 76) computed independently with node's HMAC; all 35 official
  conversation-key vectors pass; all 10 encrypt/decrypt vectors pass including re-encryption
  under the vectors' fixed nonces; all 12 invalid-decrypt vectors are rejected.
  `paddedLength` agrees with a literal transcription of the spec pseudocode on **all 65 535**
  lengths. All 262 single-bit flips across a payload are rejected with `invalid MAC` and **none
  produce plaintext**. Nonces are 32 fresh CSPRNG bytes — 300/300 distinct. Truncation,
  extension, the `#` version flag and short payloads are all rejected.
  **Authenticate-then-decrypt is correct**: `nip44.ts:168-174` computes and compares the MAC
  before ChaCha20 runs, and `unpad` runs only after. `equalConstantTime` is data-independent.
  The one deviation from the spec is the 65 535 cap and the missing 6-byte extended prefix
  (INFORMATIONAL 4) — a compatibility limit, not a weakness.
- **Bech32 / NIP-19.** Injective over 3000 random keys, zero round-trip failures. Of 1805
  mutations of a valid `npub` — every single-character substitution at every position, plus
  case, whitespace, separator and length variants — the only ones accepted were the uppercase
  form and whitespace-padded forms, both decoding to the same key. No string decodes to a
  different key; no two strings decode to the same key. Padding bits are checked
  (`convertBits(..., false)`), the length is pinned to 32 bytes, mixed case is rejected, and the
  separator is `lastIndexOf('1')` as the spec requires. `nsec` is refused where an `npub` is
  expected and vice versa (`toPublicKeyHex(nsec) = null`, `toSecretKeyHex(npub) = null`), which
  is the failure mode that actually publishes people's keys. The missing 90-character BIP-173
  limit is harmless here because the decoded length is pinned.
- **`verifyEvent` is sufficient against a relay.** Independently confirmed
  (`a7-ack.mjs`): an event correctly signed by a *different* author is rejected by the filter
  check ("discarded an event that matched no filter"); an event with a tampered id is rejected
  by verification ("bad-id"). The id is re-derived rather than trusted, the well-formedness
  regexes pin lowercase hex, nested arrays in `tags` are rejected, and dedup is by id.
- **No secret-key leakage.** `revealSecretKey` is the only reader of the stored secret; the
  `nsec` enters the DOM only inside a modal whose backdrop is `.remove()`d on close
  (`modal.ts:34`). There is no `console.*` anywhere in `src/nostr/`, `src/sync/` or
  `src/features/sync/`. The secret never enters an event, a filter, an error message or a
  problem report. **It is not in a backup**: `exportCollection` (`io.ts:81-106`) reads only the
  eight IndexedDB content stores and never touches `localStorage`; the design decision in
  `account.ts:1-20` holds, verified by reading. The `localStorage` key `flashy.sync.secretKey` is
  trivially guessable, but the honest caveat in `account.ts:13-18` and in the UI copy
  (`sync-settings.ts:104`) is accurate: any script on the origin owns the key, and that is
  unfixable without an extension.
- **What script execution on the origin gains from sync**: the secret key (already stated), and
  the ability to publish arbitrary events under the user's identity. It does not gain a new
  network egress channel — the CSP forbids it (C3) — nor a way to write into the service-worker
  cache that it did not already have (`sw.js:20-49` narrows `isCacheable` to the app's own
  files, and the reasoning in its header comment is correct).
- **Prototype pollution** is blocked. `__proto__` is dropped in `decodeBinary`
  (`wire.ts:136`); `constructor.prototype` payloads do nothing because plain assignment to
  `constructor` on an object literal is an own-property write. Verified by execution
  (`a5-wire.mjs` §2): `Object.prototype` stayed clean.
- **Deep-nesting DoS** is contained: `decodeBinary` overflows the stack at ~9000 levels, but the
  `RangeError` is caught by the per-event handler at `nostr-transport.ts:186`, costing that chunk
  and nothing else. The 64 KB plaintext cap bounds the depth anyway.
- **Malformed `$bin`** throws rather than yielding a wrong-length `ArrayBuffer`, as the comment
  claims (`a5-wire.mjs` §1).
- **`meta` is not a content store** (`storage/types.ts:160-168`), so a peer cannot overwrite
  `deviceId` and cannot make two devices ignore each other.
- **Review-log deletion is genuinely refused** (`merge.ts:218-221`), including for a peer.
- **Deletion tombstones** are structurally checked: `id` must equal `<store>:<recordId>`
  (`wire.ts:286`), `deletedAt` must be finite and non-negative, and a record edited after the
  tombstone survives.
- **Relay URL validation** (`account.ts:256-265`) correctly requires `wss:`, allowing `ws:` only
  to `localhost`/`127.0.0.1`.
- **Card content still passes through the sanitiser.** Sync does not open a new XSS path: note
  fields and note-type templates reach the DOM only via `setSafeHtml`, and media MIME is clamped
  to image/audio at the blob-URL sink. Sync is a new *source* for that existing boundary, not a
  bypass of it.
- **`auto.ts` throttling** is correct: the `running` flag is cleared in `finally`, and the
  5-minute interval is enforced before the flag is taken.
- **The 384-test suite** genuinely exercises the crypto vectors, hostile-relay faults and a
  hostile-peer merge suite. Its blind spots are the three assumptions the tests bake in: an
  injected socket (so C3 is invisible), a fake relay that never lies about *completeness* (so
  C2 is invisible), and an `until` that is always a real clock (so C1 is invisible).

---

## 4. What I could not check

- **Timing side channels.** The non-constant-time bigint arithmetic is real and is honestly
  documented at `secp256k1.ts:18-24`. Measuring an actual key-recovery channel from JS timing was
  out of scope, and the code cannot fix it in portable JavaScript anyway.
- **Real relays.** No network egress to `wss://relay.damus.io` et al. from this environment.
  Everything relay-side was exercised against `FakeRelay` and against sockets I wrote. So I
  cannot tell you how real relays treat kind 9078, whether they accept it, how long they keep it,
  or whether any of them impose limits that would change the DoS numbers.
- **IndexedDB at scale.** All merge/DoS measurements ran against `MemoryDb`. The IndexedDB
  numbers will be worse — M1's ~950 000 sequential `get`/`put` calls are far more expensive
  there than in a `Map`.
- **iOS Safari**, the app's stated primary target. Chromium only. Memory limits and
  `localStorage` behaviour differ materially.
- **The sanitiser itself** (`src/ui/safe-html.ts`). I confirmed sync routes through it and does
  not bypass it; I did not re-audit it. If it is bypassable, M5 becomes an XSS finding, because a
  peer can write arbitrary note-type templates.
- **Cryptanalysis.** I verified the implementations against their specifications and against
  independent implementations. That is evidence of correct *implementation*; it is not an
  audit of the constructions, and the warning card's framing ("better than nothing, not as
  proven") remains the right one.
