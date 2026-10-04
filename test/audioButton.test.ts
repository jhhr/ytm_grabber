// @vitest-environment jsdom
// The audio button in YTM's player bar with a fake chrome.runtime: placement, the download states,
// cancel, reveal, retry, per-video state across song changes and the music-video warning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALBUM_TRACK_TYPE,
  AUDIO_BADGE_CLASS,
  AUDIO_BUTTON_CLASS,
  AUDIO_BUTTON_PLACE,
  AUDIO_BUTTON_TEXT,
  mountAudioButton,
  type AudioButtonController,
} from "../src/content/audioButton";
import { currentPopover, POPOVER_CLASS } from "../src/content/confirmPopover";
import { CHECK_DELAY_MS } from "../src/content/lyricsButton";
import { FLOW_TEXT } from "../src/content/lyricsFlow";
import { createToaster, TOAST_CLASS, TOAST_ERROR_CLASS } from "../src/content/toast";
import type { PlayerInfo } from "../src/shared/bridgeProtocol";
import { buildStem } from "../src/shared/filenames";
import { AUDIO_PORT, type ExtensionRequest } from "../src/shared/messages";
import { FakePort } from "./helpers/fakePort";

const ID = "nKites0042x";
const OTHER = "0therS0ng11";
const SONG: PlayerInfo = { videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: ALBUM_TRACK_TYPE };
const OTHER_SONG: PlayerInfo = { videoId: OTHER, title: "Paper Weather", author: "Marrow & Tin", musicVideoType: ALBUM_TRACK_TYPE };
const STEM = buildStem({ artist: SONG.author, title: SONG.title, videoId: ID });
const OTHER_STEM = buildStem({ artist: OTHER_SONG.author, title: OTHER_SONG.title, videoId: OTHER });
const PATH = `C:\\Users\\me\\Downloads\\${STEM}.opus`;
const OTHER_PATH = `C:\\Users\\me\\Downloads\\${OTHER_STEM}.opus`;
const INVALIDATED = "Extension context invalidated.";

/** chrome.runtime as the content script sees it: every `audio` port, and what audio:reveal answers. */
class FakeRuntime {
  readonly ports: FakePort[] = [];
  readonly sent: ExtensionRequest[] = [];
  revealReply: unknown = { ok: true };
  readonly lastError = vi.fn((): string | undefined => undefined);
  readonly sendMessage = vi.fn((message: ExtensionRequest): Promise<unknown> => {
    this.sent.push(JSON.parse(JSON.stringify(message)));
    return Promise.resolve(this.revealReply);
  });
  readonly connect = vi.fn(({ name }: { name: string }) => {
    const port = new FakePort(name);
    this.ports.push(port);
    return port;
  });

  get port(): FakePort {
    return this.ports.at(-1)!;
  }
}

let runtime: FakeRuntime;
let controller: AudioButtonController | undefined;
let playing: PlayerInfo;
const warn = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  playing = { ...SONG };
});

afterEach(() => {
  controller?.dispose();
  controller = undefined;
  currentPopover()?.close();
  document.body.replaceChildren();
  warn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** YTM's player bar: song info, then the right-hand controls (a volume button in them). */
function addPlayerBar(parent: Element = document.body): { bar: HTMLElement; controls: HTMLElement; title: HTMLElement } {
  const bar = document.createElement("ytmusic-player-bar");
  const title = document.createElement("yt-formatted-string");
  title.className = "title";
  title.textContent = playing.title;
  const controls = newControls();
  bar.append(title, controls);
  parent.append(bar);
  return { bar, controls, title };
}

function newControls(): HTMLElement {
  const controls = document.createElement("div");
  controls.className = "right-controls-buttons";
  const volume = document.createElement("tp-yt-paper-icon-button");
  volume.className = "volume";
  controls.append(volume);
  return controls;
}

function mount(root?: Document | Element): void {
  runtime = new FakeRuntime();
  controller = mountAudioButton({ runtime, toaster: createToaster(), root, nowPlaying: async () => ({ ...playing }), log: { warn } });
}

/** Lets the observer report, the coalesced check run and its question be answered. */
const settle = () => vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
const flush = () => vi.advanceTimersByTimeAsync(0);
const buttons = () => document.querySelectorAll<HTMLButtonElement>(`.${AUDIO_BUTTON_CLASS}`);
const button = () => buttons()[0];
const state = () => button().dataset.state;
const badge = () => button().querySelector<HTMLElement>(`.${AUDIO_BADGE_CLASS}`)!;
const click = async () => {
  button().click();
  await flush();
};
const toast = () => document.querySelector<HTMLElement>(`.${TOAST_CLASS}`);
const toastText = () => (toast()?.hidden === false ? toast()!.textContent : null);
const popover = () => document.querySelector<HTMLElement>(`.${POPOVER_CLASS}`);
const popoverButton = (label: string) => [...popover()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;
/** The song changes: YTM rewrites the player bar's title. */
async function play(song: PlayerInfo): Promise<void> {
  playing = { ...song };
  document.querySelector(`${AUDIO_BUTTON_PLACE.playerBar} .title`)!.textContent = song.title;
  await settle();
}

describe("placement", () => {
  it("goes at the end of the player bar's right controls, as a labelled pg- button with an icon", () => {
    const { controls } = addPlayerBar();
    mount();
    expect(buttons()).toHaveLength(1);
    expect(controls.lastElementChild).toBe(button());
    expect(button().type).toBe("button");
    expect(state()).toBe("idle");
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.idle);
    expect(button().getAttribute("aria-label")).toBe(AUDIO_BUTTON_TEXT.idle);
    expect(button().querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
    expect(button().querySelectorAll("svg path").length).toBeGreaterThan(0);
    expect(badge().hidden).toBe(true);
  });

  it("appears once the player bar comes, and comes back when YTM rebuilds the controls, the bar, or removes it", async () => {
    mount();
    await settle();
    expect(buttons()).toHaveLength(0);
    const { bar, controls } = addPlayerBar();
    await settle();
    expect(controls.lastElementChild).toBe(button());

    const fresh = newControls();
    controls.replaceWith(fresh);
    await settle();
    expect(fresh.lastElementChild).toBe(button());

    button().remove();
    await settle();
    expect(fresh.lastElementChild).toBe(button());

    bar.remove();
    await settle();
    expect(buttons()).toHaveLength(0);
    const again = addPlayerBar();
    await settle();
    expect(again.controls.lastElementChild).toBe(button());
    expect(buttons()).toHaveLength(1);
  });

  it("stays where it is when YTM adds controls after it", async () => {
    const { controls } = addPlayerBar();
    mount();
    const added = document.createElement("tp-yt-paper-icon-button");
    controls.append(added);
    await settle();
    expect([...controls.children]).toEqual([controls.firstElementChild, button(), added]);
  });

  it("works under an element root", async () => {
    const app = document.createElement("ytmusic-app");
    document.body.append(app);
    mount(app);
    const { controls } = addPlayerBar(app);
    await settle();
    expect(controls.lastElementChild).toBe(button());
  });

  it("once the bar exists, watches only it: changes elsewhere cost no check", async () => {
    const page = document.createElement("div");
    document.body.append(page);
    addPlayerBar();
    mount();
    await settle();
    const checks = vi.spyOn(MutationObserver.prototype, "takeRecords");
    for (let i = 0; i < 5; i++) page.append(document.createElement("div"));
    await settle();
    expect(checks).not.toHaveBeenCalled();
    // A burst inside the bar is one check.
    for (let i = 0; i < 5; i++) document.querySelector(AUDIO_BUTTON_PLACE.playerBar)!.append(document.createElement("span"));
    await settle();
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("is removed by dispose and comes back no more", async () => {
    addPlayerBar();
    mount();
    controller!.dispose();
    controller = undefined;
    expect(buttons()).toHaveLength(0);
    document.querySelector(AUDIO_BUTTON_PLACE.playerBar)!.append(newControls());
    await settle();
    expect(buttons()).toHaveLength(0);
  });
});

describe("a download", () => {
  beforeEach(() => {
    addPlayerBar();
    mount();
  });

  it("starts on a click, shows its percent in a badge and the tooltip, then a check mark and the path", async () => {
    await click();
    expect(runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: AUDIO_PORT });
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);
    expect(state()).toBe("running");
    expect(button().title).toBe("Downloading audio\u{2026}\nClick to stop it");
    expect(badge().hidden).toBe(true);

    runtime.port.deliver({ type: "progress", percent: 42.7 });
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe("42%");
    expect(button().title).toBe("Downloading audio: 42%\nClick to stop it");
    expect(button().getAttribute("aria-label")).toBe(button().title);
    runtime.port.deliver({ type: "progress", percent: null });
    expect(badge().hidden).toBe(true);
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.running(null));

    const port = runtime.port;
    port.deliver({ type: "done", path: PATH });
    expect(state()).toBe("done");
    expect(button().title).toBe(`Audio saved: ${PATH}\nClick to show it in its folder`);
    expect(badge().hidden).toBe(true);
    expect(port.connected).toBe(false);
    expect(toastText()).toBe(`Audio saved: ${PATH}`);
  });

  it("when done, shows the file in its folder through the worker on a click; a refusal is a toast", async () => {
    await click();
    runtime.port.deliver({ type: "done", path: PATH });
    toast()!.hidden = true;
    await click();
    expect(runtime.sent).toEqual([{ type: "audio:reveal", path: PATH }]);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    expect(toastText()).toBeNull();

    runtime.revealReply = { ok: false, error: "Showing a file in its folder works on Windows only" };
    await click();
    expect(toastText()).toBe("Could not show the file: Showing a file in its folder works on Windows only");
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(true);
    expect(state()).toBe("done");

    runtime.sendMessage.mockImplementationOnce(() => {
      throw new Error(INVALIDATED);
    });
    await click();
    expect(toastText()).toBe(FLOW_TEXT.reloaded);
  });

  it("that fails shows why in the tooltip and a toast; a click tries again", async () => {
    await click();
    const first = runtime.port;
    first.deliver({ type: "progress", percent: 10 });
    first.deliver({ type: "error", message: "yt-dlp failed (exit code 1): ERROR: Video unavailable" });
    expect(state()).toBe("error");
    expect(button().title).toBe("Audio download failed: yt-dlp failed (exit code 1): ERROR: Video unavailable\nClick to try again");
    expect(toastText()).toBe("Audio download failed: yt-dlp failed (exit code 1): ERROR: Video unavailable");
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(true);
    expect(badge().hidden).toBe(true);
    expect(first.connected).toBe(false);

    await click();
    expect(runtime.ports).toHaveLength(2);
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);
    expect(state()).toBe("running");
    // The old port's late words change nothing.
    first.connected = true;
    first.deliver({ type: "done", path: PATH });
    expect(state()).toBe("running");
  });

  it("while running, a click asks before stopping it: Keep downloading changes nothing, Stop download cancels", async () => {
    await click();
    runtime.port.deliver({ type: "progress", percent: 30 });
    await click();
    expect(popover()?.getAttribute("role")).toBe("alertdialog");
    expect(popover()!.textContent).toContain(AUDIO_BUTTON_TEXT.stopQuestion);
    expect(document.activeElement).toBe(popoverButton(AUDIO_BUTTON_TEXT.keepGoing));
    popoverButton(AUDIO_BUTTON_TEXT.keepGoing).click();
    expect(popover()).toBeNull();
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);

    await click();
    // A second click on the button closes the question, as Keep downloading does.
    await click();
    expect(popover()).toBeNull();
    await click();
    popoverButton(AUDIO_BUTTON_TEXT.stop).click();
    expect(runtime.port.posted.at(-1)).toEqual({ type: "cancel" });
    expect(state()).toBe("running");
    runtime.port.deliver({ type: "error", message: "Cancelled", cancelled: true });
    expect(state()).toBe("idle");
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.idle);
    expect(toastText()).toBe(AUDIO_BUTTON_TEXT.cancelled);
    expect(toast()!.classList.contains(TOAST_ERROR_CLASS)).toBe(false);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });

  it("closes the stop question when the download ends meanwhile, and a late Stop sends nothing", async () => {
    await click();
    await click();
    const stop = popoverButton(AUDIO_BUTTON_TEXT.stop);
    runtime.port.deliver({ type: "done", path: PATH });
    expect(popover()).toBeNull();
    stop.click();
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);
    expect(state()).toBe("done");
  });

  it("fails readably when the worker goes away or the extension was reloaded", async () => {
    await click();
    runtime.port.remoteDisconnect();
    expect(state()).toBe("error");
    expect(toastText()).toBe(AUDIO_BUTTON_TEXT.failed(FLOW_TEXT.backgroundStopped));

    await click();
    runtime.lastError.mockReturnValue(INVALIDATED);
    runtime.port.remoteDisconnect();
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.error(FLOW_TEXT.reloaded));

    runtime.connect.mockImplementationOnce(() => {
      throw new Error(INVALIDATED);
    });
    await click();
    expect(state()).toBe("error");
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.error(FLOW_TEXT.reloaded));
  });

  it("says when the worker's answer is not understood", async () => {
    await click();
    runtime.port.deliver({ type: "done" });
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.error(FLOW_TEXT.badReply));
    await click();
    runtime.port.deliver({ type: "error" });
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.error(FLOW_TEXT.badReply));
  });

  it("is not started without a video id, and says why", async () => {
    playing = { ...SONG, videoId: null };
    await click();
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(toastText()).toBe("Could not tell which video is playing");
    expect(state()).toBe("idle");
  });
});

describe("state per video", () => {
  beforeEach(() => {
    addPlayerBar();
    mount();
  });

  it("follows the playing song: another song shows its own state, and the first one's again when it plays", async () => {
    await click();
    const first = runtime.port;
    first.deliver({ type: "progress", percent: 25 });
    await play(OTHER_SONG);
    expect(state()).toBe("idle");
    expect(badge().hidden).toBe(true);
    first.deliver({ type: "progress", percent: 60 });
    expect(state()).toBe("idle");

    // A download of the other song runs beside the first.
    await click();
    expect(runtime.ports).toHaveLength(2);
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: OTHER, stem: OTHER_STEM }]);
    expect(badge().hidden).toBe(true);
    runtime.port.deliver({ type: "progress", percent: 5 });
    expect(badge().textContent).toBe("5%");

    first.deliver({ type: "done", path: PATH });
    expect(toastText()).toBe(`Audio saved: ${PATH}`);
    expect(state()).toBe("running");
    expect(badge().textContent).toBe("5%");

    await play(SONG);
    expect(state()).toBe("done");
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.done(PATH));
    runtime.port.deliver({ type: "done", path: OTHER_PATH });
    expect(state()).toBe("done");
    expect(button().title).toBe(AUDIO_BUTTON_TEXT.done(PATH));
  });

  it("acts on the song playing at the click, even before a check has noticed the change", async () => {
    await click();
    runtime.port.deliver({ type: "done", path: PATH });
    // Changed, but the bar has not been rewritten yet.
    playing = { ...OTHER_SONG };
    await click();
    expect(runtime.sent).toEqual([]);
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: OTHER, stem: OTHER_STEM }]);
    expect(state()).toBe("running");
  });

  it("closes a question about the song before when the song changes", async () => {
    await click();
    await click();
    expect(popover()).not.toBeNull();
    await play(OTHER_SONG);
    expect(popover()).toBeNull();
    expect(state()).toBe("idle");
  });
});

describe("the music-video warning", () => {
  beforeEach(() => {
    addPlayerBar();
    mount();
  });

  it.each(["MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC"])("comes before a %s download: Cancel downloads nothing", async (musicVideoType) => {
    playing = { ...SONG, musicVideoType };
    await click();
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(popover()?.getAttribute("role")).toBe("alertdialog");
    expect(popover()!.querySelector("p")!.textContent).toBe(AUDIO_BUTTON_TEXT.musicVideo);
    expect([...popover()!.querySelectorAll("button")].map((element) => element.textContent)).toEqual(["Download anyway", "Cancel"]);
    expect(document.activeElement).toBe(popoverButton("Cancel"));
    popoverButton("Cancel").click();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(state()).toBe("idle");
  });

  it.each(["MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC"])("lets a %s download go ahead on Download anyway", async (musicVideoType) => {
    playing = { ...SONG, musicVideoType };
    await click();
    popoverButton("Download anyway").click();
    expect(popover()).toBeNull();
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);
    expect(state()).toBe("running");
  });

  it("closes on Esc, downloading nothing; Tab moves between its buttons", async () => {
    playing = { ...SONG, musicVideoType: "MUSIC_VIDEO_TYPE_OMV" };
    await click();
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(popoverButton("Download anyway"));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(popover()).toBeNull();
    expect(runtime.connect).not.toHaveBeenCalled();
  });

  it("comes again before a retry", async () => {
    playing = { ...SONG, musicVideoType: "MUSIC_VIDEO_TYPE_OMV" };
    await click();
    popoverButton("Download anyway").click();
    runtime.port.deliver({ type: "error", message: "yt-dlp failed (exit code 1)" });
    await click();
    expect(popover()).not.toBeNull();
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });

  it.each([ALBUM_TRACK_TYPE, null])("does not come for musicVideoType %s (album track, or unknown)", async (musicVideoType) => {
    playing = { ...SONG, musicVideoType };
    await click();
    expect(popover()).toBeNull();
    expect(runtime.port.posted).toEqual([{ type: "start", videoId: ID, stem: STEM }]);
  });
});
