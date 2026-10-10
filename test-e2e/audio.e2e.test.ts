// End to end (B11): the audio button and the options page with the REAL native host
// (native-host/ytm_grabber_host.py, a copy) registered for the test profile, running the fake
// yt-dlp of the host's own tests (nativeHost.ts; the video id's first four letters pick what the
// fake does: "wait" until released, "okay" at once, "slow" until killed). Linux Chromium finds
// the host through <user-data-dir>/NativeMessagingHosts/, as Windows Chrome does through the
// registry. The tests run in order in one browser and build on each other.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AUDIO_TEXT } from "../src/background/audio";
import { AUDIO_BADGE_CLASS, AUDIO_BUTTON_CLASS, AUDIO_BUTTON_TEXT } from "../src/content/audioButton";
import { POPOVER_CLASS } from "../src/content/confirmPopover";
import { OPTIONS_IDS, OPTIONS_TEXT } from "../src/options/optionsPage";
import { buildStem } from "../src/shared/filenames";
import { openWatchPage } from "./browser";
import {
  chooseMenuItem,
  clearToast,
  getSettings,
  openLyricsMenu,
  recordPageConsole,
  recordWorkerConsole,
  sleep,
  startE2e,
  stopE2e,
  waitForFile,
  waitForToast,
  workerConsole,
  type E2e,
} from "./harness";
import { installTestHost, processAlive, type TestHost } from "./nativeHost";

/** The extension's fixed ID (the manifest's key), which install.ps1 is given. */
const EXTENSION_ID = "mengelecikhhdpjdebjpokcmhdkhjobj";
const HOST_VERSION = /^HOST_VERSION = "([^"]+)"$/m.exec(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native-host", "ytm_grabber_host.py"), "utf8"),
)![1];
const ARTIST = "Marrow & Tin";

interface Song {
  videoId: string;
  title: string;
  musicVideoType?: string;
}

// The album track: its lyrics are downloaded first, then its audio. Non-ASCII on purpose: the
// name goes through yt-dlp's argv and back in the host's ASCII-escaped JSON.
const ALBUM_TRACK: Song = { videoId: "waitAudio01", title: "Northbound Kites (Live at Caf\u{E9} Nord)" };
const MUSIC_VIDEO: Song = { videoId: "okayMusicVd", title: "Northbound Kites (Official Video)", musicVideoType: "MUSIC_VIDEO_TYPE_OMV" };
const SLOW: Song = { videoId: "slowAudio01", title: "Paper Weather" };
const NO_HOST: Song = { videoId: "okayNoHost1", title: "Lantern Rain" };

const stem = (song: Song) => buildStem({ artist: ARTIST, title: song.title, videoId: song.videoId });

let e2e: E2e;
let host: TestHost;
let page: Page;
let pageConsole: string[];
let downloadDir: string;
/** Chrome's download folder as the extension learned it from the lyrics download. */
let learnedDir = "";

beforeAll(async () => {
  e2e = await startE2e();
  ({ downloadDir } = e2e.browser);
  host = installTestHost({ work: e2e.work, userDataDir: e2e.browser.userDataDir, extensionId: e2e.browser.extensionId });
  await recordWorkerConsole(e2e.browser.sw);
  page = e2e.browser.context.pages()[0] ?? (await e2e.browser.context.newPage());
  pageConsole = recordPageConsole(page);
});

afterAll(async () => {
  await stopE2e(e2e);
});

// --- Helpers --------------------------------------------------------------------------------------

async function waitUntil<T>(probe: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function waitUntilAsync<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function open(song: Song): Promise<void> {
  await openWatchPage(page, song.videoId, { title: song.title, artist: ARTIST, ...(song.musicVideoType ? { musicVideoType: song.musicVideoType } : {}) });
  await waitForState("idle");
}

const AUDIO_BUTTON = `ytmusic-player-bar .right-controls-buttons > button.${AUDIO_BUTTON_CLASS}`;

async function waitForState(state: string, timeoutMs = 15_000): Promise<void> {
  await page.waitForSelector(`${AUDIO_BUTTON}[data-state="${state}"]`, { timeout: timeoutMs });
}

async function buttonTitle(): Promise<string | null> {
  return page.getAttribute(AUDIO_BUTTON, "title");
}

/** The confirm popover's sentence once it is open. */
async function popoverText(): Promise<string> {
  await page.waitForSelector(`.${POPOVER_CLASS}`, { state: "visible" });
  return (await page.textContent(`.${POPOVER_CLASS}__text`)) ?? "";
}

async function choose(label: string): Promise<void> {
  await page.locator(`.${POPOVER_CLASS}`).getByRole("button", { name: label, exact: true }).click();
  await page.waitForSelector(`.${POPOVER_CLASS}`, { state: "detached" });
}

async function openOptions(): Promise<Page> {
  const options = await e2e.browser.context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await options.waitForSelector(`#${OPTIONS_IDS.dirOverride}:not([disabled])`);
  return options;
}

/** Clicks Test connection and returns the result as text lines ("term: detail" for the version rows). */
async function testConnection(options: Page): Promise<string[]> {
  await options.click(`#${OPTIONS_IDS.testConnection}`);
  await options.waitForFunction(
    (id) => {
      const state = document.getElementById(id)?.dataset.state;
      return state !== undefined && state !== "testing";
    },
    OPTIONS_IDS.connectionResult,
    { timeout: 20_000 },
  );
  return options.$$eval(`#${OPTIONS_IDS.connectionResult} p, #${OPTIONS_IDS.connectionResult} li, #${OPTIONS_IDS.connectionResult} dt`, (elements) =>
    elements.map((element) => (element.tagName === "DT" ? `${element.textContent}: ${element.nextElementSibling?.textContent}` : (element.textContent ?? ""))),
  );
}

// --- Scenarios ------------------------------------------------------------------------------------

test("the audio button is in the player bar; on an album track it shows progress, then saves <stem>.<ext> in the folder of a lyrics file downloaded first", async () => {
  await open(ALBUM_TRACK);
  expect(await page.locator(`.${AUDIO_BUTTON_CLASS}`).count()).toBe(1);
  expect(await page.isVisible(AUDIO_BUTTON)).toBe(true);
  expect(await buttonTitle()).toBe(AUDIO_BUTTON_TEXT.idle);

  // A lyrics file first: the extension learns Chrome's download folder from it (PLAN.md 3.6).
  await openLyricsMenu(page);
  await chooseMenuItem(page, "tony");
  const lyricsFile = path.join(downloadDir, `${stem(ALBUM_TRACK)}.ttml`);
  await waitForFile(lyricsFile);
  learnedDir = await waitUntilAsync(async () => {
    const value = (await getSettings(e2e.browser.sw)).learnedDownloadDir;
    return typeof value === "string" && value !== "" ? value : null;
  }, "the learned download folder");
  expect(realpathSync(learnedDir)).toBe(realpathSync(downloadDir));

  await clearToast(page);
  const hostsBefore = host.hostPids().length;
  await page.click(AUDIO_BUTTON);
  // yt-dlp's progress, relayed host -> worker -> tab: the "wait" fake says 5 % and waits.
  await page.waitForSelector(`${AUDIO_BUTTON}[data-state="running"] .${AUDIO_BADGE_CLASS}:not([hidden])`);
  expect(await page.textContent(`.${AUDIO_BADGE_CLASS}`)).toBe("5%");
  expect(await buttonTitle()).toBe(AUDIO_BUTTON_TEXT.running(5));
  host.release(ALBUM_TRACK.videoId);
  await waitForState("done");

  const audioFile = path.join(learnedDir, `${stem(ALBUM_TRACK)}.m4a`);
  expect(readFileSync(audioFile, "utf8")).toBe("fake audio");
  expect(readdirSync(downloadDir).sort()).toEqual([`${stem(ALBUM_TRACK)}.m4a`, `${stem(ALBUM_TRACK)}.ttml`]);
  // The worker passed the learned folder as outputDir; the host's fallback folder stayed empty.
  const argv = host.argv(ALBUM_TRACK.videoId)!;
  expect(argv[argv.indexOf("-P") + 1]).toBe(learnedDir);
  expect(argv[argv.indexOf("-o") + 1]).toBe(`${stem(ALBUM_TRACK)}.%(ext)s`);
  expect(argv.slice(-2)).toEqual(["--", ALBUM_TRACK.videoId]);
  expect(readdirSync(host.fallbackDir)).toEqual([]);
  expect(await buttonTitle()).toBe(AUDIO_BUTTON_TEXT.done(audioFile));
  expect(await waitForToast(page, /^Audio saved/)).toBe(AUDIO_BUTTON_TEXT.saved(audioFile));
  expect(host.hostPids()).toHaveLength(hostsBefore + 1);
});

test("the check mark asks a new host process to show the file: on Linux it gets as far as \"Windows only\", so the saved-folder check passed", async () => {
  const pids = host.hostPids();
  // The worker closed its idle native port after "done", which ended that host process.
  await waitUntil(() => !processAlive(pids.at(-1)!), "the download's host process to exit");
  expect(host.savedFolders()).toEqual([realpathSync(learnedDir)]);

  await clearToast(page);
  await page.click(AUDIO_BUTTON);
  expect(await waitForToast(page, /^Could not show the file/)).toBe(AUDIO_BUTTON_TEXT.revealFailed("Showing a file in its folder works on Windows only"));
  // Another process answered it (the host refuses before "Windows only" for any other folder).
  expect(host.hostPids()).toHaveLength(pids.length + 1);
  await waitForState("done");
});

test("a music video gets the warning first: Cancel downloads nothing, Download anyway downloads", async () => {
  await open(MUSIC_VIDEO);
  const hosts = host.hostPids().length;
  await page.click(AUDIO_BUTTON);
  expect(await popoverText()).toBe(AUDIO_BUTTON_TEXT.musicVideo);
  await choose(AUDIO_BUTTON_TEXT.cancel);
  await sleep(500);
  expect(await page.getAttribute(AUDIO_BUTTON, "data-state")).toBe("idle");
  expect(host.hostPids()).toHaveLength(hosts);
  expect(host.argv(MUSIC_VIDEO.videoId)).toBeNull();

  await page.click(AUDIO_BUTTON);
  expect(await popoverText()).toBe(AUDIO_BUTTON_TEXT.musicVideo);
  await choose(AUDIO_BUTTON_TEXT.downloadAnyway);
  await waitForState("done");
  expect(readFileSync(path.join(learnedDir, `${stem(MUSIC_VIDEO)}.m4a`), "utf8")).toBe("fake audio");
});

test("Stop download while yt-dlp runs: cancelled, yt-dlp ends, and no audio file is left (only yt-dlp's .part)", async () => {
  await open(SLOW);
  await page.click(AUDIO_BUTTON);
  await page.waitForSelector(`${AUDIO_BUTTON}[data-state="running"] .${AUDIO_BADGE_CLASS}:not([hidden])`);
  expect(await page.textContent(`.${AUDIO_BADGE_CLASS}`)).toBe("1%");
  const [fake] = await waitUntil(() => host.fakePids(SLOW.videoId), "the slow fake's pid");
  expect(processAlive(fake)).toBe(true);

  await clearToast(page);
  await page.click(AUDIO_BUTTON);
  expect(await popoverText()).toBe(AUDIO_BUTTON_TEXT.stopQuestion);
  await choose(AUDIO_BUTTON_TEXT.stop);
  expect(await waitForToast(page, /cancelled/)).toBe(AUDIO_BUTTON_TEXT.cancelled);
  await waitForState("idle");
  await waitUntil(() => !processAlive(fake), "the slow fake to be killed", 5_000);
  expect(readdirSync(learnedDir).filter((name) => name.startsWith(stem(SLOW)))).toEqual([`${stem(SLOW)}.m4a.part`]);
});

test("options: the learned folder, settings saved on change, and Test connection with the host's and the fake yt-dlp's versions, in light and dark", async () => {
  const options = await openOptions();
  expect(await options.textContent(`#${OPTIONS_IDS.learnedDir}`)).toBe(learnedDir);
  expect(await options.textContent(`#${OPTIONS_IDS.audioDir}`)).toBe(learnedDir);
  expect(await options.textContent(`#${OPTIONS_IDS.extensionId}`)).toBe(EXTENSION_ID);

  expect(await testConnection(options)).toEqual([OPTIONS_TEXT.connected, `Native host: ${HOST_VERSION}`, "yt-dlp: 2099.01.01-fake", `ffmpeg: ${OPTIONS_TEXT.ffmpegFound}`]);

  // Saved through the real chrome.storage.local, where the worker reads it.
  await options.click(`#${OPTIONS_IDS.perSongSubfolder}`);
  await options.waitForSelector(`[data-saved-for="perSongSubfolder"]:text("${OPTIONS_TEXT.saved}")`);
  expect((await getSettings(e2e.browser.sw)).perSongSubfolder).toBe(true);
  await options.fill(`#${OPTIONS_IDS.dirOverride}`, "  Music  ");
  await options.press(`#${OPTIONS_IDS.dirOverride}`, "Enter");
  await options.waitForSelector(`#${OPTIONS_IDS.dirOverrideWarning}:not([hidden])`);
  await waitUntilAsync(async () => (await getSettings(e2e.browser.sw)).downloadDirOverride === "Music", "the override to be saved");
  await options.fill(`#${OPTIONS_IDS.dirOverride}`, "");
  await options.press(`#${OPTIONS_IDS.dirOverride}`, "Enter");
  await options.click(`#${OPTIONS_IDS.perSongSubfolder}`);
  await waitUntilAsync(async () => {
    const settings = await getSettings(e2e.browser.sw);
    return settings.downloadDirOverride === "" && settings.perSongSubfolder === false;
  }, "the settings to be back");

  // The page follows the system's colour scheme.
  const background = () => options.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await options.emulateMedia({ colorScheme: "light" });
  const light = await background();
  await options.emulateMedia({ colorScheme: "dark" });
  const dark = await background();
  expect([light, dark]).toEqual(["rgb(246, 246, 247)", "rgb(22, 22, 24)"]);
  if (process.env.E2E_OPTIONS_SCREENSHOT) {
    for (const scheme of ["light", "dark"] as const) {
      await options.emulateMedia({ colorScheme: scheme });
      await options.screenshot({ path: process.env.E2E_OPTIONS_SCREENSHOT.replace(/(\.png)?$/, `-${scheme}.png`), fullPage: true });
    }
  }
  await options.close();
});

test("with the host's manifest removed, Test connection and the audio button say the native host is not installed", async () => {
  host.unregister();
  const options = await openOptions();
  expect(await testConnection(options)).toEqual([OPTIONS_TEXT.failed(AUDIO_TEXT.notInstalled)]);
  await options.close();

  const hosts = host.hostPids().length;
  await open(NO_HOST);
  await clearToast(page);
  await page.click(AUDIO_BUTTON);
  expect(await waitForToast(page, /^Audio download failed/)).toBe(AUDIO_BUTTON_TEXT.failed(AUDIO_TEXT.notInstalled));
  await waitForState("error");
  expect(await buttonTitle()).toBe(AUDIO_BUTTON_TEXT.error(AUDIO_TEXT.notInstalled));
  expect(host.hostPids()).toHaveLength(hosts);
});

test("registered for another extension ID, Test connection says to run install.ps1 with this one", async () => {
  host.register("abcdefghijklmnopabcdefghijklmnop");
  const options = await openOptions();
  expect(await testConnection(options)).toEqual([OPTIONS_TEXT.failed(AUDIO_TEXT.otherExtension(EXTENSION_ID))]);
  await options.close();
  host.register();
});

test("nothing went wrong unseen: no uncaught error in the worker or the page", async () => {
  const lines = await workerConsole(e2e.browser.sw);
  expect(lines.filter((line) => /^(uncaught|unhandled rejection)/.test(line))).toEqual([]);
  expect(pageConsole.filter((line) => line.startsWith("pageerror"))).toEqual([]);
});
