> **Status note, added when the report landed.**
>
> This report was produced by an independent audit agent working from a
> cold start, with no access to the assumptions of whoever wrote the code.
> It is kept verbatim below; nothing has been edited to be kinder.
>
> Fixed since:
>
> - **Finding 1 (critical, sanitiser bypass / stored XSS)** — the regex
>   sanitiser is gone. `src/ui/safe-html.ts` parses into an inert template
>   and applies an allow-list. All 21 demonstrated payloads are now an
>   end-to-end test corpus driven through a real browser.
> - **Finding 2 (no CSP)** — added to `index.html`. `frame-ancestors` is
>   deliberately omitted; it is ignored in a meta element.
> - **Finding 5 (entity-encoded `javascript:`)** — resolved by the same
>   change: URLs are scheme-checked after the parser decodes entities.
> - **Finding 6 (attacker-controlled media MIME)** — clamped on import and
>   again at the point the object URL is created.
> - **Unvalidated numbers in a backup** (part of Finding 4's
>   reachable-today path) — import now refuses any non-finite number.
>
> Outstanding:
>
> - **Finding 3 (service worker amplifies XSS)** — mitigated in practice by
>   fixing Finding 1, but the persistence mechanism itself is unchanged.
> - **Finding 4 (merge layer trusts a peer)** — the remaining parts live on
>   `claude/nostr-sync` and are being addressed there. Nothing in the
>   shipped app reaches them: there is no transport.
> - **Findings 7-8 (no lockfile in CI, unbounded import work)** — open.

---

# Flashy security audit — `claude/nostr-sync`

Independent review of the `claude/nostr-sync` branch (tip `d0e0c18`), focused on
the hand-written cryptography in `src/nostr/`, the sync/merge layer in
`src/sync/`, HTML rendering/sanitisation, imports, the service worker, and the
GitHub Pages deployment. Comments and commit messages were treated as claims to
be disproved, not as evidence.

## Method and what was actually verified

The audit combined source reading with executable probes. I built the branch
(`npm run build`) and ran the unit suite (`node --test dist/**/*.test.js`) — the
36 nostr tests pass, as advertised. Beyond that I wrote attack scripts that
exercise the *compiled* code, and ran the HTML ones in the same headless
Chromium the project uses, driving `element.innerHTML = html` exactly as the app
does (`src/ui/dom.ts:38`).

Verified by execution (not just by reading):

- **The HTML sanitiser is bypassable and yields real script execution** in a
  live browser, both directly and end-to-end through `renderTemplate` — three
  distinct auto-executing payloads confirmed (Finding 1).
- **The merge layer applies a hostile peer's change set with no validation** —
  demonstrated overwriting a note with attacker HTML via an out-of-range
  version, and deleting an "append-only" review log via a tombstone
  (Finding 4).
- The NIP-44 `paddedLength` matches the spec reference for every length
  `1..65535`; the BIP-340 vectors and NIP-44 round-trips pass.

Inspected but not exercised end-to-end: the elliptic-curve internals (reasoned
about, cross-checked against the spec and the vectors), and the sync *engine*
watermark logic (read closely; the merge primitive it calls is what I attacked).

Important scoping fact established during the audit: **the nostr and sync layers
are not wired into the running app.** Nothing under `src/features/` or
`src/app/` imports `src/sync/` or `src/nostr/`; there is no relay/WebSocket
transport and no code that stores a nostr secret key. So the cryptography and
the merge engine are shipped-but-dormant library code. This lowers the *present*
exploitability of the sync/crypto findings (they need a transport that does not
exist yet) but does not make them go away — they are the foundation the next
commit will build on, and the merge code is already reachable in-process.

---

## Findings, by severity

### 1. CRITICAL — HTML sanitiser bypass gives stored XSS from any imported deck

**File:** `src/domain/render.ts:95-104` (`sanitiseHtml`), reached via
`renderTemplate` (`render.ts:118-122`) and injected with `innerHTML` at
`src/ui/dom.ts:38`. Rendered card HTML is fed to that sink from three screens:
the reviewer (`src/features/review/reviewer.ts:223`), the note-editor preview
(`src/features/editor/note-editor.ts:276-277`), and the browser
(`src/features/browse/browse.ts:388-390`).

**The bug.** The sanitiser is a chain of regexes. Event-handler stripping
requires a *whitespace* character before the handler name:

```js
.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')   // note the leading \s
.replace(/\son\w+\s*=\s*'[^']*'/gi, '')
.replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
```

HTML parsers, however, also accept `/` and the closing quote of the previous
attribute as attribute separators. An `onerror`/`onload` that is *not* preceded
by whitespace therefore survives the regex but is still parsed as an event
handler by the browser. The `javascript:` filter (`render.ts:102-103`) is
likewise literal-only and only covers `href`/`src`.

**Demonstrated payloads** (each ran `sanitiseHtml`, then `innerHTML`, in
Chromium; `window.__x` was set with no user interaction):

| Payload | Result |
|---|---|
| `<img src="x"/onerror="…">` | **FIRED** |
| `<img src="x"onerror="…">` | **FIRED** |
| `<img/src="x"/onerror="…">` | **FIRED** |
| `<image src=x /onerror=…>` | **FIRED** (`<image>` → `<img>`) |
| `<img src=x onerror=…>` (control) | stripped, safe |

End-to-end through the real render path:

```
renderTemplate('{{Front}}', { fields:{ Front:'<img src="x"/onerror="window.__pwned=1">' }, ord:0, side:'question' })
  => <img src="x"/onerror="window.__pwned=1">
  => executed in browser: true
```

**Exploitation scenario.** The JSON restore (`src/collection/io.ts:141`,
`validateExport` at `io.ts:194`) imports `notes` and `noteTypes` (i.e. card
templates) verbatim, validating only that each record is an object with a string
`id`. A shared "study deck" — the app's whole reason to exist — can carry a note
whose field, or a note type whose template, contains one of the payloads above.
The victim does not even have to start a review: **opening the Browse screen
renders every card front/back and fires the payload immediately.** Because there
is no Content-Security-Policy (Finding 2) and the app is a service-worker PWA
(Finding 3), the injected script runs with full same-origin authority: it can
read and exfiltrate the entire IndexedDB collection, and — once the sync layer
lands — the nostr secret key, and it can poison the service-worker cache to make
itself persist after the malicious deck is deleted.

**Fix.** Do not sanitise HTML with regexes. Parse into a DOM
(`DOMParser`/`<template>`) and walk it with an allow-list of elements and
attributes, dropping every attribute whose name begins with `on`, resolving and
scheme-checking every URL attribute (not just `href`/`src`), and re-serialising.
Where the browser DOM is unavailable (node/export), reuse the same allow-list
model rather than the regex pass. Pair this with Finding 2 so a bypass is not
game-over.

---

### 2. HIGH — No Content-Security-Policy anywhere

**File:** `index.html:1-34` (no `<meta http-equiv="Content-Security-Policy">`);
GitHub Pages cannot set response headers, so a meta CSP is the only option and it
is absent.

**Impact.** CSP is the defense-in-depth that would blunt Finding 1: a policy of
`script-src 'self'` (no `'unsafe-inline'`), `object-src 'none'`,
`base-uri 'none'` would stop an injected inline handler from executing even when
the sanitiser is bypassed, and would contain `javascript:`/data-URL script and
`<base>` hijacking. Its absence means any HTML-injection flaw is directly
script execution with no second hurdle.

**Fix.** Add a strict meta CSP to `index.html`. The app uses ES modules from
`./dist/`, an inline-free `main.js`, and object-URL media, so
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:;
media-src 'self' blob:; connect-src 'self'; manifest-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'` is a realistic
starting point (widen `connect-src` when a relay transport is added). Verify the
stylesheet link and any future inline styles against `style-src`.

---

### 3. MEDIUM — Service worker turns any XSS into persistent, update-resistant compromise

**File:** `sw.js:54-75` (network-first cache of same-origin `basic` 200s),
registered at `src/app/main.ts:107`.

**Impact.** This is not a bug in the SW logic (network-first is a reasonable
choice and the version-skew reasoning is sound). It is an amplifier: with no CSP,
script injected via Finding 1 can call `caches.open('flashy-v3')` and
`cache.put('./dist/app/main.js', <malicious response>)`, or register its own
`fetch` handler, so the compromise survives page reloads, deck deletion, and
even a redeploy until `CACHE_VERSION` is bumped *and* the old worker is replaced.
On an installed PWA on a phone there is no visible address bar or easy "clear
site data", so recovery is materially harder than on a normal tab. I did not
build a live cache-poisoning PoC (it requires a served SW context), so the
persistence step is reasoned, not demonstrated; the XSS it builds on is
demonstrated.

**Fix.** Primarily, fix Findings 1 and 2. Additionally consider integrity
-checking or versioning cached app shell entries and narrowing what the fetch
handler will cache.

---

### 4. MEDIUM (latent; HIGH once a relay transport ships) — Merge layer trusts a peer's change set unconditionally

**File:** `src/sync/merge.ts` — `applyUpsert` (esp. the version comparison at
`merge.ts:114`, which uses the peer-supplied `upsert.version`), `applyDeletion`
(`merge.ts:141`), and the review-log/media special-casing at `merge.ts:82-103`.
Reachable via `applyChanges` (`merge.ts:43`) and the loopback transport;
tombstones for every content store, including `reviewLogs`, are produced by
`src/storage/tracking.ts:131`.

**The bugs, demonstrated** (in-memory `Db` + `applyChanges`, one hostile change
set):

- **Out-of-range version always wins.** `applyUpsert` compares
  `remoteVersion = upsert.version` against the local record's version and takes
  the record when it is larger. The version is a *peer-declared field*, not
  re-derived from the record and not bounded. A peer sending
  `version: Number.MAX_SAFE_INTEGER` overwrites any local record with arbitrary
  content:

  ```
  BEFORE: note1.Front = real answer
  AFTER : note1.Front = <img src=x/onerror=alert(document.cookie)>   // delivers Finding 1 too
  ```

- **"Append-only, never conflicts" review logs can be deleted.** The header of
  `merge.ts` and `sync/types.ts:27` state review logs never conflict and are the
  union of both devices' history. But `applyDeletion` honours a tombstone for
  *any* content store, review logs included, whenever
  `versionOf(local) <= deletedAt`. A hostile tombstone erases study history; a
  subsequent `replayCards` then recomputes the card's scheduling from the
  truncated history, silently poisoning the schedule:

  ```
  BEFORE: reviewLogs count = 1
  AFTER : reviewLogs count = 0   (deleted:1, deletionsRejected:0)
  ```

- **Unvalidated replay inputs.** `src/sync/replay.ts:58-62` casts
  `log.rating as 1|2|3|4` without range-checking it and computes
  `elapsedDays: Math.max(0, Math.round(log.elapsedDays))` — `Infinity`/`NaN`
  pass straight through. A crafted review log can drive a card's memory/interval
  to arbitrary values.

**Why MEDIUM now.** No shipped code path lets a remote party hand a change set
to `applyChanges` yet (no transport). The reachable-today vector is a malicious
JSON backup: `validateExport` (`io.ts:194-251`) does no numeric/consistency
validation, so an imported record can carry `modified: Infinity` or a bogus
review log, which then dominates the first time any sync round runs. Once the
planned nostr relay transport exists, a hostile relay or a compromised second
device gets these primitives directly, and this becomes HIGH: silent data
destruction, resurrection of deleted records, and schedule poisoning of a peer's
collection.

**Fix.** Treat an authenticated peer's *content* as still untrusted. Re-derive
`version` from the record rather than trusting `upsert.version`; reject
non-finite or absurd (`> now + skew`) timestamps; range-check `rating`,
`elapsedDays`, and the memory fields before replay; and decide deliberately
whether review-log tombstones are ever legitimate (if logs are truly
append-only, refuse to delete them on merge).

---

### 5. LOW — Click-to-execute `javascript:` URLs survive the sanitiser

**File:** `src/domain/render.ts:102-103`.

The `javascript:` filter matches the literal scheme only and only in `href`/`src`.
`<a href="javascript&colon;…">` (HTML-entity colon) passes through unchanged
(confirmed: output identical to input); the browser decodes the entity and runs
the script when the link is clicked. Other script-capable URL attributes
(`xlink:href`, `formaction`) are not considered at all. Requires a click, hence
LOW, but it is the same root cause as Finding 1 and the DOM-allow-list fix
resolves it.

---

### 6. LOW — Imported media MIME type is attacker-controlled

**File:** `src/collection/io.ts:108-118` (`decodeMedia` keeps the backup's
`mime`), used at `src/ui/media-resolver.ts:72`
(`new Blob([file.data], { type: file.mime })`).

An imported backup fully controls each media file's MIME type and bytes, and the
resulting object URL is created with that type. Today the URL is only ever
assigned to an element's `src` by the resolver, where a `text/html` blob does not
execute, so impact is limited. It becomes dangerous if any future code navigates
to, or frames, a media object URL. Note also there is no cap on media size/count
in a backup (see Finding 8). **Fix:** store and serve media under a safe,
allow-listed MIME type derived from sniffing, not from the untrusted backup.

---

### 7. LOW — CI build has no dependency pinning

**File:** `.github/workflows/pages.yml:34-35` (`npm install --no-audit
--no-fund`); no `package-lock.json` exists in the repo.

The Pages build runs `npm install` with no lockfile, so the TypeScript
dependency (and anything it pulls) resolves floating at build time; a
compromised/typosquatted release could execute in CI, which holds `pages: write`
and `id-token: write`. Small surface (one devDependency) but worth closing.
**Fix:** commit a lockfile and use `npm ci`. Separately note the workflow
deploys `main`/`master`/`claude/fsrs-flashcard-webapp-4a8p83` only
(`pages.yml:11`), so the audited branch is not currently auto-published —
informational.

---

### 8. INFORMATIONAL — Unbounded work on attacker-controlled input

`importCollection` (`io.ts:141`) reads an entire backup into memory and writes it
with no limit on record count or media size, and `validateExport` iterates every
record — a large crafted backup can exhaust storage or wedge the tab. `parseCsv`
(`src/collection/csv.ts`) is linear and fine. `verifyEvent`/`schnorrVerify` are
bigint-heavy; a relay feeding many events would be a CPU sink, but that is
inherent and not reachable today. **Fix (pre-transport):** bound import sizes and
show progress; rate-limit/verify-then-store events when the relay path lands.

---

## Looked at and found no problem with (negative results)

- **BIP-340 signing/verification correctness.** `sign`/`verify` agree with all
  19 official vectors including the negative cases; the range checks match the
  spec (`r >= P`, `s >= n` rejected at `secp256k1.ts:342`; `liftX` rejects
  `x <= 0 || x >= P` at `secp256k1.ts:172`). secp256k1 has cofactor 1, so every
  `liftX` point is in the prime-order group — no invalid-curve/small-subgroup
  angle, and `sharedSecret` cannot reach infinity for a validated key.
- **NIP-44 encrypt/decrypt construction.** Encrypt-then-MAC with the MAC checked
  *before* decryption (`nip44.ts:169-174`), so there is no padding oracle; the
  MAC comparison is genuinely constant-time (`equalConstantTime`,
  `nip44.ts:177-182`); the pre-MAC error branches (version/size) key only on
  public length data. Nonce is a fresh 32 CSPRNG bytes per message, so no reuse.
  `paddedLength` matches the spec reference for all `1..65535` (no float drift),
  and `unpad` rejects an inconsistent declared length / padded length.
- **ChaCha20 keystream.** `readLe32`'s high-byte arithmetic tops out at exactly
  `0xffffffff` with no overflow; the NIP-44 vectors pass, which they cannot
  unless the keystream is exact.
- **Key generation.** `generateSecretKey` uses `crypto.getRandomValues` with
  correct rejection sampling into `[1, n-1]`.
- **Event validation.** `verifyEvent` re-derives the id from a canonical
  serialisation before checking the signature, so a relay cannot alter content
  under a valid signature; `isWellFormed` regex-validates hex fields before any
  hashing, so `hexToBytes` cannot throw on the happy path.
- **CSV parser** and **tombstone decorator design** (`clear()` deliberately
  records no tombstones) are sound.

## Could NOT check, and why

- **Timing / constant-time behaviour of the EC code.** The non-constant-time
  bigint arithmetic is real and openly acknowledged (`secp256k1.ts:16-24`).
  Confirming or refuting a *practical* key-recovery timing side channel needs a
  statistical timing harness on real target hardware, and — more to the point —
  a remote timing oracle, which the current app does not expose (the key never
  leaves the device and nothing signs on demand for a remote party). Left as a
  known limitation, not independently measured.
- **Live relay / on-the-wire behaviour.** There is no nostr transport in the
  tree, so I could not test relay-driven attacks against the real network path
  (event flooding, subscription abuse, metadata leakage to a relay operator).
  The merge-layer attacks were demonstrated against the in-process primitive
  instead; the relay privacy trade-offs are as the NIP-44 header describes and
  were not independently measured.
- **Service-worker cache poisoning persistence.** Demonstrating the persist step
  needs a served SW origin across restarts; I confirmed the XSS and reasoned the
  SW consequence from `sw.js`, but did not stand up a persistent PWA to script
  the cache overwrite.
- **Real IndexedDB backend.** Probes used the in-memory `Db`. The IndexedDB
  backend (`src/storage/indexeddb.js`) shares the merge/tracking logic but was
  not exercised in a browser; its behaviour under quota exhaustion (Finding 8)
  was not measured.
- **iOS/Safari PWA specifics** (storage eviction, standalone recovery) — needs
  real hardware.

---

*PoC scripts used for the demonstrated findings are transient and were run
against the compiled `dist/`; they are not committed. The key ones:
`sanitiseHtml`/`renderTemplate` + Chromium `innerHTML` for Finding 1, and
`applyChanges` on a `MemoryDb` for Finding 4.*
