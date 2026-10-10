// What YouTube Music is playing, for file names (PLAN.md 3.7, and 7.1 "Filename stem source").
// Asked of the page bridge, which reads YouTube's player; when the bridge does not answer in
// time (not injected yet, or YouTube's player API changed) it is read from the page instead:
// the URL's `v` parameter and the player bar's text.
//
// YTM's `author` may be a channel name such as "Artist - Topic" for some uploads (unverified).
// It is kept as it is for now; whatever it is, the audio and lyrics files both take their stem
// from here, so they still match.
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeReply, encodeRequest, type PlayerInfo } from "../shared/bridgeProtocol";
import { buildStem, isVideoId } from "../shared/filenames";

/** How long to wait for the bridge. It answers at once when it is there. */
export const BRIDGE_TIMEOUT_MS = 300;

// Unverified: verify on the live page (user check). The player bar's song title, and its byline,
// "Artist <bullet> Album <bullet> Year" (bullet = U+2022), whose part before the first bullet
// standing on its own (white space or an end on both sides) is the artist.
export const PLAYER_BAR_SELECTORS = {
  title: "ytmusic-player-bar .title",
  byline: "ytmusic-player-bar .byline",
} as const;
const BYLINE_SEPARATOR = /(?:^|\s)\u{2022}(?:\s|$)/u;

export interface NowPlaying extends PlayerInfo {
  /** Null or a valid video id (`isVideoId`). */
  videoId: string | null;
  /** The bridge, or the page's URL and player bar (no `musicVideoType` there). */
  from: "bridge" | "page";
}

export type StemResult = { stem: string } | { stem: null; reason: string };

let requestCount = 0;

/** The bridge's answer to one request, or null when none came within `timeoutMs`. */
export function askBridge(timeoutMs: number): Promise<PlayerInfo | null> {
  // A counter keeps this script's asks apart; the random part, another instance's.
  const requestId = `pg-${++requestCount}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const finish = (info: PlayerInfo | null) => {
      clearTimeout(timer);
      document.removeEventListener(NOW_PLAYING_EVENT, onReply);
      resolve(info);
    };
    const onReply = (event: Event) => {
      const reply = decodeReply((event as CustomEvent<unknown>).detail);
      if (reply?.requestId !== requestId) return;
      const { videoId, title, author, musicVideoType } = reply;
      finish({ videoId, title, author, musicVideoType });
    };
    // Listen and arm the timer first: the bridge answers inside dispatchEvent.
    document.addEventListener(NOW_PLAYING_EVENT, onReply);
    const timer = setTimeout(() => finish(null), timeoutMs);
    document.dispatchEvent(new CustomEvent(WHAT_IS_PLAYING_EVENT, { detail: encodeRequest(requestId) }));
  });
}

/**
 * What is playing: the bridge's answer when it names a valid video id, else what the page shows.
 * Never mixes the two, so a song's stem does not depend on which of them answered a field.
 */
export async function getNowPlaying(timeoutMs = BRIDGE_TIMEOUT_MS): Promise<NowPlaying> {
  const info = await askBridge(timeoutMs);
  if (info?.videoId != null && isVideoId(info.videoId)) return { ...info, from: "bridge" };
  return nowPlayingFromPage();
}

/** The isolated world's own view: the URL's `v` parameter and the player bar's title and byline. */
export function nowPlayingFromPage(): NowPlaying {
  let videoId: string | null = null;
  try {
    const v = new URL(location.href).searchParams.get("v");
    if (v !== null && isVideoId(v)) videoId = v;
  } catch {
    // No usable URL: no id.
  }
  const byline = textOf(PLAYER_BAR_SELECTORS.byline);
  const author = byline?.split(BYLINE_SEPARATOR, 1)[0].trim() || null;
  return { videoId, title: textOf(PLAYER_BAR_SELECTORS.title), author, musicVideoType: null, from: "page" };
}

/** The file stem for what is playing (`buildStem`), or why there is none; never throws. */
export function stemFor(nowPlaying: Pick<PlayerInfo, "videoId" | "title" | "author">): StemResult {
  const { videoId, title, author } = nowPlaying;
  if (videoId === null) return { stem: null, reason: "Could not tell which video is playing" };
  try {
    return { stem: buildStem({ artist: author, title, videoId }) };
  } catch {
    return { stem: null, reason: `"${videoId.slice(0, 40)}" is not a YouTube video id` };
  }
}

function textOf(selector: string): string | null {
  return document.querySelector(selector)?.textContent?.trim() || null;
}
