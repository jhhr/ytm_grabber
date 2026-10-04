# YTM Practice Grabber — implementation plan

A personal Chrome (MV3) extension for music.youtube.com that removes the manual steps from my singing-practice prep:

1. **Audio button** in the YouTube Music player bar → runs `yt-dlp -x <videoId>` on my machine and saves the audio to my browser download folder.
2. **Lyrics button** in the Better Lyrics (BL) lyrics dock → downloads **Apple-style TTML for my Tony fork** ([jhhr/tony](https://github.com/jhhr/tony)): BL's `golyrics` TTML as-is when it exists, otherwise the best other source converted to the same TTML style. Every other source BL fetched can also be downloaded in its native format.

Today I do step 2 by hand: open DevTools → Network, find BL's `lyrics` request, copy the response, and cut the `golyrics` TTML out of it. Step 3 of my workflow (splitting stems in Moises) stays manual and is out of scope.

**Environment:** Windows x64, Google Chrome, Better Lyrics **v3.0.0.4** (all BL references below were checked against that version's source at github.com/better-lyrics/better-lyrics). Python 3 is available (conda). `yt-dlp` and `ffmpeg` are installed or installable.

---

## 1. What we learned from the Better Lyrics source (read this first)

### 1.1 How BL gets its lyrics

- `src/modules/lyrics/providers/unified.ts` → `startStream()` does
  `POST https://lyrics.api.dacubeking.com/v2/lyrics`
  with an `application/x-www-form-urlencoded` body: `videoId`, `song`, `artist`, `duration`, `album`, `alwaysFetchMetadata`, `isrc` (optional) and **`token` (a JWT BL obtained via a Cloudflare Turnstile challenge)**.
- The response is a Server-Sent-Events stream (the format in my DevTools capture): an `event: metadata` block, then one `event: provider` block per source, then `event: done`. BL parses it with `parseSSEMessage()` — split on blank lines, read `event:` and concatenate trimmed `data:` lines, `JSON.parse` the data.
- A second, separate source: `src/modules/lyrics/providers/unison.ts` does
  `GET https://unison.betterlyrics.org/lyrics?v=<videoId>&song=…&artist=…&duration=…[&album=…]` → JSON **wrapped in `data`**: `{ "data": { id, videoId, song, artist, lyrics: string, format: "ttml" | "lrc" | "plain", syncType: "richsync" | "linesync" | "plain", voteCount, … } }` (community "Unison" lyrics). HTTP 404 means "no Unison lyrics". The request carries an `x-key-id` header (BL's user identity): never store or log request headers. *(Lead check, BL 3.0.0.4 `unison.ts`.)*

### 1.2 Why the Moises-Lyric-Exporter trick doesn't carry over

The Moises exporter works because Moises' **own page code** fetches `lyrics.json`, so patching `window.fetch` in the page's MAIN world sees it. Here the request is made by **BL's content script, which runs in BL's own ISOLATED world**. Isolated worlds have their own `window.fetch`, so:

- patching `fetch`/XHR in the MAIN world will **not** see BL's request;
- our own content script is a different isolated world and can't see it either;
- BL keeps the parsed results in **its own `chrome.storage.local`** (`blyrics_<videoId>_<providerKey>`, compressed, 7-day TTL), which another extension cannot read.

BL does publish parsed lyrics on a DOM event (`blyrics-pip-lyrics`), but only while its Picture-in-Picture window is open, and only in BL's parsed form (not the raw TTML). Not usable.

**Conclusion:** the reliable way to get the raw response is the Chrome DevTools Protocol through the `chrome.debugger` API — the same data I currently copy from the Network tab, just automated. Requests from other extensions' content scripts are visible to a debugger attached to the tab (that's why they show up in the page's DevTools).

### 1.3 Caching and how to force a fresh request

- BL caches every source for 7 days. If a song was loaded before, BL makes **no network request**, so there is nothing to capture.
- BL's dock **refresh button** (`.blyrics-dock__refresh`) calls `refreshCurrentSong()` (`src/core/appState.ts`), which calls `resetUnifiedStream(videoId)` + `clearSongCache(videoId)` and reloads → a fresh `v2/lyrics` request. Clicking that button from our content script (`button.click()`) works across worlds because it is a real DOM event.
- While the refresh is running BL adds `.blyrics-dock__refresh--busy` to the button.
- BL aborts its stream after 20 s (`AbortSignal.timeout(20000)`).

### 1.4 BL's dock DOM (where our lyrics button goes)

`src/modules/ui/dom.ts` → `mountDock()` (dock + `__inner`); the controls are built in `src/modules/ui/lyricsDock/controls.ts` → `buildControlsSegment()` (lead check, 3.0.0.4):

```
#side-panel
  └─ .blyrics-dock[data-position]           (persists across songs)
       └─ .blyrics-dock__inner              (persists — insert our button here)
            └─ .blyrics-dock__controls      (REPLACED on every song/provider switch — don't insert here)
                 ├─ .blyrics-dock__source > .blyrics-dock__source-trigger
                 │     └─ .blyrics-dock__source-label > .blyrics-dock__source-name   ← current provider display name
                 ├─ .blyrics-dock__control … (translate, romanize, PiP…)
                 ├─ .blyrics-dock__control.blyrics-dock__refresh
                 └─ .blyrics-dock__offset > .blyrics-dock__offset-value
```

Also checked: `__source-label` holds a second span `.blyrics-dock__source-position` (e.g. `2/5`), so read the text of `.blyrics-dock__source-name` only. `mountDock` *prepends* a new `__controls` when there is none and BL *appends* a `.blyrics-dock__voting` segment to `__inner` for Unison lyrics; neither touches other children of `__inner`. `__inner` has a click listener that blurs the clicked button (harmless). The refresh button's click handler adds `--busy` and calls `refreshCurrentSong()`; nothing removes `--busy` except the controls being rebuilt.

BL's lyrics themselves render into `#blyrics-wrapper` / `.blyrics-container` (`@braccato/core` 1.16.3 constants `LYRICS_WRAPPER_ID`, `LYRICS_CLASS`) — use these to tell "BL has lyrics up but no dock" for the fallback button in §3.5.

Notes: the dock can be turned off in BL settings, and the set/order of dock controls is user-configurable (`dockControlsOrder`), so the refresh button may be absent. BL appends its own source menu to `document.body` to avoid clipping — do the same for our menu.

### 1.5 Provider → payload → file mapping

`displayName` values come from `PROVIDER_CONFIGS` in BL's `src/core/constants.ts` (not localized). These are what `.blyrics-dock__source-name` shows.

| SSE `provider` | Field(s) in `results` | How to decode | BL display name | Native file | For Tony |
|---|---|---|---|---|---|
| `golyrics` | `lyrics` | Usually a JSON string `{"ttml": "<tt …>"}`; sometimes raw TTML. Try `JSON.parse`, use `.ttml` if present, else the string as-is (same as BL). Timing from `itunes:timing="Word"\|"Line"` on `<tt>` | Better Lyrics | `.golyrics.ttml` | **as-is** (word timing with ends — what I use today) |
| `binimum` | `lyrics`, `timingType` (`"line"`/`"syllable"`) | Raw TTML string | BiniLyrics | `.binimum.ttml` | as-is (syllable or line timing) |
| `musixmatch` | `wordByWord` (enhanced LRC with `<mm:ss.xx>` word tags), `synced` (LRC) | strings | Musixmatch | `.musixmatch-word.lrc`, `.musixmatch.lrc` | `wordByWord` → **converted** to TTML (§3.2.1); `synced` LRC is readable by Tony as-is (line timing) |
| `lrclib` | `synced` (LRC), `plain` | strings | LRCLib | `.lrclib.lrc`, `.lrclib.txt` | LRC as-is (line timing); plain not usable |
| `qq` | `lyrics` | JSON string whose `.lyrics` is QRC XML (`<QrcInfos>` … `LyricContent="…"`) | Better Lyrics Portato | `.qq.qrc.xml` | **converted** to TTML (§3.2.2) |
| `kugou` | `lyrics` | JSON string whose `.lyrics` is LRC | Better Lyrics Legato | `.kugou.lrc` | LRC as-is (line timing) |
| *(unison request)* | `data.lyrics`, `data.format`, `data.syncType` | per `format`; `syncType: "richsync"` LRC is word-synced (enhanced LRC, same tag syntax as Musixmatch `wordByWord`) | Unison | `.unison.ttml` / `.unison.lrc` / `.unison.txt` | TTML as-is; richsync LRC → **converted** with the §3.2.1 converter; line LRC as-is |
| *anything else* | — | keep `results` as-is | — | `.<provider>.json` (forward compatibility) | — |
| *(whole stream)* | — | raw text | — | `.lyrics-stream.txt` (exactly what I copy by hand today) | — |

`YouTube` / `YouTube Captions` sources come from YouTube itself, not this stream → show them as "not downloadable" in the menu.

### 1.6 What Tony reads (checked against jhhr/tony `main/LyricsTtml.cpp`, `main/Lyrics.cpp`, `main/MainWindow.cpp`)

- **TTML, Apple style** (as Apple Music, the Moises-Lyric-Exporter and AMLL TTML Tool write it): a `<p>` per line, a `<span begin end>` per word. `parseTtml()`:
  - reads times as **absolute** (not relative to the parent); accepts `m:ss.mmm`, `mm:ss.mmm`, `h:mm:ss.mmm` and plain seconds (`32.065`, which `golyrics` uses);
  - joins timed spans with **no whitespace between them** into one word (syllables); a space between spans separates words;
  - skips spans with `ttm:role` `x-bg` / `x-translation` / `x-roman`;
  - treats a `<p>` with no timed spans as one line-long "word" (so line-timed TTML works);
  - reads a `title` element in `<head>` (`<ttm:title>`) as the lyrics title;
  - **refuses** files with a `<!DOCTYPE>` and files over **1 MB**.
- **LRC** is also read, by line or with `<mm:ss.xx>` word tags, but LRC has no word ends; TTML is preferred because every word gets its end time (Tony's README says the same about the Moises exporter).
- `parseLyrics()` picks TTML when the file starts with `<`, so the extension doesn't matter to the parser — but the **import dialog filters `*.ttml *.lrc`** and **opens in the reference audio's folder**. So Tony-ready files must end in `.ttml` (or `.lrc`), and are easiest to find saved next to the audio.
- The reference **must be the recording the lyrics were timed to** (a Moises stem and its original mix share a timeline). Hence the album-track vs. music-video warning in §3.7.
- `golyrics` files can contain backing-vocal lines as separate `<p>` elements with a group `ttm:agent`; Tony imports those as overlapping lines. That's what I get today, so leave them as they are.

Lead check of Tony's `writeTtml()` / `ttmlTime()` (`main/LyricsTtml.cpp`): times are `ms = llround(seconds*1000)` clamped at 0, written `M:SS.mmm` with **unpadded, unbounded minutes** (no hours: 1 h 1 min is `61:00.000`); the file starts `<?xml version="1.0" encoding="UTF-8"?>` + newline, is indented two spaces per level, `<ttm:title>` comes before `<ttm:agent>`, and it ends with one `\n`. `Lyrics::maxFileBytes` is exactly `1024 * 1024`. Tony's own writer emits one span per (already joined) word; our converters keep syllables as adjacent spans, as the Moises exporter does in the test file — both read back the same in Tony.

The target style for converted files is exactly what Tony's own `writeTtml()` writes (and its test data `testdata/lyrics/moises-exporter-words.ttml` shows):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
  <head>
    <metadata>
      <ttm:title>Artist - Title</ttm:title>
      <ttm:agent type="person" xml:id="v1"/>
    </metadata>
  </head>
  <body dur="1:03.500">
    <div begin="0:00.520" end="1:03.500">
      <p begin="0:00.520" end="0:02.750" ttm:agent="v1" itunes:key="L1"><span begin="0:00.520" end="0:00.800">word</span> <span begin="0:01.100" end="0:01.350">syl</span><span begin="0:01.350" end="0:01.620">la</span><span begin="0:01.620" end="0:01.900">ble</span></p>
    </div>
  </body>
</tt>
```

---

## 2. Architecture

```
music.youtube.com tab
 ├─ content/page-bridge.ts   (MAIN world)    answers "what's playing?" from #movie_player
 ├─ content/main.ts          (ISOLATED)      player-bar audio button + BL-dock lyrics button/menu
 │        │  chrome.runtime messages / port
 ▼        ▼
background/sw.ts (service worker)
 ├─ capture.ts    chrome.debugger → Network domain → raw SSE + Unison JSON
 ├─ store.ts      chrome.storage.session cache of captures (LRU)
 ├─ downloads.ts  chrome.downloads (lyrics files), learns the download folder path
 └─ audio.ts      chrome.runtime.connectNative("com.jormki.ytm_grabber") ──┐
                                                                          ▼
native-host/ytm_grabber_host.py  (Python 3, stdlib only, launched by Chrome via host.bat)
 └─ runs yt-dlp.exe, streams progress back, returns the final file path
```

### Repo layout

```
ytm-practice-grabber/
  PLAN.md                     (this file)
  README.md                   install + usage (Windows)
  package.json                scripts: build, watch, test, typecheck, gen-key
  tsconfig.json
  build.mjs                   esbuild: bundles each entry to dist/, copies static files
  static/
    manifest.json
    icons/
    options.html
  src/
    shared/
      messages.ts             typed message protocol (content ⇄ SW ⇄ host)
      sse.ts                  parseSse()                         (pure, unit-tested)
      sources.ts              extractSources(), provider table   (pure, unit-tested)
      filenames.ts            buildStem(), sanitizeFilename()    (pure, unit-tested)
      ttml.ts                 writeTonyTtml() — Tony's writeTtml() style (pure, unit-tested)
      convert/musixmatchWord.ts   Musixmatch word-by-word → lines of timed words
      convert/qrc.ts              QQ QRC → lines of timed words
      tonyPick.ts             picks the best source for Tony (§3.2.3)
      blyrics.ts              BL selectors + displayName→provider map, with BL version note
    background/
      sw.ts  capture.ts  store.ts  downloads.ts  audio.ts
    content/
      main.ts  page-bridge.ts  audioButton.ts  lyricsButton.ts  menu.ts  styles.css
    options/
      options.ts
  native-host/
    ytm_grabber_host.py
    config.example.json
    install.ps1  uninstall.ps1  (generate host.bat + host manifest, register in HKCU)
  scripts/
    gen-key.mjs               creates the manifest "key" and prints the extension ID
  test/
    sse.test.ts  sources.test.ts  filenames.test.ts
    ttml.test.ts  musixmatchWord.test.ts  qrc.test.ts  tonyPick.test.ts
    fixtures/synthetic-stream.txt        committed; invented lyrics only
  fixtures/local/                        gitignored; real captures for local tests
  docs/spike-notes.md
```

**Tooling:** TypeScript + esbuild (content scripts must be single classic scripts, so bundle), `@types/chrome`, Vitest. No UI framework — the UI is two buttons and a popover. Load `dist/` as an unpacked extension.

**Fixtures:** committed fixtures must contain **invented** lyrics only (real lyrics are copyrighted and the repo may be public). Put real captures — such as my Hot Stuff capture — in `fixtures/local/` (gitignored); tests that use them `skip` when the folder is empty.

---

## 3. Component specs

### 3.1 Manifest

```jsonc
{
  "manifest_version": 3,
  "name": "YTM Practice Grabber",
  "version": "0.1.0",
  "key": "<from scripts/gen-key.mjs — keeps the extension ID stable for native messaging>",
  "permissions": ["debugger", "downloads", "nativeMessaging", "storage"],
  "host_permissions": ["https://music.youtube.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://music.youtube.com/*"], "js": ["page-bridge.js"], "world": "MAIN", "run_at": "document_idle" },
    { "matches": ["https://music.youtube.com/*"], "js": ["content.js"], "css": ["content.css"], "run_at": "document_idle" }
  ],
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

### 3.2 Pure modules (`src/shared/`)

- **`parseSse(text): { event: string; data: unknown }[]`** — mirror BL's parser exactly: split on `/\n\n|\r\n\r\n/`, per block take the last `event:` value and concatenate `data:` values (trimmed); skip empty data and `[DONE]`; `JSON.parse` failures are kept as `{ event, data: null, error, rawData }` rather than thrown.
- **`extractSources(events, unison?): LyricsSource[]`**

  ```ts
  type Timing = "word" | "syllable" | "line" | "plain" | "unknown";
  interface LyricsSource {
    id: string;              // e.g. "golyrics", "musixmatch-word", "lrclib-plain", "unison"
    provider: string;        // SSE provider name or "unison"
    blDisplayName?: string;  // matches .blyrics-dock__source-name
    label: string;           // menu text, e.g. "Better Lyrics — TTML, word-synced"
    timing: Timing;
    ext: string;             // ".golyrics.ttml"
    mime: string;            // "application/ttml+xml", "text/plain"
    content: string;
  }
  ```
  Implements the table in §1.5. Empty strings / missing fields produce no entry. Also returns `metadata` (`song`, `artist`, `album`, `duration`, `videoId`) from the `metadata` event.
- **`buildStem({ artist, title, videoId })`** → `"Artist - Title [videoId]"`; **`sanitizeFilename()`** for Windows: replace `<>:"/\|?*` and control chars, collapse whitespace, trim trailing dots/spaces, avoid reserved names (`CON`, `NUL`, `COM1`…), cap at ~150 chars. *(B1: `chrome.downloads` is stricter than Windows: it also rejects format characters such as ZWJ, LRM or soft hyphen, C1 controls, noncharacters, whitespace/`.`/`~` at either end, `CLOCK$`, `desktop.ini` and `thumbs.db` (checked in Chromium 141), so the rules cover both. The exact rules, and the 150 UTF-16-unit cap that cuts the artist/title part and never `[videoId]`, are in `test/fixtures/sanitize-vectors.json`.)* The audio file and all lyrics files use the **same stem**, so they sort together:
  `Artist - Title [id].opus`, `Artist - Title [id].ttml` (the Tony pick), `Artist - Title [id].musixmatch.lrc`, …
- **`blyrics.ts`** — every BL selector and the `displayName → source id(s)` map live here, with a comment `// verified against Better Lyrics 3.0.0.4`. Musixmatch maps to `musixmatch-word` first, then `musixmatch`; LRCLib to `lrclib`, then `lrclib-plain`.
- **`writeTonyTtml({ title, lines })`** where `lines: { words: { pieces: { text, begin, end }[] }[] }[]` (seconds, absolute) → the TTML in §1.6: times `m:ss.mmm` rounded to the millisecond; pieces of one word written as adjacent `<span>`s with no whitespace; words separated by one space; `<p>` begin/end = first piece begin / last piece end; `itunes:key="L<n>"`; `<body dur>` and `<div>` end = last end; text XML-escaped; never a DOCTYPE. Test: output for a small synthetic input matches a golden file byte for byte.

#### 3.2.1 Musixmatch word-by-word → TTML (`convert/musixmatchWord.ts`)

The format, as seen in my capture (verify against `fixtures/local/` captures):
`[mm:ss.xx] <t0> Word <t1>   <t2> next <t3>   <t4> hy- <t5> phenated <t6>`

- Split each line after its `[…]` line stamp into alternating `<mm:ss.xx>` tags and text segments.
- Each text segment sits between two tags; drop exactly **one** formatting space on each side.
- A segment that is then empty or whitespace-only is a **separator** (a word boundary; Musixmatch times the spaces too). *(B3, as BL: an empty segment — two tags with nothing between them — is no separator; it adds no text and the pieces either side stay one word.)*
- A non-blank segment is a **piece**: begin = the tag before it, end = the tag after it.
- Consecutive pieces with **no separator between them** are one word (Musixmatch splits hyphenated words this way, e.g. `hy-` + `phenated`) → adjacent spans, which Tony joins.
- Lines without pieces are skipped. Times are absolute.

Lead check against BL's own parser (`@braccato/parsers` 0.3.2, `parseLRC`, MIT; a copy is in the lead's scratchpad, see the work orders): BL decides per line whether it is in **separator style** (some interior text segment is whitespace-only) or **compact style** (no whitespace-only segments, e.g. `<t0>Word <t1>next <t2>`). Handle both: in separator style the rules above apply (trim each piece); in compact style a piece whose raw text **ends in whitespace ends a word**, otherwise it joins the next piece (as in QRC) *(B3: and one whose raw text starts with whitespace starts a word — BL's renderer splits every part at whitespace)*. Header tags `[ti:…]`, `[ar:…]`, `[al:…]`, `[by:…]`, `[length:…]`, `[offset:…]`, `[re:…]`, `[ve:…]`, `[#:…]` are metadata. A line can end with a background part `[bg: …]` (same tag syntax): **drop it** in the Tony conversion (Tony skips background vocals anyway). A line can carry more than one `[mm:ss.xx]` stamp; use the earliest. Unison richsync LRC uses the same converter.

#### 3.2.2 QQ QRC → TTML (`convert/qrc.ts`)

- `JSON.parse(results.lyrics).lyrics` is the QRC XML; take the `LyricContent="…"` attribute (regex, then decode XML entities `&amp; &lt; &gt; &quot; &apos; &#…;` — the service worker has no `DOMParser`).
- Header lines `[ti:…] [ar:…] [al:…] [by:…] [offset:…]` are metadata; apply a non-zero `offset` (ms).
- Lyric lines: `[lineStartMs,lineDurMs]` then repeated `text(startMs,durMs)`. Match pieces with `/(.*?)\((\d+),(\d+)\)/g` so lyrics that contain parentheses still parse. begin = `start/1000`, end = `(start+dur)/1000`.
- A piece whose text ends in whitespace ends a word; a piece **without** trailing whitespace joins the next piece (syllables such as `thou` + `sand`). Trim the span text.
- **Credit lines:** QQ puts title/credit lines at the very start (e.g. `Title - Artist`, `Written by：…`, `词：`, `曲：`, `作词`, `作曲`, `编曲`, `Producer`). Drop leading lines that match these patterns or the `ti`/`ar` header, but stop at the first line that doesn't, so real lyrics are never dropped.

Lead check against BL's `parseQRC` (`@braccato/parsers` 0.3.2): the attribute is found with `/LyricContent="([\s\S]*?)"\s*(?:\/?>|[a-zA-Z]+=)/` (the value can contain `&quot;`); line stamps are `[start,dur]` in ms; pieces are `text(start,dur)` with the text **before** the parenthesised times. BL looks for credit lines only among the **first 5** lyric lines, and treats as credits: lines containing the song title and artist (normalised: lower-case, punctuation removed); lines of **more than 2 pieces whose durations are all equal within 10 ms** (QQ times credit lines uniformly); and `Key: value` / `Key：value` lines whose key is a credit word (`词 詞 作词 作詞 曲 作曲 词曲 詞曲 编曲 編曲 制作人 製作人 和声 混音 录音 written by, lyrics by, composed by, produced by, arranged by, lyricist, composer, producer, arranger, mixing, mastering, vocal(s), guitar, bass, drums` — spaces and case ignored). Use the same rules, still stopping at the first line that is not a credit. BL **ignores** `[offset:…]` in QRC; we apply a non-zero one as above (LRC sign: `time = t − offset`) — QQ files almost always have `offset:0`, so the difference is theoretical.

#### 3.2.3 Picking the file for Tony (`tonyPick.ts`)

Best first; the first one that exists wins:

1. `golyrics` TTML, **as-is** (unchanged bytes — exactly what I've been importing)
2. Unison TTML with word or syllable timing, as-is
3. `binimum` TTML with `timingType: "syllable"`, as-is
4. Musixmatch word-by-word → converted TTML (then Unison richsync LRC → converted TTML, same converter)
5. QQ → converted TTML
6. Line-timed TTML (`binimum` line, Unison line), as-is
7. Line-synced LRC (Musixmatch `synced`, LRCLib `synced`, KuGou) as `.lrc`

Returns `{ source, filename, content, timing, converted: boolean }` so the menu can say e.g. *"Musixmatch, word timing (converted to TTML)"*. Before saving, check what Tony would refuse: size ≤ 1 MB and no `<!DOCTYPE`.

### 3.3 Capture manager (`background/capture.ts`)

Two modes (option, default **on-demand**):

**On-demand** (triggered from the lyrics button when no capture exists for the current video):
1. Content script sends `capture:start { videoId }`.
2. SW: `chrome.debugger.attach({ tabId }, "1.3")` → `Network.enable` (generous `maxResourceBufferSize`/`maxTotalBufferSize`) → replies `capture:ready`.
3. Content script clicks `.blyrics-dock__refresh`.
4. SW listens on `chrome.debugger.onEvent`:
   - `Network.requestWillBeSent` with URL `https://lyrics.api.dacubeking.com/v2/lyrics` → remember `requestId`; read `videoId` from `request.postData` if present. **Never store or log the postData — it contains BL's JWT.**
   - Same for `https://unison.betterlyrics.org/lyrics?…` (GET; only the exact `/lyrics` path, not `/lyrics/<id>/vote` etc.).
   - `Network.loadingFinished` for a tracked id → `Network.getResponseBody` (handle `base64Encoded`).
   - **Body retrieval without the spike (lead decision):** Phase 0's spike cannot be run before building, so the capture collects the body three ways at once and uses the first that is non-empty, in this order: (a) `Network.getResponseBody` at `loadingFinished`; (b) the bytes accumulated from `Network.dataReceived` `data` after calling `Network.streamResourceContent` at `responseReceived` (errors ignored); (c) the stream rebuilt from `Network.eventSourceMessageReceived` events (`eventName`, `data`) as `event: …\ndata: …\n\n` blocks. It records which one was used (`bodySource: "getResponseBody" | "stream" | "eventSource"`) in the capture and logs it when the `debugCapture` option is on, so the 👤 check later tells us which path real Chrome takes.
5. Done when the stream body is in hand (plus a short grace period, ~2 s, for the Unison request), or after a 30 s timeout. Always `chrome.debugger.detach` in a `finally`.
6. Parse, store, reply `capture:done { videoId, sources[], metadata }` or `capture:error { reason }`.

**Always attached** (opt-in): attach whenever a music.youtube.com tab finishes loading, keep `Network` enabled, capture every stream passively. No refresh click needed and no extra requests to the lyrics API, at the cost of Chrome's permanent "started debugging this browser" bar.

Edge cases to handle:
- `chrome.debugger.onDetach` (I clicked *Cancel* on the infobar, tab closed, navigated away) → resolve with an error, clean up.
- Attach fails because something else is attached → clear message.
- Capture metadata `videoId` ≠ the video now playing → keep it under its own videoId, tell the UI.
- One capture per tab at a time; repeated clicks join the pending one.

**Infobar:** Chrome shows "*YTM Practice Grabber* started debugging this browser" while attached. On-demand mode keeps that to a few seconds. It can be suppressed entirely by starting Chrome with `--silent-debugger-extension-api` (add to the Chrome shortcut's target on Windows) — document this in the README.

### 3.4 Capture store (`background/store.ts`)

`chrome.storage.session` (10 MB quota, cleared on browser restart), key `capture:<videoId>` → `{ videoId, capturedAt, metadata, rawStream, unison?, sources[] }`. Keep the most recent 30 (LRU by `capturedAt`). Content script asks `capture:get { videoId }` before deciding whether to capture.

**Lead decision (quota):** one stream can be a few hundred KB (several full TTMLs), and storing `sources[]` next to `rawStream` doubles it, so 30 captures can exceed the 10 MB quota. Store only the raw inputs — `{ videoId, capturedAt, metadata, rawStream, unisonRaw?, bodySource }` — and derive `sources[]` with `parseSse` + `extractSources` on read (cheap, pure). Evict LRU by count (30) **and** by total size (keep under ~8 MB, measured as UTF-16 length × 2 or with `getBytesInUse`); on a quota error evict the oldest and retry once.

### 3.5 Lyrics button + menu (`content/lyricsButton.ts`, `content/menu.ts`)

- A `MutationObserver` (debounced) watches for `.blyrics-dock__inner`; insert one `<button class="pg-dock-btn">` with a download icon into `__inner` (after `__controls`). Re-insert if BL removes it. Style it to sit visually with BL's controls (size/radius/colour via BL's CSS where it inherits; own class names only — don't reuse BL classes, so BL's own `querySelector`s never pick up our element).
- **Fallback** when no dock exists ~3 s after `#side-panel` has BL lyrics: a small floating button in the top-right of `#side-panel`.
- Click:
  1. `capture:get` for the current videoId. If missing → show "Capturing…" state, run the on-demand flow (§3.3). If `.blyrics-dock__refresh` is missing, show: *"Turn on BL's refresh button in its dock settings, or enable Always-capture in this extension's options."*
  2. Open a popover appended to `document.body`, positioned next to the button (flip up/down like BL's menu does based on `data-position`). Esc / outside-click closes it.
- Menu items:
  - **Download TTML for Tony** (top, bold) — the pick from §3.2.3, labelled with its source and timing, e.g. *"Better Lyrics — word timing"* or *"Musixmatch — word timing, converted"*. Saved as `<stem>.ttml` (no provider infix, so it's the obvious file to import); `<stem>.lrc` when only LRC exists.
  - **Download what's showing** — the source BL currently displays (from `.blyrics-dock__source-name` via `blyrics.ts`), Tony-ready if it can be (as-is TTML, converted TTML, or LRC); disabled with a reason for YouTube / not-captured sources.
  - divider; **Other sources** — one item per captured source in its native format (§1.5), with timing, the one BL is showing marked "(showing)". Musixmatch word-by-word and QQ also get a "→ TTML" item.
  - divider; **Raw response (.txt)**; **Re-capture** (forces the on-demand flow again).
- Optional extra (cheap, useful for Tony): if BL's per-song offset (`.blyrics-dock__offset-value`, e.g. `+0.2s`) isn't zero, say so in a toast after download. Downloaded files never include BL's offset, so I know to apply it in Tony with Edit → Shift Lyrics….

### 3.6 Lyrics downloads (`background/downloads.ts`)

- `chrome.downloads.download({ url: "data:<mime>;charset=utf-8," + encodeURIComponent(content), filename: [subfolder/]<stem><ext>, conflictAction: "uniquify", saveAs: false })` (service workers have no `URL.createObjectURL`; data URLs are fine at these sizes).
- **Learn the download folder:** on `chrome.downloads.onChanged` → `complete` for our download, `chrome.downloads.search({ id })` → `item.filename` is the absolute path → store its directory (minus our subfolder) as `learnedDownloadDir`. The audio flow uses it so yt-dlp writes to the same folder Chrome uses. Overridable in options.
- Option **per-song subfolder** (default off): `<stem>/<stem><ext>` for lyrics and `<downloadDir>\<stem>\` for audio. Useful with Tony, whose Import Lyrics dialog opens in the reference audio's folder: save the Moises stems into the same subfolder and the `.ttml` is right there.

### 3.7 Audio button (`content/audioButton.ts`, `content/page-bridge.ts`)

- **page-bridge (MAIN world):** listens for `pg:what-is-playing` on `document`, replies with a `pg:now-playing` CustomEvent whose `detail` is a JSON **string** (cross-world safe):
  `{ videoId, title, author, musicVideoType }` from `document.querySelector("#movie_player")?.getVideoData()` and `getPlayerResponse()?.videoDetails?.musicVideoType`. Fallback in the isolated world: `new URL(location.href).searchParams.get("v")` + player bar title/byline text.
- **Button** in `ytmusic-player-bar .right-controls-buttons` (verify in spike; BL restyles the player bar, so observe and re-insert). States: idle → running (percentage in tooltip/badge) → done (✓, tooltip shows file path) → error (tooltip shows reason).
- **Song vs. video warning:** if `musicVideoType` is `MUSIC_VIDEO_TYPE_OMV` (official music video) rather than `MUSIC_VIDEO_TYPE_ATV` (the album track), show a warning before downloading — a music video's audio often has an intro/outro, so the track-synced lyrics won't line up. Offer "Download anyway".
- Click → `audio:download { videoId, stem }` to the SW. The SW resolves `outputDir` (learned download dir → option override → host's fallback) and talks to the native host over a `chrome.runtime.connectNative` **port**, relaying progress to the tab.

### 3.8 Native messaging host (`native-host/`)

**Host name:** `com.jormki.ytm_grabber`.

**Files**
- `ytm_grabber_host.py` — Python 3, stdlib only.
- `config.json` (created from `config.example.json` by the installer):
  ```json
  {
    "ytDlpPath": "C:\\Tools\\yt-dlp.exe",
    "ffmpegLocation": "C:\\Tools\\ffmpeg\\bin",
    "extraArgs": ["-x"],
    "fallbackOutputDir": "%USERPROFILE%\\Downloads"
  }
  ```
  `extraArgs` defaults to exactly what I run today (`-x`). It lives on disk, never comes from the extension.
- `install.ps1 -ExtensionId <id>`:
  1. find Python (`py -3` → `where python`) and write `host.bat` next to the script:
     `@echo off` / `"<abs python.exe>" -u "%~dp0ytm_grabber_host.py" %*`
  2. write `com.jormki.ytm_grabber.json`:
     `{ "name": "com.jormki.ytm_grabber", "description": "...", "path": "<abs path to host.bat>", "type": "stdio", "allowed_origins": ["chrome-extension://<id>/"] }`
  3. set `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.jormki.ytm_grabber` (default value) to that JSON's absolute path;
  4. if `config.json` is missing, copy the example and try to fill `ytDlpPath`/`ffmpegLocation` via `where.exe`.
- `uninstall.ps1` removes the registry key and generated files.

**Protocol** (Chrome native messaging: 4-byte little-endian length + UTF-8 JSON; use `sys.stdin.buffer` / `sys.stdout.buffer` and flush after every message; host → Chrome messages ≤ 1 MB; nothing else may ever be written to stdout):

```ts
// extension → host
{ type: "ping" }
{ type: "download", requestId: string, videoId: string, stem: string, outputDir?: string, subfolder?: boolean }  // subfolder: lead decision, §7.1
{ type: "cancel", requestId: string }
{ type: "reveal", path: string }            // optional: explorer /select,"<path>"

// host → extension
{ type: "pong", hostVersion: string, ytDlpVersion: string | null, ffmpegFound: boolean }
{ type: "progress", requestId, percent: number | null, line: string }
{ type: "done", requestId, path: string }
{ type: "error", requestId?, message: string, stderrTail?: string }
```

**Validation (the host is the security boundary):**
- `videoId` must match `^[A-Za-z0-9_-]{11}$`.
- `stem` re-sanitized with the same rules as `filenames.ts`, then every `%` doubled to `%%` (yt-dlp treats `-o` as a template).
- `outputDir` must be an existing absolute directory; otherwise use `fallbackOutputDir`.
- `reveal` only for paths inside a directory the host itself wrote to this session.

**yt-dlp invocation**

```python
cmd = [
  cfg["ytDlpPath"], *cfg["extraArgs"],
  "--ffmpeg-location", cfg["ffmpegLocation"],      # only if set
  "--no-playlist", "--encoding", "utf-8",
  "--newline", "--progress",
  "--progress-template", "download:PG_PROGRESS %(progress._percent_str)s",
  "--print", "after_move:filepath",                # final path on stdout
  "-P", output_dir, "-o", f"{stem}.%(ext)s",
  "--", video_id,                                  # IDs can start with "-"
]
subprocess.Popen(cmd, stdout=PIPE, stderr=PIPE, text=True, encoding="utf-8",
                 errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
```

`--print` implies `--quiet`, hence `--progress` to keep progress lines. Read stdout line by line: `PG_PROGRESS` lines → `progress`; the last non-progress line → `done.path`. Keep the last ~20 stderr lines for `error.stderrTail`. Support `cancel` (terminate the process). Verify these flags in the spike.

### 3.9 Options page

- Capture mode: on-demand (default) / always attached
- Per-song subfolder (default off)
- Download folder: shows the learned path, with a manual override
- Native host status: **Test connection** (`ping` → shows host version, yt-dlp version, ffmpeg found)
- (Phase 8) Auto-download the Tony TTML after capture

---

## 4. Phases

Each phase ends with `npm run typecheck && npm test` green and a short note in `docs/spike-notes.md` or the README where relevant. Ask me to try things in the live browser at the checkpoints marked 👤 — I'll report back.

### Phase 0 — Spikes (de-risk before building)
1. **CDP capture of BL's stream.** Throwaway extension: attach to the YTM tab, `Network.enable`, log `requestWillBeSent` / `responseReceived` (incl. `mimeType`) / `loadingFinished` for `v2/lyrics`, then try `Network.getResponseBody`. 👤 I click BL's refresh and report the console output.
   - If `getResponseBody` returns the full SSE text → use it (expected; the DevTools Response tab shows it).
   - If not (event-stream bodies are sometimes not buffered) → on `responseReceived` call `Network.streamResourceContent` and accumulate the base64 `data` from `Network.dataReceived` events.
   - Last resort → `Fetch.enable` with a `Response`-stage pattern for that URL, `Fetch.getResponseBody`, then `Fetch.fulfillRequest` with the same body (BL then gets the whole stream at once; acceptable).
2. **Selectors on the live page** 👤: `.blyrics-dock__inner`, `.blyrics-dock__refresh`, `.blyrics-dock__source-name`; `ytmusic-player-bar .right-controls-buttons`; `#movie_player.getVideoData()` and `getPlayerResponse().videoDetails.musicVideoType` from the MAIN world; whether the URL `v` param tracks queue changes.
3. **yt-dlp flags** 👤: run the §3.8 command by hand on one video; confirm progress lines, the final path line, and that `-x` works with my ffmpeg.

### Phase 1 — Scaffold
Repo layout, `package.json`, esbuild build to `dist/`, manifest, `scripts/gen-key.mjs` (generates the RSA key, writes the base64 public key to `static/manifest.json` `key`, prints the extension ID; private key goes to a gitignored file), empty SW/content/options entries that log on load. **Done when** the unpacked extension loads with a stable ID and the content script logs on music.youtube.com.

### Phase 2 — Parsing (pure, test-first)
`sse.ts`, `sources.ts`, `filenames.ts` + tests against `test/fixtures/synthetic-stream.txt`. Build the synthetic fixture to mirror my capture's *structure* exactly (metadata; lrclib with `synced` + `plain`; musixmatch with `synced` + `wordByWord`; golyrics with double-encoded `{"ttml": …}` TTML incl. `itunes:timing="Word"`; qq with nested JSON + QRC XML; binimum TTML with `timingType`; `done`) but with **invented lyric text**. Also test: CRLF separators, a block split across two `data:` lines, golyrics as raw (not double-encoded) TTML, an unknown provider, malformed JSON in one block. **Done when** each provider in §1.5 yields the right `LyricsSource`s and tests pass.

### Phase 2b — Tony TTML (pure, test-first)
`ttml.ts`, `convert/musixmatchWord.ts`, `convert/qrc.ts`, `tonyPick.ts` per §3.2–3.2.3. Tests (synthetic input, invented words): golden-file output of `writeTonyTtml`; Musixmatch spaces-as-separators and hyphen-split words joined; QRC syllables joined, trailing-space word ends, parentheses inside lyrics, credit lines dropped only at the start, `offset` applied, XML entities decoded; every pick-order branch of `tonyPick`; a converted file round-trips through a small reader that applies Tony's rules from §1.6 (absolute times, adjacent spans = one word) to the same words and times. If real captures exist in `fixtures/local/`, also check every line's words and times survive conversion. Tony's `testdata/lyrics/moises-exporter-words.ttml` in jhhr/tony is the reference for the shape — link to it, don't copy it (GPL). **Done when** tests pass and 👤 I import one converted Musixmatch file and one converted QQ file into Tony without warnings.

### Phase 3 — Capture manager
`capture.ts` + `store.ts` with the on-demand flow, using whichever body-retrieval method Phase 0 chose; always-attached mode behind the option. **Done when** 👤 a capture from the SW console (`captureNow(tabId)` dev helper) stores a parsed capture for the playing song, the infobar disappears afterwards, and the token never appears in storage or logs.

### Phase 4 — Lyrics button, menu, downloads
`lyricsButton.ts`, `menu.ts`, `downloads.ts`, learned download folder. **Done when** 👤 on a song BL already cached: click → "Capturing…" → menu lists every source; "Download TTML for Tony" saves `<stem>.ttml` byte-identical to the `golyrics` TTML I'd have cut out by hand, and Tony imports it; "Download what's showing" saves the right file with the shared stem; raw response download matches what DevTools shows; button survives song changes and provider switches.

### Phase 5 — Native host
Python host, `install.ps1`/`uninstall.ps1`, config, protocol, validation; a small `native-host/test_host.py` that drives the host over stdin/stdout with a fake yt-dlp (a script that prints canned progress) to test framing, validation and cancel. **Done when** 👤 Options → *Test connection* shows yt-dlp and ffmpeg versions.

### Phase 6 — Audio button
`page-bridge.ts`, `audioButton.ts`, `audio.ts`. **Done when** 👤 one click saves `<stem>.<ext>` into the same folder as the lyrics files, with progress shown, errors readable (e.g. yt-dlp missing, ffmpeg missing), and the OMV warning appears on a music-video item.

### Phase 7 — Options, polish, README
Options page (§3.9), README with Windows install steps (build → load unpacked → `install.ps1 -ExtensionId …` → test connection → optional `--silent-debugger-extension-api`), and a troubleshooting section (BL updated and selectors broke; dock disabled; infobar *Cancel* pressed; host not registered).

### Phase 8 — Optional, later
- Download the Tony TTML automatically after each capture (or when the audio button is used).
- One "Grab all" button: audio + best lyrics in one click.
- Write BL's current offset into a sidecar file.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| BL renames its dock classes or changes its API stream | All BL specifics in `blyrics.ts` with the verified version; fallback floating button; unknown providers saved as JSON; raw stream download always available |
| `getResponseBody` doesn't return event-stream bodies | Phase 0 decides; two CDP fallbacks listed |
| Debugger infobar is annoying | On-demand attach for a few seconds; Chrome flag to silence it |
| Refresh click causes one extra request to BL's lyrics API per capture | Only on demand, one per click; always-attached mode avoids extra requests entirely |
| Chrome launched from the Start menu doesn't see my PATH | Host uses absolute `ytDlpPath` / `ffmpegLocation` from `config.json` |
| Command injection through the stem or video id | Strict validation in the host; no args accepted from the extension; `--` before the id; `%` escaped |
| Lyrics timed to the album track but audio from a music video | `musicVideoType` check and warning |
| Converted Musixmatch/QQ timing reads wrong in Tony (format details inferred from one capture) | Converters are fallbacks only (`golyrics` is passed through untouched); tests against real captures in `fixtures/local/`; 👤 import check in Phase 2b; the native-format files stay downloadable |

## 6. Open questions (defaults in brackets — proceed with the default if I haven't answered)

1. Audio format for Moises/Tony: keep yt-dlp's default from `-x` (usually Opus or M4A), or force `--audio-format wav`/`mp3`? [keep `-x` as today; configurable through `extraArgs`]
2. Per-song subfolders? [off]

Answered: Tony reads Apple-style TTML (as Moises produces and BL's `golyrics` provides) — see §1.6.

## 7. How this is being built (lead's additions)

The work is done by a line of phase agents, one build phase each, run by a lead session; their rules and hand-over log are in `docs/WORK_ORDERS.md`. The 👤 checkpoints in §4 cannot be done during the build (no live browser, no Windows): they are collected into `docs/spike-notes.md` as a checklist for the user, and an automated end-to-end test in Chromium against a mock music.youtube.com + BL dock (B8) covers what can be covered here.

### 7.1 Decisions

| Decision | Choice | Why |
|---|---|---|
| Phase 0 spikes | Not run first. Capture collects the body three ways (§3.3); B8 tests real streaming in Chromium; the live-page checks become a 👤 checklist | The user's browser is not reachable during the build |
| Capture store | Raw inputs only, sources derived on read; count + size eviction (§3.4) | 10 MB session quota |
| Unison | Parse `{ data: … }`; richsync LRC converted like Musixmatch (§1.5, §3.2.3) | Checked in BL 3.0.0.4 |
| Enhanced LRC | Separator and compact styles; `[bg:]` dropped (§3.2.1) | Checked in BL's parser |
| QRC credits | BL's rules: first 5 lines, title/artist, equal-duration pieces, credit keys (§3.2.2) | Checked in BL's parser |
| Who commits | The lead, after review; pushes go to the session branch | Default |
| Tony test data | Linked, never copied (§4 Phase 2b) | User's instruction |
| Filename stem source | Always from YTM's now-playing info (page bridge `title`/`author` + `videoId`), sent by the content script with every download request and re-sanitised by the SW (and by the host for audio). Capture metadata (`song`/`artist`) is used only when the capture's videoId is not the playing one | BL's API metadata can spell artist/title differently from YTM, which would break "audio and lyrics share one stem" |
| Per-song subfolder for audio | Host protocol `download` gets `subfolder?: boolean`; the host itself creates `<outputDir>\<sanitised stem>\` (one level, inside a validated existing `outputDir`) | The host only accepts existing directories, and the subfolder does not exist yet |
| Lyrics button placement | In `.blyrics-dock__inner` after `__controls`, as specified; if B8 shows BL's dock layout pushes it out of view, revisit | §3.5 |

### 7.2 Build phases

Each line is marked "Done <date> (<commits>)" when finished. Mapping to §4 in brackets.

- **B1** Scaffold + `filenames.ts` [Phase 1, part of 2] — Done 2026-10-04 (0348fed)
- **B2** `sse.ts` + `sources.ts` + synthetic fixture [Phase 2] — Done 2026-10-04  (c63e14d)
- **B3** `ttml.ts` writer + enhanced-LRC word converter + Tony-rules test reader [Phase 2b, part] — Done 2026-10-04
- **B4** QRC converter + `tonyPick.ts` + `blyrics.ts` [Phase 2b, rest]
- **B5a** Messages + settings + capture store [Phase 3, part]
- **B5b** Capture manager, always-attached mode [Phase 3, rest]
- **B6** Lyrics downloads (SW) + menu model (pure) [Phase 4, part]
- **B7a** Page bridge + now playing + lyrics button placement [Phase 4 / 6, part]
- **B7b** Lyrics menu popover + capture flow (content script) [Phase 4, rest]
- **B8** End-to-end test in Chromium: mock YTM + BL dock + streaming SSE [replaces spike 1 as far as possible]
- **B9** Native host + installer scripts + host tests [Phase 5]
- **B10** Audio button + page bridge + SW audio relay [Phase 6]
- **B11** Options page; end-to-end audio with the real host and a fake yt-dlp [Phase 7, part]
- **B12** Documentation pass: README, `docs/spike-notes.md` 👤 checklist, this plan brought up to date [Phase 7, rest]
