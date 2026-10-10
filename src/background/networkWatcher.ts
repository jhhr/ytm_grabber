// Follows Better Lyrics' lyrics requests in the Chrome DevTools Protocol events of one debugger
// session (one tab) and turns each successful stream into a CapturedStream: the stream text,
// which of the three body paths delivered it (PLAN.md section 3.3, lead decision), and the Unison
// response when one came in time. background/capture.ts owns the session and decides what a
// stream is for; the watcher reads events and sends only the commands that fetch bodies.
//
// Secrets: request params are read where they arrive (readRequest() keeps the request id, URL
// path and video id only) and never kept, logged or quoted. Debug lines carry request ids,
// methods, URL paths, statuses, mime types, byte counts, the body path and times, nothing else.

import {
  byteLength,
  chooseBody,
  decodeBase64,
  readRequest,
  responseBodyText,
  streamHasEnded,
  type ChosenBody,
  type EventSourceMessage,
} from "../shared/blRequests";
import { extractSources } from "../shared/sources";
import { parseSse } from "../shared/sse";
import type { BodySource } from "../shared/summary";

/** After the stream body: how long to wait for a Unison request to appear, or to finish (PLAN.md section 3.3). */
export const UNISON_GRACE_MS = 2_000;
/** Unison answers no stream has claimed yet (BL had the stream cached), kept per video. */
const MAX_UNISON_ENTRIES = 8;
/** BL's retry after a 403 follows within seconds (one new token); a 403 older than this was not followed by one. */
const RETRY_WINDOW_MS = 30_000;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatcherContext {
  /** Sends a CDP command to this session's tab. */
  command(method: string, params: { [key: string]: unknown }): Promise<unknown>;
  timers: Timers;
  now(): number;
  /** The debugCapture log. */
  debug(message: string): void;
}

/** One lyrics stream, ready to store. */
export interface CapturedStream {
  /** From the request body, else the stream's metadata, else the sink's hint; undefined if none. */
  videoId?: string;
  rawStream: string;
  bodySource: BodySource;
  /** The Unison response body, when Unison answered 2xx in time. */
  unisonRaw?: string;
}

export interface WatcherSink {
  onCapture(stream: CapturedStream): void;
  /** A stream request failed, Better Lyrics will not retry it, and no other stream request is running. */
  onStreamFailed(reason: string): void;
  /** The video asked for, used when neither the request body nor the stream names one. */
  videoIdHint(): string | undefined;
}

interface StreamRequest {
  requestId: string;
  path: string;
  videoId?: string;
  seenAt: number;
  /** Set once a 2xx response arrived (a non-2xx one ends the request at once). */
  status?: number;
  /** Network.streamResourceContent's outcome: true once streaming is on, with `buffered` set. */
  streaming?: Promise<boolean>;
  /** bufferedData: what arrived before streaming was on. */
  buffered?: Uint8Array;
  /** Every dataReceived `data` since, in order. */
  chunks: Uint8Array[];
  /** A chunk did not decode, so the streamed copy is incomplete. */
  chunkLost: boolean;
  eventSource: EventSourceMessage[];
  /** loadingFinished or loadingFailed arrived; later events are ignored. */
  ending: boolean;
}

interface UnisonRequest {
  /** Its `v` parameter, "" when it had none. */
  key: string;
  status?: number;
  ending: boolean;
}

interface UnisonEntry {
  /** Ids of this video's Unison requests still running. */
  running: Set<string>;
  /** The first 2xx body. */
  body?: string;
}

interface PendingCapture {
  stream: CapturedStream;
  bodyAt: number;
  timer?: unknown;
  /** The current wait is for a Unison request already seen to finish (not for one to appear). */
  waitingForFinish: boolean;
}

export class NetworkWatcher {
  private readonly ctx: WatcherContext;
  private readonly sink: WatcherSink;
  private readonly streams = new Map<string, StreamRequest>();
  private readonly unisonRequests = new Map<string, UnisonRequest>();
  /** Keyed by video id ("" for a request without one), oldest first. */
  private readonly unison = new Map<string, UnisonEntry>();
  private pending: PendingCapture[] = [];
  /** BL retries a 403 once with a new token: when the first 403 came, until a stream ends. */
  private refusedAt: number | undefined;
  private sawStream = false;
  private disposed = false;
  /**
   * The last reason a stream request failed, for an on-demand capture's timeout message (its
   * watcher lives for that capture only). Cleared when a stream succeeds.
   */
  lastFailure: string | undefined;

  constructor(ctx: WatcherContext, sink: WatcherSink) {
    this.ctx = ctx;
    this.sink = sink;
  }

  /** Whether a stream request was seen at all (for a timeout's message). */
  get sawStreamRequest(): boolean {
    return this.sawStream;
  }

  handleEvent(method: string, params: unknown): void {
    if (this.disposed || !isRecord(params) || typeof params.requestId !== "string") return;
    const id = params.requestId;
    switch (method) {
      case "Network.requestWillBeSent":
        return this.requestWillBeSent(id, params);
      case "Network.responseReceived":
        return this.responseReceived(id, params);
      case "Network.dataReceived":
        return this.dataReceived(id, params);
      case "Network.eventSourceMessageReceived":
        return this.eventSourceMessage(id, params);
      case "Network.loadingFinished":
        return this.loadingFinished(id);
      case "Network.loadingFailed":
        return this.loadingFailed(id, params);
    }
  }

  /** Completes every stream waiting for Unison now, with what has arrived. Returns whether there was one. */
  flush(): boolean {
    const waiting = [...this.pending];
    for (const pending of waiting) this.complete(pending);
    return waiting.length > 0;
  }

  /** Stops: timers cleared, later events and command results ignored. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending) this.clearTimer(pending);
    this.pending = [];
  }

  private requestWillBeSent(id: string, params: Record<string, unknown>): void {
    // A redirect repeats this event under the same id: the request is whatever the new URL is.
    this.forget(id);
    const request = readRequest(params);
    if (request === null) return;
    const now = this.ctx.now();
    if (request.kind === "stream") {
      this.sawStream = true;
      this.streams.set(id, {
        requestId: id,
        path: request.path,
        ...(request.videoId === undefined ? {} : { videoId: request.videoId }),
        seenAt: now,
        chunks: [],
        chunkLost: false,
        eventSource: [],
        ending: false,
      });
      this.ctx.debug(`stream request ${id}: POST ${request.path}${request.videoId === undefined ? " (no video id in its body)" : ""}`);
      return;
    }
    const key = request.videoId ?? "";
    this.unisonRequests.set(id, { key, ending: false });
    this.unisonEntry(key).running.add(id);
    this.ctx.debug(`Unison request ${id}: GET ${request.path}`);
    this.recheck();
  }

  private forget(id: string): void {
    if (this.streams.delete(id)) return;
    const unison = this.unisonRequests.get(id);
    if (unison === undefined) return;
    this.unisonRequests.delete(id);
    this.unison.get(unison.key)?.running.delete(id);
    this.recheck();
  }

  private responseReceived(id: string, params: Record<string, unknown>): void {
    const response = isRecord(params.response) ? params.response : {};
    const status = typeof response.status === "number" ? response.status : undefined;
    const mimeType = typeof response.mimeType === "string" ? response.mimeType : "";
    const stream = this.streams.get(id);
    if (stream !== undefined && !stream.ending) {
      this.ctx.debug(`stream ${id}: HTTP ${status ?? "?"} ${mimeType}`);
      if (status !== undefined && !isOk(status)) {
        // Never the body: BL ignores it too (and retries a 403, see streamFailed()).
        this.streams.delete(id);
        this.streamFailed(status === 403 ? "The lyrics server refused the request (HTTP 403)" : `The lyrics server answered HTTP ${status}`, status === 403);
        return;
      }
      stream.status = status ?? 200;
      stream.streaming = this.startStreaming(stream);
      return;
    }
    const unison = this.unisonRequests.get(id);
    if (unison !== undefined && !unison.ending) {
      unison.status = status;
      this.ctx.debug(`Unison ${id}: HTTP ${status ?? "?"} ${mimeType}`);
    }
  }

  /** Body path (b): from now on dataReceived carries the data; what came before is bufferedData. */
  private async startStreaming(stream: StreamRequest): Promise<boolean> {
    try {
      const result = await this.ctx.command("Network.streamResourceContent", { requestId: stream.requestId });
      stream.buffered = decodeBase64(isRecord(result) && typeof result.bufferedData === "string" ? result.bufferedData : "");
      return true;
    } catch {
      // Experimental, and refused once the request has finished: the other two paths remain.
      this.ctx.debug(`stream ${stream.requestId}: streamResourceContent failed`);
      return false;
    }
  }

  private dataReceived(id: string, params: Record<string, unknown>): void {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.ending || typeof params.data !== "string" || params.data === "") return;
    try {
      stream.chunks.push(decodeBase64(params.data));
    } catch {
      stream.chunkLost = true;
    }
  }

  private eventSourceMessage(id: string, params: Record<string, unknown>): void {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.ending) return;
    stream.eventSource.push({
      eventName: typeof params.eventName === "string" ? params.eventName : "",
      data: typeof params.data === "string" ? params.data : "",
    });
  }

  private loadingFinished(id: string): void {
    const stream = this.streams.get(id);
    if (stream !== undefined && !stream.ending) {
      stream.ending = true;
      void this.finishStream(stream);
      return;
    }
    const unison = this.unisonRequests.get(id);
    if (unison !== undefined && !unison.ending) {
      unison.ending = true;
      void this.finishUnison(id, unison, true);
    }
  }

  private loadingFailed(id: string, params: Record<string, unknown>): void {
    const stream = this.streams.get(id);
    if (stream !== undefined && !stream.ending) {
      stream.ending = true;
      void this.failStream(stream, params.canceled === true, params.errorText);
      return;
    }
    const unison = this.unisonRequests.get(id);
    if (unison !== undefined && !unison.ending) {
      unison.ending = true;
      void this.finishUnison(id, unison, false);
    }
  }

  private async finishStream(stream: StreamRequest): Promise<void> {
    const streaming = (await stream.streaming) ?? false;
    let responseBody: string | undefined;
    try {
      // Body path (a). Chrome may not keep an event stream's body; then the other paths remain.
      responseBody = responseBodyText(await this.ctx.command("Network.getResponseBody", { requestId: stream.requestId }));
    } catch {
      responseBody = undefined;
    }
    if (!this.settle(stream)) return;
    const streamed = this.streamed(stream, streaming);
    const chosen = chooseBody({ responseBody, streamed, eventSource: stream.eventSource });
    const streamedBytes = streamed?.reduce((sum, part) => sum + part.length, 0);
    this.ctx.debug(
      `stream ${stream.requestId} finished after ${this.ctx.now() - stream.seenAt} ms: getResponseBody ${responseBody === undefined ? "failed" : `${byteLength(responseBody)} B`}, ` +
        `stream ${streamedBytes === undefined ? "off" : `${streamedBytes} B`}, eventSource ${stream.eventSource.length} messages; using ${chosen?.bodySource ?? "none"}`,
    );
    if (chosen === null) {
      this.streamFailed("Could not read the lyrics response", false);
      return;
    }
    this.streamSucceeded(stream, chosen);
  }

  private async failStream(stream: StreamRequest, canceled: boolean, errorText: unknown): Promise<void> {
    const streaming = (await stream.streaming) ?? false;
    if (!this.settle(stream)) return;
    // BL reads until the server closes the stream. Should a server keep it open after the closing
    // `done` event, BL's 20 s timeout cancels the request, and what arrived by then is complete.
    if (stream.status !== undefined) {
      const chosen = chooseBody({ streamed: this.streamed(stream, streaming), eventSource: stream.eventSource });
      if (chosen !== null && streamHasEnded(chosen.text)) {
        this.ctx.debug(`stream ${stream.requestId} cancelled after its done event, ${this.ctx.now() - stream.seenAt} ms; using ${chosen.bodySource}`);
        this.streamSucceeded(stream, chosen);
        return;
      }
    }
    this.ctx.debug(`stream ${stream.requestId} failed after ${this.ctx.now() - stream.seenAt} ms${canceled ? " (cancelled)" : ""}`);
    this.streamFailed(canceled ? "The lyrics request was cancelled before it finished" : `The lyrics request failed${netError(errorText)}`, false);
  }

  /** Takes a finished stream request out of the running ones; false when it was dropped meanwhile. */
  private settle(stream: StreamRequest): boolean {
    if (this.disposed || this.streams.get(stream.requestId) !== stream) return false;
    this.streams.delete(stream.requestId);
    return true;
  }

  private streamed(stream: StreamRequest, streaming: boolean): Uint8Array[] | undefined {
    return streaming && !stream.chunkLost ? [stream.buffered ?? new Uint8Array(0), ...stream.chunks] : undefined;
  }

  private streamFailed(reason: string, refused: boolean): void {
    this.lastFailure = reason;
    const now = this.ctx.now();
    if (refused && (this.refusedAt === undefined || now - this.refusedAt > RETRY_WINDOW_MS)) {
      // BL fetches a new token and tries once more (unified.ts startStream): wait for that one.
      this.refusedAt = now;
      this.ctx.debug("waiting for Better Lyrics to retry with a new token");
      return;
    }
    this.refusedAt = undefined;
    // BL started another stream meanwhile: that one decides.
    if (this.streams.size > 0) return;
    this.sink.onStreamFailed(reason);
  }

  private streamSucceeded(stream: StreamRequest, chosen: ChosenBody): void {
    this.refusedAt = undefined;
    this.lastFailure = undefined;
    const videoId = stream.videoId ?? extractSources(parseSse(chosen.text)).metadata.videoId ?? this.sink.videoIdHint();
    const pending: PendingCapture = {
      stream: { ...(videoId === undefined ? {} : { videoId }), rawStream: chosen.text, bodySource: chosen.bodySource },
      bodyAt: this.ctx.now(),
      waitingForFinish: false,
    };
    this.pending.push(pending);
    this.check(pending);
  }

  /**
   * The grace for Unison: done at once when this video's Unison request has finished (or none
   * came and none comes: then after the grace). None seen yet: wait up to UNISON_GRACE_MS for one
   * to appear. One running: wait up to UNISON_GRACE_MS from then for it to finish.
   */
  private check(pending: PendingCapture): void {
    const entry = this.unisonFor(pending.stream.videoId);
    if (entry !== undefined && entry.running.size === 0) {
      this.complete(pending);
      return;
    }
    const seen = entry !== undefined;
    if (pending.timer !== undefined && (pending.waitingForFinish || !seen)) return;
    this.clearTimer(pending);
    pending.waitingForFinish = seen;
    pending.timer = this.ctx.timers.setTimeout(() => this.complete(pending), UNISON_GRACE_MS);
  }

  private recheck(): void {
    for (const pending of [...this.pending]) this.check(pending);
  }

  private complete(pending: PendingCapture): void {
    const index = this.pending.indexOf(pending);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.clearTimer(pending);
    const key = this.unisonKey(pending.stream.videoId);
    const entry = key === undefined ? undefined : this.unison.get(key);
    if (key !== undefined && entry !== undefined && entry.running.size === 0) this.unison.delete(key);
    const unisonRaw = entry?.body;
    this.ctx.debug(`capture ready ${this.ctx.now() - pending.bodyAt} ms after the stream; Unison ${unisonRaw === undefined ? "none" : `${byteLength(unisonRaw)} B`}`);
    this.sink.onCapture(unisonRaw === undefined ? { ...pending.stream } : { ...pending.stream, unisonRaw });
  }

  private clearTimer(pending: PendingCapture): void {
    if (pending.timer === undefined) return;
    this.ctx.timers.clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private async finishUnison(id: string, request: UnisonRequest, loaded: boolean): Promise<void> {
    let body: string | undefined;
    // 404 is "no Unison lyrics" and any other failure is no Unison either: only 2xx has a body.
    if (loaded && request.status !== undefined && isOk(request.status)) {
      try {
        body = responseBodyText(await this.ctx.command("Network.getResponseBody", { requestId: id }));
      } catch {
        body = undefined;
      }
    }
    if (this.disposed || this.unisonRequests.get(id) !== request) return;
    this.unisonRequests.delete(id);
    const entry = this.unison.get(request.key);
    if (entry === undefined) return;
    entry.running.delete(id);
    if (body && entry.body === undefined) entry.body = body;
    this.ctx.debug(loaded ? `Unison ${id} finished: HTTP ${request.status ?? "?"}, ${byteLength(body ?? "")} B` : `Unison ${id} failed`);
    this.recheck();
  }

  /** The Unison entry for a stream's video: its own, else one whose request named no video; for an unknown video, the latest. */
  private unisonKey(videoId: string | undefined): string | undefined {
    if (videoId === undefined) return [...this.unison.keys()].at(-1);
    if (this.unison.has(videoId)) return videoId;
    return this.unison.has("") ? "" : undefined;
  }

  private unisonFor(videoId: string | undefined): UnisonEntry | undefined {
    const key = this.unisonKey(videoId);
    return key === undefined ? undefined : this.unison.get(key);
  }

  private unisonEntry(key: string): UnisonEntry {
    let entry = this.unison.get(key);
    if (entry === undefined) {
      entry = { running: new Set() };
      this.unison.set(key, entry);
      for (const [old, value] of this.unison) {
        if (this.unison.size <= MAX_UNISON_ENTRIES) break;
        if (value.running.size === 0) this.unison.delete(old);
      }
    }
    return entry;
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** Chrome's network error name (e.g. " (net::ERR_CONNECTION_RESET)"), only when it looks like one. */
function netError(errorText: unknown): string {
  return typeof errorText === "string" && /^net::ERR_[A-Z0-9_]{1,60}$/.test(errorText) ? ` (${errorText})` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
