// @vitest-environment jsdom
// The real content script entry, loaded into a jsdom page with BL's dock.
import { afterEach, expect, it, vi } from "vitest";
import { DOCK_BUTTON_CLASS } from "../src/content/lyricsButton";
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeRequest, encodeReply } from "../src/shared/bridgeProtocol";
import { addPlayerPage, mountDock } from "./helpers/blPage";

const ID = "nKites0042x";

afterEach(() => {
  vi.restoreAllMocks();
});

it("mounts one lyrics button per page however often it is injected, and logs the stem on click", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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

  // The click stub asks what is playing; here a stand-in bridge answers.
  document.addEventListener(WHAT_IS_PLAYING_EVENT, (event) => {
    const requestId = decodeRequest((event as CustomEvent<unknown>).detail)!;
    const detail = encodeReply({ requestId, videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: null });
    document.dispatchEvent(new CustomEvent(NOW_PLAYING_EVENT, { detail }));
  });
  document.querySelector<HTMLButtonElement>(`.${DOCK_BUTTON_CLASS}`)!.click();
  await vi.waitFor(() =>
    expect(log).toHaveBeenLastCalledWith("[YTM Practice Grabber] lyrics button clicked; now playing (from the bridge):", `Marrow & Tin - Northbound Kites [${ID}]`),
  );
});
