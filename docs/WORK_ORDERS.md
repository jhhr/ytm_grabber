# YTM Practice Grabber — Work Orders for Phase Agents

You are one of a line of agents, each building **one small phase** of this work. A lead
reviews your work when you report back. You have no memory of earlier phases; what you
need is here.

**Your context is the budget.** Aim to finish well under 200k tokens. The rules below say
how. They are about not reading huge files whole and not maintaining big documents;
they are **not** a licence to skip what you need to understand. Careful, correct work
comes first.

## 1. What to read (and what not to)

1. This file, all of it. It is short on purpose.
2. `PLAN.md` (the spec, ~550 lines): always §1.5 (provider table), §2 (architecture and
   repo layout) and §7 (decisions, build phases); plus the sections your work order names.
   Find a section by searching for its heading and read that range; do not read it whole.
3. Reference sources, cloned by the lead outside the repo (read-only; search, then read
   ranges). `REF=/tmp/claude-0/-home-user-ytm-grabber/94a3bcf2-28ed-58c8-abe0-cbe846749d71/scratchpad`
   - `$REF/bl` — Better Lyrics at tag v3.0.0.4 (TypeScript). Lyrics stream:
     `src/modules/lyrics/providers/unified.ts`; Unison: `.../providers/unison.ts`; dock
     controls: `src/modules/ui/lyricsDock/controls.ts`; dock mount: `src/modules/ui/dom.ts`
     (1800 lines — never whole).
   - `$REF/braccato/package/dist/index.js` — BL's parsers (`@braccato/parsers` 0.3.2,
     MIT, minified, 22 KB). Enhanced LRC ≈ lines 330–420, QRC ≈ 540–660. Search, then
     read ranges.
   - `$REF/tony` — Tony (C++/Qt, GPL). `main/LyricsTtml.cpp` (`parseTtml`, `writeTtml`,
     `ttmlTime`), `main/Lyrics.cpp`, `testdata/lyrics/moises-exporter-words.ttml`. Read for
     behaviour only: **never copy Tony code or test data into this repo** (user's rule).
4. Code in this repo: no file is large yet. Read the modules your phase builds on (see
   section 3) and an existing test next to where yours will go, and copy its shape.

Do not read `docs/work-log-archive.md` (if it exists) unless section 3 below leaves a
specific question open; then search it.

## 2. Rules

**Scope**

- Build your phase only. If something from a later phase is needed, build the smallest
  part of it and say so.
- The spec is agreed with the user. Where it is silent, choose the simpler option and note
  it. Where it is **wrong or impossible**, do not improvise another design: finish what
  can be finished, leave the tree building and green, and report.
- Do not edit `LICENSE`, git configuration, or anything outside the repo (the reference
  clones included). Never push. No outward-facing actions of any kind.
- Match the surrounding code: naming, comment density, idiom. Comments say why.
- Pure logic lives in `src/shared/` and never touches `chrome.*` or the DOM; Chrome- or
  DOM-dependent code lives in `src/background/`, `src/content/`, `src/options/` and takes
  its Chrome APIs through small injectable seams so tests can pass fakes.
- TypeScript `strict`. No UI framework. No runtime dependencies in the extension.

**Safety rules (non-negotiable, from the spec)**

- BL's lyrics request body contains a JWT (`token=`), and its Unison request carries an
  `x-key-id` header. **Never store, log, or put into a message** any request body or
  request header. Read only `videoId` out of the body, in memory, and drop the rest.
- Committed fixtures contain **invented lyrics only** (real lyrics are copyrighted).
  Real captures go in `fixtures/local/` (gitignored); tests that use them skip when it is
  empty.
- The native host is the security boundary: validate everything it receives (§3.8).

**Environment**

- Linux container; the user runs **Windows x64 + Google Chrome**. Write paths and scripts
  for Windows where they run there (native host, installer, download paths); test what can
  be tested here.
- Node 22, npm (registry reachable through a proxy), Python 3.11, Chromium at
  `/opt/pw-browsers/chromium-1194` with Playwright 1.56.1 (`PLAYWRIGHT_BROWSERS_PATH` is
  set; **never run `playwright install`**), `xvfb-run` available.

**Build and test**

- `npm run build` (esbuild → `dist/`), `npm run typecheck` (tsc), `npm test` (vitest run;
  fast). One file: `npx vitest run test/<name>.test.ts`; one test: add `-t "<name>"`.
  DOM tests put `// @vitest-environment jsdom` at the top of the file.
- From B9 on: `python3 -m unittest discover -s native-host -p "test_*.py"`.
- From B8 on: `npm run test:e2e` (slow, Chromium; not part of `npm test`).
- Send long output to a log file in your scratch directory with the exit status written
  into it; look at the tail or grep it, never read it whole.
- While working, run **only your tests**. At the end run `npm run typecheck`,
  `npm test`, `npm run build` (and the Python suite from B9 on) **once**, and again only if
  something failed.
- Every behaviour gets a test that can fail. Show it for the two or three that matter
  most by breaking the code for a moment; not for every test. Undo the break **by hand**:
  never `git checkout`/`git restore` a file to revert an experiment.
- Do not weaken or delete an existing test to get green. If one is wrong because the
  behaviour was meant to change, change it and say so.

**Docs: almost none.** README, `docs/spike-notes.md` and the user checklist are written
once, by the last phase. You write only:

- one entry in the log (section 5), **25 lines at most**, appended at the end;
- "Done <date>" on your phase's line in `PLAN.md` §7.2 (the lead adds the commit), and a
  correction of any spec statement your work proved wrong.

Edit documents with the Edit/Write tools only: a shell heredoc or one-liner containing
backticks, `$` or non-ASCII text gets mangled and has corrupted documents before. Put
throwaway scripts in files.

**Git: the lead commits.** Do not commit, stage, stash, reset, or switch branches. Leave
your work in the tree and list every file you created or changed in your report.

**Report** (your final message; all the lead sees; under 60 lines)

- What was built, by file, briefly. Every file created/changed.
- The totals of the final full test runs, copied, not paraphrased.
- Which tests you saw fail without the change.
- Choices made, deviations, anything fragile or unfinished. Say it plainly: a problem
  reported is cheap, one found later is not.

## 3. State of the code (kept by the lead; as of 2026-10-04, after B5a)

- Tooling: TypeScript 7 (native `tsc`), esbuild 0.28, Vitest 5. `tsconfig.json` covers
  `src/` (`types: ["chrome"]`, no node); `test/tsconfig.json` extends it with node types +
  `allowJs`; `npm run typecheck` runs both. Vitest runs `test/**/*.test.ts` only.
- `build.mjs` → `dist/` (`--outdir <dir>`, `--watch`); `test/build.test.ts` checks every
  file the manifest references exists — extend it when you add an entry or static file.
- Manifest per §3.1 with a fixed `key`: **extension ID `mengelecikhhdpjdebjpokcmhdkhjobj`**.
- Entry stubs only: `src/background/sw.ts`, `src/content/main.ts`,
  `src/content/page-bridge.ts`, `src/options/options.ts`, `src/content/styles.css`.
- `src/shared/filenames.ts`: `sanitizeFilename()`, `buildStem({artist,title,videoId})`
  (throws on a bad id), `isVideoId()`, `MAX_STEM_LENGTH = 150` (UTF-16 units). Rules cover
  Windows **and** `chrome.downloads` (stricter). Contract: `test/fixtures/sanitize-vectors.json`.
- `src/shared/sse.ts`: `parseSse(text)` → `SseEvent[]` (`{ event, data }` or
  `{ event, data: null, error, rawData }`).
- `src/shared/sources.ts`: `extractSources(events, unisonRaw?)` → `{ metadata, sources }`;
  `LyricsSource { id, provider, blDisplayName?, label, timing, format, ext, mime,
  content }`; `format` is the dispatch key (`ttml | lrc | enhanced-lrc | qrc | plain |
  json`; Unison richsync LRC is `enhanced-lrc`); `SOURCE_FORMATS` for the 8 fixed ids;
  `ttmlTiming()`. Undecodable payloads become `.<provider>.json` sources, never a `.ttml`
  that is not TTML. Metadata: `song, artist, album, duration, videoId?`.
- Fixtures (invented song "Northbound Kites" by "Marrow & Tin"):
  `test/fixtures/synthetic-stream.txt` (all 7 providers; `:` comment lines explain the
  shape; Musixmatch word-by-word in separator style with a `[bg:]` part; QRC opens with 2
  credit lines and has `thou`+`sand` and parentheses; kugou LRC uses CRLF) and
  `test/fixtures/synthetic-unison.json` (richsync TTML). Byte-exact on disk.
- BL's real parsers, runnable: `node $REF/b2/check-bl.mjs <dir with fixtures> -v`, and
  `$REF/b2/bparsers` (a runnable copy of `@braccato/parsers` 0.3.2) to compare converter
  output against what BL itself parses.
- `src/shared/ttml.ts`: `TimedPiece { text, begin, end }` (s), `TimedWord { pieces }`,
  `TimedLine { words }`; `ttmlTime()`; `writeTonyTtml({ title?, lines })` (cleans text,
  drops empty pieces/words/lines; with no lines it writes an empty div, which Tony
  refuses - callers check `lines.length > 0`).
- `src/shared/convert/musixmatchWord.ts`: `parseEnhancedLrc(text)` -> `TimedLine[]` for
  every `format === "enhanced-lrc"` source (Musixmatch word-by-word, Unison richsync).
- `src/shared/convert/qrc.ts`: `parseQrc(text, { title?, artist? })` -> `TimedLine[]`
  (all leading credit lines dropped; uniform-timing credit test only in the first 5).
- `src/shared/tonyPick.ts`: `tonyReady(source, ctx)` -> `{ ok: true, content, ext,
  filename, timing, converted, label }` | `{ ok: false, reason }`; `pickForTony(sources,
  ctx)` -> `{ pick: (file + source) | null, skipped }`; `ctx = { stem, title, metadata? }`
  (`title` = "Artist - Title"); `TONY_MAX_BYTES`. Order and gap decisions: PLAN 7.1.
- `src/shared/blyrics.ts`: `BL_SELECTORS` (dock, inner, controls, refresh, refreshBusy,
  sourceName, offsetValue, sidePanel, lyricsWrapper, lyricsContainer),
  `BL_DOCK_POSITION_ATTRIBUTE`, `BL_VERIFIED_VERSION`, `sourcesForDisplayName(name,
  sources)` -> `{ downloadable: true, sources }` | `{ downloadable: false, why, reason }`.
- Background so far: `src/background/sw.ts` creates ONE capture store over
  `chrome.storage.session` and a top-level `chrome.runtime.onMessage` listener
  (`src/background/requests.ts` `createMessageListener({ store })`; `capture:get`
  answered, `lyrics:download` a stub until B6). `src/background/store.ts`
  `createCaptureStore({ area, ... })` -> `put(StoredCapture)`, `get(videoId)` (record +
  derived `sources`).
- `src/shared/summary.ts` (`StoredCapture`, `BodySource`, `summarize(capture, sources)` -
  never contents; its Tony pick uses a placeholder stem), `messages.ts` (requests,
  `CAPTURE_PORT = "capture"` with `start` / `ready` / `done` / `error`, guards that
  check shapes + `isVideoId`), `settings.ts` (`createSettingsStore(area)`; one item per
  setting), `storageArea.ts` (area interfaces, `isQuotaError`, `storedItemBytes`).
- Fakes: `test/helpers/fakeStorage.ts` (`FakeStorageArea` with quota, call log,
  `writtenText()` for secret checks, failure hooks; `FakeEvent`).
- Content may hold lone surrogates: `encodeURIComponent` throws on them (use TextEncoder
  or replace them before building a data URL).
- Test helpers: `test/helpers/tonyReader.ts` `readTony()` - an independent oracle of
  Tony's TTML rules; use it for round trips. `@braccato/parsers` 0.3.2 is a pinned
  devDependency: tests may compare against BL's own parsers (`parseLRC`, `parseQRC`).
  Goldens in `test/fixtures/golden/`.
- Platform traps found so far (everyone):
  - `\uXXXX` escapes written through the Write/Edit tools arrive as the literal character.
    In code use `\u{XXXX}` or `\xNN`, which survive. Keep source files ASCII.
  - Chromium in this container runs under the C locale and then rejects every non-ASCII
    download filename: launch it with `LANG=C.UTF-8`.

## 4. Phases

Done: B1, B2, B3, B4, B5a. (B5 and B7 were split in two after B1/B2 ran large.)

### B1 — Scaffold + filenames (spec §2 repo layout, §3.1, §3.2 `buildStem` bullet, §4 Phase 1)

- `package.json` (private, `"type": "module"`, scripts `build`, `watch`, `test`,
  `typecheck`, `gen-key`), `tsconfig.json`, `vitest.config.ts`, `build.mjs` (esbuild:
  `src/background/sw.ts` → `dist/background.js` as ESM, `src/content/main.ts` →
  `dist/content.js` IIFE, `src/content/page-bridge.ts` → `dist/page-bridge.js` IIFE,
  `src/options/options.ts` → `dist/options.js` IIFE; copy `static/` into `dist/` and
  `src/content/styles.css` → `dist/content.css`; `--watch`). Current stable dev
  dependencies, pinned with `^`; commit `package-lock.json`.
- `static/manifest.json` per §3.1; `static/icons/` (16/32/48/128 PNG, simple and
  generated by a committed script — no image tools are installed); `static/options.html`.
- `scripts/gen-key.mjs`: RSA-2048 key → base64 DER SPKI public key into the manifest
  `key`; extension ID = first 32 hex chars of SHA-256(DER) mapped `0-f` → `a-p`; private
  key PEM to `keys/` (gitignored); refuses to overwrite an existing key without `--force`;
  prints the ID. Export the ID function and test it. **Run it once** so the manifest has a
  key; put the ID in your log entry.
- Entry stubs that log once on load (SW, content, page bridge, options).
- `.gitignore`: `node_modules/`, `dist/`, `keys/`, `fixtures/local/*` (keep a
  `fixtures/local/README.md` saying what goes there).
- `src/shared/filenames.ts`: `sanitizeFilename()` and `buildStem()` per §3.2, plus
  `test/fixtures/sanitize-vectors.json` (input → expected output, ~25 cases incl.
  reserved names, trailing dots/spaces, control chars, `%`, non-ASCII, over-long input)
  used by `test/filenames.test.ts` — and later by the Python host, which must sanitise
  identically. Decide and document how the 150-char cap interacts with the `[videoId]`
  suffix (the id must survive).
- Tests: filenames; key/ID derivation; a build test that runs the build into a temp dir
  (or `dist/`) and checks every file the manifest references exists.

### B2 — SSE parsing + source extraction (spec §1.1, §1.5, §3.2 first two bullets, §4 Phase 2)

- `src/shared/sse.ts` `parseSse()` mirroring BL's `parseSSEMessage` exactly
  (`$REF/bl/src/modules/lyrics/providers/unified.ts` lines 340–411: blocks split on
  `/\n\n|\r\n\r\n/`, lines on `/\r?\n/`, `startsWith("event:")`/`("data:")`, value after
  the first `:` trimmed, data values concatenated with no separator, empty and `[DONE]`
  skipped). Malformed JSON → `{ event, data: null, error, rawData }`, never thrown.
- `src/shared/sources.ts` `extractSources(events, unisonRaw?)` → `{ metadata, sources }`
  per §1.5 and §3.2 (`LyricsSource`). `unisonRaw` is the Unison response body text;
  its payload is under `data` (§1.1). Provider decoding exactly as BL does
  (`processStreamData`, lines 413–594): golyrics double-encoded or raw; binimum
  `timingType`; qq/kugou nested JSON `.lyrics`. A nested-JSON failure drops that source
  only (keep the provider's raw `results` as a `.<provider>.json` source instead).
  Timing: golyrics from `itunes:timing` on `<tt>`; Unison from `syncType`.
- `test/fixtures/synthetic-stream.txt` + `test/fixtures/synthetic-unison.json`: structure
  exactly as BL consumes it (§4 Phase 2 lists every part), **invented lyrics**; the TTML
  in golyrics should look like Apple TTML with word spans and one backing-vocal `<p>`
  with a group `ttm:agent`. The real `done` event payload is unknown: use
  `event: done` + `data: {}` and say so.
- Tests: every provider row of §1.5; the cases listed in §4 Phase 2 (CRLF, split `data:`
  lines, raw golyrics, unknown provider, malformed block); Unison 3 formats + missing
  `data`; empty strings produce no source.

### B3 — Tony TTML writer + enhanced-LRC converter (spec §1.6, §3.2 `writeTonyTtml` bullet, §3.2.1, §4 Phase 2b)

- `src/shared/ttml.ts`: types `TimedPiece { text, begin, end }` (seconds, absolute),
  `TimedWord { pieces }`, `TimedLine { words }`; `writeTonyTtml({ title, lines })` →
  string exactly in the §1.6 style, with the lead-checked `ttmlTime` rules in §1.6.
  Golden file `test/fixtures/golden/*.ttml` compared byte for byte.
- `src/shared/convert/musixmatchWord.ts`: enhanced LRC → `TimedLine[]`, both styles,
  `[bg:]` dropped, header tags, offset, several line stamps (§3.2.1 and the lead check
  under it). A piece with no closing tag ends at the next line's start (last line: begin
  + 1 s) — note it. Used for Musixmatch `wordByWord` and Unison richsync LRC.
- `test/helpers/tonyReader.ts`: a small reader applying Tony's rules from §1.6 (absolute
  times; adjacent spans = one word; space separates words; skip `x-bg`/`x-translation`/
  `x-roman`/`x-romanization` roles; `<p>` without timed spans = one word; refuse DOCTYPE
  and > 1 MiB). Check its behaviour against `$REF/tony/main/LyricsTtml.cpp` `parseTtml`.
- Tests: golden output; XML escaping; times ≥ 10 min and ≥ 60 min; separator style with
  timed spaces; compact style; hyphen split `hy-` + `phenated` → one word of two spans;
  `[bg:]`; offset; converted output read back through `tonyReader` gives the same words
  and times (to the ms); `fixtures/local/` real-capture checks that skip when empty.

### B4 — QRC converter + Tony pick + BL map (spec §1.4, §3.2 `blyrics.ts` bullet, §3.2.2, §3.2.3)

- `src/shared/convert/qrc.ts` → `TimedLine[]` per §3.2.2 and the lead check under it
  (entity decoding incl. numeric; credits; offset; parentheses inside lyrics).
- `src/shared/tonyPick.ts`: `tonyReady(source, ctx)` (one source → Tony-ready
  `{ content, ext: ".ttml" | ".lrc", timing, converted }` or a reason it can't be) and
  `pickForTony(sources, ctx)` = the §3.2.3 order mapped through `tonyReady`; candidates
  failing Tony's checks (> 1 MiB UTF-8, `<!DOCTYPE` any case) are skipped with a warning.
  Converted TTML title = `Artist - Title`.
- `src/shared/blyrics.ts`: every BL selector from §1.4 (+ `#blyrics-wrapper`,
  `.blyrics-container`), `BL_VERIFIED_VERSION = "3.0.0.4"`, and the displayName → source
  ids map (§3.2 bullet; YouTube / YouTube Captions → not downloadable, with reason).
- Tests: QRC rules one by one; every pick branch of §3.2.3; Tony checks; map lookups.

### B5a — Messages, settings, capture store (spec §3.3 steps 1–6 for the protocol, §3.4, §3.9)

- `src/shared/messages.ts`: the typed content ⇄ SW protocol for the whole extension so
  far: `capture:get { videoId }` → summary or none; capture over a
  `chrome.runtime.connect` port named `capture` (content posts `start { videoId }`; SW
  posts `ready` after `Network.enable`, then `done { summary }` / `error { reason }`);
  `lyrics:download` (B6 fills in the handler). Leave audio messages to B10.
- Capture summary (what the content script gets): videoId, capturedAt, metadata,
  bodySource, source summaries (id, label, timing, format, ext, size, blDisplayName) and
  the Tony pick summary — never contents. The Tony pick does not exist until B4 is
  committed; if B4 is done, use `pickForTony`, else leave a typed slot.
- `src/shared/settings.ts`: `captureMode` (`"on-demand"` default | `"always"`),
  `perSongSubfolder` (false), `downloadDirOverride` (""), `debugCapture` (false),
  `learnedDownloadDir` (""), in `chrome.storage.local`; defaults, typed get/set, change
  subscription; storage injected for tests.
- `src/background/store.ts` per §3.4 incl. the lead decision: raw inputs only, sources
  derived on read, LRU by count (30) and size (~8 MB), quota error → evict oldest, retry
  once. Storage area injected.
- Tests: settings defaults/merge; store put/get/derive, both evictions, quota retry,
  `capture:get` summary shape; a summary never contains source contents.

### B5b — Capture manager (spec §1.2, §1.3, §3.3, §4 Phase 3)

The risky phase. Read §3.3 in full including the lead decision inside it.

- `src/background/capture.ts`: on-demand capture per §3.3 with the three body paths,
  injected `chrome.debugger`-like API; always-attached mode behind `captureMode`
  (attach to music.youtube.com tabs on load, capture passively, detach when switched
  off); wiring in `sw.ts` (all listeners registered synchronously at top level; the
  `capture` port; `capture:get`) and a `captureNow(tabId)` dev helper on `globalThis`.
- Tests with a fake `chrome.debugger`: all three body paths (+ base64); Unison 200/404 and
  the 2 s grace; timeout; `onDetach` mid-capture; attach failure message; a second request
  joins the first; `verify-turnstile` and `/lyrics/<id>/vote` ignored; videoId mismatch;
  detach always called; **the token and `x-key-id` value never appear in stored data,
  logs, or messages** (assert on everything the fake storage/console/port received).

### B6 — Lyrics downloads + menu model (spec §3.5 menu items, §3.6, §7.1 stem decision)

- `src/background/downloads.ts` (data-URL download, subfolder option, learned download
  dir with a pure `dirFromDownloadedPath()` for Windows and POSIX paths) and the SW
  handler `lyrics:download { videoId, itemId, stem }` (re-sanitises the stem, derives
  content from the stored capture, never includes BL's offset).
- `src/shared/menuModel.ts` (pure): capture summary + showing display name + stem →
  menu items (Tony pick first and bold, "what's showing", other sources with "(showing)"
  and "→ TTML" items, raw `.lyrics-stream.txt`, re-capture), with disabled reasons.
- Tests: every menu branch; filenames with/without subfolder; data-URL encoding of
  non-ASCII; learned-dir extraction; download handler with a fake `chrome.downloads`.

### B7a — Page bridge + now playing + lyrics button placement (spec §1.4, §3.5 first two bullets, §3.7 first bullet)

- `src/content/page-bridge.ts` complete (§3.7 first bullet; `musicVideoType` included;
  reply `detail` is a JSON string), `src/content/nowPlaying.ts` (asks the bridge with a
  short timeout; isolated-world fallback from the URL `v` param + player bar text; builds
  the stem with `buildStem`, catching its throw), `src/content/lyricsButton.ts`
  (debounced MutationObserver; one `pg-` button in `.blyrics-dock__inner` after
  `__controls`; re-insert; fallback floating button in `#side-panel` ~3 s after BL lyrics
  appear without a dock), `src/content/main.ts` bootstrap, `styles.css` for the button.
  Clicking calls a handler B7b provides (a stub that logs is fine).
- Add jsdom as a dev dependency.
- Tests (jsdom): insertion after `__controls`; survives `__controls` replacement and its
  own removal; never inside `__controls`; one button only; fallback button appears and
  goes away when a dock appears; bridge reply JSON string; nowPlaying fallback.

### B7b — Lyrics menu popover + capture flow (spec §1.3, §3.5)

- `src/content/menu.ts` (renders the B6 menu model in a popover appended to
  `document.body`, positioned at the button, flipped by the dock's `data-position`;
  Esc/outside-click close; disabled items show their reason), the click flow
  (`capture:get` → if missing "Capturing…", open the `capture` port, click
  `.blyrics-dock__refresh` on `ready`, render on `done`, error states; missing refresh
  button → the §3.5 message; "Re-capture"), downloads via `lyrics:download`, the offset
  toast.
- Tests (jsdom): menu render, disabled items, Esc/outside close, flip; flow with a fake
  port incl. error and missing-refresh; joining when clicked twice; offset toast only when
  non-zero.

### B8 — End-to-end test in Chromium (new; see §7)

- `test-e2e/` + `npm run test:e2e`: Playwright (`playwright-core` pinned to the installed
  1.56.1) launches the Chromium above with `dist/` loaded as an extension (headless=new,
  else `xvfb-run`), a local HTTPS server (test-only self-signed cert), and
  `--host-resolver-rules` mapping `music.youtube.com`, `lyrics.api.dacubeking.com`,
  `unison.betterlyrics.org` to it, plus `--ignore-certificate-errors`.
- Mock page: BL dock DOM as in §1.4 whose refresh button POSTs a form body with a fake
  `token=` to `/v2/lyrics` and GETs Unison with a fake `x-key-id`, then replaces
  `__controls` like BL; `#movie_player` stub in the main world; player bar element for B10.
  The server streams the synthetic SSE in several chunks with delays,
  `content-type: text/event-stream`.
- Scenario: button appears → click → capture → menu → "Download TTML for Tony" → file
  equals the fixture's golyrics TTML byte for byte; raw download equals the stream;
  storage contains neither fake secret; report which `bodySource` real streaming used.
- Time-box: if extensions or `chrome.debugger` cannot run here after reasonable attempts,
  stop, leave what works, and report exactly what was tried.

### B9 — Native host (spec §3.8, §4 Phase 5, §7.1 subfolder decision)

- `native-host/ytm_grabber_host.py` (stdlib only; stdin reader thread, stdout writes under
  a lock, one or more downloads, `cancel`, `ping`, `reveal`), `config.example.json`,
  `install.ps1`, `uninstall.ps1`, `test_host.py` + a fake yt-dlp script.
- Sanitising must give the same results as `filenames.ts` on
  `test/fixtures/sanitize-vectors.json`.
- If `pip install yt-dlp` works into a scratch venv, check the §3.8 flag combination
  against a small media file served over local HTTP (no `-x`, no ffmpeg needed) and report
  what stdout/stderr actually contain. Never add yt-dlp to the repo.
- Tests: framing (incl. a > 64 KB message), every validation rule, `%` doubling, cancel,
  progress parsing, final path, error with stderr tail, missing yt-dlp, `subfolder`.

### B10 — Audio button + SW audio relay (spec §3.7, §3.8 protocol)

- `src/background/audio.ts` (native port, progress relay to the tab, outputDir
  resolution, readable errors such as host not registered), `src/content/audioButton.ts`
  (player bar insertion with re-insert, states, OMV warning with "Download anyway").
- Tests: fake native port (progress, done, error, disconnect + `lastError`), button states,
  OMV warning, re-insertion.

### B11 — Options page + end-to-end audio (spec §3.9)

- `src/options/options.ts` + `static/options.html`: every setting, learned folder with
  override, Test connection (`ping`).
- e2e: register the real Python host for the test profile (Linux Chromium reads
  `<user-data-dir>/NativeMessagingHosts/`) with a config pointing at the fake yt-dlp;
  audio button → file appears; options Test connection shows versions. Same time-box rule
  as B8.

### B12 — Documentation pass

- `README.md` (Windows install: build → load unpacked → `install.ps1 -ExtensionId …` →
  Test connection → optional `--silent-debugger-extension-api`; usage; troubleshooting per
  §4 Phase 7), `docs/spike-notes.md` (the 👤 checks from §4 as a checklist the user can
  run, incl. which `bodySource` real Chrome uses and the live selectors), `PLAN.md`
  brought up to date with what was built and a "Known limitations and open points"
  section. No code: suspected bugs go in the report.

## 5. Log (newest last; 25 lines at most per entry)

Template:

    ### B<n> — <date>
    Built: ...
    Choices / deviations: ...
    The next phase must know: ...
    Left open: ...

### B1 — 2026-10-04
Built: scaffold (TypeScript 7.0.2 native `tsc`, esbuild 0.28, Vitest 5 on Vite 8), `build.mjs`
(`--outdir`, `--watch`), §3.1 manifest, icons from `scripts/make-icons.mjs`, stubs, `gen-key.mjs`,
`src/shared/filenames.ts` + `test/fixtures/sanitize-vectors.json`; tests: filenames, key/ID, build.
**Extension ID `mengelecikhhdpjdebjpokcmhdkhjobj`** (pinned in `test/gen-key.test.ts`; Chromium 141
loading `dist/` reports the same). Private key `keys/extension-key.pem` exists only in this tree.
Choices / deviations:
- `tsconfig.json` = `src/` with `types: ["chrome"]` only; `test/tsconfig.json` extends it with
  `node` and `allowJs` (tests import `scripts/*.mjs`); `typecheck` runs both. @types/node ^22.
- Illegal characters become a space. `chrome.downloads` rejects far more than Windows (Cf such as
  ZWJ/LRM/soft hyphen, C1, noncharacters, whitespace/`.`/`~` at either end, CLOCK$, desktop.ini,
  thumbs.db), so the rules cover both (PLAN §3.2 noted); Chromium 141 accepted 1028 outputs.
- Cap = 150 UTF-16 units; `buildStem` cuts only "Artist - Title" (to 136), its output is a fixed
  point of `sanitizeFilename`, and it throws unless `isVideoId(videoId)` (`^[A-Za-z0-9_-]{11}$`).
- `build.mjs` empties only the default `dist/`, never a custom `--outdir`.
The next phase must know:
- B9: count UTF-16 units, not `len()` (emoji vectors at the cap); reserved names are ASCII-case-
  insensitive (`re.ASCII`: plain IGNORECASE matches the Kelvin sign to `k`); check ids with
  `re.fullmatch` (`$` matches before a trailing newline); Cf via `unicodedata.category`.
- B6/B8: under this container's default C locale Linux Chromium rejects every non-ASCII download
  filename ("Invalid filename"); launch it with `LANG=C.UTF-8`.
- Backslash-u escapes written through Write/Edit arrive as literal characters (a literal U+2028
  broke a regex); in code use the `\u{...}` or `\xNN` forms, which survive.
Left open: with the per-song subfolder, `<dir>\<stem>\<stem><ext>` can exceed Windows' 260-char
MAX_PATH for near-cap stems (150 + 1 + ~170 + dir); typical stems are far shorter.

### Lead after B1 — 2026-10-04 — 0348fed
Reviewed `filenames.ts`, re-ran typecheck/tests/build (82 passed); committed. B1 used ~260k
tokens: later phases, stay on your work order — probe Chromium only where it decides
something your phase builds. Traps moved into section 3.

### B2 — 2026-10-04
Built: `src/shared/sse.ts` `parseSse()` (BL's parseSSEMessage rule for rule, plus the BOM drop BL's
TextDecoder does); `src/shared/sources.ts` `extractSources(events, unisonRaw?)` → `{ metadata, sources }`,
`ttmlTiming()`, `SOURCE_FORMATS`; fixtures `synthetic-stream.txt` (all 7 providers incl. kugou; `:` comment
lines document the shape) + `synthetic-unison.json` (richsync TTML); tests `sse.test.ts`, `sources.test.ts`.
Choices / deviations:
- `LyricsSource.format` (`ttml|lrc|enhanced-lrc|qrc|plain|json`) is the dispatch key; Unison richsync LRC is
  `enhanced-lrc`. `SOURCE_FORMATS` maps the 8 fixed ids (Unison's format follows its response).
- golyrics/binimum text with no `<tt>` start tag, or qq/kugou whose nested JSON does not decode, becomes a raw
  `.<provider>.json` source (format `json`, no blDisplayName): never a `.ttml` that is not TTML.
- Unknown provider id: lower-cased, runs outside `[a-z0-9_-]` → `_`, max 40 chars, `_`/`-` trimmed, `unknown`
  if empty; a known id gets `-raw` (a stream provider "unison" cannot replace the Unison source).
- Timing: qq `word`; Unison richsync `word` (syllable vs word cannot be told from its metadata); Unison LRC
  not richsync `line` (as BL); TTML without `itunes:timing` `unknown`; binimum without timingType → TTML attr.
- Blank strings count as empty. Metadata: non-blank strings, finite duration (numeric strings too), videoId
  only if `isVideoId`; last metadata event wins; a repeated provider block wins per source id.
The next phase must know:
- Fixture: golyrics single-line Apple TTML, plain seconds below 60 s and `m:ss.mmm` from 1:00 (my belief
  about Apple, unverified); binimum AMLL-like `mm:ss.mmm`, `x-bg` span, no `itunes:timing`; wordByWord in
  separator style with a `[bg:]` part; QRC opens with 2 credit lines; kugou LRC uses CRLF + a title line.
- BL's own parsers run over the fixture as intended: `node $REF/b2/check-bl.mjs <dir with the fixtures> -v`
  (`$REF/b2/bparsers` is a runnable copy of @braccato/parsers; compare converters against it).
- Real metadata fields beyond song/artist/album/duration are unknown: the fixture has no videoId.
Left open: the real `done` payload (`{}` used); `mime` values untested against Chrome's download naming.

### B3 — 2026-10-04
Built: `src/shared/ttml.ts` (`TimedPiece/Word/Line`, `ttmlTime`, `writeTonyTtml`); `src/shared/convert/musixmatchWord.ts`
`parseEnhancedLrc` (Musixmatch wordByWord and Unison richsync LRC); `test/helpers/tonyReader.ts` `readTony` (oracle with a strict
hand-written XML tokenizer, no jsdom); goldens `test/fixtures/golden/{writer-basic,musixmatch-word}.ttml`; tests `ttml`,
`musixmatchWord`, `tonyReader`. Dev dependency `@braccato/parsers` 0.3.2 (exact; same bytes as `$REF/braccato`): tests check our
words and piece starts against BL's own `parseLRC`.
Choices / deviations:
- Writer cleans each piece (drops what XML 1.0 forbids, tab/CR/LF to space, trims); pieces, words and lines left empty are
  dropped and use no key; a blank title writes no `<ttm:title>`. `<p>` begin = earliest piece begin (the first, for lyrics in
  time order); body/div end = latest begin or end, as Tony's writer. Non-finite time: RangeError. No lines: empty div.
- Converter follows BL where PLAN 3.2.1 wording differed (annotated there): two adjacent tags are no separator; in compact
  style leading white space also starts a word. Unlike BL: `[offset:]` in ms (BL: seconds); credit-like lines kept (BL drops
  them); a piece with inner spaces stays one piece (BL's renderer splits it); unclosed piece on the last line = begin + 1 s.
- Tony and short pieces: a word ends at its LAST span's end; end == begin is accepted silently; end < begin becomes begin with
  the warning "word ended before it started". The writer keeps times as given.
The next phase must know:
- B4: `parseEnhancedLrc(source.content)` for every `format === "enhanced-lrc"` source; check `lines.length > 0` before
  `writeTonyTtml({ title: "Artist - Title", lines })`, else Tony gets a file with no words. QRC can produce `TimedLine[]` and use
  `readTony` (test/helpers) for its round trip. Writer and converter are not imported by any entry yet.
- `test/fixtures/golden/musixmatch-word.ttml` is a converted synthetic file: B12 can point the 👤 Tony import check at it.
Left open: `fixtures/local/` is empty, so that test skips (it passed once against a temporary copy of the synthetic stream).

### B4 — 2026-10-04
Built: `src/shared/convert/qrc.ts` `parseQrc(text, { title?, artist? })`; `src/shared/tonyPick.ts` `tonyReady`, `pickForTony`,
`TONY_MAX_BYTES`; `src/shared/blyrics.ts` `BL_SELECTORS`, `BL_DOCK_POSITION_ATTRIBUTE`, `BL_VERIFIED_VERSION`, `sourcesForDisplayName`;
golden `test/fixtures/golden/qq.ttml`; tests `qrc` (incl. a cross-check against BL's `parseQRC`), `tonyPick`, `blyrics`.
Choices / deviations:
- QRC credits as specified (first 5 lyric lines, stop at the first non-credit) with BL's exact key list (49 keys, role split, short-role
  suffix rule, 40-char key limit); title/artist from the context and `[ti:]`/`[ar:]`. BL itself differs (note added under PLAN 3.2.2):
  window "until 5 kept", key lines dropped anywhere, a fuzzy similarity rule (left out: it drops real first lines), singer labels.
- Entities decoded once, in the attribute only (raw QRC is not XML); bad references U+FFFD. Lines with no text are skipped, uncounted.
- `TonyContext = { stem, title, metadata? }`: the capture's song/artist feed QQ credit detection. `tonyReady` -> `{ ok: true, content,
  ext, filename, timing, converted, label }` | `{ ok: false, reason }`; `TonyPick` = the file + `source`. Labels "<BL name> —
  word timing[, converted]". A converter that throws makes that source not ready (reason), never the whole pick.
- Pick order and gap decisions: PLAN 7.1 row. `skipped` lists tried candidates only (plain/JSON never are). DOCTYPE refused in any
  case, anywhere, LRC too; size in UTF-8 bytes, exactly 1 MiB accepted.
- `sourcesForDisplayName` -> `{ downloadable: true, sources }` (non-empty, best first, only sources carrying that display name, so
  never raw JSON) | `{ downloadable: false, why: "youtube" | "not-captured" | "unknown-name", reason }`.
- `offsetValue` is `.blyrics-dock__offset > .blyrics-dock__offset-value`: BL's body-rendered offset menu reuses the class.
The next phase must know:
- B5a: call `pickForTony(sources, { stem, title, metadata })`; summarise `pick.source.id`, `label`, `filename`, `timing`, `converted`
  and `skipped`. B6: "what's showing" = `sourcesForDisplayName`, then the first source whose `tonyReady` is ok; an LRC pick's label
  does not say LRC (its `ext` does).
- As-is content may hold lone surrogates (JSON `\ud800`): `encodeURIComponent` throws on them (B6 data URLs); TextEncoder does not.
Left open: `fixtures/local/` is empty, so the real-capture QQ test skips.

### Lead after B4 — 2026-10-04 — bcc8ce5
Changed `parseQrc`: any number of leading credit lines is dropped (stop rule kept); only the
uniform-timing test is limited to the first 5 lyric lines (PLAN 3.2.2 note). Tests updated
and seen failing with the window removed. B2-B4 each used ~260-275k tokens.

### B5a — 2026-10-04
Built: `src/shared/storageArea.ts` (area seams, `isQuotaError`, `storedItemBytes`), `summary.ts` (`StoredCapture`, `BodySource`, `summarize`),
`messages.ts` (requests + responses, `CAPTURE_PORT` and its messages, guards), `settings.ts` (`createSettingsStore(area)`); `src/background/store.ts`
(`createCaptureStore({ area, now?, maxCaptures?, maxBytes? })` -> `put`, `get`), `requests.ts` (`handleCaptureGet`, `createMessageListener`); `sw.ts`
answers `capture:get` from a store over `chrome.storage.session`. Test helper `test/helpers/fakeStorage.ts` (`FakeStorageArea`, `FakeEvent`).
Choices / deviations:
- Chromium source: the SESSION area's quota error is "Session storage quota bytes exceeded. Values were not stored." and it charges a memory
  estimate; "Resource::kQuotaBytes quota exceeded" and key + JSON are the local/sync rules. The store matches /quota/i and budgets key + JSON in
  UTF-8 (8 MiB; over-counts long strings, so safe). The fake has `kind: "session" | "local"` (wording; fails at >= vs > quota). PLAN 3.4 note.
- Capture and index go in ONE `set()` (Chrome applies it whole), not two writes. Evicted captures are removed first; if the write then fails the
  index is rewritten without them; `get()` drops entries whose capture is missing and removes captures the index does not list.
- LRU = `lastUsed` in the index (put and `get` count; stamps never go back with the clock); the index is kept in that order.
- `summarize` runs `pickForTony` with an empty stem and title (comment says why); only the winning source's id/label/timing/ext are kept.
- Malformed requests get no reply (listener returns false); a failing handler still answers (`{ summary: null }` / `{ ok: false, error }`).
  `lyrics:download` answers an error stub until B6.
- Settings: one local item per setting (the options page and the SW cannot overwrite each other); `onSettingsChanged(cb)` passes the changed
  settings' new values (defaults for removed or ill-typed ones) and returns an unsubscribe function.
The next phase must know:
- B5b: store a `StoredCapture` (copy fields by name; `put` also drops unknown fields), then `summarize(capture, sources)` for `done`. `put`
  rejects with readable errors (too big, storage full). Serialisation is per store instance: use the one created in `sw.ts`.
- B6: `store.get(videoId)` returns `sources` with contents; run `tonyReady`/`pickForTony` again with the real stem and title; replace the stub
  in `requests.ts`. Fake: `calls`, `writtenText()` (all set() input, for secret checks), `beforeSet`/`beforeRemove` hooks inject failures.
Left open: a capture the index does not list (only after index corruption) is removed only when `get()` meets it.
