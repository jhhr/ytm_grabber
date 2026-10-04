// What a click on the lyrics button does (PLAN.md 3.5; 3.3 steps 1-6 from the content script's side):
//
//   what is playing -> its file stem (none: say why) -> capture:get
//     a stored capture -> the menu
//     none             -> capture over the `capture` port: post `start`; on `ready` click BL's
//                         refresh button once (a real DOM event, so it reaches BL's isolated
//                         world); `done` -> the menu, `error` -> its reason
//   a menu download    -> lyrics:download -> "Saved" (and BL's offset when it is not zero), or the error
//   Re-capture         -> the capture again, whether or not one is stored
//
// One flow per page at a time: clicks while one runs change nothing (the button keeps showing
// "Capturing..."); a click on the button whose menu is open closes the menu.
//
// Without BL's refresh button, BL makes no request to capture (it serves its 7-day cache), so in
// on-demand mode the capture is not started at all: attaching would show Chrome's debugging bar
// for 30 s for nothing. In always mode the worker is already watching, so it waits for the next
// stream instead.
//
// Every Chrome API comes in through `deps`; main.ts passes the real ones. A content script outlives
// its extension: after the extension is reloaded or updated every chrome.* call here throws
// "Extension context invalidated", which becomes a sentence for the user, never an unhandled
// rejection.

import { BL_SELECTORS, parseBlOffset } from "../shared/blyrics";
import type { PlayerInfo } from "../shared/bridgeProtocol";
import { RECAPTURE_ITEM } from "../shared/lyricsItems";
import { lyricsMenu, type MenuItem } from "../shared/menuModel";
import { CAPTURE_PORT, type CapturePortRequest, type ExtensionRequest } from "../shared/messages";
import type { SettingsStore } from "../shared/settings";
import type { CaptureSummary } from "../shared/summary";
import { DOCK_BUTTON_CLASS, FLOATING_BUTTON_CLASS } from "./lyricsButton";
import { currentMenu, openMenu, type OpenMenu } from "./menu";
import { getNowPlaying, stemFor } from "./nowPlaying";
import { createToaster, pageTimers, type Timers, type Toaster } from "./toast";

/** A little over the worker's own 30 s capture limit: it should always answer first. */
export const CAPTURE_GUARD_MS = 35_000;
/** For one-shot requests (capture:get, lyrics:download), which the worker answers in well under a second. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** On the button while a capture runs. */
export const BUSY_CLASS = "pg-busy";

export const FLOW_TEXT = {
  capturing: "Capturing\u{2026}",
  noRefresh: "Turn on BL's refresh button in its dock settings, or enable Always-capture in this extension's options.",
  waitingForBl: "Waiting for Better Lyrics to load lyrics: its refresh button is off, so the capture takes the next lyrics it loads\u{2026}",
  reloaded: "The extension was reloaded: reload this tab",
  backgroundStopped: "The extension's background stopped; try again",
  noAnswer: "The extension's background did not answer; try again",
  badReply: "The extension's background sent an answer this page does not understand; reload this tab",
  saved: "Saved",
} as const;

const LOG_PREFIX = "[YTM Practice Grabber]";
/** Chrome's "Extension context invalidated." once the extension was reloaded, updated or removed. */
const INVALIDATED = /context invalidated/i;

/** The end of a chrome.runtime.Port this script holds. */
export interface CapturePortLike {
  postMessage(message: CapturePortRequest): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

/** The slice of chrome.runtime the flow uses. */
export interface RuntimeLike {
  sendMessage(message: ExtensionRequest): Promise<unknown>;
  connect(connectInfo: { name: string }): CapturePortLike;
  /** chrome.runtime.lastError's message; read in onDisconnect, where Chrome logs an unread one. */
  lastError?(): string | undefined;
}

export interface LyricsFlowDeps {
  runtime: RuntimeLike;
  /** The options (captureMode); content scripts may read chrome.storage.local. */
  settings: Pick<SettingsStore, "getSettings">;
  toaster?: Toaster;
  timers?: Timers;
  /** What is playing; nowPlaying.ts getNowPlaying() by default. */
  nowPlaying?: () => Promise<Pick<PlayerInfo, "videoId" | "title" | "author">>;
  doc?: Document;
  log?: Pick<Console, "warn">;
}

export interface LyricsFlow {
  /** The lyrics button's click handler (mountLyricsButton's onClick). */
  onClick(button: HTMLButtonElement): void;
}

/** A sentence for the user, shown as it is. */
class FlowError extends Error {}

interface Playing {
  videoId: string;
  stem: string;
}

/** "BL shows these lyrics shifted by +0.2 s; ..." for a non-zero offset in seconds. */
export function offsetNote(seconds: number): string {
  const amount = `${seconds > 0 ? "+" : "-"}${Number(Math.abs(seconds).toFixed(3))}`;
  return `BL shows these lyrics shifted by ${amount} s; the file is not shifted. In Tony use Edit \u{2192} Shift Lyrics\u{2026}`;
}

export function createLyricsFlow(deps: LyricsFlowDeps): LyricsFlow {
  const { runtime, settings } = deps;
  const doc = deps.doc ?? document;
  const timers = deps.timers ?? pageTimers;
  const toaster = deps.toaster ?? createToaster({ doc, timers });
  const nowPlaying = deps.nowPlaying ?? (() => getNowPlaying());
  const log = deps.log ?? console;
  let running = false;

  /** Runs the flow unless one is running; reports every failure, never rejects. */
  async function run(button: HTMLButtonElement, fresh: boolean): Promise<void> {
    if (running) return;
    running = true;
    try {
      await flow(button, fresh);
    } catch (error) {
      report(error);
    } finally {
      running = false;
    }
  }

  async function flow(button: HTMLButtonElement, fresh: boolean): Promise<void> {
    const playing = await whatIsPlaying();
    if (!fresh) {
      const stored = await storedCapture(playing.videoId);
      if (stored !== null) {
        showMenu(button, stored, playing);
        return;
      }
    }
    const summary = await capture(button, playing.videoId);
    if (summary === null) return;
    // The worker stores what BL fetched, which is another song when the song changed meanwhile:
    // compare with what plays now.
    const now = summary.videoId === playing.videoId ? playing : await whatIsPlaying().catch(() => playing);
    showMenu(button, summary, now);
  }

  async function whatIsPlaying(): Promise<Playing> {
    const info = await nowPlaying();
    const result = stemFor(info);
    if (result.stem === null) throw new FlowError(result.reason);
    // stemFor() names a video only when there is a video id.
    return { videoId: info.videoId!, stem: result.stem };
  }

  async function storedCapture(videoId: string): Promise<CaptureSummary | null> {
    const reply = await request({ type: "capture:get", videoId });
    if (isRecord(reply) && reply.summary === null) return null;
    if (isRecord(reply) && isSummary(reply.summary)) return reply.summary;
    throw new FlowError(FLOW_TEXT.badReply);
  }

  /** The capture's summary, or null when it was not started (the user has been told why). */
  async function capture(button: HTMLButtonElement, videoId: string): Promise<CaptureSummary | null> {
    if (doc.querySelector(BL_SELECTORS.refresh) === null && (await captureMode()) !== "always") {
      toaster.show(FLOW_TEXT.noRefresh, "error");
      return null;
    }
    const idle = showBusy(button);
    try {
      return await capturePort(videoId);
    } finally {
      idle();
    }
  }

  async function captureMode(): Promise<string> {
    try {
      return (await settings.getSettings()).captureMode;
    } catch (error) {
      throw extensionError(error);
    }
  }

  /** One capture over its own port, which is always disconnected at the end. */
  function capturePort(videoId: string): Promise<CaptureSummary> {
    return new Promise((resolve, reject) => {
      let port: CapturePortLike;
      try {
        port = runtime.connect({ name: CAPTURE_PORT });
      } catch (error) {
        reject(extensionError(error));
        return;
      }
      let settled = false;
      let clicked = false;
      const finish = (outcome: { summary: CaptureSummary } | { error: FlowError }) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(guard);
        try {
          port.disconnect();
        } catch {
          // Already gone.
        }
        if ("summary" in outcome) resolve(outcome.summary);
        else reject(outcome.error);
      };
      const guard = timers.setTimeout(() => finish({ error: new FlowError(FLOW_TEXT.noAnswer) }), CAPTURE_GUARD_MS);
      port.onMessage.addListener((message) => {
        if (settled || !isRecord(message)) return;
        switch (message.type) {
          case "ready":
            // Once: a joined capture or always mode may say it more than once.
            if (!clicked) {
              clicked = true;
              clickRefresh();
            }
            return;
          case "done":
            finish(isSummary(message.summary) ? { summary: message.summary } : { error: new FlowError(FLOW_TEXT.badReply) });
            return;
          case "error":
            finish({ error: new FlowError(typeof message.reason === "string" ? message.reason : FLOW_TEXT.badReply) });
            return;
        }
      });
      // The worker never closes the port before answering: this is the worker going away, or a
      // port Chrome could not connect (lastError says why; reading it also keeps Chrome from
      // logging it as unchecked).
      port.onDisconnect.addListener(() => {
        const lastError = runtime.lastError?.();
        const reloaded = lastError !== undefined && INVALIDATED.test(lastError);
        finish({ error: new FlowError(reloaded ? FLOW_TEXT.reloaded : FLOW_TEXT.backgroundStopped) });
      });
      try {
        port.postMessage({ type: "start", videoId });
      } catch (error) {
        finish({ error: extensionError(error) });
      }
    });
  }

  // Looked up now, not before the capture: BL may have rebuilt its controls meanwhile.
  function clickRefresh(): void {
    const refresh = doc.querySelector<HTMLElement>(BL_SELECTORS.refresh);
    if (refresh === null) toaster.show(FLOW_TEXT.waitingForBl);
    // Busy: BL is fetching already (its own click, or ours from an earlier capture), which is
    // the request the worker is waiting for.
    else if (!refresh.matches(BL_SELECTORS.refreshBusy)) refresh.click();
  }

  function showMenu(button: HTMLButtonElement, summary: CaptureSummary, playing: Playing): void {
    const anchor = button.isConnected ? button : (doc.querySelector<HTMLButtonElement>(`.${DOCK_BUTTON_CLASS}, .${FLOATING_BUTTON_CLASS}`) ?? button);
    const forPlayingVideo = summary.videoId === playing.videoId;
    const items = lyricsMenu({ summary, showingName: showingName(), forPlayingVideo });
    const menu = openMenu({
      anchor,
      items,
      onSelect(item) {
        if (item.id === RECAPTURE_ITEM) {
          menu.close();
          void run(anchor, true);
          return;
        }
        void download(menu, item, summary, forPlayingVideo ? playing.stem : null);
      },
    });
  }

  /** `playingStem`: the stem when the capture is of the playing video, else null (from the capture's metadata). */
  async function download(menu: OpenMenu, item: MenuItem, summary: CaptureSummary, playingStem: string | null): Promise<void> {
    // Files of the playing song share YTM's stem with its audio (PLAN.md 7.1); another song's
    // capture has only BL's metadata to name it by.
    const named = playingStem !== null ? { stem: playingStem } : stemFor({ videoId: summary.videoId, title: summary.metadata.song ?? null, author: summary.metadata.artist ?? null });
    if (named.stem === null) {
      toaster.show(named.reason, "error");
      return;
    }
    menu.setBusy(true);
    try {
      const reply = await request({ type: "lyrics:download", videoId: summary.videoId, itemId: item.id, stem: named.stem });
      if (!isRecord(reply) || typeof reply.ok !== "boolean") throw new FlowError(FLOW_TEXT.badReply);
      if (!reply.ok) {
        toaster.show(typeof reply.error === "string" ? reply.error : FLOW_TEXT.badReply, "error");
        return;
      }
      menu.close();
      // BL's offset belongs to the song it shows: only worth a word for that song's files.
      const offset = playingStem !== null ? blOffset() : null;
      toaster.show(offset === null ? FLOW_TEXT.saved : `${FLOW_TEXT.saved}\n${offsetNote(offset)}`);
    } catch (error) {
      report(error);
    } finally {
      menu.setBusy(false);
    }
  }

  /** Tells the user; a failure that is not one of ours also goes to the console. */
  function report(error: unknown): void {
    if (error instanceof FlowError) {
      toaster.show(error.message, "error");
      return;
    }
    log.warn(`${LOG_PREFIX} lyrics button:`, error);
    toaster.show(`Something went wrong: ${messageOf(error)}`, "error");
  }

  /** A request to the worker; its failures (and its silence) become FlowErrors. */
  function request(message: ExtensionRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => reject(new FlowError(FLOW_TEXT.noAnswer)), REQUEST_TIMEOUT_MS);
      let reply: Promise<unknown>;
      try {
        reply = Promise.resolve(runtime.sendMessage(message));
      } catch (error) {
        timers.clearTimeout(timer);
        reject(extensionError(error));
        return;
      }
      reply.then(
        (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          timers.clearTimeout(timer);
          reject(extensionError(error));
        },
      );
    });
  }

  function showingName(): string | null {
    const name = doc.querySelector(BL_SELECTORS.sourceName);
    return name === null ? null : (name.textContent ?? "").trim();
  }

  /** BL's per-song offset in seconds when it is not zero, else null. */
  function blOffset(): number | null {
    const text = doc.querySelector(BL_SELECTORS.offsetValue)?.textContent;
    const seconds = text == null ? null : parseBlOffset(text);
    return seconds === 0 ? null : seconds;
  }

  return {
    onClick(button) {
      const menu = currentMenu();
      if (menu?.anchor === button) {
        menu.close();
        return;
      }
      void run(button, false);
    },
  };
}

/** Marks the button as capturing; returns the function that ends that. */
function showBusy(button: HTMLButtonElement): () => void {
  const title = button.getAttribute("title");
  button.classList.add(BUSY_CLASS);
  button.setAttribute("aria-busy", "true");
  button.title = FLOW_TEXT.capturing;
  return () => {
    button.classList.remove(BUSY_CLASS);
    button.removeAttribute("aria-busy");
    if (title === null) button.removeAttribute("title");
    else button.title = title;
  };
}

/** What the user is told when a chrome.* call fails. */
function extensionError(error: unknown): FlowError {
  if (error instanceof FlowError) return error;
  const message = messageOf(error);
  if (INVALIDATED.test(message)) return new FlowError(FLOW_TEXT.reloaded);
  return new FlowError(`Could not reach the extension's background (${message}); try again`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enough of a summary's shape for the menu model to work on; the worker built it. */
function isSummary(value: unknown): value is CaptureSummary {
  return (
    isRecord(value) &&
    typeof value.videoId === "string" &&
    isRecord(value.metadata) &&
    Array.isArray(value.sources) &&
    Array.isArray(value.tonySkipped) &&
    (value.tonyPick === null || isRecord(value.tonyPick))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
