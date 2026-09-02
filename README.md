# Flashy

> ### ⚠️ Written by an AI, largely unreviewed by a human
>
> Every line of this repository — code, tests, documentation, this warning —
> was written by Claude (Opus 5) in a single session, from a one-paragraph
> brief. A human directed it and looked at screenshots; nobody has read the
> code line by line.
>
> **What that is worth.** The FSRS implementation is ported from the
> reference Rust implementation and pinned by two golden vectors taken from
> that project's own test suite, so the algorithm is not improvised. There
> are 230 unit tests and 57 end-to-end checks against a real browser, and
> the storage layer is verified against both of its backends. Several real
> bugs were caught that way and are recorded in the commit history.
>
> **What that is not worth.** Passing tests written by the same author that
> wrote the code is weaker evidence than it looks: a blind spot in the
> implementation is likely to be a blind spot in its tests. No human has
> audited the scheduling logic, the migration path, or the sanitiser. It
> has never run on real phone hardware. It has never been used by anyone
> for actual studying.
>
> **If you are going to rely on it**, keep backups (Import & export writes a
> complete one), and read `src/fsrs/` and `src/scheduler/` yourself before
> trusting your study time to them.


A local-first spaced-repetition flashcard webapp implementing **FSRS-6**.
Dark mode only. **Zero runtime dependencies** — no framework, no bundler, no
package installs. TypeScript compiled straight to native ES modules that the
browser loads.

## Running

```sh
npm run build     # compile src/ -> dist/ with tsc
npm run dev       # compile, then serve on http://localhost:5173
npm test          # compile, then run the unit suite with node --test
npm run e2e       # drive a real browser through the app (needs Playwright)
npm run check     # both suites
npm run watch     # incremental recompile
```

Then open `http://localhost:5173/index.html`. Everything is static: there is
no backend, no account and no network traffic. Your collection lives in
IndexedDB on your device.

Any static host will serve it — copy `index.html`, `icon.svg`,
`manifest.webmanifest`, `sw.js`, `src/ui/theme.css` and `dist/` and you are
done. It installs as a PWA and works fully offline.

### GitHub Pages

`.github/workflows/pages.yml` builds the app and publishes it. `dist/` is
not committed, so Pages cannot serve the repository directly — the workflow
compiles it, runs the unit suite, and uploads the result.

To turn it on once: **repository Settings → Pages → Source → GitHub
Actions**. Every push then redeploys. All paths in the app are relative, so
it works correctly from a project subpath such as
`https://<user>.github.io/Flashy/`.

## Architecture

Strict layering. Each layer may only import from the ones below it, so any
one of them can be replaced without touching the others.

| Layer | Path | Responsibility |
|---|---|---|
| Algorithm | `src/fsrs/` | Pure FSRS-6. No I/O, no DOM, no clock, no randomness. |
| Domain | `src/domain/` | Entities, template rendering, card generation, deck paths. |
| Storage | `src/storage/` | `Db`/`Store` interfaces, IndexedDB and in-memory backends, change tracking. |
| Scheduler | `src/scheduler/` | Study days, queue building, answering, undo. |
| Collection | `src/collection/` | Note and note-type operations, stats, import/export, optimiser. |
| UI kit | `src/ui/` | Theme tokens, DOM helpers, modals, toasts, charts. Knows nothing about flashcards. |
| Features | `src/features/` | Decks, editor, review, browse, stats, settings, import/export. |
| App | `src/app/` | Router, shell, context. |

### The model, borrowed from Anki

A **note type** declares fields and templates. A **note** holds the field
values. Each template that renders a non-blank question generates a **card**
— and cards, not notes, are what get scheduled. A cloze note type generates
one card per `{{c1::deletion}}` number instead.

That indirection is what buys reverse cards and cloze deletions: editing one
note updates every card made from it, without disturbing their independent
scheduling state.

Every answer appends a **ReviewLog** carrying a complete snapshot of the
pre-answer card. That is what makes undo an exact restore rather than a
recomputation, and what the parameter optimiser learns from.

### Purity, and why it matters

`src/fsrs/` takes the current time and its source of randomness as
arguments. Nothing in it reads a clock or calls `Math.random` on its own.
That is the reason its 34 tests are deterministic, and the reason a 90-day
study simulation can run in milliseconds in the test suite.

## Data, and your phone

The collection lives in IndexedDB on the device. Nothing is uploaded, there
is no account, and the app works with the network off.

On a phone that raises a real risk: browsers treat ordinary IndexedDB as
"best effort" and may evict it when storage runs low, which here would mean
losing months of review history without warning. So the app asks for
[durable storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
on startup and reports the answer under **Settings → Storage**. Browsers
decide differently — some grant it silently, some only once the app is
installed, some never.

### On an iPhone, install it

This is not a preference. Safari applies a cap to script-writable storage
and clears it for sites you have not returned to for a while — and web apps
launched from the Home Screen are **exempt**. Studying in a Safari tab means
your review history can be wiped without warning; studying from the Home
Screen means it is not.

There is no install prompt API on iOS, so the app detects a Safari tab and
explains the steps itself, once, dismissibly:

1. Tap the Share button at the bottom of Safari.
2. Scroll down and tap **Add to Home Screen**.
3. Tap Add, then open Flashy from the new icon.

Settings → Storage reports which situation you are in. Note that only
Safari can do this on iOS — Chrome and Firefox there are WebKit under the
hood but have no "Add to Home Screen".

Even so: take a backup occasionally. Import & export writes a complete
copy, review history included.

### Images and sounds

Attach files to a note while editing: use the **Attach…** button, drag a
file onto a field, or paste a screenshot. They are stored in the collection
itself and included in backups, so a restore brings them back with
everything else.

Files are content-addressed, so pasting the same diagram onto twenty cards
stores it once. Nothing is reference-counted: which files are in use is
derived from the notes whenever it is asked, and **Import & export → Images
& sounds** lists everything with its usage and reclaims what nothing refers
to any more. Deleting a note deliberately does *not* delete its files —
another note may share them.

### Syncing between devices

Not implemented, and deliberately not designed. What *is* in place is the
groundwork that cannot be retrofitted: deletions leave tombstones, every
record carries an indexed version, and there is a change feed
(`changesSince`) that a transport can attach to. See
[docs/sync.md](docs/sync.md) for the seam and the decisions behind it.

## Sync across devices (optional, off by default)

Two devices holding the same collection can be kept in step through
[nostr](https://github.com/nostr-protocol/nips) relays. It is off until you
turn it on, and turning it on is three steps: create or paste a key, add a
relay, press Sync.

**What is sent.** A change set — the records that changed since the last
round — encrypted with NIP-44 to *your own* public key. A relay carries
ciphertext that only your key can open. Nothing is published in the clear.

**What a relay still learns, and it is not nothing.** Relays index events by
author, so anyone who knows your public key can ask any relay when you
studied, from how many devices, and roughly how much changed each time. The
contents stay unreadable; the pattern does not. Use a key you use only for
this — reusing your nostr profile key ties a permanent, timestamped record
of your study habits to your public identity.

**Where the key lives.** In a browser extension if you have one, which is
the safest arrangement available on the web: the key never enters the page.
On iPhone there are no extensions, so it is stored in the browser, where
anything that can run code on the page can read it. The settings screen says
this in as many words rather than implying a safety it does not have.

**How conflicts resolve.** Last write wins on the record's own timestamp,
except review logs, which are append-only and merged rather than overwritten
— so answering the same card on two devices keeps both answers and replays
the card's schedule from the combined history. Deletions travel as
tombstones, so a deleted card does not come back from a device that never
saw it go.

**The honest caveat.** The cryptography here is hand-written, because this
project cannot install packages. It is verified against the specifications'
own test vectors — all 19 BIP-340 vectors, every NIP-44 vector, ChaCha20
byte-identical to a known-good implementation — and it has been through an
independent adversarial audit (`docs/sync-audit.md`, kept verbatim, findings
and all). That is evidence the implementations are correct. It is not a
cryptographic audit, and there are no constant-time guarantees, because
JavaScript bigints leak timing. Treat it as better than nothing rather than
as proven.

Design notes and the decisions behind them: `docs/sync.md`.

## FSRS-6

Ported from the reference implementation
([open-spaced-repetition/fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs),
`src/model.rs`) rather than written from memory. The two golden vectors from
its own `test_memory_state` are asserted in `src/fsrs/core.test.ts`, so a
formula drift fails the build.

The model tracks two numbers per card:

- **stability** — days for recall probability to fall to 90%.
- **difficulty** — 1 to 10; how weakly a success grows stability.

Recall decays on a power curve, not an exponential, and the interval for a
target retention is that curve inverted. The 21 weights are what the
optimiser fits.

### Parameter optimisation

`src/collection/optimize.ts` fits the weights to your own review history by
coordinate descent over the same log loss the reference trainer minimises,
with the same parameter bounds. It is much simpler than a gradient trainer
and will not match one, but it runs in about a second in a browser tab with
no dependencies, and it can never return parameters worse than the ones it
started from.

It scores only reviews with at least a day elapsed — same-day answers
predict recall of essentially 1 and would swamp the objective — and refuses
to run on fewer than 100 dated reviews.

## Testing

```
npm test    230 unit tests
npm run e2e  57 end-to-end checks in a real browser
```

Some of the load-bearing ones:

- **Golden vectors** from the reference FSRS implementation, so the maths
  cannot drift.
- **A 90-day, 50-card simulation** with a seeded PRNG and an 85%-accurate
  reviewer, asserting that no card is lost or duplicated, each is introduced
  exactly once, the daily limit holds every day, the queue always drains,
  intervals grow, memory states stay in range, there is exactly one log per
  answer, and undo still works at the end.
- **A storage conformance suite** run against both backends. Node runs it
  against the in-memory database; the page at `#/debug/storage` runs the
  identical suite against real IndexedDB. It has already caught one genuine
  divergence.
- **CSV and backup round-trips**, including quoted commas, embedded
  newlines and doubled quotes.
- **A schema migration test** that builds a v1 database by hand, opens it
  with the current code, and checks the data survived and the new indexes
  and stores are there. This is the one path that can silently destroy
  someone's review history.
- **iOS checks** in an emulated iPhone, covering both a Safari tab and an
  installed app: the install advice appears in one and not the other, the
  storage report matches, dismissal sticks, and the answer buttons stay
  tappable. The installed-app checks run at iPhone SE size — the tightest
  modern iPhone — and assert the review screen needs no scrolling there.

## Debug pages

Not linked from the main navigation, but useful:

| Path | What it does |
|---|---|
| `#/debug/fsrs` | Answer a simulated card and watch stability, difficulty and the four intervals move. |
| `#/debug/storage` | Run the storage conformance suite against both backends. |
| `#/debug/sample` | Generate a vocabulary deck with months of simulated review history — or wipe the collection. |

## Keyboard shortcuts

While reviewing: `Space` shows the answer then answers Good, `1`–`4` grade
directly, `U` undoes, `E` edits the note, `-` buries, `!` suspends, `?`
lists them all. In the editor, `Ctrl`/`Cmd`+`Enter` saves.

## Data

Everything is in IndexedDB under the database `flashy`. Nothing leaves the
device. Import & export produces a full JSON backup — every card's
scheduling state and complete history — or a CSV of your notes.

## Notable deliberate choices

- **Note field values are keyed by field name, not ordinal.** Reordering a
  note type's fields is then free and cannot scramble existing notes.
- **A resync never deletes a note's last card.** Silently destroying study
  history because a template edit made a question render blank would be
  worse than leaving a card that renders empty.
- **True retention counts only answers on cards already in review.**
  Including learning-step answers is the standard way to make the number
  look better than it is.
- **Unknown template references render as `{{Typo}}`**, so a template
  mistake is visible while editing — except during card generation, which
  is given the note type's declared field names and treats anything outside
  that set as empty.
- **User HTML is sanitised on render**, so an imported deck cannot execute
  in your collection.
