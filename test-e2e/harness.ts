// What the end-to-end tests share: start and stop the server and browser, look into the service
// worker (its storage and console), and drive the lyrics button, menu and downloads.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, Worker } from "playwright-core";
import type { Settings } from "../src/shared/settings";
import type { StoredCapture } from "../src/shared/summary";
import { launchWithExtension, type ExtensionBrowser } from "./browser";
import { makeCertificate } from "./certs";
import type { BlLoad, MockYtm } from "./page/mockYtm";
import { startMockServer, type MockServer } from "./server";

export interface E2e {
  work: string;
  server: MockServer;
  browser: ExtensionBrowser;
}

export async function startE2e(): Promise<E2e> {
  const work = mkdtempSync(path.join(tmpdir(), "pg-e2e-"));
  const server = await startMockServer(makeCertificate(work));
  try {
    const browser = await launchWithExtension({ port: server.port, workDir: work });
    return { work, server, browser };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export async function stopE2e(e2e: E2e | undefined): Promise<void> {
  if (e2e === undefined) return;
  await e2e.browser.close().catch(() => undefined);
  await e2e.server.close();
  rmSync(e2e.work, { recursive: true, force: true });
}

// --- The service worker -------------------------------------------------------------------------

const CONSOLE_KEY = "__pgE2eConsole";

/**
 * Records every console line the service worker writes from now on, and its uncaught errors.
 * Playwright 1.56 does not report a service worker's console, so the console methods are wrapped
 * in the worker itself; the extension's modules look them up at call time (`log.log(...)` on the
 * console object they were given), so they write through the wrappers.
 */
export async function recordWorkerConsole(sw: Worker): Promise<void> {
  await sw.evaluate((key) => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (scope[key] !== undefined) return;
    const lines: string[] = [];
    scope[key] = lines;
    const text = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        lines.push(`${level}: ${args.map(text).join(" ")}`);
        original(...args);
      };
    }
    addEventListener("error", (event) => lines.push(`uncaught: ${text((event as ErrorEvent).error ?? (event as ErrorEvent).message)}`));
    addEventListener("unhandledrejection", (event) => lines.push(`unhandled rejection: ${text((event as PromiseRejectionEvent).reason)}`));
  }, CONSOLE_KEY);
}

/** The service worker's console since recordWorkerConsole(); throws if the worker was restarted meanwhile. */
export async function workerConsole(sw: Worker): Promise<string[]> {
  const lines = await sw.evaluate((key) => (globalThis as unknown as Record<string, string[] | undefined>)[key] ?? null, CONSOLE_KEY);
  if (lines === null) throw new Error("The service worker was restarted: its console was not recorded throughout");
  return lines;
}

const DEBUGGER_KEY = "__pgE2eDebuggerEvents";

/** What recordDebuggerEvents() keeps of one CDP event: never a body, a header or a query. */
export interface DebuggerEventNote {
  method: string;
  requestId?: string;
  /** requestWillBeSent: the URL's origin and path. */
  path?: string;
  status?: number;
  dataLength?: number;
  /** dataReceived carried the data itself (streaming was on). */
  hasData?: boolean;
  canceled?: boolean;
  errorText?: string;
}

/**
 * Notes every event the extension's debugger sessions receive, from a second
 * chrome.debugger.onEvent listener in the worker (the extension's own is untouched).
 */
export async function recordDebuggerEvents(sw: Worker): Promise<void> {
  await sw.evaluate((key) => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (scope[key] !== undefined) return;
    const notes: DebuggerEventNote[] = [];
    scope[key] = notes;
    chrome.debugger.onEvent.addListener((_source, method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const request = p.request as { url?: unknown } | undefined;
      const response = p.response as { status?: unknown } | undefined;
      const note: DebuggerEventNote = { method };
      if (typeof p.requestId === "string") note.requestId = p.requestId;
      if (typeof request?.url === "string") {
        try {
          const url = new URL(request.url);
          note.path = url.origin + url.pathname;
        } catch {
          // No path.
        }
      }
      if (typeof response?.status === "number") note.status = response.status;
      if (typeof p.dataLength === "number") note.dataLength = p.dataLength;
      if (method === "Network.dataReceived") note.hasData = typeof p.data === "string" && p.data !== "";
      if (typeof p.canceled === "boolean") note.canceled = p.canceled;
      if (typeof p.errorText === "string") note.errorText = p.errorText;
      notes.push(note);
    });
  }, DEBUGGER_KEY);
}

export async function debuggerEvents(sw: Worker): Promise<DebuggerEventNote[]> {
  const notes = await sw.evaluate((key) => (globalThis as unknown as Record<string, DebuggerEventNote[] | undefined>)[key] ?? null, DEBUGGER_KEY);
  if (notes === null) throw new Error("The service worker was restarted: its debugger events were not recorded throughout");
  return notes;
}

export async function setSettings(sw: Worker, settings: Partial<Settings>): Promise<void> {
  await sw.evaluate((items) => chrome.storage.local.set(items), settings as Record<string, unknown>);
}

export async function getSettings(sw: Worker): Promise<Record<string, unknown>> {
  return sw.evaluate(() => chrome.storage.local.get(null));
}

export async function storedCapture(sw: Worker, videoId: string): Promise<StoredCapture | undefined> {
  const key = `capture:${videoId}`;
  const items = await sw.evaluate((k) => chrome.storage.session.get(k), key);
  return items[key] as StoredCapture | undefined;
}

/** Polls for `capture:<videoId>` in session storage. */
export async function waitForCapture(sw: Worker, videoId: string, timeoutMs = 15_000): Promise<StoredCapture> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const capture = await storedCapture(sw, videoId);
    if (capture !== undefined) return capture;
    if (Date.now() > end) throw new Error(`No capture of ${videoId} was stored within ${timeoutMs} ms`);
    await sleep(100);
  }
}

/** Everything in the extension's storage areas, as JSON text. */
export async function storageText(sw: Worker): Promise<string> {
  const areas = await sw.evaluate(async () => ({
    session: await chrome.storage.session.get(null),
    local: await chrome.storage.local.get(null),
    sync: await chrome.storage.sync.get(null),
  }));
  return JSON.stringify(areas);
}

/** Polls the worker's console until a line matches. */
export async function waitForWorkerLine(sw: Worker, pattern: RegExp, from = 0, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const line = (await workerConsole(sw)).slice(from).find((candidate) => pattern.test(candidate));
    if (line !== undefined) return line;
    if (Date.now() > end) throw new Error(`No service worker console line matched ${pattern} within ${timeoutMs} ms`);
    await sleep(100);
  }
}

// --- The page -------------------------------------------------------------------------------------

/** Console lines and uncaught errors of the page, all worlds, from now on (attach before goto). */
export function recordPageConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (message) => lines.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
  return lines;
}

export async function mockState(page: Page): Promise<Pick<MockYtm, "song" | "refreshClicks" | "loads">> {
  return page.evaluate(() => {
    const { song, refreshClicks, loads } = (window as unknown as { mockYtm: MockYtm }).mockYtm;
    return { song, refreshClicks, loads };
  });
}

/** BL rebuilding its controls (`__controls` replaced), as on a source switch. */
export async function blRebuildsControls(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { mockYtm: MockYtm }).mockYtm.rebuildControls());
}

/** BL loading the song's lyrics by itself (no refresh click), as on a song change. */
export async function blLoadsLyrics(page: Page): Promise<BlLoad> {
  return page.evaluate(() => (window as unknown as { mockYtm: MockYtm }).mockYtm.loadLyrics());
}

/** Clicks the lyrics button in the dock and waits for the menu (the capture, when one runs, included). */
export async function openLyricsMenu(page: Page, timeoutMs = 40_000): Promise<void> {
  await page.click(".pg-dock-btn");
  await page.waitForSelector(".pg-menu", { state: "visible", timeout: timeoutMs });
}

export async function menuItemIds(page: Page): Promise<string[]> {
  return page.$$eval('.pg-menu [role="menuitem"]', (items) => items.map((item) => (item as HTMLElement).dataset.itemId ?? ""));
}

/** Chooses the first enabled menu item with this id ("tony" is also the id of "what's showing" when they agree). */
export async function chooseMenuItem(page: Page, itemId: string): Promise<void> {
  await page.locator(`.pg-menu [role="menuitem"][data-item-id="${itemId}"]:not([aria-disabled="true"])`).first().click();
}

/** Hides the toast and empties it, so that waitForToast() sees only a message shown after this. */
export async function clearToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>(".pg-toast");
    if (toast === null) return;
    toast.hidden = true;
    toast.textContent = "";
  });
}

/** The toast's text once it shows `pattern`. */
export async function waitForToast(page: Page, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.evaluate(() => {
      const toast = document.querySelector<HTMLElement>(".pg-toast");
      return toast === null || toast.hidden ? "" : (toast.textContent ?? "");
    });
    if (pattern.test(text)) return text;
    if (Date.now() > end) throw new Error(`The toast did not show ${pattern} within ${timeoutMs} ms (it shows ${JSON.stringify(text)})`);
    await sleep(50);
  }
}

/** The file's bytes once Chrome has finished writing it (it renames `<name>.crdownload` at the end). */
export async function waitForFile(file: string, timeoutMs = 10_000): Promise<Buffer> {
  const end = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`${path.basename(file)} did not appear within ${timeoutMs} ms`);
    await sleep(50);
  }
  return readFileSync(file);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
