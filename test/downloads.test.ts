import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLyricsDownloads } from "../src/background/downloads";
import { createCaptureStore } from "../src/background/store";
import { buildStem } from "../src/shared/filenames";
import { createSettingsStore } from "../src/shared/settings";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import type { StoredCapture } from "../src/shared/summary";
import { decodeDataUrl, FakeDownloads } from "./helpers/fakeDownloads";
import { FakeStorageArea } from "./helpers/fakeStorage";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { metadata, sources } = extractSources(parseSse(stream), unison);
const ID = "Synth3t1cK1";
const OTHER = "Other0ther0";
const EXTENSION_ID = "mengelecikhhdpjdebjpokcmhdkhjobj";
const STEM = buildStem({ artist: "Marrow & Tin", title: "Northbound Kites", videoId: ID });
const WINDOWS_DIR = "C:\\Users\\Tester\\Downloads";
const stored: StoredCapture = { videoId: ID, capturedAt: 1_700_000_000_000, metadata, rawStream: stream, unisonRaw: unison, bodySource: "getResponseBody" };
const byId = (id: string) => sources.find((source) => source.id === id)!;
/** Lets the onChanged handler's async work finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup({ subfolder = false, downloadDir = WINDOWS_DIR } = {}) {
  const fake = new FakeDownloads(EXTENSION_ID, downloadDir);
  const store = createCaptureStore({ area: new FakeStorageArea() });
  await store.put(stored);
  const local = new FakeStorageArea({ kind: "local" });
  const settings = createSettingsStore(local);
  if (subfolder) await settings.setSettings({ perSongSubfolder: true });
  const warn = vi.fn();
  const lyrics = createLyricsDownloads({ downloads: fake, store, settings, extensionId: EXTENSION_ID, log: { warn } });
  fake.onChanged.addListener(lyrics.handleChanged);
  const request = (itemId: string, stem = STEM, videoId = ID) => lyrics.download({ type: "lyrics:download", videoId, itemId, stem });
  const learned = async () => (await settings.getSettings()).learnedDownloadDir;
  const learnedWrites = () => local.calls.filter((call) => call.method === "set" && "learnedDownloadDir" in call.items).length;
  const lastId = () => fake.items[fake.items.length - 1].id;
  return { fake, local, settings, warn, request, learned, learnedWrites, lastId };
}

describe("lyrics:download", () => {
  it("saves the Tony pick as <stem>.ttml from a data URL of golyrics' exact bytes, uniquified, without Save As", async () => {
    const { fake, request } = await setup();
    expect(await request("tony")).toEqual({ ok: true });
    expect(fake.calls).toEqual([
      { url: expect.stringMatching(/^data:application\/ttml\+xml;charset=utf-8;base64,/), filename: `${STEM}.ttml`, conflictAction: "uniquify", saveAs: false },
    ]);
    const { bytes } = decodeDataUrl(fake.calls[0].url);
    expect(bytes.equals(Buffer.from(byId("golyrics").content, "utf8"))).toBe(true);
    expect(bytes[0]).toBe(0x3c);
    expect(fake.items[0].filename).toBe(`${WINDOWS_DIR}\\${STEM}.ttml`);
  });

  it("names every kind of file after the stem, inside a <stem> folder with the per-song subfolder option", async () => {
    const names: [string, string][] = [
      ["tony", `${STEM}.ttml`],
      ["native:golyrics", `${STEM}.golyrics.ttml`],
      ["native:musixmatch-word", `${STEM}.musixmatch-word.lrc`],
      ["ttml:musixmatch-word", `${STEM}.musixmatch-word.ttml`],
      ["native:qq", `${STEM}.qq.qrc.xml`],
      ["ttml:qq", `${STEM}.qq.ttml`],
      ["native:lrclib-plain", `${STEM}.lrclib.txt`],
      ["raw", `${STEM}.lyrics-stream.txt`],
    ];
    for (const subfolder of [false, true]) {
      const { fake, request } = await setup({ subfolder });
      for (const [itemId] of names) expect(await request(itemId), itemId).toEqual({ ok: true });
      expect(fake.calls.map((call) => call.filename)).toEqual(names.map(([, name]) => (subfolder ? `${STEM}/${name}` : name)));
      expect(fake.items.map((item) => item.filename)).toEqual(names.map(([, name]) => (subfolder ? `${WINDOWS_DIR}\\${STEM}\\${name}` : `${WINDOWS_DIR}\\${name}`)));
    }
    const { fake, request } = await setup();
    await request("raw");
    expect(decodeDataUrl(fake.calls[0].url)).toEqual({ mediaType: "text/plain;charset=utf-8", bytes: Buffer.from(stream, "utf8") });
  });

  it("titles converted TTML with the stem the content script sent", async () => {
    const { fake, request } = await setup();
    await request("ttml:qq", buildStem({ artist: "Someone Else", title: "Renamed", videoId: ID }));
    expect(fake.calls[0].filename).toBe(`Someone Else - Renamed [${ID}].qq.ttml`);
    expect(decodeDataUrl(fake.calls[0].url).bytes.toString("utf8")).toContain("<ttm:title>Someone Else - Renamed</ttm:title>");
  });

  it("refuses a stem that is not this video's buildStem() output, before reading the capture", async () => {
    const { fake, request } = await setup();
    expect(await request("tony", `${STEM}.`)).toEqual({ ok: false, error: `Not a usable file name: ${JSON.stringify(`${STEM}.`)}` });
    expect(await request("tony", "..\\..\\evil [Synth3t1cK1]")).toEqual({ ok: false, error: expect.stringMatching(/^Not a usable file name/) });
    const otherStem = buildStem({ title: "x", videoId: OTHER });
    expect(await request("tony", otherStem)).toEqual({ ok: false, error: `The file name ${JSON.stringify(otherStem)} does not end with this song's video id [${ID}]` });
    expect(fake.calls).toEqual([]);
  });

  it("says when there is no capture, no such source, or nothing Tony can read", async () => {
    const { fake, request } = await setup();
    expect(await request("tony", buildStem({ title: "x", videoId: OTHER }), OTHER)).toEqual({
      ok: false,
      error: "This song's capture is no longer kept (a browser restart or newer captures removed it): capture it again",
    });
    expect(await request("native:nope")).toEqual({ ok: false, error: "There is no nope source in this capture" });
    expect(await request("ttml:golyrics")).toEqual({ ok: false, error: `${byId("golyrics").label} is not converted to TTML` });
    expect(fake.calls).toEqual([]);
  });

  it("turns Chrome's refusal into a readable error", async () => {
    const { fake, request } = await setup();
    fake.failNext = "Invalid filename";
    expect(await request("tony")).toEqual({ ok: false, error: `Chrome did not save ${STEM}.ttml: Invalid filename` });
    expect(fake.items).toEqual([]);
    // The next one goes through.
    expect(await request("tony")).toEqual({ ok: true });
  });
});

describe("learning the download folder", () => {
  it("stores the folder of a finished download of ours", async () => {
    const { fake, request, learned, lastId } = await setup();
    await request("tony");
    expect(await learned()).toBe("");
    fake.complete(lastId());
    await settle();
    expect(await learned()).toBe(WINDOWS_DIR);
  });

  it("strips the per-song folder, and the file name uniquify changed", async () => {
    const { fake, request, learned, learnedWrites, lastId } = await setup({ subfolder: true });
    await request("tony");
    fake.complete(lastId());
    await request("tony");
    expect(fake.items[1].filename).toBe(`${WINDOWS_DIR}\\${STEM}\\${STEM} (1).ttml`);
    fake.complete(lastId());
    await settle();
    expect(await learned()).toBe(WINDOWS_DIR);
    // The same folder again is not written again.
    expect(learnedWrites()).toBe(1);
  });

  it("learns a POSIX folder", async () => {
    const { fake, request, learned, lastId } = await setup({ subfolder: true, downloadDir: "/home/tester/Downloads" });
    await request("raw");
    fake.complete(lastId());
    await settle();
    expect(await learned()).toBe("/home/tester/Downloads");
  });

  it("learns from a download that finishes before Chrome has given us its id", async () => {
    const { fake, request, learned } = await setup();
    fake.completeAtOnce = true;
    expect(await request("tony")).toEqual({ ok: true });
    await settle();
    expect(await learned()).toBe(WINDOWS_DIR);
  });

  it("ignores other extensions' and the user's downloads, interrupted ones, and files not where we asked", async () => {
    const { fake, request, learned, learnedWrites, lastId } = await setup();
    fake.complete(fake.addForeign("other.zip", "abcdefghijklmnopabcdefghijklmnop"));
    fake.complete(fake.addForeign("user.pdf"));
    await request("tony");
    fake.interrupt(lastId());
    // One of ours as far as we know, but Chrome says another extension made it: not trusted.
    await request("raw");
    fake.item(lastId()).byExtensionId = "abcdefghijklmnopabcdefghijklmnop";
    fake.complete(lastId());
    await settle();
    expect(learnedWrites()).toBe(0);

    // Saved somewhere else than the <stem> folder we asked for (as a Save As dialog could).
    const subfolder = await setup({ subfolder: true });
    await subfolder.request("tony");
    subfolder.fake.item(subfolder.lastId()).filename = `D:\\Elsewhere\\${STEM}.ttml`;
    subfolder.fake.complete(subfolder.lastId());
    await settle();
    expect(subfolder.learnedWrites()).toBe(0);
    expect(await learned()).toBe("");
  });

  it("logs, without the path, when the setting cannot be written", async () => {
    const { fake, local, request, warn, lastId } = await setup();
    local.beforeSet = () => {
      throw new Error("storage broke");
    };
    await request("tony");
    fake.complete(lastId());
    await settle();
    expect(warn).toHaveBeenCalledWith("[YTM Practice Grabber] could not learn the download folder: storage broke");
  });
});
