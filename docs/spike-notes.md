# Checks in your own browser (👤)

Everything in this repository was built and tested in a Linux container: unit tests, the
Python host's tests, and an end-to-end test that drives the built extension in Chromium 141
against a **mock** music.youtube.com, a **mock** Better Lyrics dock and **mock** lyrics servers,
with the real native host and a fake yt-dlp. What that cannot show is how the real pages, your
Chrome on Windows, PowerShell, Explorer, yt-dlp against YouTube, and Tony behave. These checks
are that part. They are ordered so that the quickest checks, and the ones that decide whether a
whole feature works, come first.

Each check says how to do it, what to expect, and what to report. Report what differs from the
expectation; "as expected" is enough otherwise. **Never paste the request side of BL's lyrics
request from DevTools** (its body holds BL's token, its Unison request a key): responses, file
names and the extension's console lines are fine.

Set up first: README steps 1 to 3 (clone, build, load `dist\`). The native host (step 4) is
needed from check 8 on.

## Already verified in Chromium (no need to repeat)

From the end-to-end tests (B8, B11; Chromium 141, headless, Linux) and the host's tests (B9):

- The lyrics button sits right after BL's controls in a dock built like BL 3.0.0.4's, is visible,
  and stays there when BL replaces its controls (as it does on every song or source switch).
- On demand: a click attaches, clicks BL's refresh button, captures the streamed response
  (`bodySource: "stream"`, see check 4), detaches, and opens a menu listing every source; the
  Tony file equals the stream's Better Lyrics TTML byte for byte; the raw download equals the
  streamed bytes; Musixmatch word-by-word → TTML reads back (by Tony's rules) with the same words
  and times. A second click opens the menu from the stored capture with no request and no
  debugger.
- A 403 followed by BL's retry is captured from the retry; Unison's 404 means no Unison source.
- Always attached mode stores a stream BL loads by itself, without a click.
- BL's token and Unison key reached the mock servers but appear in no extension storage, no
  console (worker or page) and no saved file, in both modes.
- Downloads keep the names asked for; the learned folder is Chrome's real download folder; a raw
  stream of 1.75 MB (a 2.3-million-character data URL) saves whole. Chromium's downloads API
  accepted all 1028 sanitised file names B1 tried.
- The menu opens upwards from a dock at the bottom and stays inside the window.
- Reloading the extension: a capture running at that moment says "The extension's background
  stopped; try again"; a click in a tab opened before says "The extension was reloaded: reload
  this tab".
- Audio: the button sits at the end of the player bar's right-hand controls; progress, then
  `<stem>.<ext>` saved in the folder of a lyrics file downloaded first; the music-video warning
  (Cancel downloads nothing, Download anyway downloads); Stop download ends yt-dlp and leaves only
  its `.part` file; a reveal from a new host process passes the saved-folder check (on Linux it
  then stops at "Showing a file in its folder works on Windows only").
- Options: the learned folder, settings saved on change, Test connection with the host's and
  yt-dlp's versions; with the host's registration removed, "The native host is not installed…";
  registered for another ID, "…run install.ps1 -ExtensionId…".
- yt-dlp 2026.08.19 itself (B9, a local file, `-x` with ffmpeg): progress lines and the final
  path come on stdout as the host expects.

## 0. The extension ID (seconds)

**How:** `chrome://extensions`, Developer mode on, look at the YTM Practice Grabber card.

**Expect:** ID `mengelecikhhdpjdebjpokcmhdkhjobj`; no error on the card.

**Report:** the ID if different, any error the card shows, your Chrome version
(`chrome://version`, first line).

## 1. BL's dock on the live page (DevTools console, 2 minutes)

Decides whether the lyrics button can find its place and the menu can read BL's state.

**How:** open a song with lyrics, with the side panel on **Lyrics**. Open DevTools (F12) →
Console, and run:

```js
[".blyrics-dock", "#side-panel .blyrics-dock__inner", ".blyrics-dock__inner > .blyrics-dock__controls",
 ".blyrics-dock__refresh", ".blyrics-dock__refresh--busy", ".blyrics-dock__source-name",
 ".blyrics-dock__offset > .blyrics-dock__offset-value", "#blyrics-wrapper", "#side-panel .blyrics-container"]
  .map((selector) => `${document.querySelectorAll(selector).length}  ${selector}`).join("\n")
```

then:

```js
({ position: document.querySelector(".blyrics-dock")?.getAttribute("data-position"),
   source: document.querySelector(".blyrics-dock__source-name")?.textContent,
   offset: document.querySelector(".blyrics-dock__offset > .blyrics-dock__offset-value")?.textContent })
```

**Expect:** a count of 1 for each selector except `--busy` (0 while BL is not refreshing), the
refresh button and the offset (1 each when those dock controls are turned on in BL), and
`.blyrics-container` (1 or more). `position` such as `bottom-right`; `source` one of
`Better Lyrics`, `Unison`, `BiniLyrics`, `Better Lyrics Portato`, `Musixmatch`, `LRCLib`,
`Better Lyrics Legato`, `YouTube`, `YouTube Captions`; `offset` such as `0.0s` or `+0.2s`.

**Report:** both outputs, and BL's version from its card in `chrome://extensions`.

## 2. YouTube Music's player (DevTools console, 3 minutes)

Decides the audio button's place, the file names, and the music-video warning.

**How:** in the same console, run this on (a) an **album track** (a song played from an album
page), (b) a **music video**, (c) after the queue moves on by itself, and (d) after you pick
another song in the queue:

```js
(() => {
  const player = document.querySelector("#movie_player");
  const data = player.getVideoData();
  return {
    controls: document.querySelectorAll("ytmusic-player-bar .right-controls-buttons").length,
    title: document.querySelector("ytmusic-player-bar .title")?.textContent.trim(),
    byline: document.querySelector("ytmusic-player-bar .byline")?.textContent.trim(),
    videoId: data.video_id, author: data.author, playerTitle: data.title,
    musicVideoType: player.getPlayerResponse()?.videoDetails?.musicVideoType,
    urlV: new URL(location.href).searchParams.get("v"),
  };
})()
```

**Expect:** `controls` 1; `title` the song's title; `byline` "Artist • Album • Year" for (a);
`author` the artist's name; `musicVideoType`
`MUSIC_VIDEO_TYPE_ATV` for (a) and something else, such as `MUSIC_VIDEO_TYPE_OMV`, for (b);
`urlV` equal to `videoId` in every case.

**Report:** the four outputs. In particular: whether `author` is the plain artist or
"Artist - Topic" (it becomes the start of every file name), and whether `urlV` follows the queue
in (c) and (d). (`urlV`, `title` and `byline` are only a fallback for when the extension's page
script does not answer; `videoId`, `author`, `playerTitle` and `musicVideoType` are what it
normally uses.)

## 3. The lyrics button: look and position (2 minutes)

**How:** with the extension loaded and the Lyrics tab showing, look at BL's dock. Hover the
row. Switch BL's source in its dock menu, and go to the next song. Then play a song BL has no
lyrics for (an instrumental) and wait 3 seconds; and switch the side panel to **Up next**.

**Expect:** a download icon (an arrow onto a tray) right after BL's own controls, the same size
and colour as BL's icons, brightening with the row on hover, tooltip "Download lyrics (YTM
Practice Grabber)"; still there after the source switch and the song change. For the song
without lyrics: a floating button with its own dark background at the top right of the side
panel, clear of YouTube Music's tab row; it hides on **Up next**.

**Report:** a screenshot of the dock with the button, and one of the floating button; anything
overlapping, clipped, or out of line.

## 4. The first capture: how Chrome hands over BL's response (5 minutes)

Decides whether the lyrics feature works at all in your Chrome. In Chromium 141, BL's lyrics
request (a streamed `fetch`) never "finishes" in the debugger's eyes: Chrome reports it as
cancelled once BL has read it, `Network.getResponseBody` has nothing, and the body comes only
from `Network.streamResourceContent` (`bodySource: "stream"`). The capture accepts such a
cancelled response only when it contains BL's closing `event: done`. A newer Chrome may hand
the body over differently; the capture tries all three ways and logs which one it used.

**How:**

1. Options (`chrome://extensions` → Details → Extension options) → turn on **Debug capture
   logging**.
2. `chrome://extensions` → YTM Practice Grabber → **Inspect views: service worker** → Console.
   Keep that window open while you capture.
3. In the YouTube Music tab, on a song not captured yet, click the lyrics button.
4. In the menu, click **Raw response (.txt)** and open the saved `.lyrics-stream.txt` in Notepad.

**Expect:** Chrome's bar "“YTM Practice Grabber” started debugging this browser" for a few
seconds; BL reloads its lyrics; the bar goes; the menu opens. In the worker's console, lines
starting `[YTM Practice Grabber] capture:`, among them one of

- `tab <n>: stream <id> cancelled after its done event, <n> ms; using stream` (as in Chromium
  141), or
- `tab <n>: stream <id> finished after <n> ms: getResponseBody <n> B, stream <n> B, eventSource
  <n> messages; using <way>`

and `stored a capture: <n> sources, body from <way>, <n> B, …`. The text file starts with an
`event: metadata` block, has one `event: provider` block per source, and ends with
`event: done` and its `data:` line.

**Report:** those console lines as they are (they hold no lyrics and no token); the `data:`
line after `event: done`; the field names (not the values) in the `metadata` block's `data:`;
how long the bar stayed; any `capture failed:` warning or message on the page. If the capture
fails with "The lyrics request was cancelled before it finished", that is this check failing:
report the last lines of the text file if one was saved.

## 5. "Download TTML for Tony" against your hand-cut file (10 minutes)

**How:** on a song you have not captured yet, open DevTools → Network on the YouTube Music
tab, click BL's refresh button in its dock, and cut the Better Lyrics TTML out of BL's `lyrics`
response the way you always have, into `old.ttml`. Close DevTools. Click the lyrics button; if
the menu's **Download TTML for Tony** says "Better Lyrics — word timing" under it, click it
(otherwise try another song). In PowerShell, in the folder holding both files:

```
(Get-FileHash .\old.ttml).Hash -eq (Get-FileHash -LiteralPath '.\<the downloaded name>.ttml').Hash
```

Then open DevTools on the tab again and click **Re-capture** in the lyrics menu.

**Expect:** `True`: the same bytes. (A difference only in line endings or escaping can come from
the copy by hand; then `fc.exe /n old.ttml "<downloaded>.ttml"` shows where.) Re-capture with
DevTools open works too.

**Report:** `True` or `False` and, if `False`, the first difference; whether the capture with
DevTools open worked or said "Another debugger is already attached to this tab…".

## 6. The rest of the lyrics menu (10 minutes)

**How:**

- Switch BL's source in its dock (for example to Musixmatch), reopen the lyrics menu, and use
  **Download what's showing**.
- Download a few **Other sources** items, including a "→ TTML" one and, if there is one, the
  QQ item (`.qq.qrc.xml`).
- Set BL's offset for the song to something other than zero, and download any file.
- Play another song and click the button; come back to the first and click again.

**Expect:** "(showing)" follows BL's source; **Download what's showing** saves that source's
Tony-ready file (`<stem>.musixmatch-word.ttml` for Musixmatch word-by-word). Every file is named
`Artist - Title [id]` plus exactly the ending shown in the menu (Chrome adds nothing). With an
offset the message adds "BL shows these lyrics shifted by … s; the file is not shifted. In Tony
use Edit → Shift Lyrics…". The new song gets its own capture; the first opens at once from the
stored capture.

**Report:** any file whose name or content is not what the menu said; anything the menu shows
disabled that you expected to work, with its reason.

## 7. Tony imports converted files (15 minutes)

**How:** first the committed examples: `test\fixtures\golden\musixmatch-word.ttml` and
`test\fixtures\golden\qq.ttml` (invented lyrics, "Marrow & Tin - Northbound Kites", converted
from invented Musixmatch word-by-word and QQ data exactly as real ones are). In Tony, with any
reference audio longer than 1:01 (their words run from 0:12 to 1:01), **File → Import Lyrics…**
each. Then real ones: a song whose menu lists "Musixmatch — LRC, word-synced", saved with its
"→ TTML" item; and a song with "Better Lyrics Portato — QRC, …" (QQ), also "→ TTML". Import each
with the song's own audio as the reference.

**Expect:** Tony's status bar says "Imported 22 words in 5 lines." (musixmatch-word) and
"Imported 25 words in 5 lines." (qq), and nothing more: no warning sentence after it. (With a
reference shorter than 1:01, "… words start after the end of the reference." is added; that is
the reference, not the file.) For the real files: no warning either; the words sit where they are
sung; a word split into syllables, such as "hy-" + "phenated", shows as one word; for QQ, the
first line is the first sung line (credit lines such as "词：…" or "Title - Artist" left out)
and no sung line is missing.

**Report:** the status bar text for each file; any line that looks wrong (its first words and
what is wrong). Optional: copy the two songs' `.lyrics-stream.txt` into `fixtures\local\` and
run `npm test`: the two tests that skip without real captures then run on them; report pass or
fail (do not send the files).

## 8. Install the native host (10 minutes)

These scripts have never been run: there was no PowerShell to run them.

**How:** README step 4: in `native-host`, run
`powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` (with `-Python …` for conda
if it finds no Python). Then:

```
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jormki.ytm_grabber"
type host.bat
type com.jormki.ytm_grabber.json
type config.json
```

Restart Chrome, then Options → **Test connection**. Optional, to check `uninstall.ps1` and the
"not installed" message: run `powershell -NoProfile -ExecutionPolicy Bypass -File
.\uninstall.ps1`, click **Test connection** again, then run `install.ps1` again.

**Expect:** install.ps1 prints `Python:`, `Wrote` (host.bat, the manifest), `Registered`, `Wrote`
or `Kept` (config.json) and `Test:     host 0.1.0, yt-dlp <version>, ffmpeg found: True`, then
`Done. …`. The registry's default value is the manifest's full path; host.bat has two lines
(`@echo off` and the quoted python.exe running `ytm_grabber_host.py`). Test connection says "The
native host answers." with yt-dlp's version and "ffmpeg: found". After uninstall.ps1, Test
connection says "Test failed: The native host is not installed: run native-host\install.ps1 (see
the README)."

**Report:** install.ps1's whole output (it holds only local paths), any red error or yellow
warning, and the Test connection result. If your user name or Python's path has non-ASCII
letters, say so (host.bat handles that specially).

## 9. A real audio download (5 minutes)

**How:** on an album track, download a lyrics file first (Options should then show "Chrome's
download folder: <your folder>"). Click the audio button. Then on another song, start a download
and stop it (click the button → **Stop download**). Then turn on **A folder for each song** in
the options and download lyrics and audio for a third song. Last, reload the page and click the
audio button again on the first song, whose file already exists (no test covers what yt-dlp
does then).

**Expect:** a badge counting up, then a check mark and "Audio saved: <path>", the path being
`<download folder>\<same stem as the lyrics>.opus` (or `.m4a`; `-x` keeps YouTube's audio
format). No console window appears. The stopped one says "Audio download cancelled" and leaves
only a `.part` file. With the folder option, both files are in `<download folder>\<stem>\`.

**Report:** the saved paths, how long a download took, whether the percentage moved, whether a
console window flashed up, what the second download of the first song said, any error message
verbatim.

## 10. Show the file in Explorer (1 minute)

**How:** after a download finished, click the check mark. (The host process that saved the file
exits as soon as the download is over, so this also checks that a new one knows the folder.)

**Expect:** an Explorer window on the folder with the file selected.

**Report:** whether it opened, whether it came to the front or opened behind Chrome, or the
message ("Could not show the file: …").

## 11. The music-video warning (2 minutes)

**How:** play a music video (one where check 2 showed a type other than `MUSIC_VIDEO_TYPE_ATV`)
and click the audio button; try **Cancel**, then **Download anyway**. Then click it on an album
track.

**Expect:** for the video, a popover: "This is a music video, not the album track: its audio may
have an intro or outro, so lyrics timed to the album track won't line up." with **Download
anyway** and **Cancel**; Cancel downloads nothing. No popover on the album track.

**Report:** the `musicVideoType` of each and whether the popover came when expected.

## 12. A non-ASCII title (5 minutes)

**How:** a song whose artist or title has letters outside ASCII (Finnish ä/ö, or Japanese, say),
and one with a character Windows forbids in names (`/`, `:`, `?`). Download the Tony file and
the audio for each, and import the TTML in Tony.

**Expect:** names keep the letters as YouTube Music shows them; forbidden characters become
spaces; lyrics and audio share the stem; Tony imports. (A title containing `$` followed by the
name of an environment variable on your PC, such as `$PATH`, is refused for audio: that is
deliberate, see the README.)

**Report:** the file names as Explorer shows them; any error message verbatim.

## 13. What Chromium 141 did that your Chrome may do differently

- **How the response is handed over** (check 4): if your Chrome finishes the request normally
  the console says `using getResponseBody` and everything still works; if it reports no
  `event: done`, captures fail. Either way, report the line.
- **Reloading the extension:** reload it in `chrome://extensions`, then, in a YouTube Music tab
  opened before, click the lyrics button on a song not captured yet and the audio button on an
  album track not downloaded yet. Expect "The extension was reloaded: reload this tab" (from the
  audio button: "Audio download failed: The extension was reloaded: reload this tab"). Report
  what it says instead.
- **Chrome's native messaging errors** (check 8's optional part): the extension turns Chrome's
  own error texts into its messages by matching their exact words. If your Chrome words them
  differently, the message shown is Chrome's own sentence: report it verbatim.
- **"Ask where to save each file before downloading"** (Chrome settings → Downloads), optional:
  with it on, Chrome should ask where to save each lyrics file. Report whether it does.

## 14. Optional: the debugging bar and always attached mode

**How:** add `--silent-debugger-extension-api` to the Chrome shortcut (README step 6) and do a
capture. Separately, in the options choose **Always attached**, reload the YouTube Music tab,
play a song you have not played for 7 days (so BL fetches it), then click the lyrics button.

**Expect:** with the flag, no debugging bar during a capture. In always attached mode the bar
stays up (without the flag), and the click opens the menu at once, without "Capturing…".

**Report:** whether the flag hid the bar, any warning Chrome shows about the flag at start-up,
and whether always attached mode behaved as described (with two YouTube Music tabs open too, if
you use that).

## What to send back

One line per check: its number, "as expected" or what differed, plus the outputs asked for
(console outputs, install.ps1's output, file names, status bar texts, screenshots for check 3).
