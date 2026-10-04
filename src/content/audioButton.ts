// The audio button (PLAN.md 3.7): one `button.pg-audio-btn` among YouTube Music's player bar
// controls. It saves the playing song's audio through the native host (yt-dlp), named with the
// same stem as the song's lyrics files (nowPlaying.ts stemFor()).
//
// Placement, as for the lyrics button (lyricsButton.ts): a MutationObserver on child lists only,
// its checks coalesced into at most one per CHECK_DELAY_MS; it watches the whole page until the
// player bar exists, then the bar's subtree and its ancestors' child lists only. YTM (and BL,
// which restyles the bar) may rebuild the controls: the one button goes back in at their end.
//
// State is per video and lives in this page: idle -> running (the percent in a badge and the
// tooltip) -> done (a check mark; the tooltip shows the file's path) or error (the tooltip and a
// toast say why). The button shows the state of the song playing now: each check asks what is
// playing (the player bar's text changes with the song) and so does each click.
//
// A click acts on the song playing at that moment:
//   idle, error -> download it; first the music-video warning when YTM says it is not the album
//                  track (a known musicVideoType other than ATV; unknown: no warning)
//   running     -> "Stop this audio download?" in a confirm popover. A popover rather than a
//                  second click, so that a stray double click never cancels a download.
//   done        -> show the file in its folder (audio:reveal; the native host decides whether)
//
// Each download runs over its own `audio` port (shared/messages.ts). When this page goes away the
// worker carries on with it; only its outcome is not shown.

import type { PlayerInfo } from "../shared/bridgeProtocol";
import { isVideoId } from "../shared/filenames";
import { AUDIO_PORT, type AudioPortRequest, type ExtensionRequest } from "../shared/messages";
import { openConfirm, type ConfirmOptions, type OpenPopover } from "./confirmPopover";
import { CHECK_DELAY_MS } from "./lyricsButton";
import { FLOW_TEXT } from "./lyricsFlow";
import { getNowPlaying, stemFor } from "./nowPlaying";
import type { Toaster } from "./toast";

export const AUDIO_BUTTON_CLASS = "pg-audio-btn";
export const AUDIO_BADGE_CLASS = "pg-audio-btn__badge";
// Unverified: verify on the live page (user check). YouTube Music's player bar and, in it, the
// row of controls on its right (volume, repeat, shuffle), at whose end the button goes.
export const AUDIO_BUTTON_PLACE = { playerBar: "ytmusic-player-bar", controls: ".right-controls-buttons" } as const;
/** YTM's musicVideoType for an album track: the audio lyrics are timed to. */
export const ALBUM_TRACK_TYPE = "MUSIC_VIDEO_TYPE_ATV";

export const AUDIO_BUTTON_TEXT = {
  idle: "Download audio (YTM Practice Grabber)",
  running: (percent: number | null) => `Downloading audio${percent === null ? "\u{2026}" : `: ${Math.floor(percent)}%`}\nClick to stop it`,
  done: (path: string) => `Audio saved: ${path}\nClick to show it in its folder`,
  error: (message: string) => `Audio download failed: ${message}\nClick to try again`,
  saved: (path: string) => `Audio saved: ${path}`,
  failed: (message: string) => `Audio download failed: ${message}`,
  cancelled: "Audio download cancelled",
  revealFailed: (message: string) => `Could not show the file: ${message}`,
  musicVideoLabel: "Music video",
  musicVideo: "This is a music video, not the album track: its audio may have an intro or outro, so lyrics timed to the album track won't line up.",
  downloadAnyway: "Download anyway",
  cancel: "Cancel",
  stopLabel: "Stop the audio download",
  stopQuestion: "Stop this audio download?",
  stop: "Stop download",
  keepGoing: "Keep downloading",
} as const;

/** Chrome's "Extension context invalidated." once the extension was reloaded, updated or removed. */
const INVALIDATED = /context invalidated/i;
const LOG_PREFIX = "[YTM Practice Grabber]";
const SVG_NS = "http://www.w3.org/2000/svg";

/** The end of an `audio` port this script holds. */
export interface AudioPortLike {
  postMessage(message: AudioPortRequest): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

/** The slice of chrome.runtime the button uses. */
export interface AudioRuntimeLike {
  sendMessage(message: ExtensionRequest): Promise<unknown>;
  connect(connectInfo: { name: string }): AudioPortLike;
  /** chrome.runtime.lastError's message; read in onDisconnect, where Chrome logs an unread one. */
  lastError?(): string | undefined;
}

export interface AudioButtonOptions {
  runtime: AudioRuntimeLike;
  /** The page's one toaster (main.ts), shared with the lyrics flow. */
  toaster: Toaster;
  /** Where the player bar is looked for: the document (default) or an element holding it. */
  root?: Document | Element;
  /** What is playing; nowPlaying.ts getNowPlaying() by default. */
  nowPlaying?: () => Promise<PlayerInfo>;
  log?: Pick<Console, "warn">;
}

export interface AudioButtonController {
  /** Removes the button and stops watching the page. */
  dispose(): void;
}

interface Running {
  kind: "running";
  /** Null until yt-dlp reports one, and while it cannot tell. */
  percent: number | null;
  port: AudioPortLike;
}

type AudioState = Running | { kind: "done"; path: string } | { kind: "error"; message: string };

/** The button's data-state. */
export type AudioButtonState = AudioState["kind"] | "idle";

export function mountAudioButton({ runtime, toaster, root = document, nowPlaying = () => getNowPlaying(), log = console }: AudioButtonOptions): AudioButtonController {
  const doc = root.ownerDocument ?? (root as Document);
  const view = createView(doc);
  const { button } = view;
  /** Downloads of this page, by video id; a video with none is idle. */
  const states = new Map<string, AudioState>();
  /** The video whose state the button shows: the one playing at the last answer. */
  let shown: string | null = null;
  let popover: OpenPopover | null = null;
  /** Answers to "what is playing?" are applied in the order asked; this is the newest applied. */
  let asked = 0;
  let applied = 0;
  let checkAsking = false;
  let checkAskAgain = false;
  let clicking = false;
  /** What the observer is set up for: the player bar and its parent then (null: none, so all of root). */
  let watched: { bar: Element | null; parent: Node | null } | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const observer = new MutationObserver(() => {
    if (checkTimer === undefined && !disposed) checkTimer = setTimeout(check, CHECK_DELAY_MS);
  });

  function check(): void {
    clearTimeout(checkTimer);
    checkTimer = undefined;
    if (disposed) return;
    const bar = root.querySelector(AUDIO_BUTTON_PLACE.playerBar);
    watch(bar);
    const controls = bar?.querySelector(AUDIO_BUTTON_PLACE.controls) ?? null;
    if (controls === null) {
      button.remove();
    } else {
      if (button.parentNode !== controls) controls.append(button);
      refreshShown();
    }
    // Every change before this check has been seen: the records left are our own.
    observer.takeRecords();
  }

  // Narrows the observer to the player bar once it exists; while it does not, all of root.
  function watch(bar: Element | null): void {
    const parent = bar?.parentNode ?? null;
    if (watched && watched.bar === bar && watched.parent === parent) return;
    observer.disconnect();
    watched = { bar, parent };
    if (!bar) {
      observer.observe(root, { childList: true, subtree: true });
      return;
    }
    observer.observe(bar, { childList: true, subtree: true });
    // The bar's own removal or replacement shows only in its ancestors' child lists.
    for (let node: Node | null = parent; node; node = node.parentNode) {
      observer.observe(node, { childList: true });
      if (node === root) break;
    }
  }

  /** Asks what is playing and shows that video's state; an older answer never overrides a newer one. */
  async function whatIsPlaying(): Promise<PlayerInfo> {
    const turn = ++asked;
    const playing = await nowPlaying();
    if (turn > applied && !disposed) {
      applied = turn;
      show(playing.videoId !== null && isVideoId(playing.videoId) ? playing.videoId : null);
    }
    return playing;
  }

  // One check's question at a time; a check meanwhile asks again once it is answered.
  function refreshShown(): void {
    if (checkAsking) {
      checkAskAgain = true;
      return;
    }
    checkAsking = true;
    whatIsPlaying()
      .catch((error: unknown) => log.warn(`${LOG_PREFIX} audio button:`, error))
      .finally(() => {
        checkAsking = false;
        if (checkAskAgain && !disposed) {
          checkAskAgain = false;
          refreshShown();
        }
      });
  }

  function show(videoId: string | null): void {
    if (videoId === shown) return;
    shown = videoId;
    // A question about the song before belongs to it.
    popover?.close();
    render();
  }

  function render(): void {
    view.render(shown === null ? undefined : states.get(shown));
  }

  /** A download's state changed kind (not its percent). */
  function setState(videoId: string, state: AudioState | undefined): void {
    if (state === undefined) states.delete(videoId);
    else states.set(videoId, state);
    if (videoId !== shown) return;
    // "Stop this download?" is moot once it has ended.
    popover?.close();
    render();
  }

  async function onClick(): Promise<void> {
    // A click on the button whose popover is open closes the popover.
    if (popover !== null) {
      popover.close();
      return;
    }
    if (clicking) return;
    clicking = true;
    let playing: PlayerInfo;
    try {
      playing = await whatIsPlaying();
    } catch (error) {
      log.warn(`${LOG_PREFIX} audio button:`, error);
      toaster.show(`Something went wrong: ${messageOf(error)}`, "error");
      return;
    } finally {
      clicking = false;
    }
    const named = stemFor(playing);
    if (named.stem === null) {
      toaster.show(named.reason, "error");
      return;
    }
    const stem = named.stem;
    // stemFor() names a video only when it has a valid id.
    const videoId = playing.videoId!;
    const state = states.get(videoId);
    if (state?.kind === "running") {
      askToStop(videoId, state);
    } else if (state?.kind === "done") {
      reveal(state.path);
    } else if (isMusicVideo(playing.musicVideoType)) {
      openPopover({
        text: AUDIO_BUTTON_TEXT.musicVideo,
        label: AUDIO_BUTTON_TEXT.musicVideoLabel,
        confirmLabel: AUDIO_BUTTON_TEXT.downloadAnyway,
        dismissLabel: AUDIO_BUTTON_TEXT.cancel,
        onConfirm: () => start(videoId, stem),
      });
    } else {
      start(videoId, stem);
    }
  }

  function askToStop(videoId: string, running: Running): void {
    openPopover({
      text: AUDIO_BUTTON_TEXT.stopQuestion,
      label: AUDIO_BUTTON_TEXT.stopLabel,
      confirmLabel: AUDIO_BUTTON_TEXT.stop,
      dismissLabel: AUDIO_BUTTON_TEXT.keepGoing,
      onConfirm() {
        // The download may have ended while the question was open.
        if (states.get(videoId) !== running) return;
        try {
          running.port.postMessage({ type: "cancel" });
        } catch {
          // The port has gone: its onDisconnect says so.
        }
      },
    });
  }

  function openPopover(options: Omit<ConfirmOptions, "anchor" | "onClose">): void {
    const opened = openConfirm({
      ...options,
      anchor: button,
      onClose: () => {
        if (popover === opened) popover = null;
      },
    });
    popover = opened;
  }

  function start(videoId: string, stem: string): void {
    if (states.get(videoId)?.kind === "running") return;
    let port: AudioPortLike;
    try {
      port = runtime.connect({ name: AUDIO_PORT });
    } catch (error) {
      fail(videoId, extensionProblem(error));
      return;
    }
    const running: Running = { kind: "running", percent: null, port };
    setState(videoId, running);
    const current = () => states.get(videoId) === running && !disposed;
    const end = () => {
      try {
        port.disconnect();
      } catch {
        // Already gone.
      }
    };
    port.onMessage.addListener((message) => {
      if (!current() || !isRecord(message)) return;
      switch (message.type) {
        case "progress":
          running.percent = typeof message.percent === "number" && Number.isFinite(message.percent) ? Math.min(100, Math.max(0, message.percent)) : null;
          if (videoId === shown) render();
          return;
        case "done":
          end();
          if (typeof message.path === "string" && message.path !== "") {
            setState(videoId, { kind: "done", path: message.path });
            toaster.show(AUDIO_BUTTON_TEXT.saved(message.path));
          } else {
            fail(videoId, FLOW_TEXT.badReply);
          }
          return;
        case "error":
          end();
          if (message.cancelled === true) {
            setState(videoId, undefined);
            toaster.show(AUDIO_BUTTON_TEXT.cancelled);
          } else {
            fail(videoId, typeof message.message === "string" && message.message !== "" ? message.message : FLOW_TEXT.badReply);
          }
          return;
      }
    });
    // The worker answers before it lets go of a port: this is the worker going away (the download
    // with it, as its native port closes) or the extension reloaded.
    port.onDisconnect.addListener(() => {
      const lastError = runtime.lastError?.();
      if (!current()) return;
      fail(videoId, lastError !== undefined && INVALIDATED.test(lastError) ? FLOW_TEXT.reloaded : FLOW_TEXT.backgroundStopped);
    });
    try {
      port.postMessage({ type: "start", videoId, stem });
    } catch (error) {
      end();
      fail(videoId, extensionProblem(error));
    }
  }

  function fail(videoId: string, message: string): void {
    setState(videoId, { kind: "error", message });
    toaster.show(AUDIO_BUTTON_TEXT.failed(message), "error");
  }

  function reveal(path: string): void {
    let reply: Promise<unknown>;
    try {
      reply = Promise.resolve(runtime.sendMessage({ type: "audio:reveal", path }));
    } catch (error) {
      toaster.show(extensionProblem(error), "error");
      return;
    }
    reply.then(
      (value) => {
        if (isRecord(value) && value.ok === true) return;
        if (isRecord(value) && value.ok === false && typeof value.error === "string") toaster.show(AUDIO_BUTTON_TEXT.revealFailed(value.error), "error");
        else toaster.show(FLOW_TEXT.badReply, "error");
      },
      (error: unknown) => toaster.show(extensionProblem(error), "error"),
    );
  }

  button.addEventListener("click", () => void onClick());
  render();
  check();
  return {
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(checkTimer);
      checkTimer = undefined;
      popover?.close();
      button.remove();
      for (const state of states.values()) {
        if (state.kind !== "running") continue;
        try {
          state.port.disconnect();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** A known type that is not the album track: an official music video (OMV), a user upload (UGC)... */
function isMusicVideo(musicVideoType: string | null): boolean {
  return musicVideoType !== null && musicVideoType !== "" && musicVideoType !== ALBUM_TRACK_TYPE;
}

// --- The button itself --------------------------------------------------------------------------

interface View {
  button: HTMLButtonElement;
  /** Shows a video's state (undefined: idle). */
  render(state: AudioState | undefined): void;
}

// Own class names only, as for the lyrics button. Built node by node (no HTML parsing). The percent
// changes the badge's text node and the attributes only, which the child-list observer ignores.
function createView(doc: Document): View {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = AUDIO_BUTTON_CLASS;
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attributes: Record<string, string> = {
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  const badge = doc.createElement("span");
  badge.className = AUDIO_BADGE_CLASS;
  badge.setAttribute("aria-hidden", "true");
  badge.hidden = true;
  const badgeText = doc.createTextNode("");
  badge.append(badgeText);
  button.append(svg, badge);

  return {
    button,
    render(state) {
      const kind: AudioButtonState = state?.kind ?? "idle";
      if (button.dataset.state !== kind) {
        button.dataset.state = kind;
        svg.replaceChildren(...ICONS[kind].map((d) => {
          const path = doc.createElementNS(SVG_NS, "path");
          path.setAttribute("d", d);
          return path;
        }));
      }
      const label = tooltip(state);
      button.title = label;
      button.setAttribute("aria-label", label);
      const percent = state?.kind === "running" && state.percent !== null ? `${Math.floor(state.percent)}%` : "";
      if (badgeText.data !== percent) badgeText.data = percent;
      badge.hidden = percent === "";
    },
  };
}

function tooltip(state: AudioState | undefined): string {
  switch (state?.kind) {
    case undefined:
      return AUDIO_BUTTON_TEXT.idle;
    case "running":
      return AUDIO_BUTTON_TEXT.running(state.percent);
    case "done":
      return AUDIO_BUTTON_TEXT.done(state.path);
    case "error":
      return AUDIO_BUTTON_TEXT.error(state.message);
  }
}

// Drawn like the lyrics button's icon (24-unit grid, 2-unit round strokes), at YTM's 24 px.
const NOTE_WITH_ARROW = ["M9.5 17a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0", "M9.5 17V5l6-1.5", "M18.5 9v9", "M15.5 15l3 3 3-3"];
const ICONS: Record<AudioButtonState, string[]> = {
  idle: NOTE_WITH_ARROW,
  running: NOTE_WITH_ARROW,
  done: ["M5 12.5l4.5 4.5L19 7.5"],
  error: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0", "M12 7.5v5", "M12 16.5h.01"],
};

/** What the user is told when a chrome.* call fails (as the lyrics flow says it). */
function extensionProblem(error: unknown): string {
  const message = messageOf(error);
  if (INVALIDATED.test(message)) return FLOW_TEXT.reloaded;
  return `Could not reach the extension's background (${message}); try again`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
