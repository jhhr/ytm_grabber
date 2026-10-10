// How the content script (isolated world) asks the page bridge (MAIN world) what YouTube Music
// is playing (PLAN.md 3.7). Both scripts share the page's DOM but not its JavaScript objects, so
// they talk through events on `document`; an object in a CustomEvent's `detail` does not reach
// the other world intact, a string does, so both directions carry JSON text.
//
// The page sees these events too and could answer them itself: whatever comes back is checked
// here, the video id again by the content script, and every stem again by the service worker.

/** Content script -> bridge; `detail` is `encodeRequest(requestId)`. */
export const WHAT_IS_PLAYING_EVENT = "pg:what-is-playing";
/** Bridge -> content script; `detail` is `encodeReply(...)`. */
export const NOW_PLAYING_EVENT = "pg:now-playing";

/** What the player reports. Any value it does not give as a string is null. */
export interface PlayerInfo {
  /** As the player gives it; the content script checks it with `isVideoId`. */
  videoId: string | null;
  title: string | null;
  /** YTM's artist line for the video; may be a channel name (see nowPlaying.ts). */
  author: string | null;
  /** E.g. `MUSIC_VIDEO_TYPE_ATV` (album track) or `MUSIC_VIDEO_TYPE_OMV` (music video). */
  musicVideoType: string | null;
}

export interface NowPlayingReply extends PlayerInfo {
  /** The request this answers: several asks may be in flight, and every listener sees every reply. */
  requestId: string;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeRequest(requestId: string): string {
  return JSON.stringify({ requestId });
}

/** The request id of a well-formed request, else null (the bridge does not answer it). */
export function decodeRequest(detail: unknown): string | null {
  const value = parseObject(detail);
  return typeof value?.requestId === "string" && REQUEST_ID.test(value.requestId) ? value.requestId : null;
}

export function encodeReply(reply: NowPlayingReply): string {
  const { requestId, videoId, title, author, musicVideoType } = reply;
  return JSON.stringify({ requestId, videoId, title, author, musicVideoType });
}

/** A reply with its fields typed (non-strings become null), or null when it is not a reply at all. */
export function decodeReply(detail: unknown): NowPlayingReply | null {
  const value = parseObject(detail);
  if (typeof value?.requestId !== "string") return null;
  return {
    requestId: value.requestId,
    videoId: stringOrNull(value.videoId),
    title: stringOrNull(value.title),
    author: stringOrNull(value.author),
    musicVideoType: stringOrNull(value.musicVideoType),
  };
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseObject(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== "string") return null;
  try {
    const value: unknown = JSON.parse(detail);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
