// Page bridge (dist/page-bridge.js), MAIN world on music.youtube.com: the only script
// that can call the player's own methods. Bundled as an IIFE so nothing leaks into the page.
//
// It answers `pg:what-is-playing` with `pg:now-playing` (src/shared/bridgeProtocol.ts). Every
// request gets an answer, with nulls for whatever the player cannot tell, so the content script
// need not wait for its timeout. YouTube's player API is not ours: any part of it may be missing
// or throw, and nothing here may ever throw into the page.
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeRequest, encodeReply, stringOrNull, type PlayerInfo } from "../shared/bridgeProtocol";

/** The parts of YouTube's `#movie_player` element we call. */
interface YouTubePlayer {
  getVideoData?: () => { video_id?: unknown; title?: unknown; author?: unknown } | null | undefined;
  getPlayerResponse?: () => { videoDetails?: { musicVideoType?: unknown } | null } | null | undefined;
}

/** What `#movie_player` reports now; each call is tried on its own so one failing keeps the other. */
function readPlayer(doc: Document): PlayerInfo {
  const info: PlayerInfo = { videoId: null, title: null, author: null, musicVideoType: null };
  let player: YouTubePlayer | null = null;
  try {
    player = doc.querySelector("#movie_player") as YouTubePlayer | null;
  } catch {
    return info;
  }
  if (!player) return info;
  try {
    const data = typeof player.getVideoData === "function" ? player.getVideoData() : null;
    if (data) {
      info.videoId = stringOrNull(data.video_id);
      info.title = stringOrNull(data.title);
      info.author = stringOrNull(data.author);
    }
  } catch {
    // Keep the nulls: the content script falls back to the URL and the player bar.
  }
  try {
    const response = typeof player.getPlayerResponse === "function" ? player.getPlayerResponse() : null;
    info.musicVideoType = stringOrNull(response?.videoDetails?.musicVideoType);
  } catch {
    // Keep the null.
  }
  return info;
}

function answer(event: Event): void {
  try {
    const requestId = decodeRequest((event as CustomEvent<unknown>).detail);
    if (requestId === null) return;
    const detail = encodeReply({ requestId, ...readPlayer(document) });
    document.dispatchEvent(new CustomEvent(NOW_PLAYING_EVENT, { detail }));
  } catch {
    // Never throw into the page; the content script times out and uses its fallback.
  }
}

document.addEventListener(WHAT_IS_PLAYING_EVENT, answer);
console.log("[YTM Practice Grabber] page bridge loaded");
