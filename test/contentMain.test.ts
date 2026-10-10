// @vitest-environment jsdom
// The real content script entry, loaded into a jsdom page with BL's dock and a stubbed chrome.*.
import { afterEach, expect, it, vi } from "vitest";
import { AUDIO_BUTTON_CLASS } from "../src/content/audioButton";
import { DOCK_BUTTON_CLASS } from "../src/content/lyricsButton";
import { MENU_CLASS } from "../src/content/menu";
import { TOAST_CLASS } from "../src/content/toast";
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeRequest, encodeReply } from "../src/shared/bridgeProtocol";
import { addPlayerPage, mountDock } from "./helpers/blPage";
import { fixtureSummary } from "./helpers/captureSummary";
import { FakePort } from "./helpers/fakePort";
import { FakeStorageArea } from "./helpers/fakeStorage";

const ID = "nKites0042x";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A stand-in page bridge: answers what is playing, as page-bridge.ts does from the main world.
function answerWhatIsPlaying(): void {
  document.addEventListener(WHAT_IS_PLAYING_EVENT, (event) => {
    const requestId = decodeRequest((event as CustomEvent<unknown>).detail)!;
    const detail = encodeReply({ requestId, videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: null });
    document.dispatchEvent(new CustomEvent(NOW_PLAYING_EVENT, { detail }));
  });
}

/** YTM's player bar with its right-hand controls, where the audio button goes. */
function addPlayerBar(): void {
  const bar = document.createElement("ytmusic-player-bar");
  const controls = document.createElement("div");
  controls.className = "right-controls-buttons";
  bar.append(controls);
  document.body.append(bar);
}

it("mounts one lyrics button and one audio button per page however often it is injected; a click opens the menu of the stored capture; both buttons share one toaster; after a reload it says to reload the tab", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const sendMessage = vi.fn(async () => ({ summary: fixtureSummary(ID) }));
  const connect = vi.fn();
  vi.stubGlobal("chrome", { runtime: { sendMessage, connect, lastError: undefined }, storage: { local: new FakeStorageArea({ kind: "local" }) } });
  addPlayerPage();
  mountDock();
  addPlayerBar();
  vi.resetModules();
  await import("../src/content/main");
  expect(document.documentElement.hasAttribute("data-pg-grabber")).toBe(true);
  expect(log).toHaveBeenLastCalledWith("[YTM Practice Grabber] content script loaded");
  expect(document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`)).toHaveLength(1);
  expect(document.querySelectorAll(`.${AUDIO_BUTTON_CLASS}`)).toHaveLength(1);

  vi.resetModules();
  await import("../src/content/main");
  expect(log).toHaveBeenLastCalledWith("[YTM Practice Grabber] content script already running in this page");
  expect(document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`)).toHaveLength(1);
  expect(document.querySelectorAll(`.${AUDIO_BUTTON_CLASS}`)).toHaveLength(1);

  answerWhatIsPlaying();
  const button = document.querySelector<HTMLButtonElement>(`.${DOCK_BUTTON_CLASS}`)!;
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
  button.click();
  await vi.waitFor(() => expect(document.querySelector(`.${MENU_CLASS}`)).not.toBeNull());
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "capture:get", videoId: ID });
  expect(connect).not.toHaveBeenCalled();
  // (main.ts, imported after resetModules, has its own copy of menu.ts: look at the page.)
  expect(button.getAttribute("aria-expanded")).toBe("true");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(`.${MENU_CLASS}`)).toBeNull();

  // The audio button downloads over an `audio` port and reports through the same toaster.
  const audioButton = document.querySelector<HTMLButtonElement>(`.${AUDIO_BUTTON_CLASS}`)!;
  const audioPort = new FakePort("audio");
  connect.mockImplementationOnce(() => audioPort);
  audioButton.click();
  await vi.waitFor(() => expect(audioPort.types()).toEqual(["start"]));
  expect(connect).toHaveBeenCalledExactlyOnceWith({ name: "audio" });
  audioPort.deliver({ type: "error", message: "yt-dlp failed (exit code 1)" });
  expect(document.querySelector(`.${TOAST_CLASS}`)?.textContent).toBe("Audio download failed: yt-dlp failed (exit code 1)");
  connect.mockReset();

  // The extension was reloaded: this script lives on, and every chrome.* call throws.
  sendMessage.mockImplementation(() => {
    throw new Error("Extension context invalidated.");
  });
  button.click();
  await vi.waitFor(() => expect(document.querySelector(`.${TOAST_CLASS}`)?.textContent).toBe("The extension was reloaded: reload this tab"));
  expect(document.querySelector(`.${MENU_CLASS}`)).toBeNull();

  // What Chromium 141 does instead (seen in the B8 end-to-end test): it takes chrome.runtime away
  // from the orphaned script. First mid-capture, where the port is then closed (reading lastError
  // in onDisconnect must not throw), then on a click.
  const toast = document.querySelector<HTMLElement>(`.${TOAST_CLASS}`)!;
  toast.textContent = "";
  const port = new FakePort("capture");
  sendMessage.mockImplementation(async () => ({ summary: null }) as never);
  connect.mockImplementation(() => port);
  button.click();
  await vi.waitFor(() => expect(port.types()).toEqual(["start"]));
  vi.stubGlobal("chrome", { storage: { local: new FakeStorageArea({ kind: "local" }) } });
  port.remoteDisconnect();
  await vi.waitFor(() => expect(toast.textContent).toBe("The extension was reloaded: reload this tab"));
  toast.textContent = "";
  button.click();
  await vi.waitFor(() => expect(toast.textContent).toBe("The extension was reloaded: reload this tab"));
  expect(document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`)).toHaveLength(1);
  // The audio button's port goes through the same wrapper: a retry now says to reload the tab.
  toast.textContent = "";
  audioButton.click();
  await vi.waitFor(() => expect(toast.textContent).toBe("Audio download failed: The extension was reloaded: reload this tab"));
  expect(document.querySelectorAll(`.${TOAST_CLASS}`)).toHaveLength(1);
  expect(document.querySelectorAll(`.${AUDIO_BUTTON_CLASS}`)).toHaveLength(1);
});
