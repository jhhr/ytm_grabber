# YTM Practice Grabber

A personal Chrome extension for [YouTube Music](https://music.youtube.com) that takes the
manual steps out of preparing a song for singing practice in
[Tony](https://github.com/jhhr/tony) (the jhhr fork). It adds two buttons:

- **Lyrics button**, in the [Better Lyrics](https://github.com/better-lyrics/better-lyrics) (BL)
  lyrics dock: saves the song's lyrics as **TTML that Tony imports**. When BL has its own
  word-timed TTML (the "Better Lyrics" source, `golyrics`), that file is saved byte for byte, so
  you get exactly what you used to cut out of DevTools by hand. When it doesn't, the best other
  source is used: another word-timed TTML as it came, Musixmatch word-by-word, Unison or QQ
  lyrics converted to the same TTML style, or, failing those, line-timed lyrics. Every other
  source BL fetched can be saved too, as it came.
- **Audio button**, in YouTube Music's player bar: runs `yt-dlp -x <videoId>` on your PC through
  a small Python helper (the *native host*) and saves the audio **next to the lyrics, under the
  same name**, so `Artist - Title [videoId].opus` and `Artist - Title [videoId].ttml` sort
  together.

What it does **not** do: split the audio into stems. Uploading the audio to Moises and saving
the stems stays a manual step (see [Tony and Moises](#tony-and-moises)).

How it gets the lyrics: BL's request for them is made from BL's own extension, which other
extensions cannot see. So this extension briefly attaches Chrome's debugger to the YouTube Music
tab, clicks BL's refresh button so BL fetches the lyrics again, and keeps the response: the same
data you would copy from DevTools' Network tab. While it is attached Chrome shows a bar saying
"YTM Practice Grabber" started debugging this browser.

The design, decisions and known limitations are in [PLAN.md](PLAN.md); the checks still to be
done in your own browser are in [docs/spike-notes.md](docs/spike-notes.md).

## Requirements

- **Windows x64 and Google Chrome.** (The automated tests run Chromium 141 on Linux.)
- **Better Lyrics 3.0.0.4** (its page structure was checked against that version).
- **Node.js 22.12 or newer** with npm, to build the extension (`package.json` `engines`).
- **Git**, to get the code.
- **Python 3.8 or newer** (python.org or conda; the host uses the standard library only).
- **yt-dlp** (`yt-dlp.exe`; the host was tried with yt-dlp 2026.08.19) and **ffmpeg**
  (`ffmpeg.exe`; yt-dlp's `-x` needs it to extract the audio).
- **Tony** (jhhr/tony) to import the lyrics.

## Install

### 1. Get the code

In a terminal, in the folder where you keep projects:

```
git clone https://github.com/jhhr/ytm_grabber.git
cd ytm_grabber
```

Keep this folder where it is: the native host runs from `native-host\` inside it.

### 2. Build the extension

```
npm ci
npm run build
```

`npm ci` installs the build and test tools (development dependencies only; the extension itself
has no dependencies). `npm run build` writes the extension to `dist\` (it empties `dist\` first).

### 3. Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist` folder inside `ytm_grabber`.

The card shows **YTM Practice Grabber** with the ID **`mengelecikhhdpjdebjpokcmhdkhjobj`**. This
ID is fixed: `dist\manifest.json` carries a `"key"` (a public key), and Chrome derives the ID
from it, so it is the same wherever `dist\` is and however often you rebuild. The native host
only answers the extension with this ID, so it never needs registering again after a rebuild.
(If the card shows another ID, the manifest's key was changed; see
[Troubleshooting](#audio-the-native-host).)

### 4. Install the native host

The native host is `native-host\ytm_grabber_host.py`. Chrome starts it when you click the audio
button; it runs yt-dlp and reports back. To register it with Chrome, open PowerShell (or
Command Prompt) in the repository folder and run:

```
cd native-host
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

(`powershell` is Windows PowerShell 5.1, part of Windows 10 and 11; the script needs 5.1 or
newer.)

`-ExecutionPolicy Bypass` lets this one run of the script go ahead without changing your PC's
execution policy. No administrator rights are needed. The script:

1. finds Python 3.8 or newer: first `py -3` (the python.org launcher), then `python.exe` on PATH
   (skipping the Microsoft Store stub);
2. writes `host.bat` next to itself (it runs that Python on `ytm_grabber_host.py`);
3. writes the host manifest `com.jormki.ytm_grabber.json` next to itself (it names `host.bat`
   and allows only `chrome-extension://mengelecikhhdpjdebjpokcmhdkhjobj/`);
4. points the registry key
   `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.jormki.ytm_grabber` at
   that manifest;
5. creates `config.json` from `config.example.json` if there is none, filling in the paths of
   `yt-dlp.exe` and `ffmpeg.exe` when they are on PATH (an existing `config.json` is never
   changed);
6. sends the host a test ping and prints `Test:     host 0.1.0, yt-dlp <version>, ffmpeg found:
   True`, with a warning for each problem the host reports.

It ends with `Done. Restart Chrome, then use the extension's options page: Test connection.`

Options:

- `-Python C:\path\to\python.exe` uses that Python instead of searching. With **conda**, the
  search finds nothing unless conda's Python is on PATH; get the path in the Anaconda Prompt
  with `python -c "import sys; print(sys.executable)"` and pass it, for example
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Python "C:\Users\you\miniconda3\python.exe"`.
- `-ExtensionId <id>` registers another extension ID (the default is the fixed one above).

Run `install.ps1` again whenever you move the repository folder or the Python it found.
`uninstall.ps1` undoes it (same way of running it; add `-RemoveConfig` to delete `config.json`
too).

#### config.json

`native-host\config.json` is the host's own settings. The extension cannot change it.

```json
{
  "ytDlpPath": "C:\\Tools\\yt-dlp.exe",
  "ffmpegLocation": "C:\\Tools\\ffmpeg\\bin",
  "extraArgs": ["-x"],
  "fallbackOutputDir": "%USERPROFILE%\\Downloads"
}
```

- `ytDlpPath` (required): the full path of `yt-dlp.exe`. A `.bat` or `.cmd` wrapper is refused
  (Windows would run it through cmd.exe, which would read characters in song titles).
- `ffmpegLocation`: the folder holding `ffmpeg.exe` (or the file itself). Empty or missing:
  ffmpeg is looked for on PATH.
- `extraArgs`: yt-dlp options added in front of the host's own; default `["-x"]` (audio only, in
  the format YouTube has, usually Opus or M4A). For example `["-x", "--audio-format", "mp3"]`.
  Options that change where or under what name yt-dlp saves make every download fail: the host
  checks that the file landed as `<folder>\<stem>.<ext>`.
- `fallbackOutputDir`: where audio goes when the extension has no usable folder to give (see
  [Where files go](#where-files-go)). It must exist.

To fix a path, edit the file in Notepad. In JSON every backslash is written twice
(`C:\\Tools\\yt-dlp.exe`). `%NAME%` environment variables and `~` work in the three paths. The
host reads the file for every request, so a change applies at once, without restarting Chrome.

### 5. Test the connection

Open the extension's options: `chrome://extensions` → YTM Practice Grabber → **Details** →
**Extension options**. Under **Native host**, click **Test connection**. It should say
"The native host answers." and list the host's version, yt-dlp's version and "ffmpeg: found".
If the host answers but something is wrong it says "The native host answers, but reports
problems:" and lists them (a wrong `ytDlpPath`, ffmpeg not found...). For other answers see
[Troubleshooting](#troubleshooting).

### 6. Optional: hide Chrome's debugging bar

While the extension's debugger is attached, Chrome shows a bar: "YTM Practice Grabber" started
debugging this browser. In the default **on demand** mode that is a few seconds per capture. In
**always attached** mode (see [Options](#options)) the bar stays up the whole time. Chrome hides
it when started with the flag `--silent-debugger-extension-api`:

1. Quit Chrome completely. If Chrome keeps running in the background ("Continue running
   background apps when Google Chrome is closed" in its settings), quit it from its icon in the
   notification area too: a flag only takes effect when Chrome starts.
2. Right-click the shortcut you start Chrome from → **Properties**. For the taskbar, right-click
   the Chrome button, then right-click **Google Chrome** in that menu → **Properties**.
3. In **Target**, add the flag after the closing quote:
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api`
4. Start Chrome from that shortcut.

The trade-off: the flag hides the bar for **every** extension that uses Chrome's debugger, and
the bar is how you would notice (and stop, with its **Cancel**) an extension debugging your tabs
when you did not expect it. Chrome started some other way (another shortcut, a link opened from
another program while Chrome is closed) runs without the flag. Whether your Chrome version still
honours the flag is one of the checks in [docs/spike-notes.md](docs/spike-notes.md).

### Updating

```
git pull
npm ci
npm run build
```

Then click the reload button on the extension's card in `chrome://extensions` and **reload your
YouTube Music tabs** (a tab opened before the reload keeps the old version, which can no longer
reach the extension). `install.ps1` needs running again only if the folder or Python moved.

## Usage

Open a song on music.youtube.com with BL's lyrics showing (the side panel's **Lyrics** tab).

### The lyrics button

A download icon (an arrow onto a tray) in BL's lyrics dock, right after BL's own controls,
styled like them; its tooltip is "Download lyrics (YTM Practice Grabber)". It stays there
through song changes and source switches.

When BL shows lyrics but no dock (the dock is turned off in BL's settings, or BL found no
lyrics for the song), a floating button with the same icon appears at the top right of the side
panel about 3 seconds after the lyrics, and goes away when a dock appears. It hides on side
panel tabs other than Lyrics.

**First click on a song** (nothing captured for it yet): the button pulses and its tooltip says
"Capturing…". The extension attaches Chrome's debugger to the tab (Chrome's bar appears), clicks
BL's refresh button, and keeps BL's lyrics response and its Unison response. Then it detaches
(the bar goes) and the menu opens. This makes BL fetch the song's lyrics once more: one extra
request to BL's lyrics service per capture. **Do not press Cancel on Chrome's bar** meanwhile:
that stops the capture ("Debugging was cancelled (Cancel on Chrome's debugging bar)").

**Later clicks** open the menu from the stored capture at once, with no request and no debugger.
Captures are kept until Chrome restarts (the 30 most recently used). A click while the menu is
open closes it; Esc or a click elsewhere closes it too, and the arrow keys move through it.

### The lyrics menu

Item by item, top to bottom (disabled items stay visible with their reason underneath):

| Item | What it saves |
|---|---|
| **Captured for another song** (a note, only when the capture is not of the song playing, e.g. the song changed during the capture) | nothing; it names the song the capture is of |
| **Download TTML for Tony** (bold; "Download LRC for Tony" when only LRC exists) | The best file for Tony, `Artist - Title [id].ttml` (or `.lrc`): no provider in the name, so it is the obvious file to import. Its second line says where it comes from, e.g. "Better Lyrics — word timing" or "Musixmatch — word timing, converted". Order: Better Lyrics TTML as-is; Unison word-timed TTML as-is; BiniLyrics syllable TTML as-is; Musixmatch word-by-word, then Unison word-timed LRC, converted; QQ converted; line-timed TTML as-is; line-timed LRC. Files Tony would refuse (over 1 MB, a DOCTYPE) are skipped. |
| **Download what's showing** | The source BL is showing now (read from BL's dock), made Tony-ready: the Tony pick itself, a TTML or LRC as it came (`<stem>.golyrics.ttml`...), or converted TTML (`<stem>.musixmatch-word.ttml`...). Disabled for YouTube's own lyrics and captions (not in the captured request), for plain text, and when it cannot see BL's dock. |
| **Other sources** | One item per source BL fetched, in its own format, labelled e.g. "Better Lyrics — TTML, word-synced" with the file's ending underneath; the one BL is showing ends with "(showing)". Musixmatch word-by-word, Unison word-timed LRC and QQ also get a "… → TTML" item, which saves the converted file. |
| **Raw response (.txt)** | BL's whole lyrics response as captured, `<stem>.lyrics-stream.txt`: what you used to copy from DevTools. |
| **Re-capture** | Captures the song again (BL fetches it again), for example when BL's lyrics changed. |

After a download the page shows "Saved". BL lets you shift a song's lyrics in time (the offset
in its dock); downloaded files are **never** shifted. When the offset of the song playing is not
zero, the message adds, for example: "BL shows these lyrics shifted by +0.2 s; the file is not
shifted. In Tony use Edit → Shift Lyrics…".

### File names

Every file of a song starts with the same stem, `Artist - Title [videoId]`, made from what
YouTube Music shows for the song playing (characters Windows does not allow in file names, such
as `/ : ? *`, become spaces; the artist and title part is cut at 136 characters, the video id is
always kept).

| File | Content |
|---|---|
| `<stem>.ttml` / `<stem>.lrc` | Download TTML for Tony |
| `<stem>.golyrics.ttml` | Better Lyrics (BL's own) TTML |
| `<stem>.binimum.ttml` | BiniLyrics TTML |
| `<stem>.musixmatch-word.lrc`, `<stem>.musixmatch-word.ttml` | Musixmatch word-by-word, as it came and converted |
| `<stem>.musixmatch.lrc` | Musixmatch line-synced |
| `<stem>.lrclib.lrc`, `<stem>.lrclib.txt` | LRCLib synced and plain |
| `<stem>.qq.qrc.xml`, `<stem>.qq.ttml` | QQ ("Better Lyrics Portato") QRC, as it came and converted |
| `<stem>.kugou.lrc` | KuGou ("Better Lyrics Legato") |
| `<stem>.unison.ttml` / `.unison.lrc` / `.unison.txt` | Unison (community lyrics), in the format it came in; word-timed LRC converts to `<stem>.unison.ttml` |
| `<stem>.<provider>.json` | a source BL's service added after 3.0.0.4, or one that could not be decoded |
| `<stem>.lyrics-stream.txt` | Raw response |
| `<stem>.opus` (or `.m4a`, ...) | the audio button's file |

Saving a file a second time does not overwrite it: Chrome adds ` (1)` to the new one.

### The audio button

A music note with an arrow at the end of the player bar's right-hand controls (tooltip
"Download audio (YTM Practice Grabber)"). It always shows the state of the song playing now:

- **Idle**: a click downloads the song's audio.
- **Running**: a badge shows the percentage (the tooltip too). A click asks "Stop this audio
  download?" with **Stop download** and **Keep downloading**: a stray double click never stops a
  download. Stopping says "Audio download cancelled"; yt-dlp's unfinished `.part` file is left
  in the folder (yt-dlp resumes it next time).
- **Done**: a check mark; the page says "Audio saved: <path>" and the tooltip keeps the path. A
  click opens the folder in Explorer with the file selected.
- **Error**: an exclamation mark; the message ("Audio download failed: <why>") stays in the
  tooltip, and a click tries again.

The states belong to the open page: reloading it starts every song at idle again (saved files
stay on disk). A download keeps running if you leave the song or close the tab.

**Music videos.** YouTube Music plays some songs as their music video rather than the album
track. A video's audio often has an intro or outro, so lyrics timed to the album track would not
line up. When YouTube Music says the item is anything other than the album track
(`MUSIC_VIDEO_TYPE_ATV`), a click first asks: "This is a music video, not the album track: its
audio may have an intro or outro, so lyrics timed to the album track won't line up." with
**Download anyway** and **Cancel**. If YouTube Music also has the song as an album track, play
that one and download it instead.

### Where files go

- **Lyrics** always go to Chrome's download folder (Chrome settings → Downloads → Location):
  extensions cannot save anywhere else.
- **Audio** goes to the folder set in the options ("Save audio in this folder instead"); if
  none is set, to Chrome's download folder, which the extension learns from the first lyrics
  file it saves (so download one lyrics file before the first audio). When there is no folder
  yet, or the one chosen is not a full path or does not exist, the host uses
  `fallbackOutputDir` from `config.json`. The options page shows the result as "Audio goes to".

With the option **A folder for each song**, a song's files go into a folder named after its
stem: lyrics to `<Chrome's download folder>\<stem>\<stem>.ttml`, audio to
`<audio folder>\<stem>\<stem>.opus`. When the audio folder is Chrome's download folder, both
land in the same folder.

### Tony and Moises

1. Download the lyrics (**Download TTML for Tony**) and the audio for the song.
2. Upload the audio to Moises and save the stems you want **into the same folder** (with the
   per-song folder option, that is the song's own folder). Moises stems keep the original's
   timeline, so the lyrics line up with them.
3. In Tony, open a stem or the original as the reference, then **File → Import Lyrics…**. Tony's
   dialog opens in the reference audio's folder and lists `*.ttml` and `*.lrc`, so
   `<stem>.ttml` is right there.
4. If BL had an offset for the song, apply it with **Edit → Shift Lyrics…**.

## Options

`chrome://extensions` → YTM Practice Grabber → Details → Extension options. Every change is
saved at once ("Saved" shows next to it).

- **When to capture**
  - **On demand** (recommended, the default): the debugger is attached only for the few seconds
    after you click the lyrics button. Needs BL's refresh button in its dock.
  - **Always attached**: the debugger stays attached to every YouTube Music tab and keeps
    whatever lyrics BL loads by itself, so a click needs no extra request when BL has just
    loaded the song. Chrome's debugging bar stays up the whole time (see
    [step 6](#6-optional-hide-chromes-debugging-bar)). BL keeps lyrics in its own cache for 7
    days and loads nothing for a cached song: a click then clicks BL's refresh button as in on
    demand mode, or, if BL's refresh button is off, waits for the next lyrics BL loads.
- **Debug capture logging**: writes each capture's steps to the service worker's console (see
  [docs/spike-notes.md](docs/spike-notes.md) for how to open it). Never the request or the lyrics.
- **A folder for each song**: see [Where files go](#where-files-go).
- **Audio folder**
  - "Chrome's download folder": what the extension learned, or "not learned yet — download a
    lyrics file once".
  - **Save audio in this folder instead**: a full folder path such as `C:\Users\you\Music`; empty
    uses Chrome's download folder. Saved when you leave the field or press Enter. A path that is
    not a full folder path gets a warning: the host would ignore it and use `fallbackOutputDir`.
  - "Audio goes to": where the next audio download will go.
- **Native host**: the extension's ID (the one `install.ps1` registers) and **Test connection**.

## Troubleshooting

Messages appear at the bottom right of the YouTube Music page, above the player bar (for 6
seconds, or until clicked), in the buttons' tooltips, or on the options page. The texts below
are the extension's own.

### No lyrics button, or BL was updated

All of BL's page details live in `src/shared/blyrics.ts` (`BL_SELECTORS`, checked against
`BL_VERIFIED_VERSION = "3.0.0.4"`), and BL's two lyrics addresses in `src/shared/blRequests.ts`.
After a BL update, if the button is missing or the menu says `Unknown lyrics source "…" (checked
with Better Lyrics 3.0.0.4)`, compare those with the new BL (the checks in
[docs/spike-notes.md](docs/spike-notes.md) show how), fix, and rebuild. While the capture still
works, **Raw response (.txt)** always saves BL's whole response, whatever the menu makes of it.

- **BL's dock is turned off**: the floating button appears instead (top right of the side panel,
  about 3 s after the lyrics).
- **All of BL's dock controls are turned off**: BL then hides the whole dock, and the lyrics
  button with it (no floating button either, since the dock exists). Turn at least one dock
  control back on, preferably the refresh button.
- **BL's refresh button is turned off**: in on demand mode a click says "Turn on BL's refresh
  button in its dock settings, or choose "Always attached" under When to capture in this
  extension's options." In always attached mode the click says "Waiting for
  Better Lyrics to load lyrics: its refresh button is off, so the capture takes the next lyrics
  it loads…", and ends with "No lyrics stream from Better Lyrics within 30 s" if BL loads
  nothing (for a song in its cache it does not).

### The capture fails

- "Debugging was cancelled (Cancel on Chrome's debugging bar)": Cancel was pressed on Chrome's
  bar. Click the lyrics button again. In always attached mode the extension attaches again at
  the next click or when the tab reloads.
- "Another debugger is already attached to this tab. Close other debugging tools on it (or
  reload the tab) and try again.": another extension (or tool) is debugging the tab.
- "Better Lyrics made no lyrics request within 30 s": BL did not fetch after the refresh click.
  Try **Re-capture**; if it keeps happening, BL may have changed (see above).
- "The lyrics request was cancelled before it finished": the response ended without BL's closing
  `event: done`, which the capture relies on (see PLAN.md §8).
- "The lyrics server refused the request (HTTP 403)" or "The lyrics server answered HTTP <n>":
  BL's lyrics service refused. (BL retries a 403 once with a new token, and the capture waits for
  that retry; this message means the retry failed too, or never came.)
- "This song's capture is no longer kept (a browser restart or newer captures removed it):
  capture it again": click **Re-capture**.

### The extension was reloaded

After the extension is reloaded or updated, a YouTube Music tab opened before keeps the old
version: its buttons say "The extension was reloaded: reload this tab" (a capture running at that
moment says "The extension's background stopped; try again" first). Reload the tab.

### Audio: the native host

These come from Test connection ("Test failed: …") and from the audio button ("Audio download
failed: …"):

- "The native host is not installed: run native-host\install.ps1 (see the README)." Chrome finds
  no registered host: run [install.ps1](#4-install-the-native-host), then restart Chrome.
- "The native host is registered for another extension ID: run install.ps1 -ExtensionId
  mengelecikhhdpjdebjpokcmhdkhjobj." The host was registered for an ID other than the one Chrome
  shows. Run `install.ps1` with `-ExtensionId` and the ID the message names (also shown on the
  options page), from the `native-host` folder.
- "The native host stopped unexpectedly." The host could not start or crashed. Usually
  `host.bat` points to a Python that is gone: run `install.ps1` again (its test ping shows the
  host's own error).
- "The native host sent something Chrome could not read." Something other than the host's
  messages reached Chrome; report it.

The host's own problems (shown by Test connection and `install.ps1`, and as the reason of a
failed download):

- "yt-dlp was not found at C:\Tools\yt-dlp.exe (ytDlpPath in …\native-host\config.json)", or
  "Set ytDlpPath in … to the full path of yt-dlp.exe": fix `ytDlpPath` in
  [config.json](#configjson).
- "ffmpeg was not found at … (ffmpegLocation in …)" or "ffmpeg was not found on PATH; set
  ffmpegLocation in …": fix `ffmpegLocation`. Without ffmpeg, `-x` downloads fail with yt-dlp's
  own error.
- "…\config.json is missing: run install.ps1, or copy config.example.json to config.json and
  edit it", or "… is not valid JSON (…); in JSON every backslash in a path is written twice".
- "The folder … (fallbackOutputDir in …) does not exist": create it or fix the path.
- "yt-dlp failed (exit code <n>): ERROR: …": yt-dlp's own last error line. The service worker's
  console has yt-dlp's last 20 lines of error output.

### Audio: a title is refused

yt-dlp replaces `$NAME` and `${NAME}` in the name it is given (and `%NAME%` in a folder name)
with the value of the environment variable NAME, if your PC has one. The host refuses a song
whose name would change that way rather than let yt-dlp save it under another name, or
somewhere else:

- "yt-dlp would replace part of the file name "…" with an environment variable's value ($NAME or
  ${NAME}), so it cannot be saved under that name"
- "yt-dlp would replace part of the folder name "…" with an environment variable's value" (with
  the per-song folder)

The song's lyrics still download. For the audio, run yt-dlp by hand and rename the file to the
lyrics' stem.

### Chrome asks where to save every lyrics file

That is Chrome's setting **Ask where to save each file before downloading** (Settings →
Downloads). Turn it off for one-click saving. While it is on, the folder you choose for a lyrics
file becomes the "Chrome's download folder" the extension learns (without the per-song folder
option; with it, only when the file stays in a folder named after the song), and audio follows
it.

### Long paths

Windows limits a path to 260 characters unless long paths are enabled. A stem can be up to 150
characters, and with **A folder for each song** it appears twice in a path
(`<folder>\<stem>\<stem>.musixmatch-word.ttml`), so a very long title in a deep download folder
can pass the limit; Chrome or yt-dlp may then fail to save. Keep the download and audio folders
short (for example `C:\Music`), or turn the per-song folder off for such songs. Typical stems are
far shorter.

## Development

Everything below is for working on the extension; using it needs none of it.

| Command | What it does |
|---|---|
| `npm run build` | bundles `src/` with esbuild into `dist/` and copies `static/` |
| `npm run watch` | rebuilds on every change (reload the extension in Chrome afterwards) |
| `npm run typecheck` | `tsc` over `src/` and over the tests |
| `npm test` | the unit tests (Vitest, a few seconds); 2 tests skip unless `fixtures/local/` has captures |
| `npm run test:e2e` | builds, then drives the built extension in Chromium against a mock music.youtube.com, BL dock and lyrics servers, and the real native host with a fake yt-dlp (about 30 s) |
| `npm run gen-key` | made the manifest's key once; it refuses to replace it (that would change the extension ID) |

- **Python host tests**: `python -m unittest discover -s native-host -p "test_*.py"`
  (`python3` on Linux). The tests that run the host against the fake yt-dlp
  (`native-host/testing/fake_yt_dlp.py`, a shebang script) skip on Windows.
- **End-to-end tests** run on Linux only: they need `openssl`, `/bin/sh`, `python3` and the
  Chromium build Playwright 1.56.1 uses (`playwright-core` is a pinned dev dependency; the
  browser is found through `PLAYWRIGHT_BROWSERS_PATH`). Set `E2E_MENU_SCREENSHOT=<file.png>` to
  keep a screenshot of the open lyrics menu, and `E2E_OPTIONS_SCREENSHOT=<file.png>` to keep the
  options page as `<file>-light.png` and `<file>-dark.png`.
- **Real captures**: committed fixtures contain invented lyrics only (real lyrics are
  copyrighted). Put raw lyrics streams (the **Raw response (.txt)** files) in `fixtures/local/`,
  which git ignores; `npm test` then also checks the Musixmatch and QQ converters against them.
- The reference sources the build agents read (Better Lyrics, its parsers, Tony) are not needed
  to build or test; `@braccato/parsers` (BL's parsers) is a dev dependency the tests compare
  against.
- `docs/WORK_ORDERS.md` is the build log, phase by phase; `PLAN.md` the design.

## License

GPL-3.0; see [LICENSE](LICENSE).
