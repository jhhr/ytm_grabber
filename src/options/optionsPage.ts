// The options page (PLAN.md 3.9): the settings the user chooses (settings.ts), the download folder
// the extension learned, with an override for audio, and Test connection, which asks the native
// host for its versions through the service worker (audio:ping).
//
// The markup is static/options.html; this finds its controls by id and keeps them in step with
// chrome.storage.local both ways. A control's change is saved at once, one setting per write, with
// a short "Saved" next to it; a change made elsewhere (the worker learning the download folder,
// the page open in another tab) shows here. The override text field is saved when it is committed
// (Enter, or leaving the field), trimmed, "" meaning none; it is checked as it is typed.
//
// The worker puts no time limit on a ping (the host's own `yt-dlp --version` takes up to 10 s), so
// this page gives up after PING_TIMEOUT_MS. options.ts wires in chrome.*; tests pass fakes.

import { pageTimers, type Timers } from "../content/toast";
import { isAbsoluteFolderPath } from "../shared/downloadDir";
import type { AudioPingRequest, HostPong } from "../shared/messages";
import type { CaptureMode, Settings, SettingsStore } from "../shared/settings";

export const PING_TIMEOUT_MS = 15_000;
/** How long "Saved" shows next to a control. */
export const SAVED_NOTE_MS = 2_000;

export const OPTIONS_TEXT = {
  notLearned: "not learned yet \u{2014} download a lyrics file once",
  saved: "Saved",
  notSaved: (message: string) => `Not saved: ${message}`,
  readFailed: (message: string) => `Could not read the settings: ${message}`,
  notAbsolute:
    "This is not a full folder path (such as C:\\Users\\you\\Music): the native host will not use it and saves audio in its fallbackOutputDir (config.json) instead.",
  fallbackDir: "the native host's fallbackOutputDir (config.json)",
  perSong: " \u{2014} in a folder for each song",
  testing: "Asking the native host\u{2026}",
  connected: "The native host answers.",
  connectedWithProblems: "The native host answers, but reports problems:",
  hostVersion: "Native host",
  ytDlp: "yt-dlp",
  ytDlpMissing: "not working",
  ffmpeg: "ffmpeg",
  ffmpegFound: "found",
  ffmpegMissing: "not found",
  failed: (message: string) => `Test failed: ${message}`,
  timeout: (ms: number) => `No answer within ${Math.round(ms / 1000)} seconds: the native host may be stuck. Try again.`,
  unreachable: (message: string) => `Could not reach the extension's background (${message}); reload this page and try again.`,
  badReply: "The extension's background sent an answer this page does not understand.",
} as const;

/** The element ids options.html must have. */
export const OPTIONS_IDS = {
  pageError: "page-error",
  captureMode: "capture-mode",
  onDemand: "capture-on-demand",
  always: "capture-always",
  debugCapture: "debug-capture",
  perSongSubfolder: "per-song-subfolder",
  learnedDir: "learned-dir",
  dirOverride: "dir-override",
  dirOverrideWarning: "dir-override-warning",
  audioDir: "audio-dir",
  extensionId: "extension-id",
  testConnection: "test-connection",
  connectionResult: "connection-result",
} as const;

/** The slice of chrome.runtime the page uses. */
export interface OptionsRuntime {
  sendMessage(message: AudioPingRequest): Promise<unknown>;
}

export interface OptionsDeps {
  settings: SettingsStore;
  runtime: OptionsRuntime;
  /** chrome.runtime.id: install.ps1 must be given it. */
  extensionId: string;
  doc?: Document;
  timers?: Timers;
  pingTimeoutMs?: number;
  log?: Pick<Console, "warn">;
}

export interface OptionsPage {
  /** Settles once the stored settings are shown (or the failure to read them). */
  ready: Promise<void>;
  /** Stops following changes made elsewhere. */
  dispose(): void;
}

type EditableKey = "captureMode" | "debugCapture" | "perSongSubfolder" | "downloadDirOverride";

type PingOutcome = { pong: HostPong } | { error: string };

export function mountOptions({ settings, runtime, extensionId, doc = document, timers = pageTimers, pingTimeoutMs = PING_TIMEOUT_MS, log = console }: OptionsDeps): OptionsPage {
  const byId = <T extends HTMLElement>(id: string): T => {
    const element = doc.getElementById(id);
    if (element === null) throw new Error(`options.html has no #${id}`);
    return element as T;
  };
  const el = {
    pageError: byId<HTMLElement>(OPTIONS_IDS.pageError),
    captureMode: byId<HTMLFieldSetElement>(OPTIONS_IDS.captureMode),
    onDemand: byId<HTMLInputElement>(OPTIONS_IDS.onDemand),
    always: byId<HTMLInputElement>(OPTIONS_IDS.always),
    debugCapture: byId<HTMLInputElement>(OPTIONS_IDS.debugCapture),
    perSongSubfolder: byId<HTMLInputElement>(OPTIONS_IDS.perSongSubfolder),
    learnedDir: byId<HTMLElement>(OPTIONS_IDS.learnedDir),
    dirOverride: byId<HTMLInputElement>(OPTIONS_IDS.dirOverride),
    dirOverrideWarning: byId<HTMLElement>(OPTIONS_IDS.dirOverrideWarning),
    audioDir: byId<HTMLElement>(OPTIONS_IDS.audioDir),
    extensionId: byId<HTMLElement>(OPTIONS_IDS.extensionId),
    testConnection: byId<HTMLButtonElement>(OPTIONS_IDS.testConnection),
    connectionResult: byId<HTMLElement>(OPTIONS_IDS.connectionResult),
  };
  const notes = new Map<EditableKey, { element: HTMLElement; timer: unknown }>();
  for (const element of doc.querySelectorAll<HTMLElement>("[data-saved-for]")) {
    notes.set(element.dataset.savedFor as EditableKey, { element, timer: undefined });
  }
  const editable = [el.captureMode, el.debugCapture, el.perSongSubfolder, el.dirOverride];

  /** What storage holds, as far as this page knows. */
  let current: Settings | null = null;
  let disposed = false;
  /** Each Test connection click; a late answer to an earlier one is dropped. */
  let pings = 0;

  el.extensionId.textContent = extensionId;

  // --- Showing the settings ---

  function show(changed: Partial<Settings>): void {
    if (current === null) return;
    Object.assign(current, changed);
    if (changed.captureMode !== undefined) {
      el.onDemand.checked = current.captureMode === "on-demand";
      el.always.checked = current.captureMode === "always";
    }
    if (changed.debugCapture !== undefined) el.debugCapture.checked = current.debugCapture;
    if (changed.perSongSubfolder !== undefined) el.perSongSubfolder.checked = current.perSongSubfolder;
    // Not while the user is typing in it: the field is saved when they leave it.
    if (changed.downloadDirOverride !== undefined && doc.activeElement !== el.dirOverride) {
      el.dirOverride.value = current.downloadDirOverride;
      showOverrideWarning();
    }
    if (changed.learnedDownloadDir !== undefined) {
      const learned = current.learnedDownloadDir;
      el.learnedDir.textContent = learned === "" ? OPTIONS_TEXT.notLearned : learned;
      el.learnedDir.dataset.learned = String(learned !== "");
    }
    showAudioDir();
  }

  /** Where the worker sends audio (audio.ts): the override, else the learned folder, else the host's fallback. */
  function showAudioDir(): void {
    if (current === null) return;
    const chosen = current.downloadDirOverride || current.learnedDownloadDir;
    // A folder the host cannot use sends audio to its fallbackOutputDir instead.
    const where = chosen !== "" && isAbsoluteFolderPath(chosen) ? chosen : OPTIONS_TEXT.fallbackDir;
    el.audioDir.textContent = where + (current.perSongSubfolder ? OPTIONS_TEXT.perSong : "");
  }

  function showOverrideWarning(): void {
    const value = el.dirOverride.value.trim();
    const problem = value !== "" && !isAbsoluteFolderPath(value);
    el.dirOverrideWarning.textContent = problem ? OPTIONS_TEXT.notAbsolute : "";
    el.dirOverrideWarning.hidden = !problem;
  }

  function note(key: EditableKey, text: string, kind: "saved" | "error"): void {
    const entry = notes.get(key);
    if (entry === undefined) return;
    timers.clearTimeout(entry.timer);
    entry.element.textContent = text;
    entry.element.dataset.kind = kind;
    // An error stays until the next change; "Saved" goes by itself.
    entry.timer = kind === "saved" ? timers.setTimeout(() => (entry.element.textContent = ""), SAVED_NOTE_MS) : undefined;
  }

  // --- Saving ---

  async function save<K extends EditableKey>(key: K, value: Settings[K]): Promise<void> {
    try {
      await settings.setSettings({ [key]: value } as Partial<Settings>);
      note(key, OPTIONS_TEXT.saved, "saved");
    } catch (error) {
      log.warn("[YTM Practice Grabber] options: saving failed:", error);
      note(key, OPTIONS_TEXT.notSaved(messageOf(error)), "error");
      // Show what is stored again rather than a choice that was not kept.
      try {
        const stored = await settings.getSettings();
        if (current !== null && !disposed) show({ [key]: stored[key] } as Partial<Settings>);
      } catch {
        // The note says enough.
      }
    }
  }

  function onCaptureModeChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.checked) void save("captureMode", input.value as CaptureMode);
  }
  el.onDemand.addEventListener("change", onCaptureModeChange);
  el.always.addEventListener("change", onCaptureModeChange);
  el.debugCapture.addEventListener("change", () => void save("debugCapture", el.debugCapture.checked));
  el.perSongSubfolder.addEventListener("change", () => {
    if (current !== null) current.perSongSubfolder = el.perSongSubfolder.checked;
    showAudioDir();
    void save("perSongSubfolder", el.perSongSubfolder.checked);
  });
  el.dirOverride.addEventListener("input", showOverrideWarning);
  el.dirOverride.addEventListener("change", () => {
    const value = el.dirOverride.value.trim();
    el.dirOverride.value = value;
    showOverrideWarning();
    if (current !== null) current.downloadDirOverride = value;
    showAudioDir();
    void save("downloadDirOverride", value);
  });

  // --- Test connection ---

  async function ping(): Promise<PingOutcome> {
    let timer: unknown;
    const timeout = new Promise<PingOutcome>((resolve) => {
      timer = timers.setTimeout(() => resolve({ error: OPTIONS_TEXT.timeout(pingTimeoutMs) }), pingTimeoutMs);
    });
    const answer = (async (): Promise<PingOutcome> => {
      let reply: unknown;
      try {
        reply = await runtime.sendMessage({ type: "audio:ping" });
      } catch (error) {
        return { error: OPTIONS_TEXT.unreachable(messageOf(error)) };
      }
      if (isRecord(reply) && reply.ok === true) {
        const pong = pongOf(reply.pong);
        return pong === null ? { error: OPTIONS_TEXT.badReply } : { pong };
      }
      if (isRecord(reply) && reply.ok === false && typeof reply.error === "string" && reply.error !== "") return { error: OPTIONS_TEXT.failed(reply.error) };
      return { error: OPTIONS_TEXT.badReply };
    })();
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  el.testConnection.addEventListener("click", () => {
    const attempt = ++pings;
    el.testConnection.disabled = true;
    el.connectionResult.dataset.state = "testing";
    el.connectionResult.replaceChildren(paragraph(OPTIONS_TEXT.testing));
    void ping().then((outcome) => {
      if (attempt !== pings || disposed) return;
      el.testConnection.disabled = false;
      showPing(outcome);
    });
  });

  function showPing(outcome: PingOutcome): void {
    const box = el.connectionResult;
    if ("error" in outcome) {
      box.dataset.state = "error";
      box.replaceChildren(paragraph(outcome.error, "status-problem"));
      return;
    }
    const { pong } = outcome;
    const problems = pong.problems.length > 0;
    box.dataset.state = problems ? "problems" : "ok";
    const list = doc.createElement("dl");
    const rows: [string, string][] = [
      [OPTIONS_TEXT.hostVersion, pong.hostVersion],
      [OPTIONS_TEXT.ytDlp, pong.ytDlpVersion ?? OPTIONS_TEXT.ytDlpMissing],
      [OPTIONS_TEXT.ffmpeg, pong.ffmpegFound ? OPTIONS_TEXT.ffmpegFound : OPTIONS_TEXT.ffmpegMissing],
    ];
    for (const [name, value] of rows) {
      const term = doc.createElement("dt");
      term.textContent = name;
      const detail = doc.createElement("dd");
      detail.textContent = value;
      list.append(term, detail);
    }
    const children: Node[] = [paragraph(problems ? OPTIONS_TEXT.connectedWithProblems : OPTIONS_TEXT.connected, problems ? "status-problem" : "status-ok")];
    if (problems) {
      const items = doc.createElement("ul");
      for (const problem of pong.problems) {
        const item = doc.createElement("li");
        item.textContent = problem;
        items.append(item);
      }
      children.push(items);
    }
    children.push(list);
    box.replaceChildren(...children);
  }

  function paragraph(text: string, className?: string): HTMLParagraphElement {
    const element = doc.createElement("p");
    element.textContent = text;
    if (className !== undefined) element.className = className;
    return element;
  }

  // --- Start ---

  // Subscribed before the first read, so a change made meanwhile is not missed; until the read
  // is shown, show() ignores changes (the read then has them).
  const unsubscribe = settings.onSettingsChanged((changed) => {
    if (!disposed) show(changed);
  });
  const ready = settings.getSettings().then(
    (stored) => {
      if (disposed) return;
      current = { ...stored };
      show(stored);
      for (const control of editable) control.disabled = false;
    },
    (error: unknown) => {
      log.warn("[YTM Practice Grabber] options: reading the settings failed:", error);
      el.pageError.textContent = OPTIONS_TEXT.readFailed(messageOf(error));
      el.pageError.hidden = false;
    },
  );

  return {
    ready,
    dispose() {
      disposed = true;
      unsubscribe();
      for (const entry of notes.values()) timers.clearTimeout(entry.timer);
    },
  };
}

function pongOf(value: unknown): HostPong | null {
  if (!isRecord(value)) return null;
  const { hostVersion, ytDlpVersion, ffmpegFound, problems } = value;
  if (typeof hostVersion !== "string" || typeof ffmpegFound !== "boolean") return null;
  if (ytDlpVersion !== null && typeof ytDlpVersion !== "string") return null;
  if (!Array.isArray(problems) || !problems.every((problem) => typeof problem === "string")) return null;
  return { hostVersion, ytDlpVersion, ffmpegFound, problems: [...problems] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
