# Flashy

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
| Storage | `src/storage/` | `Db`/`Store` interfaces + IndexedDB and in-memory backends. |
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
npm test    180 unit tests
npm run e2e  28 end-to-end checks in a real browser
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
