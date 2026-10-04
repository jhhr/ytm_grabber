// A chrome.debugger stand-in for capture tests (B5b; meant for reuse by later phases). It models
// what the capture manager relies on, as Chromium does it (chrome/browser/extensions/api/debugger/
// debugger_api.cc and the DevTools protocol's Network domain):
// - calls are logged when made and take effect a microtask later, as Chrome answers asynchronously;
// - attach fails "Another debugger is already attached to the tab with id: N." when this extension
//   is attached already (or `attachedElsewhere` says so); detach and sendCommand fail "Debugger is
//   not attached to the tab with id: N." when it is not;
// - a detach by the extension fires no onDetach; browserDetach() fires it as Chrome does;
// - events reach onEvent only for a tab that is attached with Network enabled;
// - Network.dataReceived carries `data` only for a request whose streaming was turned on with
//   Network.streamResourceContent, which answers what arrived before as `bufferedData` and fails
//   once the request has finished;
// - Network.getResponseBody answers per request as the test sets `bodyMode`.
// Test hooks: `beforeAttach` / `beforeCommand` may throw to make that call fail.

import { LYRICS_STREAM_URL, UNISON_URL } from "../../src/shared/blRequests";
import { FakeEvent } from "./fakeStorage";

/** Invented secrets that must never leave the capture manager. */
export const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRUNSRVQtVE9LRU4tYjViIn0.c2VjcmV0LXNpZ25hdHVyZQ";
export const FAKE_KEY_ID = "SECRET-KEY-ID-7c1e9b";

export type DebuggerCall =
  | { kind: "attach"; tabId: number; version: string }
  | { kind: "detach"; tabId: number }
  | { kind: "command"; tabId: number; method: string; params?: Record<string, unknown> }
  | { kind: "getTargets" };

/** What Network.getResponseBody answers once the request has finished. */
export type BodyMode = "text" | "base64" | "empty" | "error";

export interface FakeRequestInit {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}

export function base64(bytes: Uint8Array | string): string {
  return Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

/** One request in a tab, driven by the test. Each method emits the CDP event Chrome would. */
export class FakeRequest {
  readonly tabId: number;
  readonly requestId: string;
  readonly url: string;
  /** Every chunk of the response body so far. */
  readonly received: Uint8Array[] = [];
  streaming = false;
  finished = false;
  bodyMode: BodyMode = "text";
  /** false: Network.streamResourceContent fails for this request. */
  streamable = true;
  private readonly fake: FakeDebugger;

  constructor(fake: FakeDebugger, tabId: number, requestId: string, url: string) {
    this.fake = fake;
    this.tabId = tabId;
    this.requestId = requestId;
    this.url = url;
  }

  respond(status: number, mimeType = "text/event-stream"): this {
    this.emit("Network.responseReceived", {
      type: "Fetch",
      response: { url: this.url, status, statusText: "", mimeType, headers: { "content-type": mimeType } },
    });
    return this;
  }

  /** Bytes arrive; the event carries them only while streaming is on. */
  data(chunk: string | Uint8Array): this {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.received.push(bytes);
    this.emit("Network.dataReceived", {
      dataLength: bytes.length,
      encodedDataLength: bytes.length,
      ...(this.streaming ? { data: base64(bytes) } : {}),
    });
    return this;
  }

  eventSource(eventName: string, data: string): this {
    this.emit("Network.eventSourceMessageReceived", { eventName, eventId: "", data });
    return this;
  }

  finish(): this {
    this.finished = true;
    this.emit("Network.loadingFinished", { encodedDataLength: this.body().length });
    return this;
  }

  fail(errorText = "net::ERR_FAILED", canceled = false): this {
    this.finished = true;
    this.emit("Network.loadingFailed", { type: "Fetch", errorText, canceled });
    return this;
  }

  body(): Uint8Array {
    return concat(this.received);
  }

  private emit(method: string, params: Record<string, unknown>): void {
    this.fake.emit(this.tabId, method, { requestId: this.requestId, timestamp: 0, ...params });
  }
}

export class FakeDebugger {
  readonly onEvent = new FakeEvent<(source: { tabId?: number }, method: string, params?: object) => void>();
  readonly onDetach = new FakeEvent<(source: { tabId?: number }, reason: string) => void>();
  readonly calls: DebuggerCall[] = [];
  /** Tabs this extension is attached to. */
  readonly attached = new Set<number>();
  /** Tabs where attaching fails as "already attached" because of some other client. */
  readonly attachedElsewhere = new Set<number>();
  readonly networkEnabled = new Set<number>();
  /** Tab id -> URL: the tabs that exist (getTargets, fakeTabs). */
  readonly tabs = new Map<number, string>();
  readonly requests = new Map<string, FakeRequest>();
  beforeAttach?: (tabId: number) => void;
  beforeCommand?: (tabId: number, method: string, params?: Record<string, unknown>) => void;

  async attach(target: { tabId?: number }, version: string): Promise<void> {
    const tabId = target.tabId!;
    this.calls.push({ kind: "attach", tabId, version });
    await Promise.resolve();
    this.beforeAttach?.(tabId);
    if (!this.tabs.has(tabId)) throw new Error(`No tab with given id ${tabId}.`);
    if (this.attached.has(tabId) || this.attachedElsewhere.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    this.attached.add(tabId);
  }

  async detach(target: { tabId?: number }): Promise<void> {
    const tabId = target.tabId!;
    this.calls.push({ kind: "detach", tabId });
    await Promise.resolve();
    if (!this.attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    this.attached.delete(tabId);
    this.networkEnabled.delete(tabId);
  }

  async sendCommand(target: { tabId?: number }, method: string, params?: { [key: string]: unknown }): Promise<unknown> {
    const tabId = target.tabId!;
    this.calls.push({ kind: "command", tabId, method, ...(params === undefined ? {} : { params: structuredClone(params) }) });
    await Promise.resolve();
    if (!this.attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    this.beforeCommand?.(tabId, method, params);
    const request = typeof params?.requestId === "string" ? this.requests.get(params.requestId) : undefined;
    switch (method) {
      case "Network.enable":
        this.networkEnabled.add(tabId);
        return {};
      case "Network.streamResourceContent":
        if (request === undefined || request.finished || !request.streamable) throw new Error("Can only stream resources that are still loading");
        request.streaming = true;
        return { bufferedData: base64(request.body()) };
      case "Network.getResponseBody":
        if (request === undefined || !request.finished || request.bodyMode === "error") throw new Error("No resource with given identifier found");
        if (request.bodyMode === "empty") return { body: "", base64Encoded: false };
        if (request.bodyMode === "base64") return { body: base64(request.body()), base64Encoded: true };
        return { body: new TextDecoder().decode(request.body()), base64Encoded: false };
      default:
        return {};
    }
  }

  async getTargets(): Promise<{ type: string; id: string; tabId?: number; attached: boolean; title: string; url: string }[]> {
    this.calls.push({ kind: "getTargets" });
    await Promise.resolve();
    return [...this.tabs].map(([tabId, url]) => ({
      type: "page",
      id: `target-${tabId}`,
      tabId,
      attached: this.attached.has(tabId) || this.attachedElsewhere.has(tabId),
      title: "",
      url,
    }));
  }

  // --- Driving it ---------------------------------------------------------------------------

  /** Dispatches a CDP event as Chrome would: only to an attached tab with Network on. Returns whether it was delivered. */
  emit(tabId: number, method: string, params: Record<string, unknown>): boolean {
    if (!this.attached.has(tabId) || !this.networkEnabled.has(tabId)) return false;
    this.onEvent.dispatch({ tabId }, method, params);
    return true;
  }

  /** A request starts in the tab (Network.requestWillBeSent). */
  request(tabId: number, requestId: string, init: FakeRequestInit): FakeRequest {
    const request = new FakeRequest(this, tabId, requestId, init.url);
    this.requests.set(requestId, request);
    this.emit(tabId, "Network.requestWillBeSent", {
      requestId,
      loaderId: "loader-1",
      documentURL: "https://music.youtube.com/watch",
      request: {
        url: init.url,
        method: init.method,
        headers: init.headers ?? {},
        ...(init.postData === undefined ? {} : { postData: init.postData }),
        ...(init.hasPostData === undefined ? {} : { hasPostData: init.hasPostData }),
        ...(init.postDataEntries === undefined ? {} : { postDataEntries: init.postDataEntries }),
        initialPriority: "High",
        referrerPolicy: "strict-origin-when-cross-origin",
      },
      timestamp: 0,
      wallTime: 0,
      initiator: { type: "other" },
      type: "Fetch",
    });
    return request;
  }

  /** Chrome ends the session (the user pressed Cancel on the debugging bar, the tab closed...). */
  browserDetach(tabId: number, reason: "canceled_by_user" | "target_closed" | string): void {
    if (!this.attached.delete(tabId)) return;
    this.networkEnabled.delete(tabId);
    this.onDetach.dispatch({ tabId }, reason);
  }

  // --- Assertions ---------------------------------------------------------------------------

  callsOf(kind: DebuggerCall["kind"], tabId?: number): DebuggerCall[] {
    return this.calls.filter((call) => call.kind === kind && (tabId === undefined || ("tabId" in call && call.tabId === tabId)));
  }

  commands(method: string): Record<string, unknown>[] {
    return this.calls.flatMap((call) => (call.kind === "command" && call.method === method ? [call.params ?? {}] : []));
  }
}

/** chrome.tabs' query() over the fake's tabs; `url` is a match pattern ending in "*". */
export function fakeTabs(fake: FakeDebugger) {
  return {
    async query({ url }: { url: string }): Promise<{ id: number; url: string }[]> {
      const prefix = url.endsWith("*") ? url.slice(0, -1) : url;
      return [...fake.tabs].filter(([, tabUrl]) => tabUrl.startsWith(prefix)).map(([id, tabUrl]) => ({ id, url: tabUrl }));
    },
  };
}

// --- Better Lyrics' requests, as its content script makes them (BL 3.0.0.4) ---------------------

export interface BlStreamOptions {
  videoId?: string;
  token?: string;
  /** The body only as postDataEntries (newer Chrome), not postData. */
  entriesOnly?: boolean;
  /** No body in the event at all (hasPostData only). */
  noBody?: boolean;
}

/** POST v2/lyrics with BL's form body, `token` included. */
export function blStreamRequest(fake: FakeDebugger, tabId: number, requestId: string, { videoId, token = FAKE_TOKEN, entriesOnly = false, noBody = false }: BlStreamOptions = {}): FakeRequest {
  const form = new URLSearchParams();
  if (videoId !== undefined) form.append("videoId", videoId);
  form.append("song", "Northbound Kites");
  form.append("artist", "Marrow & Tin");
  form.append("duration", "72");
  form.append("album", "Weather Almanac");
  form.append("alwaysFetchMetadata", "false");
  form.append("token", token);
  const body = form.toString();
  return fake.request(tabId, requestId, {
    url: LYRICS_STREAM_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    hasPostData: true,
    ...(noBody ? {} : entriesOnly ? { postDataEntries: [{ bytes: base64(body) }] } : { postData: body }),
  });
}

/** GET Unison with BL's `x-key-id` header. */
export function blUnisonRequest(fake: FakeDebugger, tabId: number, requestId: string, { videoId, keyId = FAKE_KEY_ID }: { videoId: string; keyId?: string }): FakeRequest {
  return fake.request(tabId, requestId, {
    url: `${UNISON_URL}?v=${videoId}&song=Northbound+Kites&artist=Marrow+%26+Tin&duration=72&album=Weather+Almanac`,
    method: "GET",
    headers: { "x-key-id": keyId },
  });
}
