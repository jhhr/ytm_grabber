import { afterEach, expect, it, vi } from "vitest";
import { AUDIO_TEXT, CHROME_HOST_ERRORS } from "../src/background/audio";
import { UNISON_GRACE_MS } from "../src/background/networkWatcher";
import { buildStem } from "../src/shared/filenames";
import { AUDIO_PORT, CAPTURE_PORT, NATIVE_HOST_NAME } from "../src/shared/messages";
import { ID, TAB, YTM_URL, serveStream, tick } from "./helpers/captureHarness";
import { FakeDebugger, fakeTabs } from "./helpers/fakeDebugger";
import { FakeDownloads } from "./helpers/fakeDownloads";
import { FakeNative } from "./helpers/fakeNative";
import { FakePort } from "./helpers/fakePort";
import { FakeEvent, FakeStorageArea } from "./helpers/fakeStorage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { captureNow?: unknown }).captureNow;
});

it("registers every listener as it loads, captures through the capture port into the store capture:get reads, saves lyrics from it, and relays audio downloads and ping to the native host", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const fake = new FakeDebugger();
  fake.tabs.set(TAB, YTM_URL);
  const session = new FakeStorageArea();
  const local = new FakeStorageArea({ kind: "local" });
  const onConnect = new FakeEvent<(port: FakePort) => void>();
  const onMessage = new FakeEvent<(message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean>();
  const onUpdated = new FakeEvent<(tabId: number, changeInfo: { status?: string }, tab: { url?: string }) => void>();
  const extensionId = "mengelecikhhdpjdebjpokcmhdkhjobj";
  const downloads = new FakeDownloads(extensionId);
  const native = new FakeNative();
  const runtime = {
    onMessage,
    onConnect,
    id: extensionId,
    connectNative: native.connectNative,
    sendNativeMessage: native.sendNativeMessage,
    lastError: undefined as { message: string } | undefined,
  };
  vi.stubGlobal("chrome", { runtime, storage: { session, local }, debugger: fake, tabs: { ...fakeTabs(fake), onUpdated }, downloads });
  vi.resetModules();
  await import("../src/background/sw");

  for (const event of [onMessage, onConnect, fake.onEvent, fake.onDetach, onUpdated, local.onChanged, downloads.onChanged]) expect(event.hasListeners()).toBe(true);
  expect(typeof (globalThis as { captureNow?: unknown }).captureNow).toBe("function");

  const port = new FakePort(CAPTURE_PORT, { tab: { id: TAB } });
  onConnect.dispatch(port);
  port.deliver({ type: "start", videoId: ID });
  await tick();
  expect(port.types()).toEqual(["ready"]);
  await serveStream(fake);
  await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
  expect(port.types()).toEqual(["ready", "done"]);
  expect(fake.attached.size).toBe(0);

  const sendResponse = vi.fn();
  onMessage.dispatch({ type: "capture:get", videoId: ID }, { tab: { id: TAB } }, sendResponse);
  await tick();
  expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ videoId: ID }) }));

  // A lyrics download from that capture, and the download folder learned when it finishes.
  const stem = buildStem({ artist: "Marrow & Tin", title: "Northbound Kites", videoId: ID });
  const downloaded = vi.fn();
  onMessage.dispatch({ type: "lyrics:download", videoId: ID, itemId: "tony", stem }, { tab: { id: TAB } }, downloaded);
  await tick();
  expect(downloaded).toHaveBeenCalledWith({ ok: true });
  expect(downloads.calls).toEqual([expect.objectContaining({ filename: `${stem}.ttml`, conflictAction: "uniquify", saveAs: false })]);
  downloads.complete(downloads.items[0].id);
  await tick();
  expect(local.snapshot()).toMatchObject({ learnedDownloadDir: downloads.downloadDir });

  // An audio download through the `audio` port: to the folder just learned, relayed back.
  const audio = new FakePort(AUDIO_PORT, { tab: { id: TAB } });
  onConnect.dispatch(audio);
  audio.deliver({ type: "start", videoId: ID, stem });
  await tick();
  expect(native.connectNative).toHaveBeenCalledExactlyOnceWith(NATIVE_HOST_NAME);
  const [sent] = native.port.posted as { requestId: string }[];
  expect(sent).toEqual({ type: "download", requestId: expect.any(String), videoId: ID, stem, outputDir: downloads.downloadDir, subfolder: false });
  native.reply({ type: "progress", requestId: sent.requestId, percent: 50, line: "" });
  native.reply({ type: "done", requestId: sent.requestId, path: `${downloads.downloadDir}/${stem}.opus` });
  expect(audio.posted).toEqual([
    { type: "progress", percent: 50 },
    { type: "done", path: `${downloads.downloadDir}/${stem}.opus` },
  ]);
  expect(native.port.connected).toBe(false);

  // Chrome's lastError when the host is missing reaches the tab in the user's words.
  const missing = new FakePort(AUDIO_PORT, { tab: { id: TAB } });
  onConnect.dispatch(missing);
  missing.deliver({ type: "start", videoId: ID, stem });
  await tick();
  runtime.lastError = { message: CHROME_HOST_ERRORS.notFound };
  native.port.remoteDisconnect();
  runtime.lastError = undefined;
  expect(missing.posted).toEqual([{ type: "error", message: AUDIO_TEXT.notInstalled }]);

  // audio:ping, as the options page sends it.
  const pong = { hostVersion: "0.1.0", ytDlpVersion: "2026.08.19", ffmpegFound: true, problems: [] };
  native.sendNativeMessage.mockResolvedValueOnce({ type: "pong", ...pong });
  const pinged = vi.fn();
  expect(onMessage.dispatch({ type: "audio:ping" }, {}, pinged)).toEqual([true]);
  await tick();
  expect(pinged).toHaveBeenCalledWith({ ok: true, pong });
  expect(native.sendNativeMessage).toHaveBeenCalledExactlyOnceWith(NATIVE_HOST_NAME, { type: "ping" });

  // Not from a tab: turned away, for both ports. Another port name: not ours to handle.
  for (const name of [CAPTURE_PORT, AUDIO_PORT]) {
    const stray = new FakePort(name, {});
    onConnect.dispatch(stray);
    expect(stray.connected).toBe(false);
  }
  const other = new FakePort("nope", { tab: { id: TAB } });
  onConnect.dispatch(other);
  expect(other.connected).toBe(true);
  expect(other.onMessage.hasListeners()).toBe(false);
});
