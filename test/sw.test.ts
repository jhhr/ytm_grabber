import { afterEach, expect, it, vi } from "vitest";
import { UNISON_GRACE_MS } from "../src/background/networkWatcher";
import { buildStem } from "../src/shared/filenames";
import { CAPTURE_PORT } from "../src/shared/messages";
import { ID, TAB, YTM_URL, serveStream, tick } from "./helpers/captureHarness";
import { FakeDebugger, fakeTabs } from "./helpers/fakeDebugger";
import { FakeDownloads } from "./helpers/fakeDownloads";
import { FakePort } from "./helpers/fakePort";
import { FakeEvent, FakeStorageArea } from "./helpers/fakeStorage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { captureNow?: unknown }).captureNow;
});

it("registers every listener as it loads, captures through the capture port into the store capture:get reads, and saves lyrics from it", async () => {
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
  vi.stubGlobal("chrome", { runtime: { onMessage, onConnect, id: extensionId }, storage: { session, local }, debugger: fake, tabs: { ...fakeTabs(fake), onUpdated }, downloads });
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

  // Not from a tab: turned away. Another port name: not ours to handle.
  const stray = new FakePort(CAPTURE_PORT, {});
  onConnect.dispatch(stray);
  expect(stray.connected).toBe(false);
  const other = new FakePort("audio", { tab: { id: TAB } });
  onConnect.dispatch(other);
  expect(other.connected).toBe(true);
  expect(other.onMessage.hasListeners()).toBe(false);
});
