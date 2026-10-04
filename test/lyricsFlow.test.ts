// @vitest-environment jsdom
// The lyrics button's click flow with a fake chrome.runtime: stored captures, the capture port,
// downloads, the offset note and what the user is told when something fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_CLASS, CAPTURE_GUARD_MS, createLyricsFlow, FLOW_TEXT, offsetNote, REQUEST_TIMEOUT_MS, type LyricsFlow } from "../src/content/lyricsFlow";
import { currentMenu, MENU_CLASS } from "../src/content/menu";
import { TOAST_CLASS, TOAST_ERROR_CLASS } from "../src/content/toast";
import type { ExtensionRequest } from "../src/shared/messages";
import { createSettingsStore, type CaptureMode, type SettingsStore } from "../src/shared/settings";
import type { CaptureSummary } from "../src/shared/summary";
import { addPlayerPage, mountDock, type ControlOptions } from "./helpers/blPage";
import { fixtureSummary } from "./helpers/captureSummary";
import { FakePort } from "./helpers/fakePort";
import { FakeStorageArea } from "./helpers/fakeStorage";

const ID = "nKites0042x";
const OTHER = "0therS0ng11";
const BUTTON_TITLE = "Download lyrics";
// YTM spells the title differently from BL's lyrics API: the stem must follow YTM for the playing song.
const YTM_TITLE = "Northbound Kites (Live at Home)";
const PLAYING_STEM = `Marrow & Tin - ${YTM_TITLE} [${ID}]`;
const INVALIDATED = "Extension context invalidated.";

/** chrome.runtime as the content script sees it, with a worker that keeps captures in `stored`. */
class FakeRuntime {
  readonly ports: FakePort[] = [];
  readonly sent: ExtensionRequest[] = [];
  readonly stored = new Map<string, CaptureSummary>();
  downloadReply: unknown = { ok: true };
  readonly lastError = vi.fn((): string | undefined => undefined);
  readonly sendMessage = vi.fn((message: ExtensionRequest): Promise<unknown> => {
    this.sent.push(JSON.parse(JSON.stringify(message)));
    const reply = message.type === "capture:get" ? { summary: this.stored.get(message.videoId) ?? null } : this.downloadReply;
    return Promise.resolve(JSON.parse(JSON.stringify(reply)));
  });
  readonly connect = vi.fn(({ name }: { name: string }) => {
    const port = new FakePort(name);
    this.ports.push(port);
    return port;
  });

  get port(): FakePort {
    return this.ports.at(-1)!;
  }

  /** The worker finishes the capture: stores it and posts `done`. */
  complete(summary: CaptureSummary): void {
    this.stored.set(summary.videoId, summary);
    this.port.deliver({ type: "done", summary });
  }

  types(): string[] {
    return this.sent.map((message) => message.type);
  }
}

let runtime: FakeRuntime;
let flow: LyricsFlow;
let button: HTMLButtonElement;
let playing: { videoId: string | null; title: string | null; author: string | null };
const refreshClicks = vi.fn();
const warn = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  playing = { videoId: ID, title: YTM_TITLE, author: "Marrow & Tin" };
});

afterEach(() => {
  currentMenu()?.close();
  document.body.replaceChildren();
  refreshClicks.mockReset();
  warn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** BL's page with its dock, our button in it, and a flow behind the button. */
function setup({ mode = "on-demand", settings, ...dock }: { mode?: CaptureMode; settings?: Pick<SettingsStore, "getSettings"> } & ControlOptions & { sourceName?: string } = {}): void {
  addPlayerPage();
  const inner = mountDock(dock);
  // BL's refresh handler marks the button busy until the controls are rebuilt.
  const refresh = document.querySelector<HTMLElement>(".blyrics-dock__refresh");
  refresh?.addEventListener("click", () => {
    refreshClicks();
    refresh.classList.add("blyrics-dock__refresh--busy");
  });
  button = document.createElement("button");
  button.className = "pg-dock-btn";
  button.title = BUTTON_TITLE;
  inner.append(button);
  runtime = new FakeRuntime();
  flow = createLyricsFlow({
    runtime,
    settings: settings ?? createSettingsStore(new FakeStorageArea({ kind: "local", initial: { captureMode: mode } })),
    nowPlaying: async () => ({ ...playing }),
    log: { warn },
  });
  button.addEventListener("click", () => flow.onClick(button));
}

/** Lets every pending promise chain run (the fake timers' async tick yields to the event loop). */
const settle = () => vi.advanceTimersByTimeAsync(0);
const click = async () => {
  button.click();
  await settle();
};
const menu = () => document.querySelector<HTMLElement>(`.${MENU_CLASS}`);
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.pg-menu [role="menuitem"]')].find((element) => element.querySelector(".pg-menu__label")!.textContent === label)!;
const toast = () => document.querySelector<HTMLElement>(`.${TOAST_CLASS}`);
const toastText = () => (toast()?.hidden === false ? toast()!.textContent : null);
const isBusy = () => button.classList.contains(BUSY_CLASS);

describe("a stored capture", () => {
  it("opens the menu without a capture", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    expect(runtime.sent).toEqual([{ type: "capture:get", videoId: ID }]);
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    expect(menuItem("Download TTML for Tony")).toBeDefined();
    // The source BL's dock names ("Better Lyrics") is marked.
    expect(document.querySelector(".pg-menu__item--showing .pg-menu__label")!.textContent).toMatch(/^Better Lyrics .* \(showing\)$/);
    expect(isBusy()).toBe(false);
  });

  it("reads only the source name, not BL's position beside it", async () => {
    setup({ sourceName: "  Musixmatch " });
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    expect(document.querySelector(".pg-menu__item--showing .pg-menu__label")!.textContent).toMatch(/^Musixmatch .* \(showing\)$/);
  });

  it("closes the menu on a click on its button, without asking again", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    await click();
    expect(menu()).toBeNull();
    expect(runtime.sent).toHaveLength(1);
    await click();
    expect(menu()).not.toBeNull();
    expect(runtime.sent).toHaveLength(2);
  });

  it("says why when there is no stem, and asks nothing", async () => {
    setup();
    playing = { videoId: null, title: "Northbound Kites", author: null };
    await click();
    expect(toastText()).toBe("Could not tell which video is playing");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a capture", () => {
  it("starts on the port, clicks BL's refresh once on ready, and shows the menu on done", async () => {
    setup();
    await click();
    expect(runtime.types()).toEqual(["capture:get"]);
    expect(runtime.connect).toHaveBeenCalledWith({ name: "capture" });
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID }]);
    expect(isBusy()).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.title).toBe(FLOW_TEXT.capturing);
    expect(refreshClicks).not.toHaveBeenCalled();

    runtime.port.deliver({ type: "ready" });
    expect(refreshClicks).toHaveBeenCalledTimes(1);
    // A second ready (or BL's busy button) never makes a second request.
    document.querySelector(".blyrics-dock__refresh")!.classList.remove("blyrics-dock__refresh--busy");
    runtime.port.deliver({ type: "ready" });
    expect(refreshClicks).toHaveBeenCalledTimes(1);

    runtime.complete(fixtureSummary(ID));
    await settle();
    expect(menu()).not.toBeNull();
    expect(menuItem("Captured for another song")).toBeUndefined();
    expect(runtime.port.connected).toBe(false);
    expect(isBusy()).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.title).toBe(BUTTON_TITLE);
    expect(toastText()).toBeNull();
  });

  it("does not click a refresh button BL already marks busy", async () => {
    setup();
    document.querySelector(".blyrics-dock__refresh")!.classList.add("blyrics-dock__refresh--busy");
    await click();
    runtime.port.deliver({ type: "ready" });
    expect(refreshClicks).not.toHaveBeenCalled();
  });

  it("shows the worker's reason on error", async () => {
    setup();
    await click();
    runtime.port.deliver({ type: "ready" });
    runtime.port.deliver({ type: "error", reason: "No lyrics stream from Better Lyrics within 30 s" });
    await settle();
    expect(toastText()).toBe("No lyrics stream from Better Lyrics within 30 s");
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(true);
    expect(menu()).toBeNull();
    expect(runtime.port.connected).toBe(false);
    expect(isBusy()).toBe(false);
  });

  it("says the background stopped when the port goes without a result", async () => {
    setup();
    await click();
    runtime.port.deliver({ type: "ready" });
    runtime.port.remoteDisconnect();
    await settle();
    expect(toastText()).toBe(FLOW_TEXT.backgroundStopped);
    expect(runtime.lastError).toHaveBeenCalled();
    expect(isBusy()).toBe(false);
    // A late message on a dead port changes nothing.
    runtime.port.deliver({ type: "done", summary: fixtureSummary(ID) });
    await settle();
    expect(menu()).toBeNull();
  });

  it("gives up after its guard time when nothing comes back", async () => {
    setup();
    await click();
    runtime.port.deliver({ type: "ready" });
    await vi.advanceTimersByTimeAsync(CAPTURE_GUARD_MS - 1);
    expect(isBusy()).toBe(true);
    expect(toastText()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(toastText()).toBe(FLOW_TEXT.noAnswer);
    expect(runtime.port.connected).toBe(false);
    expect(isBusy()).toBe(false);
    // The flow is free again.
    await click();
    expect(runtime.ports).toHaveLength(2);
  });

  it("joins the running flow on clicks while it runs: one request, one port", async () => {
    setup();
    button.click();
    button.click();
    await settle();
    await click();
    runtime.port.deliver({ type: "ready" });
    await click();
    expect(runtime.types()).toEqual(["capture:get"]);
    expect(runtime.ports).toHaveLength(1);
    expect(refreshClicks).toHaveBeenCalledTimes(1);
    expect(isBusy()).toBe(true);
    runtime.complete(fixtureSummary(ID));
    await settle();
    expect(document.querySelectorAll(`.${MENU_CLASS}`)).toHaveLength(1);
  });

  it("without BL's refresh button in on-demand mode: the message, and no capture", async () => {
    setup({ refresh: false });
    await click();
    expect(toastText()).toBe(FLOW_TEXT.noRefresh);
    expect(toastText()).toBe("Turn on BL's refresh button in its dock settings, or enable Always-capture in this extension's options.");
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(isBusy()).toBe(false);
  });

  it("without BL's refresh button in always mode: captures the next lyrics BL loads, clicking nothing", async () => {
    setup({ refresh: false, mode: "always" });
    await click();
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID }]);
    runtime.port.deliver({ type: "ready" });
    expect(toastText()).toBe(FLOW_TEXT.waitingForBl);
    runtime.complete(fixtureSummary(ID));
    await settle();
    expect(menu()).not.toBeNull();
  });

  it("in always mode with the refresh button: clicks it, as on demand", async () => {
    setup({ mode: "always" });
    await click();
    runtime.port.deliver({ type: "ready" });
    expect(refreshClicks).toHaveBeenCalledTimes(1);
  });

  it("re-captures from the menu, whatever is stored", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    menuItem("Re-capture").click();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
    await settle();
    expect(runtime.types()).toEqual(["capture:get"]);
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID }]);
    runtime.port.deliver({ type: "ready" });
    expect(refreshClicks).toHaveBeenCalledTimes(1);
    runtime.complete(fixtureSummary(ID));
    await settle();
    expect(menu()).not.toBeNull();
  });
});

describe("downloads", () => {
  /** Opens the menu for a stored capture of the playing song and chooses `label`. */
  const choose = async (label: string, dock: ControlOptions = {}) => {
    setup(dock);
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    menuItem(label).click();
    await settle();
  };
  const downloads = () => runtime.sent.filter((message) => message.type === "lyrics:download");

  it("sends the playing song's stem (YTM's names), then closes the menu and says Saved", async () => {
    await choose("Download TTML for Tony");
    expect(downloads()).toEqual([{ type: "lyrics:download", videoId: ID, itemId: "tony", stem: PLAYING_STEM }]);
    expect(menu()).toBeNull();
    expect(toastText()).toBe(FLOW_TEXT.saved);
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(false);
  });

  it("names another song's capture from its metadata", async () => {
    setup();
    await click();
    runtime.port.deliver({ type: "ready" });
    runtime.complete(fixtureSummary(OTHER));
    await settle();
    expect(menuItem("Captured for another song")).toBeDefined();
    menuItem("Raw response (.txt)").click();
    await settle();
    expect(downloads()).toEqual([{ type: "lyrics:download", videoId: OTHER, itemId: "raw", stem: `Marrow & Tin - Northbound Kites [${OTHER}]` }]);
  });

  it("takes the song now playing when it changed during the capture", async () => {
    setup();
    await click();
    runtime.port.deliver({ type: "ready" });
    playing = { videoId: OTHER, title: "Southbound Kites", author: "Marrow & Tin" };
    runtime.complete(fixtureSummary(OTHER));
    await settle();
    expect(menuItem("Captured for another song")).toBeUndefined();
    menuItem("Download TTML for Tony").click();
    await settle();
    expect(downloads()).toEqual([{ type: "lyrics:download", videoId: OTHER, itemId: "tony", stem: `Marrow & Tin - Southbound Kites [${OTHER}]` }]);
  });

  it("sends a source item's own id", async () => {
    await choose("Better Lyrics Portato \u{2014} QRC, word-synced \u{2192} TTML");
    expect(downloads().map((message) => message.type === "lyrics:download" && message.itemId)).toEqual(["ttml:qq"]);
  });

  it("shows the worker's error and keeps the menu open", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    runtime.downloadReply = { ok: false, error: "Chrome refused the download: FILE_FAILED" };
    await click();
    menuItem("Download TTML for Tony").click();
    await settle();
    expect(toastText()).toBe("Chrome refused the download: FILE_FAILED");
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(true);
    expect(menu()).not.toBeNull();
    expect(menu()!.hasAttribute("aria-busy")).toBe(false);
  });

  it("saves one file per choice while the worker is busy with it", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    let answer!: (reply: unknown) => void;
    runtime.sendMessage.mockImplementationOnce((message) => {
      runtime.sent.push(message);
      return new Promise((resolve) => (answer = resolve));
    });
    menuItem("Download TTML for Tony").click();
    menuItem("Download TTML for Tony").click();
    menuItem("Raw response (.txt)").click();
    expect(downloads()).toHaveLength(1);
    answer({ ok: true });
    await settle();
    expect(toastText()).toBe(FLOW_TEXT.saved);
  });

  describe("BL's offset", () => {
    const shifted = (amount: string) => `${FLOW_TEXT.saved}\n${offsetNote(Number(amount))}`;
    it.each([
      ["+0.2s", "+0.2"],
      ["-1.5s", "-1.5"],
      ["+0,25 s", "+0.25"],
      ["\u{2212}0.3s", "-0.3"],
      ["+120ms", "+0.12"],
      ["2", "+2"],
    ])("adds a note for %j", async (text, amount) => {
      await choose("Download TTML for Tony", { offset: text });
      expect(toastText()).toBe(shifted(amount));
    });

    it.each(["0s", "0.0s", "-0.0s", "+0.0s", "0", "", "auto"])("says only Saved for %j", async (text) => {
      await choose("Download TTML for Tony", { offset: text });
      expect(toastText()).toBe(FLOW_TEXT.saved);
    });

    it("says only Saved without an offset control", async () => {
      await choose("Download TTML for Tony");
      expect(toastText()).toBe(FLOW_TEXT.saved);
    });

    it("words the note for Tony", () => {
      expect(offsetNote(0.2)).toBe("BL shows these lyrics shifted by +0.2 s; the file is not shifted. In Tony use Edit \u{2192} Shift Lyrics\u{2026}");
      expect(offsetNote(-1.5)).toBe("BL shows these lyrics shifted by -1.5 s; the file is not shifted. In Tony use Edit \u{2192} Shift Lyrics\u{2026}");
    });

    it("leaves it out for another song's capture, which BL is not showing", async () => {
      setup({ offset: "+0.2s" });
      await click();
      runtime.port.deliver({ type: "ready" });
      runtime.complete(fixtureSummary(OTHER));
      await settle();
      menuItem("Download TTML for Tony").click();
      await settle();
      expect(toastText()).toBe(FLOW_TEXT.saved);
    });
  });
});

describe("when the extension cannot be reached", () => {
  it("says to reload the tab when the extension was reloaded (sendMessage throws)", async () => {
    setup();
    runtime.sendMessage.mockImplementation(() => {
      throw new Error(INVALIDATED);
    });
    await click();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
    expect(toastText()).toBe("The extension was reloaded: reload this tab");
    expect(warn).not.toHaveBeenCalled();
    // And the button still works afterwards.
    await click();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("says the same when the request rejects", async () => {
    setup();
    runtime.sendMessage.mockRejectedValue(new Error(INVALIDATED));
    await click();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
  });

  it("says the same when the port cannot be opened", async () => {
    setup();
    runtime.connect.mockImplementation(() => {
      throw new Error(INVALIDATED);
    });
    await click();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
    expect(isBusy()).toBe(false);
  });

  it("says the same when the port is disconnected with that error", async () => {
    setup();
    await click();
    runtime.lastError.mockReturnValue(INVALIDATED);
    runtime.port.remoteDisconnect();
    await settle();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
    expect(isBusy()).toBe(false);
  });

  it("says the same when the options cannot be read", async () => {
    setup({ refresh: false, settings: { getSettings: () => Promise.reject(new Error(INVALIDATED)) } });
    await click();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
    expect(runtime.connect).not.toHaveBeenCalled();
  });

  it("says the same for a download, keeping the menu", async () => {
    setup();
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    runtime.sendMessage.mockRejectedValue(new Error(INVALIDATED));
    menuItem("Download TTML for Tony").click();
    await settle();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
    expect(menu()).not.toBeNull();
  });

  it("passes Chrome's words on for other failures", async () => {
    setup();
    runtime.sendMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    await click();
    expect(toastText()).toBe("Could not reach the extension's background (Could not establish connection. Receiving end does not exist.); try again");
  });

  it("gives up on a request the worker never answers, and is free again", async () => {
    setup();
    runtime.sendMessage.mockImplementationOnce(() => new Promise(() => undefined));
    await click();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(toastText()).toBe(FLOW_TEXT.noAnswer);
    runtime.stored.set(ID, fixtureSummary(ID));
    await click();
    expect(menu()).not.toBeNull();
  });

  it("refuses an answer it does not understand", async () => {
    setup();
    runtime.sendMessage.mockResolvedValue(undefined);
    await click();
    expect(toastText()).toBe(FLOW_TEXT.badReply);
    expect(runtime.connect).not.toHaveBeenCalled();
  });
});
