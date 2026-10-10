// @vitest-environment jsdom
// The options page: static/options.html's markup with src/options/optionsPage.ts over a fake
// chrome.storage.local and a fake chrome.runtime.sendMessage; and options.ts, the entry, wiring
// the real chrome.* names.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_TEXT } from "../src/background/audio";
import { mountOptions, OPTIONS_IDS, OPTIONS_TEXT, PING_TIMEOUT_MS, SAVED_NOTE_MS, type OptionsPage } from "../src/options/optionsPage";
import type { HostPong } from "../src/shared/messages";
import { createSettingsStore, type Settings } from "../src/shared/settings";
import { FakeStorageArea } from "./helpers/fakeStorage";

// Not `new URL(..., import.meta.url)`: in jsdom tests Vite turns that into an http: URL.
const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "static", "options.html"), "utf8");
const EXTENSION_ID = "mengelecikhhdpjdebjpokcmhdkhjobj";
const PONG: HostPong = { hostVersion: "0.1.0", ytDlpVersion: "2026.08.19", ffmpegFound: true, problems: [] };

let area: FakeStorageArea;
let page: OptionsPage | undefined;
const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>();
const warn = vi.fn();

afterEach(() => {
  page?.dispose();
  page = undefined;
  sendMessage.mockReset();
  warn.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** options.html's body, without its script, in place of this document's. */
function loadPage(): void {
  const parsed = new DOMParser().parseFromString(HTML, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  document.body.replaceWith(document.importNode(parsed.body, true));
}

function open(initial: Record<string, unknown> = {}): OptionsPage {
  area = new FakeStorageArea({ kind: "local", initial });
  loadPage();
  page = mountOptions({ settings: createSettingsStore(area), runtime: { sendMessage }, extensionId: EXTENSION_ID, log: { warn } });
  return page;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id}`);
  return element as T;
}

const input = (id: string) => byId<HTMLInputElement>(id);
const text = (id: string) => byId(id).textContent ?? "";
const note = (key: keyof Settings) => document.querySelector<HTMLElement>(`[data-saved-for="${key}"]`)!;
const stored = () => area.snapshot();
const writes = () => area.calls.filter((call) => call.method === "set").map((call) => (call.method === "set" ? call.items : {}));

/** Types into the override field (input events) and, with `commit`, leaves it (change). */
function typeOverride(value: string, commit = true): void {
  const field = input(OPTIONS_IDS.dirOverride);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  if (commit) field.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The connection result as text lines: its paragraphs, list items and "term: detail" rows. */
function connectionResult(): string[] {
  const box = byId(OPTIONS_IDS.connectionResult);
  const lines: string[] = [];
  for (const element of box.querySelectorAll("p, li, dt")) {
    if (element.tagName === "DT") lines.push(`${element.textContent}: ${element.nextElementSibling?.textContent}`);
    else lines.push(element.textContent ?? "");
  }
  return lines;
}

async function testConnection(): Promise<void> {
  byId<HTMLButtonElement>(OPTIONS_IDS.testConnection).click();
  await vi.waitFor(() => expect(byId(OPTIONS_IDS.connectionResult).dataset.state).not.toBe("testing"));
}

describe("showing the settings", () => {
  it("shows what is stored, the learned folder and the extension's ID; the controls work once it is read", async () => {
    const opened = open({
      captureMode: "always",
      perSongSubfolder: true,
      debugCapture: true,
      downloadDirOverride: "D:\\Audio",
      learnedDownloadDir: "C:\\Users\\me\\Downloads",
    });
    const controls = [OPTIONS_IDS.captureMode, OPTIONS_IDS.debugCapture, OPTIONS_IDS.perSongSubfolder, OPTIONS_IDS.dirOverride];
    expect(controls.map((id) => byId<HTMLInputElement>(id).disabled)).toEqual([true, true, true, true]);
    await opened.ready;
    expect(controls.map((id) => byId<HTMLInputElement>(id).disabled)).toEqual([false, false, false, false]);
    expect(input(OPTIONS_IDS.always).checked).toBe(true);
    expect(input(OPTIONS_IDS.onDemand).checked).toBe(false);
    expect(input(OPTIONS_IDS.debugCapture).checked).toBe(true);
    expect(input(OPTIONS_IDS.perSongSubfolder).checked).toBe(true);
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("D:\\Audio");
    expect(text(OPTIONS_IDS.learnedDir)).toBe("C:\\Users\\me\\Downloads");
    expect(text(OPTIONS_IDS.audioDir)).toBe(`D:\\Audio${OPTIONS_TEXT.perSong}`);
    expect(text(OPTIONS_IDS.extensionId)).toBe(EXTENSION_ID);
    expect(byId(OPTIONS_IDS.dirOverrideWarning).hidden).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("by default: on demand, nothing learned yet, audio to the native host's fallback folder", async () => {
    await open().ready;
    expect(input(OPTIONS_IDS.onDemand).checked).toBe(true);
    expect(input(OPTIONS_IDS.always).checked).toBe(false);
    expect(input(OPTIONS_IDS.debugCapture).checked).toBe(false);
    expect(input(OPTIONS_IDS.perSongSubfolder).checked).toBe(false);
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("");
    expect(text(OPTIONS_IDS.learnedDir)).toBe(OPTIONS_TEXT.notLearned);
    expect(byId(OPTIONS_IDS.learnedDir).dataset.learned).toBe("false");
    expect(text(OPTIONS_IDS.audioDir)).toBe(OPTIONS_TEXT.fallbackDir);
    expect(byId(OPTIONS_IDS.connectionResult).childElementCount).toBe(0);
  });

  it("has a Saved note for each setting the user chooses, and nothing else", async () => {
    await open().ready;
    const keys = [...document.querySelectorAll<HTMLElement>("[data-saved-for]")].map((element) => element.dataset.savedFor).sort();
    expect(keys).toEqual(["captureMode", "debugCapture", "downloadDirOverride", "perSongSubfolder"]);
  });

  it("follows changes made elsewhere (the worker learning the folder, another options tab), but not into a field being typed in", async () => {
    await open().ready;
    await area.set({ learnedDownloadDir: "C:\\Users\\me\\<b>Downloads</b>", captureMode: "always", perSongSubfolder: true });
    expect(text(OPTIONS_IDS.learnedDir)).toBe("C:\\Users\\me\\<b>Downloads</b>"); // text, never markup
    expect(byId(OPTIONS_IDS.learnedDir).querySelector("b")).toBeNull();
    expect(byId(OPTIONS_IDS.learnedDir).dataset.learned).toBe("true");
    expect(input(OPTIONS_IDS.always).checked).toBe(true);
    expect(input(OPTIONS_IDS.perSongSubfolder).checked).toBe(true);
    expect(text(OPTIONS_IDS.audioDir)).toBe(`C:\\Users\\me\\<b>Downloads</b>${OPTIONS_TEXT.perSong}`);

    await area.set({ downloadDirOverride: "E:\\Audio", debugCapture: true });
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("E:\\Audio");
    expect(input(OPTIONS_IDS.debugCapture).checked).toBe(true);
    await area.remove(["captureMode", "debugCapture"]); // back to the defaults
    expect(input(OPTIONS_IDS.onDemand).checked).toBe(true);
    expect(input(OPTIONS_IDS.debugCapture).checked).toBe(false);

    input(OPTIONS_IDS.dirOverride).focus();
    typeOverride("F:\\Mine", false);
    await area.set({ downloadDirOverride: "G:\\Theirs" });
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("F:\\Mine");
    expect(writes().filter((items) => "downloadDirOverride" in items && items.downloadDirOverride === "F:\\Mine")).toEqual([]);
  });
});

describe("saving", () => {
  it("saves each change at once, one setting per write, with a short Saved note", async () => {
    await open().ready;
    vi.useFakeTimers();
    input(OPTIONS_IDS.always).click();
    await vi.waitFor(() => expect(note("captureMode").textContent).toBe(OPTIONS_TEXT.saved));
    expect(stored().captureMode).toBe("always");
    vi.advanceTimersByTime(SAVED_NOTE_MS);
    expect(note("captureMode").textContent).toBe("");

    input(OPTIONS_IDS.debugCapture).click();
    await vi.waitFor(() => expect(note("debugCapture").textContent).toBe(OPTIONS_TEXT.saved));
    expect(stored().debugCapture).toBe(true);
    input(OPTIONS_IDS.perSongSubfolder).click();
    await vi.waitFor(() => expect(stored().perSongSubfolder).toBe(true));
    expect(text(OPTIONS_IDS.audioDir)).toBe(OPTIONS_TEXT.fallbackDir + OPTIONS_TEXT.perSong);
    input(OPTIONS_IDS.onDemand).click();
    await vi.waitFor(() => expect(stored().captureMode).toBe("on-demand"));
    expect(writes()).toEqual([{ captureMode: "always" }, { debugCapture: true }, { perSongSubfolder: true }, { captureMode: "on-demand" }]);
  });

  it("trims the override, stores \"\" for none, and warns about a path that is not a full folder path", async () => {
    await open({ learnedDownloadDir: "C:\\Users\\me\\Downloads" }).ready;
    const warning = byId(OPTIONS_IDS.dirOverrideWarning);

    typeOverride("  D:\\Music\\Practice  ");
    await vi.waitFor(() => expect(note("downloadDirOverride").textContent).toBe(OPTIONS_TEXT.saved));
    expect(stored().downloadDirOverride).toBe("D:\\Music\\Practice");
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("D:\\Music\\Practice");
    expect(warning.hidden).toBe(true);
    expect(text(OPTIONS_IDS.audioDir)).toBe("D:\\Music\\Practice");

    // Checked while typing, saved on commit only.
    typeOverride("Music\\Practice", false);
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe(OPTIONS_TEXT.notAbsolute);
    expect(stored().downloadDirOverride).toBe("D:\\Music\\Practice");
    typeOverride("Music\\Practice");
    // Saved anyway (it is the user's choice); the native host would use its fallback folder.
    await vi.waitFor(() => expect(stored().downloadDirOverride).toBe("Music\\Practice"));
    expect(text(OPTIONS_IDS.audioDir)).toBe(OPTIONS_TEXT.fallbackDir);

    for (const good of ["/home/me/Music", "\\\\server\\share\\Music", "C:\\"]) {
      typeOverride(good, false);
      expect(warning.hidden, good).toBe(true);
    }
    for (const bad of ["C:Music", "\\Music", "~/Music", "%USERPROFILE%\\Music"]) {
      typeOverride(bad, false);
      expect(warning.hidden, bad).toBe(false);
    }

    typeOverride("   ");
    await vi.waitFor(() => expect(stored().downloadDirOverride).toBe(""));
    expect(input(OPTIONS_IDS.dirOverride).value).toBe("");
    expect(warning.hidden).toBe(true);
    expect(text(OPTIONS_IDS.audioDir)).toBe("C:\\Users\\me\\Downloads");
  });

  it("says when a change could not be saved and shows what is stored again", async () => {
    await open({ captureMode: "on-demand" }).ready;
    area.beforeSet = () => {
      throw new Error("Resource::kQuotaBytes quota exceeded");
    };
    vi.useFakeTimers();
    input(OPTIONS_IDS.always).click();
    await vi.waitFor(() => expect(note("captureMode").textContent).toBe(OPTIONS_TEXT.notSaved("Resource::kQuotaBytes quota exceeded")));
    expect(note("captureMode").dataset.kind).toBe("error");
    await vi.waitFor(() => expect(input(OPTIONS_IDS.onDemand).checked).toBe(true));
    expect(input(OPTIONS_IDS.always).checked).toBe(false);
    vi.advanceTimersByTime(SAVED_NOTE_MS * 5);
    expect(note("captureMode").textContent).not.toBe(""); // an error stays
    expect(warn).toHaveBeenCalled();

    area.beforeSet = undefined;
    input(OPTIONS_IDS.always).click();
    await vi.waitFor(() => expect(note("captureMode").textContent).toBe(OPTIONS_TEXT.saved));
    expect(note("captureMode").dataset.kind).toBe("saved");
  });

  it("says when the settings cannot be read, and leaves the controls off", async () => {
    area = new FakeStorageArea({ kind: "local" });
    area.get = () => Promise.reject(new Error("storage is gone"));
    loadPage();
    page = mountOptions({ settings: createSettingsStore(area), runtime: { sendMessage }, extensionId: EXTENSION_ID, log: { warn } });
    await page.ready;
    expect(byId(OPTIONS_IDS.pageError).hidden).toBe(false);
    expect(text(OPTIONS_IDS.pageError)).toBe(OPTIONS_TEXT.readFailed("storage is gone"));
    expect(byId<HTMLFieldSetElement>(OPTIONS_IDS.captureMode).disabled).toBe(true);
    expect(input(OPTIONS_IDS.dirOverride).disabled).toBe(true);
  });
});

describe("Test connection", () => {
  it("asks the worker for audio:ping and shows the host's version, yt-dlp's and ffmpeg", async () => {
    await open().ready;
    let answer!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const button = byId<HTMLButtonElement>(OPTIONS_IDS.testConnection);
    button.click();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "audio:ping" });
    expect(button.disabled).toBe(true);
    expect(connectionResult()).toEqual([OPTIONS_TEXT.testing]);
    answer({ ok: true, pong: PONG });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(byId(OPTIONS_IDS.connectionResult).dataset.state).toBe("ok");
    expect(connectionResult()).toEqual([OPTIONS_TEXT.connected, "Native host: 0.1.0", "yt-dlp: 2026.08.19", "ffmpeg: found"]);
  });

  it("lists each problem the host reports", async () => {
    await open().ready;
    const problems = ["yt-dlp was not found at C:\\Tools\\yt-dlp.exe (ytDlpPath in C:\\host\\config.json)", "ffmpeg was not found at C:\\Tools\\ffmpeg (ffmpegLocation in C:\\host\\config.json)"];
    sendMessage.mockResolvedValue({ ok: true, pong: { ...PONG, ytDlpVersion: null, ffmpegFound: false, problems } });
    await testConnection();
    expect(byId(OPTIONS_IDS.connectionResult).dataset.state).toBe("problems");
    expect(connectionResult()).toEqual([OPTIONS_TEXT.connectedWithProblems, ...problems, "Native host: 0.1.0", `yt-dlp: ${OPTIONS_TEXT.ytDlpMissing}`, `ffmpeg: ${OPTIONS_TEXT.ffmpegMissing}`]);
  });

  it("shows the worker's readable error: the host is not installed, or registered for another extension", async () => {
    await open().ready;
    for (const error of [AUDIO_TEXT.notInstalled, AUDIO_TEXT.otherExtension(EXTENSION_ID)]) {
      sendMessage.mockResolvedValueOnce({ ok: false, error });
      await testConnection();
      expect(byId(OPTIONS_IDS.connectionResult).dataset.state).toBe("error");
      expect(connectionResult()).toEqual([OPTIONS_TEXT.failed(error)]);
    }
    expect(connectionResult()[0]).toContain(`install.ps1 -ExtensionId ${EXTENSION_ID}`);
  });

  it(`gives up after ${PING_TIMEOUT_MS / 1000} s, and a late answer changes nothing`, async () => {
    await open().ready;
    vi.useFakeTimers();
    let answer!: (value: unknown) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const button = byId<HTMLButtonElement>(OPTIONS_IDS.testConnection);
    button.click();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(connectionResult()).toEqual([OPTIONS_TEXT.testing]);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectionResult()).toEqual([OPTIONS_TEXT.timeout(PING_TIMEOUT_MS)]);
    expect(button.disabled).toBe(false);
    answer({ ok: true, pong: PONG });
    await vi.advanceTimersByTimeAsync(0);
    expect(connectionResult()).toEqual([OPTIONS_TEXT.timeout(PING_TIMEOUT_MS)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says when the worker cannot be reached or answers something it does not understand", async () => {
    await open().ready;
    sendMessage.mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    await testConnection();
    expect(connectionResult()).toEqual([OPTIONS_TEXT.unreachable("Could not establish connection. Receiving end does not exist.")]);
    for (const reply of [undefined, { ok: true }, { ok: true, pong: { ...PONG, problems: [1] } }, { ok: true, pong: { ...PONG, hostVersion: 1 } }, { ok: false }, "pong"]) {
      sendMessage.mockResolvedValueOnce(reply);
      await testConnection();
      expect(connectionResult(), JSON.stringify(reply)).toEqual([OPTIONS_TEXT.badReply]);
    }
  });
});

describe("options.ts", () => {
  it("wires chrome.storage.local and chrome.runtime into the page", async () => {
    const local = new FakeStorageArea({ kind: "local", initial: { learnedDownloadDir: "C:\\dl", captureMode: "always" } });
    const send = vi.fn(async () => ({ ok: true, pong: PONG }));
    vi.stubGlobal("chrome", { storage: { local }, runtime: { id: EXTENSION_ID, sendMessage: send } });
    loadPage();
    vi.resetModules();
    await import("../src/options/options");
    await vi.waitFor(() => expect(text(OPTIONS_IDS.learnedDir)).toBe("C:\\dl"));
    expect(input(OPTIONS_IDS.always).checked).toBe(true);
    expect(text(OPTIONS_IDS.extensionId)).toBe(EXTENSION_ID);
    input(OPTIONS_IDS.perSongSubfolder).click();
    await vi.waitFor(() => expect(local.snapshot().perSongSubfolder).toBe(true));
    await testConnection();
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "audio:ping" });
    expect(connectionResult()[0]).toBe(OPTIONS_TEXT.connected);
  });

  it("reports a page whose markup does not match instead of throwing", async () => {
    vi.stubGlobal("chrome", { storage: { local: new FakeStorageArea({ kind: "local" }) }, runtime: { id: EXTENSION_ID, sendMessage } });
    loadPage();
    byId(OPTIONS_IDS.audioDir).remove();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    await import("../src/options/options");
    expect(error).toHaveBeenCalledWith("[YTM Practice Grabber] options page:", expect.objectContaining({ message: `options.html has no #${OPTIONS_IDS.audioDir}` }));
  });
});
