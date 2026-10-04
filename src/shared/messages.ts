// The message protocol between the content script and the service worker, and between the worker
// and the native host. One-shot requests go through chrome.runtime.sendMessage; a capture runs
// over a long-lived port (PLAN.md section 3.3), because it spans the content script clicking BL's
// refresh button, and so does an audio download, whose progress the worker relays.
//
// The service worker validates everything it receives with the guards below: a content script
// runs inside a web page and is less trusted than the worker. Messages never carry lyrics
// contents, request bodies or request headers (BL's token): a capture is described by its
// summary, and the worker reads contents from its own store.

import { isVideoId } from "./filenames";
import { isDownloadItemId } from "./lyricsItems";
import type { CaptureSummary } from "./summary";

// --- One-shot requests: content script -> service worker -------------------------------------

/** Is there a capture for this video? Asked before deciding whether to capture. */
export interface CaptureGetRequest {
  type: "capture:get";
  videoId: string;
}

export interface CaptureGetResponse {
  summary: CaptureSummary | null;
}

/**
 * Save one lyrics menu item's file. `videoId` is the capture's (the summary's, which may not be
 * the playing video's); `itemId` is a download item id (lyricsItems.ts: tony, native:<source>,
 * ttml:<source>, raw); `stem` is buildStem()'s output for that video, from YTM's now-playing info
 * (or the capture's metadata when the capture is of another song). The worker refuses a stem that
 * sanitizeFilename() would change or that does not end with " [videoId]".
 */
export interface LyricsDownloadRequest {
  type: "lyrics:download";
  videoId: string;
  itemId: string;
  stem: string;
}

export type LyricsDownloadResponse = { ok: true } | { ok: false; error: string };

/** Is the native host installed and working? Asked by the options page's Test connection. */
export interface AudioPingRequest {
  type: "audio:ping";
}

/** The host's `pong`, the fields the options page shows. */
export interface HostPong {
  hostVersion: string;
  /** Null when yt-dlp could not be run (`problems` says why). */
  ytDlpVersion: string | null;
  ffmpegFound: boolean;
  /** Readable sentences, e.g. that yt-dlp was not found; empty when all is well. */
  problems: string[];
}

export type AudioPingResponse = { ok: true; pong: HostPong } | { ok: false; error: string };

/**
 * Show a downloaded audio file in Explorer: `path` is a `done` reply's path. The host decides
 * whether it may (only inside a folder it saved to while running; Windows only).
 */
export interface AudioRevealRequest {
  type: "audio:reveal";
  path: string;
}

export type AudioRevealResponse = { ok: true } | { ok: false; error: string };

export type ExtensionRequest = CaptureGetRequest | LyricsDownloadRequest | AudioPingRequest | AudioRevealRequest;

export interface ResponseMap {
  "capture:get": CaptureGetResponse;
  "lyrics:download": LyricsDownloadResponse;
  "audio:ping": AudioPingResponse;
  "audio:reveal": AudioRevealResponse;
}

/** The response type for a request type, e.g. `ResponseTo<CaptureGetRequest>`. */
export type ResponseTo<R extends ExtensionRequest> = ResponseMap[R["type"]];

// --- The capture port (chrome.runtime.connect({ name: CAPTURE_PORT })) -------------------------
//
// The content script posts `start`; the worker attaches the debugger, enables the Network
// domain and posts `ready`, upon which the content script clicks BL's refresh button; the
// worker then posts `done` with the stored capture's summary, or `error`.

export const CAPTURE_PORT = "capture";

/** Content script -> service worker. */
export interface CaptureStart {
  type: "start";
  videoId: string;
}

export type CapturePortRequest = CaptureStart;

/** Service worker -> content script. */
export type CapturePortReply = { type: "ready" } | { type: "done"; summary: CaptureSummary } | { type: "error"; reason: string };

// --- The audio port (chrome.runtime.connect({ name: AUDIO_PORT })) -----------------------------
//
// One download per port (PLAN.md 3.7). The content script posts `start`, and `cancel` to stop it;
// the worker relays the native host's progress, then posts exactly one `done` or `error`. A
// content script that goes away (the tab navigates) only stops hearing about it: the download
// goes on, since the file lands on disk either way.

export const AUDIO_PORT = "audio";

/** Content script -> service worker. `stem` is buildStem()'s output for that video, as for lyrics. */
export type AudioPortRequest = { type: "start"; videoId: string; stem: string } | { type: "cancel" };

/** Service worker -> content script. `percent` is null while yt-dlp cannot tell (no size known). */
export type AudioPortReply =
  | { type: "progress"; percent: number | null }
  | { type: "done"; path: string }
  | { type: "error"; message: string; cancelled?: true };

// --- The native host (chrome.runtime.connectNative / sendNativeMessage) ------------------------
//
// PLAN.md 3.8 and native-host/ytm_grabber_host.py, which validates all of it again. A request
// may carry a requestId; the host echoes it in its replies to that request, errors included.

export const NATIVE_HOST_NAME = "com.jormki.ytm_grabber";

/** Service worker -> host. */
export type HostRequest =
  | { type: "ping"; requestId?: string }
  | { type: "download"; requestId: string; videoId: string; stem: string; outputDir?: string; subfolder?: boolean }
  | { type: "cancel"; requestId: string }
  | { type: "reveal"; requestId?: string; path: string };

// --- Guards for what the service worker receives ---------------------------------------------
// Extra fields are allowed and ignored: handlers read the fields named here only.

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "capture:get":
      return isVideoIdValue(value.videoId);
    case "lyrics:download":
      return isVideoIdValue(value.videoId) && isDownloadItemId(value.itemId) && isNonEmptyString(value.stem);
    case "audio:ping":
      return true;
    case "audio:reveal":
      // Any path: the host only shows files in folders it saved to itself.
      return isNonEmptyString(value.path);
    default:
      return false;
  }
}

export function isCapturePortRequest(value: unknown): value is CapturePortRequest {
  return isRecord(value) && value.type === "start" && isVideoIdValue(value.videoId);
}

export function isAudioPortRequest(value: unknown): value is AudioPortRequest {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "start":
      return isVideoIdValue(value.videoId) && isNonEmptyString(value.stem);
    case "cancel":
      return true;
    default:
      return false;
  }
}

function isVideoIdValue(value: unknown): value is string {
  return typeof value === "string" && isVideoId(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
