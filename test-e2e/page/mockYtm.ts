// The mock YouTube Music watch page for the end-to-end test, with Better Lyrics' parts. It runs in
// the page's MAIN world (bundled by server.ts), so it stands in for two things at once:
//
// - YouTube Music: `#page > #main-panel + #side-panel`, a `#movie_player` whose getVideoData() /
//   getPlayerResponse() the page bridge calls, and `ytmusic-player-bar` with title, byline and
//   `.right-controls-buttons` (where B10's audio button goes).
// - Better Lyrics 3.0.0.4 with this song's lyrics in its cache: the dock and lyrics built by
//   test/helpers/blPage.ts (the same DOM the unit tests use), and the refresh button's behaviour
//   (PLAN.md 1.3): add `--busy`, POST the form body with the fake `token=` to the lyrics API and
//   GET Unison with the fake `x-key-id`, read the stream to its end (retrying a 403 once with a new
//   token, as BL's startStream() does), then rebuild the controls with replaceWith().
//
// BL's real requests come from its isolated-world content script; in MV3 those fetch with the
// page's origin, as these do. The test drives the page through `window.mockYtm` (MockYtm).
import { addPlayerPage, mountDock, showLyrics } from "../../test/helpers/blPage";
import { E2E_KEY_ID, E2E_RETRY_TOKEN, E2E_TOKEN } from "../secrets";

const LYRICS_URL = "https://lyrics.api.dacubeking.com/v2/lyrics";
const UNISON_URL = "https://unison.betterlyrics.org/lyrics";
/** What BL's dock shows as the song's offset; non-zero, so the "Saved" toast mentions it. */
export const MOCK_OFFSET = "+0.2s";

export interface MockSong {
  videoId: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds. */
  duration: number;
}

/** One lyrics load by the mock BL (a refresh click, or the test asking for one). */
export interface BlLoad {
  videoId: string;
  /** HTTP status of each stream request in order (a 403 then the retry's 200). */
  streamStatuses: number[];
  /** reader.read() results with data, and their bytes: BL got the stream in this many pieces. */
  streamReads: number;
  streamBytes: number;
  /** The stream as BL decoded it (TextDecoder with `stream: true`, as BL does). */
  streamText: string;
  unisonStatus: number | null;
  error?: string;
  done: boolean;
}

export interface MockYtm {
  song: MockSong;
  refreshClicks: number;
  loads: BlLoad[];
  /** BL loading this song's lyrics without a click (a song change; always-capture mode). */
  loadLyrics(): Promise<BlLoad>;
  /** BL rebuilding its controls (a source switch): `__controls` replaced with replaceWith(). */
  rebuildControls(): void;
}

const params = new URL(location.href).searchParams;
const song: MockSong = {
  videoId: params.get("v") ?? "",
  title: params.get("title") ?? "Northbound Kites",
  artist: params.get("artist") ?? "Marrow & Tin",
  album: "Weather Almanac",
  duration: 72,
};

const mock: MockYtm = {
  song,
  refreshClicks: 0,
  loads: [],
  loadLyrics,
  rebuildControls,
};
(window as unknown as { mockYtm: MockYtm }).mockYtm = mock;

// --- YouTube Music ------------------------------------------------------------------------------

const { mainPanel } = addPlayerPage();
const player = document.createElement("div");
player.id = "movie_player";
Object.assign(player, {
  getVideoData: () => ({ video_id: song.videoId, title: song.title, author: song.artist }),
  getPlayerResponse: () => ({ videoDetails: { videoId: song.videoId, musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } }),
});
mainPanel.append(player);

const bar = document.createElement("ytmusic-player-bar");
const info = document.createElement("div");
const title = document.createElement("div");
title.className = "title";
// Not what getVideoData() says, on purpose: a file named after this title would show that the
// content script fell back to the player bar because the page bridge did not answer.
title.textContent = `${song.title} (player bar)`;
const byline = document.createElement("div");
byline.className = "byline";
byline.textContent = `${song.artist} \u{2022} ${song.album} \u{2022} 2025`;
info.append(title, byline);
const rightControls = document.createElement("div");
rightControls.className = "right-controls-buttons";
bar.append(info, rightControls);
document.body.append(bar);

// --- Better Lyrics ------------------------------------------------------------------------------

/** BL's mountDock() for this song: the controls replaced (or prepended), the refresh button wired. */
function rebuildControls(): void {
  const inner = mountDock({ position: "bottom-right", sourceName: "Better Lyrics", offset: MOCK_OFFSET });
  // Glyphs for the screenshot; BL draws SVG icons here.
  const glyphs: [string, string][] = [
    [".blyrics-dock__control:not(.blyrics-dock__refresh)", "\u{6587}"],
    [".blyrics-dock__refresh", "\u{21BB}"],
  ];
  for (const [selector, glyph] of glyphs) {
    const element = inner.querySelector(selector);
    if (element !== null) element.textContent = glyph;
  }
  inner.querySelectorAll(".blyrics-dock__offset-step").forEach((step, index) => (step.textContent = index === 0 ? "\u{2212}" : "+"));
  const refresh = inner.querySelector<HTMLButtonElement>(".blyrics-dock__refresh");
  refresh?.addEventListener("click", () => {
    mock.refreshClicks++;
    // BL: the busy class stays until the controls are rebuilt.
    refresh.classList.add("blyrics-dock__refresh--busy");
    void loadLyrics();
  });
}

async function loadLyrics(): Promise<BlLoad> {
  const load: BlLoad = { videoId: song.videoId, streamStatuses: [], streamReads: 0, streamBytes: 0, streamText: "", unisonStatus: null, done: false };
  mock.loads.push(load);
  try {
    await Promise.all([stream(load, 0), unison(load)]);
  } catch (error) {
    load.error = error instanceof Error ? error.message : String(error);
  }
  rebuildControls();
  showLyrics();
  load.done = true;
  return load;
}

/** BL's startStream(): the form body with the token; one retry with a new token after a 403. */
async function stream(load: BlLoad, retry: number): Promise<void> {
  const body = new URLSearchParams();
  body.append("videoId", song.videoId);
  body.append("song", song.title);
  body.append("artist", song.artist);
  body.append("duration", String(Math.round(song.duration)));
  body.append("album", song.album);
  body.append("alwaysFetchMetadata", "false");
  body.append("token", retry === 0 ? E2E_TOKEN : E2E_RETRY_TOKEN);
  const response = await fetch(LYRICS_URL, { method: "POST", body, signal: AbortSignal.timeout(20_000) });
  load.streamStatuses.push(response.status);
  if (response.status === 403 && retry < 1) return stream(load, retry + 1);
  if (!response.ok || response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined && value.length > 0) {
      load.streamReads++;
      load.streamBytes += value.length;
      load.streamText += decoder.decode(value, { stream: true });
    }
    if (done) break;
  }
  load.streamText += decoder.decode();
}

/** BL's unison(): GET with the identity header; 404 means none. */
async function unison(load: BlLoad): Promise<void> {
  const url = new URL(UNISON_URL);
  url.searchParams.append("v", song.videoId);
  url.searchParams.append("song", song.title);
  url.searchParams.append("artist", song.artist);
  url.searchParams.append("duration", String(Math.round(song.duration)));
  url.searchParams.append("album", song.album);
  const response = await fetch(url.toString(), { headers: { "x-key-id": E2E_KEY_ID }, signal: AbortSignal.timeout(10_000) });
  load.unisonStatus = response.status;
  if (response.ok) await response.json();
}

// BL has this song in its 7-day cache: dock and lyrics are up at once, with no request.
rebuildControls();
showLyrics();
