// Shared set-up for the capture manager tests (B5b): a manager over a FakeDebugger, a fake
// session store and fake settings, wired as sw.ts wires the real ones, plus Better Lyrics'
// requests played step by step. Tests use Vitest's fake timers; tick() lets promises settle.

import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { createCaptureManager, type CaptureManager } from "../../src/background/capture";
import { createCaptureStore } from "../../src/background/store";
import type { EventSourceMessage } from "../../src/shared/blRequests";
import { CAPTURE_PORT } from "../../src/shared/messages";
import type { CaptureMode } from "../../src/shared/settings";
import { createSettingsStore } from "../../src/shared/settings";
import type { StoredCapture } from "../../src/shared/summary";
import { blStreamRequest, blUnisonRequest, FakeDebugger, fakeTabs, type BlStreamOptions, type BodyMode, type FakeRequest } from "./fakeDebugger";
import { FakePort } from "./fakePort";
import { FakeStorageArea } from "./fakeStorage";

export const STREAM = readFileSync(new URL("../fixtures/synthetic-stream.txt", import.meta.url), "utf8");
export const UNISON = readFileSync(new URL("../fixtures/synthetic-unison.json", import.meta.url), "utf8");
export const ID = "Synth3t1cK1";
export const OTHER = "Other0ther0";
export const TAB = 7;
export const YTM_URL = `https://music.youtube.com/watch?v=${ID}`;

/** Lets every pending promise settle; with fake timers nothing else moves. */
export const tick = () => vi.advanceTimersByTimeAsync(0);

export interface Harness {
  fake: FakeDebugger;
  /** The capture store's session area. */
  area: FakeStorageArea;
  settingsArea: FakeStorageArea;
  manager: CaptureManager;
  /** The stored capture of a video, if any. */
  stored(videoId?: string): StoredCapture | undefined;
}

export interface SetupOptions {
  mode?: CaptureMode;
  debug?: boolean;
  /** Tab id -> URL; default one YouTube Music tab, TAB. */
  tabs?: Record<number, string>;
  /** Runs before the manager is created (e.g. a session an earlier service worker left). */
  before?: (fake: FakeDebugger) => void;
}

export async function setup({ mode = "on-demand", debug = false, tabs = { [TAB]: YTM_URL }, before }: SetupOptions = {}): Promise<Harness> {
  const fake = new FakeDebugger();
  for (const [id, url] of Object.entries(tabs)) fake.tabs.set(Number(id), url);
  before?.(fake);
  const area = new FakeStorageArea();
  const settingsArea = new FakeStorageArea({ kind: "local", initial: { captureMode: mode, debugCapture: debug } });
  const settings = createSettingsStore(settingsArea);
  const manager = createCaptureManager({ debugger: fake, tabs: fakeTabs(fake), store: createCaptureStore({ area }), settings, log: console });
  // As sw.ts wires the real ones.
  fake.onEvent.addListener(manager.handleEvent);
  fake.onDetach.addListener(manager.handleDetach);
  settings.onSettingsChanged(manager.settingsChanged);
  await manager.init();
  return { fake, area, settingsArea, manager, stored: (videoId = ID) => area.snapshot()[`capture:${videoId}`] as StoredCapture | undefined };
}

/** The content script's end of a new `capture` port, connected to the manager. */
export function openPort(manager: CaptureManager, tabId = TAB): FakePort {
  const port = new FakePort(CAPTURE_PORT, { tab: { id: tabId } });
  manager.connect(port, tabId);
  return port;
}

/** Opens a port and posts `start`, as the content script does. */
export async function start(manager: CaptureManager, { videoId = ID, tabId = TAB }: { videoId?: string; tabId?: number } = {}): Promise<FakePort> {
  const port = openPort(manager, tabId);
  port.deliver({ type: "start", videoId });
  await tick();
  return port;
}

export interface ServeStreamOptions extends BlStreamOptions {
  requestId?: string;
  tabId?: number;
  status?: number;
  /** Response body chunks (dataReceived), in order. */
  chunks?: (string | Uint8Array)[];
  eventSource?: EventSourceMessage[];
  bodyMode?: BodyMode;
  streamable?: boolean;
}

/** BL's stream request: response, body chunks (and EventSource messages), then loadingFinished. */
export async function serveStream(
  fake: FakeDebugger,
  { requestId = "1000.1", tabId = TAB, videoId = ID, status = 200, chunks = [STREAM], eventSource = [], bodyMode = "text", streamable = true, ...body }: ServeStreamOptions = {},
): Promise<FakeRequest> {
  const request = blStreamRequest(fake, tabId, requestId, { videoId, ...body });
  request.bodyMode = bodyMode;
  request.streamable = streamable;
  request.respond(status, status === 200 ? "text/event-stream" : "application/json");
  await tick();
  for (const chunk of chunks) request.data(chunk);
  for (const message of eventSource) request.eventSource(message.eventName, message.data);
  request.finish();
  await tick();
  return request;
}

export interface ServeUnisonOptions {
  requestId?: string;
  tabId?: number;
  videoId?: string;
  status?: number;
  body?: string;
  /** false: the response has started but not finished. */
  finish?: boolean;
}

/** BL's Unison request: response, body, loadingFinished. */
export async function serveUnison(fake: FakeDebugger, { requestId = "2000.1", tabId = TAB, videoId = ID, status = 200, body, finish = true }: ServeUnisonOptions = {}): Promise<FakeRequest> {
  const request = blUnisonRequest(fake, tabId, requestId, { videoId });
  request.respond(status, "application/json");
  await tick();
  request.data(body ?? (status === 200 ? UNISON : '{"error":"Not found"}'));
  if (finish) request.finish();
  await tick();
  return request;
}
