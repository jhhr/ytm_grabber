// The message protocol between the content script and the service worker. One-shot requests
// go through chrome.runtime.sendMessage; a capture runs over a long-lived port (PLAN.md
// section 3.3), because it spans the content script clicking BL's refresh button.
//
// The service worker validates everything it receives with the guards below: a content script
// runs inside a web page and is less trusted than the worker. Messages never carry lyrics
// contents, request bodies or request headers (BL's token): a capture is described by its
// summary, and the worker reads contents from its own store.

import { isVideoId } from "./filenames";
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

/** Save one menu item's file (B6). `stem` comes from YTM's now-playing info; the worker sanitises it again. */
export interface LyricsDownloadRequest {
  type: "lyrics:download";
  videoId: string;
  itemId: string;
  stem: string;
}

export type LyricsDownloadResponse = { ok: true } | { ok: false; error: string };

export type ExtensionRequest = CaptureGetRequest | LyricsDownloadRequest;

export interface ResponseMap {
  "capture:get": CaptureGetResponse;
  "lyrics:download": LyricsDownloadResponse;
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

// --- Guards for what the service worker receives ---------------------------------------------
// Extra fields are allowed and ignored: handlers read the fields named here only.

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "capture:get":
      return isVideoIdValue(value.videoId);
    case "lyrics:download":
      return isVideoIdValue(value.videoId) && isNonEmptyString(value.itemId) && isNonEmptyString(value.stem);
    default:
      return false;
  }
}

export function isCapturePortRequest(value: unknown): value is CapturePortRequest {
  return isRecord(value) && value.type === "start" && isVideoIdValue(value.videoId);
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
