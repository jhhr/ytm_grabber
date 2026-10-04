// @vitest-environment jsdom
// The real content script entry, loaded into a jsdom page with BL's dock and a stubbed chrome.*.
import { afterEach, expect, it, vi } from "vitest";
import { DOCK_BUTTON_CLASS } from "../src/content/lyricsButton";
import { MENU_CLASS } from "../src/content/menu";
import { TOAST_CLASS } from "../src/content/toast";
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeRequest, encodeReply } from "../src/shared/bridgeProtocol";
import { addPlayerPage, mountDock } from "./helpers/blPage";
import { fixtureSummary } from "./helpers/captureSummary";
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

it("mounts one lyrics button per page however often it is injected; a click opens the menu of the stored capture", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const sendMessage = vi.fn(async () => ({ summary: fixtureSummary(ID) }));
  const connect = vi.fn();
  vi.stubGlobal("chrome", { runtime: { sendMessage, connect, lastError: undefined }, storage: { local: new FakeStorageArea({ kind: "local" }) } });
  addPlayerPage();
  mountDock();
  vi.resetModules();
  await import("../src/content/main");
  expect(document.documentElement.hasAttribute("data-pg-grabber")).toBe(true);
  expect(log).toHaveBeenLastCalledWith("[YTM Practice Grabber] content script loaded");
  expect(document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`)).toHaveLength(1);

  vi.resetModules();
  await import("../src/content/main");
  expect(log).toHaveBeenLastCalledWith("[YTM Practice Grabber] content script already running in this page");
  expect(document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`)).toHaveLength(1);

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

  // The extension was reloaded: this script lives on, and every chrome.* call throws.
  sendMessage.mockImplementation(() => {
    throw new Error("Extension context invalidated.");
  });
  button.click();
  await vi.waitFor(() => expect(document.querySelector(`.${TOAST_CLASS}`)?.textContent).toBe("The extension was reloaded: reload this tab"));
  expect(document.querySelector(`.${MENU_CLASS}`)).toBeNull();
});
