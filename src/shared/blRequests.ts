// Better Lyrics' two lyrics requests as the capture sees them through the Chrome DevTools
// Protocol (verified against Better Lyrics 3.0.0.4, src/modules/lyrics/providers/unified.ts and
// unison.ts), and the pure parts of reading them: which requests to track, the video id in the
// stream's form body, base64 and UTF-8 decoding, and choosing among the three ways the response
// body can arrive (PLAN.md section 3.3, lead decision). background/networkWatcher.ts passes CDP
// event params in; nothing here touches chrome.*.
//
// Secrets: the stream request's body carries BL's Turnstile JWT (`token=`) and the Unison request
// an `x-key-id` header. readRequest() reads the video id out of the body and returns only that;
// it never reads headers, and nothing it returns or throws contains request text.

import { isVideoId } from "./filenames";
import type { BodySource } from "./summary";

/** POST with a form body (videoId, song, artist, ..., token); the response is a text/event-stream. */
export const LYRICS_STREAM_URL = "https://lyrics.api.dacubeking.com/v2/lyrics";
/** GET `?v=<videoId>&song=...` with an `x-key-id` header; 404 means "no Unison lyrics". `/lyrics/<id>/vote` is something else. */
export const UNISON_URL = "https://unison.betterlyrics.org/lyrics";

export type BlRequestKind = "stream" | "unison";

/** All the capture keeps of a request it tracks: never its body or headers. */
export interface BlRequest {
  requestId: string;
  kind: BlRequestKind;
  /** The URL without its query, for debug logs. */
  path: string;
  /** The stream's `videoId` form field, or Unison's `v` parameter, when it is a valid video id. */
  videoId?: string;
}

/**
 * Reads a `Network.requestWillBeSent` event: the stream (exactly `POST` to LYRICS_STREAM_URL, any
 * query) or Unison (exactly `GET` of UNISON_URL, any query; not a CORS preflight, which is an
 * OPTIONS), else null. BL's `verify-turnstile` and Unison's vote requests are not tracked.
 */
export function readRequest(params: unknown): BlRequest | null {
  if (!isRecord(params) || typeof params.requestId !== "string" || !isRecord(params.request)) return null;
  const request = params.request;
  const { url, method } = request;
  if (typeof url !== "string" || typeof method !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.origin + parsed.pathname;
  const base = { requestId: params.requestId, path };
  if (method === "POST" && path === LYRICS_STREAM_URL) return withVideoId({ ...base, kind: "stream" }, formVideoId(request));
  if (method === "GET" && path === UNISON_URL) return withVideoId({ ...base, kind: "unison" }, parsed.searchParams.get("v"));
  return null;
}

function withVideoId(request: BlRequest, videoId: string | null): BlRequest {
  return videoId !== null && isVideoId(videoId) ? { ...request, videoId } : request;
}

/**
 * The `videoId` field of the form body, read in memory and nothing else kept. The body is in
 * `postData`, or (newer Chrome, or a large body) only in `postDataEntries` as base64 bytes. It may
 * be missing altogether (`hasPostData` without either); Network.getRequestPostData would fetch it,
 * but that is deliberately never called: the capture falls back to other sources of the id.
 */
function formVideoId(request: Record<string, unknown>): string | null {
  const form = typeof request.postData === "string" && request.postData !== "" ? request.postData : entriesText(request.postDataEntries);
  return form === null ? null : new URLSearchParams(form).get("videoId");
}

function entriesText(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.bytes !== "string") continue;
    try {
      parts.push(decodeBase64(entry.bytes));
    } catch {
      return null;
    }
  }
  return utf8(parts);
}

/** Base64 to bytes (the service worker has no Buffer). Throws on malformed input; the error does not quote it. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The chunks joined and decoded as UTF-8 once, so a character split across two chunks survives.
 * A leading byte order mark is dropped and malformed bytes become U+FFFD, as BL's TextDecoder does.
 */
export function utf8(parts: readonly Uint8Array[]): string {
  let length = 0;
  for (const part of parts) length += part.length;
  const all = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(all);
}

/** The text of a `Network.getResponseBody` result (`{ body, base64Encoded }`), or undefined when it has none. */
export function responseBodyText(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.body !== "string") return undefined;
  return result.base64Encoded === true ? utf8([decodeBase64(result.body)]) : result.body;
}

/** One `Network.eventSourceMessageReceived` message. */
export interface EventSourceMessage {
  eventName: string;
  /** The message's data lines, joined with "\n" (EventSource rules). */
  data: string;
}

/**
 * The stream rebuilt from EventSource messages: per message one `event:` line, one `data:` line
 * per line of its data, then a blank line. parseSse() then sees what BL saw (it trims each `data:`
 * value and joins them without a separator). SSE comments and `id:` lines are not recoverable.
 */
export function sseFromEventSource(messages: readonly EventSourceMessage[]): string {
  return messages
    .map(({ eventName, data }) => `event: ${eventName}\n${data
      .split("\n")
      .map((line) => `data: ${line}\n`)
      .join("")}\n`)
    .join("");
}

/** The three copies of the lyrics response the capture collects at once (PLAN.md section 3.3). */
export interface BodyParts {
  /** (a) `Network.getResponseBody` at `loadingFinished`, decoded; undefined when it failed. */
  responseBody?: string;
  /**
   * (b) `bufferedData` from `Network.streamResourceContent` followed by every `dataReceived`
   * `data`, as bytes in order; undefined when streaming could not be turned on (or a chunk did
   * not decode), since the copy is then incomplete.
   */
  streamed?: readonly Uint8Array[];
  /** (c) The `eventSourceMessageReceived` messages, in order. */
  eventSource: readonly EventSourceMessage[];
}

export interface ChosenBody {
  text: string;
  bodySource: BodySource;
}

/** The first non-empty of (a), (b), (c), and which it was; null when all three are empty. */
export function chooseBody({ responseBody, streamed, eventSource }: BodyParts): ChosenBody | null {
  if (responseBody) return { text: responseBody, bodySource: "getResponseBody" };
  if (streamed) {
    const text = utf8(streamed);
    if (text !== "") return { text, bodySource: "stream" };
  }
  if (eventSource.length > 0) return { text: sseFromEventSource(eventSource), bodySource: "eventSource" };
  return null;
}

/** Whether the stream text holds BL's closing `done` event (an `event:` line whose value, trimmed, is "done"). */
export function streamHasEnded(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.startsWith("event:") && line.slice("event:".length).trim() === "done");
}

/** UTF-8 bytes of a string, for debug logs. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
