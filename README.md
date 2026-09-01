# Flashy

A local-first spaced-repetition flashcard webapp implementing **FSRS-6**.
Dark mode only. Zero runtime dependencies.

## Running

```sh
npm run build     # compile src/ -> dist/ with tsc
npm run dev       # compile, then serve on http://localhost:5173
npm test          # compile, then run the unit tests with node --test
npm run watch     # incremental recompile
```

Open `http://localhost:5173/index.html`. Everything is static; there is no
backend and no build tooling beyond `tsc`.

## Architecture

Strict layering — each layer may only import from the ones below it.

| Layer | Path | Responsibility |
|---|---|---|
| Algorithm | `src/fsrs/` | Pure FSRS-6. No I/O, no DOM, no clock. |
| Domain | `src/domain/` | Entity types: Note, NoteType, Card, Deck, ReviewLog, config. |
| Storage | `src/storage/` | Repository interfaces + IndexedDB and in-memory implementations. |
| Scheduler | `src/scheduler/` | Queue building, day rollover, limits, answering, undo. |
| UI kit | `src/ui/` | Theme tokens and DOM primitives. Knows nothing about flashcards. |
| Features | `src/features/` | Decks, editor, review, stats, settings, import/export. |
| App | `src/app/` | Router and shell. |

The point of the layering is that you can replace any single layer — swap
IndexedDB for a server, swap the DOM helpers for a framework, tune the FSRS
parameters — without touching the others.

Model, borrowed from Anki: a **note** holds fields; its **note type** holds
templates; each template generates a **card**. Cards are what get scheduled.
Every answer appends a **ReviewLog**, which is what makes undo and parameter
optimisation possible.

## Status

Built in testable steps. See the commit history; each step ends green.
