// Audio downloads (PLAN.md 3.7, 3.8). A content script asks for a song's audio over an `audio`
// port; this relays the request to the native host (native-host/ytm_grabber_host.py), which runs
// yt-dlp, and relays the host's progress and final path back. It also answers audio:ping (the
// options page's Test connection) and audio:reveal (show a saved file in Explorer).
//
// One native port serves every download. It is opened by the first request and closed once the
// host owes nothing more: closing it ends the host process, which kills any yt-dlp still running,
// so it is never closed while a download runs (and while it is open, Chrome keeps this worker
// alive). Each request to the host gets its own requestId, which the host echoes in its replies;
// a reply whose requestId is unknown or already finished is dropped (the host's answer to a cancel
// that came too late, say).
//
// Where the file goes: `outputDir` is the downloadDirOverride option, else the learned download
// folder (where Chrome saved our lyrics), else none, and the host uses its fallbackOutputDir;
// `subfolder` is the per-song subfolder option (the host makes the folder).
//
// sw.ts wires chrome.runtime in; tests pass fakes (test/helpers/fakeNative.ts).

import { stemProblem } from "../shared/lyricsFiles";
import {
  isAudioPortRequest,
  NATIVE_HOST_NAME,
  type AudioPingResponse,
  type AudioPortReply,
  type AudioRevealRequest,
  type AudioRevealResponse,
  type HostPong,
  type HostRequest,
} from "../shared/messages";
import type { SettingsStore } from "../shared/settings";

const LOG_PREFIX = "[YTM Practice Grabber]";

/** Chrome's runtime.lastError texts for native messaging failures (Chromium's native messaging host code). */
export const CHROME_HOST_ERRORS = {
  notFound: "Specified native messaging host not found.",
  forbidden: "Access to the specified native messaging host is forbidden.",
  exited: "Native host has exited.",
  io: "Error when communicating with the native messaging host.",
} as const;

export const AUDIO_TEXT = {
  notInstalled: "The native host is not installed: run native-host\\install.ps1 (see the README).",
  otherExtension: (extensionId: string) => `The native host is registered for another extension ID: run install.ps1 -ExtensionId ${extensionId}.`,
  exited: "The native host stopped unexpectedly.",
  unreadable: "The native host sent something Chrome could not read.",
  badReply: "The native host sent an answer this extension does not understand.",
  /** As the host says it for a download it stopped. */
  cancelled: "Cancelled",
} as const;

// --- Seams: the slice of chrome.runtime used here ---------------------------------------------

/** A chrome.runtime.connectNative() port. */
export interface NativePortLike {
  postMessage(message: HostRequest): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export interface NativeMessagingApi {
  connectNative(application: string): NativePortLike;
  /** Resolves with the host's first reply; rejects with Chrome's runtime.lastError text. */
  sendNativeMessage(application: string, message: HostRequest): Promise<unknown>;
  /** chrome.runtime.lastError's message, read in a native port's onDisconnect. */
  lastError(): string | undefined;
}

/** The service worker's end of an `audio` port. */
export interface AudioPortLike {
  postMessage(message: AudioPortReply): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export interface AudioRelayDeps {
  native: NativeMessagingApi;
  settings: Pick<SettingsStore, "getSettings">;
  /** chrome.runtime.id, which install.ps1 must be given. */
  extensionId: string;
  /** A fresh requestId; crypto.randomUUID() by default. */
  newRequestId?: () => string;
  log?: Pick<Console, "warn">;
}

/** Bound functions: sw.ts passes them on as they are. */
export interface AudioRelay {
  /** An `audio` port from a content script: one download. */
  connect(port: AudioPortLike): void;
  /** audio:ping, through a one-shot sendNativeMessage (its own short-lived host process). */
  ping(): Promise<AudioPingResponse>;
  /** audio:reveal: the host's refusal, or ok once the host has taken it. */
  reveal(request: AudioRevealRequest): Promise<AudioRevealResponse>;
}

/** What the user is told for Chrome's `lastError` on a native port or sendNativeMessage. */
export function hostErrorText(chromeMessage: string | undefined, extensionId: string): string {
  switch (chromeMessage) {
    case CHROME_HOST_ERRORS.notFound:
      return AUDIO_TEXT.notInstalled;
    case CHROME_HOST_ERRORS.forbidden:
      return AUDIO_TEXT.otherExtension(extensionId);
    case CHROME_HOST_ERRORS.io:
      return AUDIO_TEXT.unreadable;
    case CHROME_HOST_ERRORS.exited:
    case undefined:
    case "":
      // The host closed its end without Chrome naming a reason: the same thing to the user.
      return AUDIO_TEXT.exited;
    default:
      return chromeMessage;
  }
}

// --- Host replies -------------------------------------------------------------------------------

type HostReply =
  | { type: "progress"; requestId: string; percent: number | null }
  | { type: "done"; requestId: string; path: string }
  | { type: "error"; requestId?: string; message: string; cancelled: boolean; stderrTail?: string }
  | { type: "pong"; requestId?: string; pong: HostPong };

/**
 * A host message with its fields checked, or null when it is not one. A `done` or `pong` with
 * fields missing becomes an error for its request, so the request still ends.
 */
function parseHostReply(value: unknown): HostReply | null {
  if (!isRecord(value)) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
  const badReply = { type: "error", requestId, message: AUDIO_TEXT.badReply, cancelled: false } as const;
  switch (value.type) {
    case "progress":
      return requestId === undefined ? null : { type: "progress", requestId, percent: percentOf(value.percent) };
    case "done":
      if (requestId === undefined) return null;
      return isNonEmptyString(value.path) ? { type: "done", requestId, path: value.path } : badReply;
    case "error": {
      const message = isNonEmptyString(value.message) ? value.message : AUDIO_TEXT.badReply;
      const reply: Extract<HostReply, { type: "error" }> = { type: "error", requestId, message, cancelled: value.cancelled === true };
      if (isNonEmptyString(value.stderrTail)) reply.stderrTail = value.stderrTail;
      return reply;
    }
    case "pong": {
      const pong = pongOf(value);
      return pong === null ? badReply : { type: "pong", requestId, pong };
    }
    default:
      return null;
  }
}

function percentOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function pongOf(value: Record<string, unknown>): HostPong | null {
  const { hostVersion, ytDlpVersion, ffmpegFound, problems } = value;
  if (typeof hostVersion !== "string" || typeof ffmpegFound !== "boolean") return null;
  if (ytDlpVersion !== null && typeof ytDlpVersion !== "string") return null;
  if (!Array.isArray(problems) || !problems.every((problem) => typeof problem === "string")) return null;
  return { hostVersion, ytDlpVersion, ffmpegFound, problems: [...problems] };
}

// --- The relay ------------------------------------------------------------------------------------

/** A request the host has not finished answering. */
interface Pending {
  /** A reply carrying the request's id; true when it was the last one. */
  reply(reply: HostReply): boolean;
  /** The port closed first; `message` says why, for the user. */
  closed(message: string): void;
}

/** A content port's download: being prepared (requestId null) or sent to the host. */
interface PortDownload {
  requestId: string | null;
  cancelled: boolean;
}

export function createAudioRelay({ native, settings, extensionId, newRequestId = () => crypto.randomUUID(), log = console }: AudioRelayDeps): AudioRelay {
  /** Requests sent to the host on `port`, by requestId. */
  const pending = new Map<string, Pending>();
  let port: NativePortLike | null = null;

  /** The shared port, opened when there is none. Throws only when Chrome cannot even try. */
  function openPort(): NativePortLike {
    if (port !== null) return port;
    const opened = native.connectNative(NATIVE_HOST_NAME);
    port = opened;
    opened.onMessage.addListener((message) => {
      if (port === opened) received(message);
    });
    // Chrome fires this when the host could not be started or has gone (never after our own
    // disconnect()); every request still open ends with the reason.
    opened.onDisconnect.addListener(() => {
      // Read in any case: Chrome logs a lastError nobody read.
      const reason = hostErrorText(native.lastError(), extensionId);
      if (port !== opened) return;
      port = null;
      const waiting = [...pending.values()];
      pending.clear();
      for (const entry of waiting) entry.closed(reason);
    });
    return opened;
  }

  /** Sends one request's messages; `entry` hears its replies under `requestId`. */
  function send(requestId: string, entry: Pending, messages: HostRequest[]): void {
    let target: NativePortLike;
    try {
      target = openPort();
    } catch (error) {
      entry.closed(`Could not start the native host: ${messageOf(error)}`);
      return;
    }
    pending.set(requestId, entry);
    try {
      for (const message of messages) target.postMessage(message);
    } catch (error) {
      pending.delete(requestId);
      entry.closed(hostErrorText(messageOf(error), extensionId));
      closeIfIdle();
    }
  }

  function received(message: unknown): void {
    const reply = parseHostReply(message);
    if (reply === null) {
      log.warn(`${LOG_PREFIX} audio: ignored a malformed message from the native host`);
      return;
    }
    if (reply.requestId === undefined) {
      // Only an error answers none of our requests: the host could not read one at all.
      if (reply.type === "error") log.warn(`${LOG_PREFIX} audio: the native host said: ${reply.message}`);
      return;
    }
    const entry = pending.get(reply.requestId);
    if (entry === undefined) return;
    if (entry.reply(reply)) {
      pending.delete(reply.requestId);
      closeIfIdle();
    }
  }

  function closeIfIdle(): void {
    if (pending.size > 0 || port === null) return;
    const idle = port;
    port = null;
    idle.disconnect();
  }

  function downloadEntry(post: (message: AudioPortReply) => void): Pending {
    return {
      reply(reply) {
        switch (reply.type) {
          case "progress":
            post({ type: "progress", percent: reply.percent });
            return false;
          case "done":
            post({ type: "done", path: reply.path });
            return true;
          case "error":
            if (reply.cancelled) {
              post({ type: "error", message: reply.message, cancelled: true });
            } else {
              // yt-dlp's last lines say more than the message; the console keeps them for troubleshooting.
              log.warn(`${LOG_PREFIX} audio download failed: ${reply.message}${reply.stderrTail ? `\n${reply.stderrTail}` : ""}`);
              post({ type: "error", message: reply.message });
            }
            return true;
          case "pong":
            return false;
        }
      },
      closed: (message) => post({ type: "error", message }),
    };
  }

  async function startDownload(download: PortDownload, videoId: string, stem: string, post: (message: AudioPortReply) => void): Promise<void> {
    // Refused, not changed, as for lyrics (lyricsFiles.ts): the audio must share the lyrics' stem.
    const problem = stemProblem(stem, videoId);
    if (problem !== null) {
      post({ type: "error", message: problem });
      return;
    }
    let outputDir: string;
    let subfolder: boolean;
    try {
      const current = await settings.getSettings();
      outputDir = current.downloadDirOverride || current.learnedDownloadDir;
      subfolder = current.perSongSubfolder;
    } catch (error) {
      post({ type: "error", message: `Could not read the extension's settings: ${messageOf(error)}` });
      return;
    }
    if (download.cancelled) {
      post({ type: "error", message: AUDIO_TEXT.cancelled, cancelled: true });
      return;
    }
    const requestId = newRequestId();
    download.requestId = requestId;
    send(requestId, downloadEntry(post), [{ type: "download", requestId, videoId, stem, ...(outputDir === "" ? {} : { outputDir }), subfolder }]);
  }

  function cancelDownload(download: PortDownload): void {
    download.cancelled = true;
    const { requestId } = download;
    // Not sent yet: startDownload() sees the flag. Finished: nothing to stop.
    if (requestId === null || !pending.has(requestId) || port === null) return;
    try {
      port.postMessage({ type: "cancel", requestId });
    } catch {
      // The port is going; its onDisconnect ends the download.
    }
  }

  return {
    connect(contentPort) {
      let gone = false;
      let download: PortDownload | null = null;
      const post = (message: AudioPortReply) => {
        if (gone) return;
        try {
          contentPort.postMessage(message);
        } catch {
          // Disconnected meanwhile: nobody to tell.
        }
      };
      contentPort.onMessage.addListener((message) => {
        if (!isAudioPortRequest(message)) {
          log.warn(`${LOG_PREFIX} audio: ignored a malformed message`);
          return;
        }
        if (message.type === "cancel") {
          if (download !== null) cancelDownload(download);
          return;
        }
        if (download !== null) {
          log.warn(`${LOG_PREFIX} audio: ignored a second start on one port`);
          return;
        }
        download = { requestId: null, cancelled: false };
        void startDownload(download, message.videoId, message.stem, post);
      });
      // The tab navigated or closed: the download goes on (the file lands on disk either way),
      // only its outcome is not shown.
      contentPort.onDisconnect.addListener(() => {
        gone = true;
      });
    },

    async ping() {
      let answer: unknown;
      try {
        answer = await native.sendNativeMessage(NATIVE_HOST_NAME, { type: "ping" });
      } catch (error) {
        return { ok: false, error: hostErrorText(messageOf(error), extensionId) };
      }
      const reply = parseHostReply(answer);
      if (reply?.type === "pong") return { ok: true, pong: reply.pong };
      if (reply?.type === "error") return { ok: false, error: reply.message };
      return { ok: false, error: AUDIO_TEXT.badReply };
    },

    // The host answers reveal only when it refuses, and reads its messages one at a time, in
    // order: a ping with the same requestId right after it is answered after any refusal, so
    // the first reply decides. The host shows only files in folders it saved downloads into; it
    // keeps them in a file (saved-folders.json), so a new host process, which this usually is
    // (the port closes when no download is left), knows them too.
    reveal({ path }) {
      return new Promise((resolve) => {
        const requestId = newRequestId();
        const entry: Pending = {
          reply(reply) {
            if (reply.type === "error") resolve({ ok: false, error: reply.message });
            else if (reply.type === "pong") resolve({ ok: true });
            else return false;
            return true;
          },
          closed: (message) => resolve({ ok: false, error: message }),
        };
        send(requestId, entry, [
          { type: "reveal", requestId, path },
          { type: "ping", requestId },
        ]);
      });
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
