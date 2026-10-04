// End to end (B8): the built extension in real Chromium, against the mock YouTube Music page with
// Better Lyrics' dock (page/) and real HTTPS lyrics servers that stream (server.ts). The tests run
// in order and build on each other (one browser for the file): the first capture is reused by the
// later scenarios on that song.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildStem } from "../src/shared/filenames";
import { lyricsFile } from "../src/shared/lyricsFiles";
import { RAW_EXT } from "../src/shared/lyricsItems";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { readTony } from "../test/helpers/tonyReader";
import { openWatchPage } from "./browser";
import { LYRICS_HOST, UNISON_HOST } from "./certs";
import {
  blLoadsLyrics,
  blRebuildsControls,
  chooseMenuItem,
  clearToast,
  debuggerEvents,
  getSettings,
  menuItemIds,
  mockState,
  openLyricsMenu,
  recordDebuggerEvents,
  recordPageConsole,
  recordWorkerConsole,
  setSettings,
  sleep,
  startE2e,
  stopE2e,
  storageText,
  storedCapture,
  waitForCapture,
  waitForFile,
  waitForToast,
  waitForWorkerLine,
  workerConsole,
  type E2e,
} from "./harness";
import { E2E_KEY_ID, E2E_RETRY_TOKEN, E2E_TOKEN, secretsIn } from "./secrets";
import { LARGE_STREAM_BYTES, STREAM_FIXTURE, UNISON_FIXTURE } from "./server";

const VIDEO = "Synth3t1cK1";
// What YTM's player reports (the mock's getVideoData(); its player bar shows another title, so
// every file name below also shows that the page bridge answered). Non-ASCII on purpose:
// Chromium under the C locale refuses such file names.
const SONG = { title: "Northbound Kites (Live at Caf\u{E9} Nord)", artist: "Marrow & Tin" };
const STEM = buildStem({ artist: SONG.artist, title: SONG.title, videoId: VIDEO });
const FIXTURE_TEXT = STREAM_FIXTURE.toString("utf8");
const UNISON_TEXT = UNISON_FIXTURE.toString("utf8");
const { metadata: METADATA, sources: SOURCES } = extractSources(parseSse(FIXTURE_TEXT), UNISON_TEXT);

let e2e: E2e;
let page: Page;
let pageConsole: string[];

beforeAll(async () => {
  e2e = await startE2e();
  await recordWorkerConsole(e2e.browser.sw);
  await recordDebuggerEvents(e2e.browser.sw);
  // The debug log names the body path and every capture step: it is checked for secrets too.
  await setSettings(e2e.browser.sw, { debugCapture: true });
  page = e2e.browser.context.pages()[0] ?? (await e2e.browser.context.newPage());
  pageConsole = recordPageConsole(page);
  await openWatchPage(page, VIDEO, SONG);
});

afterAll(async () => {
  await stopE2e(e2e);
});

async function consoleLength(): Promise<number> {
  return (await workerConsole(e2e.browser.sw)).length;
}

async function consoleSince(from: number): Promise<string[]> {
  return (await workerConsole(e2e.browser.sw)).slice(from);
}

function downloaded(name: string): string {
  return path.join(e2e.browser.downloadDir, name);
}

/** BL's secrets went to the servers; nothing the extension keeps or prints holds them in any form. */
async function expectSecretsSentNotKept(sent: string[]): Promise<void> {
  const { received } = e2e.server;
  const tokens = received.filter((r) => r.host === LYRICS_HOST && r.method === "POST").map((r) => new URLSearchParams(r.body).get("token"));
  const keys = received.filter((r) => r.host === UNISON_HOST && r.method === "GET").map((r) => r.headers["x-key-id"]);
  for (const secret of sent) expect([...tokens, ...keys]).toContain(secret);

  const storage = await storageText(e2e.browser.sw);
  const workerLines = await workerConsole(e2e.browser.sw);
  // The checks below look at something real: captures in storage, a recorded debug log, and a
  // page console that includes the content script's isolated world.
  expect(storage).toContain('"capture:index"');
  expect(workerLines.some((line) => line.includes("capture: tab"))).toBe(true);
  expect(pageConsole.some((line) => line.includes("[YTM Practice Grabber] content script loaded"))).toBe(true);
  expect(secretsIn(storage)).toEqual([]);
  expect(secretsIn(workerLines.join("\n"))).toEqual([]);
  expect(secretsIn(pageConsole.join("\n"))).toEqual([]);
  const files = readdirSync(e2e.browser.downloadDir).map((name) => readFileSync(downloaded(name), "latin1"));
  expect(secretsIn(files.join("\n"))).toEqual([]);
}

test("the lyrics button sits right after BL's controls, visible, and stays there when BL replaces them", async () => {
  await page.waitForSelector(".blyrics-dock__inner > .pg-dock-btn");
  const placement = () =>
    page.evaluate(() => {
      const button = document.querySelector(".pg-dock-btn");
      const rect = button?.getBoundingClientRect();
      const hit = rect === undefined ? null : document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        buttons: document.querySelectorAll(".pg-dock-btn, .pg-floating-btn").length,
        parent: button?.parentElement?.className,
        previous: button?.previousElementSibling?.className,
        inViewport: rect !== undefined && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        onTop: hit !== null && button !== null && button !== undefined && button.contains(hit),
      };
    });
  const expected = { buttons: 1, parent: "blyrics-dock__inner", previous: "blyrics-dock__controls", inViewport: true, onTop: true };
  expect(await placement()).toEqual(expected);

  const before = await page.evaluateHandle(() => document.querySelector(".blyrics-dock__controls"));
  await blRebuildsControls(page);
  expect(await page.evaluate((old) => old !== null && !old.isConnected && document.querySelector(".blyrics-dock__controls") !== null, before)).toBe(true);
  // Give the button's observer time to (needlessly) act, then look again.
  await sleep(300);
  expect(await placement()).toEqual(expected);
});

test("on demand: a click makes BL refresh, the stream is captured (bodySource), the menu lists every source, and the Tony file is the golyrics TTML byte for byte", async () => {
  const { sw } = e2e.browser;
  const from = await consoleLength();
  const eventsFrom = (await debuggerEvents(sw)).length;
  const requestsFrom = e2e.server.received.length;

  await openLyricsMenu(page);

  const mock = await mockState(page);
  expect(mock.refreshClicks).toBe(1);
  expect(mock.loads).toHaveLength(1);
  const [load] = mock.loads;
  expect(load.streamStatuses).toEqual([200]);
  // BL read the whole stream, in several pieces.
  expect(load.streamText).toBe(FIXTURE_TEXT);
  expect(load.streamReads).toBeGreaterThan(2);
  expect(load.unisonStatus).toBe(200);
  const posts = e2e.server.received.slice(requestsFrom).filter((r) => r.host === LYRICS_HOST && r.method === "POST");
  expect(posts).toHaveLength(1);
  expect(new URLSearchParams(posts[0].body).get("videoId")).toBe(VIDEO);

  const capture = await storedCapture(sw, VIDEO);
  expect(capture).toBeDefined();
  expect(capture!.rawStream).toBe(FIXTURE_TEXT);
  expect(capture!.unisonRaw).toBe(UNISON_TEXT);
  // The Phase 0 question (PLAN.md 3.3). Chromium 141 ends a fetch whose body BL reads with
  // getReader() as loadingFailed (canceled, net::ERR_ABORTED), never loadingFinished, and
  // Network.getResponseBody then has no data; Network.streamResourceContent + dataReceived carry
  // the whole stream, and eventSourceMessageReceived never comes (this is fetch, not EventSource).
  expect(capture!.bodySource).toBe("stream");
  const events = (await debuggerEvents(sw)).slice(eventsFrom);
  const streamId = events.find((e) => e.method === "Network.requestWillBeSent" && e.path === "https://lyrics.api.dacubeking.com/v2/lyrics")?.requestId;
  const stream = events.filter((e) => streamId !== undefined && e.requestId === streamId);
  expect(stream.map((e) => e.method)).not.toContain("Network.loadingFinished");
  expect(stream.at(-1)).toMatchObject({ method: "Network.loadingFailed", canceled: true, errorText: "net::ERR_ABORTED" });
  expect(events.filter((e) => e.method === "Network.eventSourceMessageReceived")).toEqual([]);
  // The data came in the server's chunks, one ending inside the multi-byte character (the
  // capture joins the bytes before decoding them, so rawStream above is still exact).
  const chunks = stream.filter((e) => e.method === "Network.dataReceived");
  expect(chunks.some((e) => e.hasData)).toBe(true);
  const ends = chunks.map((e) => e.dataLength ?? 0).map((_, i, all) => all.slice(0, i + 1).reduce((a, b) => a + b, 0));
  expect(ends.at(-1)).toBe(STREAM_FIXTURE.length);
  expect(ends).toContain(STREAM_FIXTURE.findIndex((byte) => byte >= 0x80) + 1);
  const lines = await consoleSince(from);
  expect(lines.some((line) => /: attached, Network on \(on-demand\)$/.test(line))).toBe(true);
  expect(lines.some((line) => /cancelled after its done event, \d+ ms; using stream$/.test(line))).toBe(true);
  expect(lines.some((line) => /: detached$/.test(line))).toBe(true);

  const ids = await menuItemIds(page);
  expect(SOURCES).toHaveLength(9);
  for (const source of SOURCES) expect(ids).toContain(`native:${source.id}`);
  expect(ids).toEqual(expect.arrayContaining(["tony", "ttml:musixmatch-word", "ttml:qq", "raw", "recapture"]));

  await chooseMenuItem(page, "tony");
  const file = await waitForFile(downloaded(`${STEM}.ttml`));
  const golyrics = SOURCES.find((source) => source.id === "golyrics")!;
  expect(file.equals(Buffer.from(golyrics.content, "utf8"))).toBe(true);
  // BL's offset (+0.2s in the mock dock) is mentioned, not applied.
  expect(await waitForToast(page, /^Saved/)).toContain("+0.2 s");
});

test("a second click opens the menu from the stored capture (no request, no debugger), and the raw response is exactly the streamed bytes", async () => {
  const from = await consoleLength();
  const requestsBefore = e2e.server.received.length;
  const clicksBefore = (await mockState(page)).refreshClicks;

  await openLyricsMenu(page, 5_000);
  await chooseMenuItem(page, "raw");
  const file = await waitForFile(downloaded(`${STEM}${RAW_EXT}`));
  // Byte for byte what the server sent, including the character split across two chunks.
  expect(file.equals(STREAM_FIXTURE)).toBe(true);
  expect(e2e.server.streamsSent).toHaveLength(1);

  expect(e2e.server.received.length).toBe(requestsBefore);
  expect((await mockState(page)).refreshClicks).toBe(clicksBefore);
  expect((await consoleSince(from)).filter((line) => /attached|Network on|stream request/.test(line))).toEqual([]);
});

test("Musixmatch word-by-word -> TTML saves a file Tony reads with the same words and times", async () => {
  await openLyricsMenu(page, 5_000);
  await chooseMenuItem(page, "ttml:musixmatch-word");
  const text = (await waitForFile(downloaded(`${STEM}.musixmatch-word.ttml`))).toString("utf8");

  // Exactly what the shared code makes of the capture (nothing changed on the way through
  // chrome.downloads, the non-ASCII title included) ...
  const made = lyricsFile("ttml:musixmatch-word", { videoId: VIDEO, metadata: METADATA, rawStream: FIXTURE_TEXT, sources: SOURCES }, STEM);
  expect(made.ok && made.file.content).toBe(text);
  // ... and Tony's rules read it as the B3 golden file.
  const tony = readTony(text);
  expect(tony.title).toBe(`${SONG.artist} - ${SONG.title}`);
  const golden = readTony(readFileSync(fileURLToPath(new URL("../test/fixtures/golden/musixmatch-word.ttml", import.meta.url)), "utf8"));
  expect(tony.lines).toEqual(golden.lines);
  expect(tony.lines.length).toBeGreaterThan(0);
});

test("the learned download folder is Chrome's real download folder, and chrome.downloads reports real paths", async () => {
  const { sw, downloadDir, extensionId } = e2e.browser;
  const settings = await getSettings(sw);
  expect(typeof settings.learnedDownloadDir).toBe("string");
  expect(realpathSync(settings.learnedDownloadDir as string)).toBe(realpathSync(downloadDir));

  const items = await sw.evaluate(() => chrome.downloads.search({}));
  const names = [`${STEM}.ttml`, `${STEM}${RAW_EXT}`, `${STEM}.musixmatch-word.ttml`];
  expect(items.map((item) => item.filename).sort()).toEqual(names.map(downloaded).sort());
  for (const item of items) {
    expect(item).toMatchObject({ state: "complete", exists: true, byExtensionId: extensionId });
  }
});

test("secrets after the on-demand capture: the token and key reached the server, but no storage or console holds them", async () => {
  await expectSecretsSentNotKept([E2E_TOKEN, E2E_KEY_ID]);
});

test("always-attached mode: a stream BL loads by itself is captured and stored without a click", async () => {
  const { sw } = e2e.browser;
  const video = "AlwaysE2e01";
  await openWatchPage(page, video);
  await page.waitForSelector(".pg-dock-btn");
  let from = await consoleLength();
  await setSettings(sw, { captureMode: "always" });
  await waitForWorkerLine(sw, /: attached, Network on \(always\)$/, from);

  // BL loading lyrics for a new song: no click, no refresh.
  const load = await blLoadsLyrics(page);
  expect(load.streamStatuses).toEqual([200]);
  expect(load.streamText).toBe(FIXTURE_TEXT);
  const capture = await waitForCapture(sw, video);
  expect(capture.rawStream).toBe(FIXTURE_TEXT);
  expect(capture.unisonRaw).toBe(UNISON_TEXT);
  expect(capture.bodySource).toBe("stream");
  expect((await mockState(page)).refreshClicks).toBe(0);

  from = await consoleLength();
  await setSettings(sw, { captureMode: "on-demand" });
  await waitForWorkerLine(sw, /: detached$/, from);
});

test("secrets after the always-attached capture: the token and key reached the server, but no storage or console holds them", async () => {
  expect(await storedCapture(e2e.browser.sw, "AlwaysE2e01")).toBeDefined();
  await expectSecretsSentNotKept([E2E_TOKEN, E2E_KEY_ID]);
});

test("a 403 and BL's retry with a new token: the retry's stream is captured (and Unison's 404 means no Unison)", async () => {
  const { sw } = e2e.browser;
  const video = "Retry403e2e";
  await openWatchPage(page, video);
  await page.waitForSelector(".pg-dock-btn");
  const from = await consoleLength();
  const requestsFrom = e2e.server.received.length;
  e2e.server.plan.refuse = 1;
  e2e.server.plan.unison = 404;
  try {
    await openLyricsMenu(page);
  } finally {
    e2e.server.plan.refuse = 0;
    e2e.server.plan.unison = "fixture";
  }

  const [load] = (await mockState(page)).loads;
  expect(load.streamStatuses).toEqual([403, 200]);
  expect(load.unisonStatus).toBe(404);
  const tokens = e2e.server.received
    .slice(requestsFrom)
    .filter((r) => r.host === LYRICS_HOST && r.method === "POST")
    .map((r) => new URLSearchParams(r.body).get("token"));
  expect(tokens).toEqual([E2E_TOKEN, E2E_RETRY_TOKEN]);
  const capture = await storedCapture(sw, video);
  expect(capture?.rawStream).toBe(FIXTURE_TEXT);
  expect(capture).not.toHaveProperty("unisonRaw");
  const lines = await consoleSince(from);
  expect(lines.some((line) => /HTTP 403/.test(line))).toBe(true);
  expect(lines.some((line) => /waiting for Better Lyrics to retry with a new token/.test(line))).toBe(true);
  const ids = await menuItemIds(page);
  expect(ids).toContain("tony");
  expect(ids).not.toContain("native:unison");
  await page.keyboard.press("Escape");
  await expectSecretsSentNotKept([E2E_TOKEN, E2E_RETRY_TOKEN, E2E_KEY_ID]);
});

test("a raw stream whose data URL is over Chrome's 2 MiB URL limit still saves whole", async () => {
  const { sw } = e2e.browser;
  const video = "LargeRaw0e2";
  e2e.server.plan.body = "large";
  try {
    await openWatchPage(page, video);
    await page.waitForSelector(".pg-dock-btn");
    await openLyricsMenu(page);
  } finally {
    e2e.server.plan.body = "fixture";
  }
  const sent = e2e.server.streamsSent.at(-1)!;
  expect(sent.length).toBe(LARGE_STREAM_BYTES);
  expect((await storedCapture(sw, video))?.rawStream).toBe(sent.toString("utf8"));

  await clearToast(page);
  await chooseMenuItem(page, "raw");
  const name = `${buildStem({ artist: "Marrow & Tin", title: "Northbound Kites", videoId: video })}${RAW_EXT}`;
  const file = await waitForFile(downloaded(name), 20_000);
  expect(file.equals(sent)).toBe(true);
  expect(await waitForToast(page, /^Saved/)).toMatch(/^Saved/);
  // The test did go past the limit: Chrome's url::kMaxURLChars is 2 MiB characters.
  const [item] = await sw.evaluate((file) => chrome.downloads.search({ filename: file }), downloaded(name));
  expect(item).toMatchObject({ state: "complete", bytesReceived: LARGE_STREAM_BYTES });
  expect(item.url.length).toBeGreaterThan(2 * 1024 * 1024);
});

test("screenshot: the open menu over the mock dock", async () => {
  await openWatchPage(page, VIDEO, SONG);
  await page.waitForSelector(".pg-dock-btn");
  // The capture is stored: the menu opens at once.
  await openLyricsMenu(page, 5_000);
  const geometry = await page.evaluate(() => {
    const menu = document.querySelector(".pg-menu")!.getBoundingClientRect();
    const button = document.querySelector(".pg-dock-btn")!.getBoundingClientRect();
    return { menu: { left: menu.left, top: menu.top, right: menu.right, bottom: menu.bottom }, buttonTop: button.top, width: innerWidth, height: innerHeight };
  });
  // From a dock at the bottom the menu opens upwards, inside the window.
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.buttonTop);
  expect(geometry.menu.top).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.left).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.right).toBeLessThanOrEqual(geometry.width);
  // Set E2E_MENU_SCREENSHOT=<file.png> to keep it.
  const shot = await page.screenshot(process.env.E2E_MENU_SCREENSHOT ? { path: process.env.E2E_MENU_SCREENSHOT } : {});
  expect(shot.subarray(1, 4).toString("latin1")).toBe("PNG");
});

// The last two tests reload the extension: its worker, storage and console recording start over.

test("the extension reloaded during a capture: the tab says the background stopped", async () => {
  const { sw } = e2e.browser;
  e2e.server.plan.holdMs = 4_000;
  try {
    await openWatchPage(page, "Reload0e2e1");
    await page.waitForSelector(".pg-dock-btn");
    const from = await consoleLength();
    await clearToast(page);
    await page.click(".pg-dock-btn");
    // The capture is running: attached, BL's refresh clicked, its request held by the server.
    await waitForWorkerLine(sw, /: attached, Network on \(on-demand\)$/, from);
    await page.waitForFunction(() => (window as unknown as { mockYtm: { refreshClicks: number } }).mockYtm.refreshClicks === 1);
    const closed = new Promise((resolve) => sw.once("close", resolve));
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await closed;
    // Chromium 141 closes the port while chrome.runtime and its id are still there and lastError
    // is empty (100 ms later the id was gone): at that moment a reload looks like the worker
    // stopping, which is what the user is told. The next click says to reload (next test).
    expect(await waitForToast(page, /./)).toBe("The extension's background stopped; try again");
  } finally {
    e2e.server.plan.holdMs = 0;
  }
});

test("after the extension is reloaded, a click in a tab opened before says to reload the tab", async () => {
  await clearToast(page);
  // The old content script still owns the button; Chromium has taken chrome.runtime from it.
  await page.click(".pg-dock-btn");
  expect(await waitForToast(page, /./)).toBe("The extension was reloaded: reload this tab");
  expect(pageConsole.filter((line) => line.startsWith("pageerror:"))).toEqual([]);
});
