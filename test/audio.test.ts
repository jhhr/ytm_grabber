// The service worker's audio relay with a fake native host: downloads over content `audio` ports,
// the one shared native port and when it closes, Chrome's errors, ping and reveal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_TEXT, CHROME_HOST_ERRORS, createAudioRelay, hostErrorText, type AudioRelay } from "../src/background/audio";
import { buildStem } from "../src/shared/filenames";
import { AUDIO_PORT, NATIVE_HOST_NAME } from "../src/shared/messages";
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from "../src/shared/settings";
import { FakeNative } from "./helpers/fakeNative";
import { FakePort } from "./helpers/fakePort";
import { FakeStorageArea } from "./helpers/fakeStorage";

const ID = "nKites0042x";
const OTHER = "0therS0ng11";
const STEM = buildStem({ artist: "Marrow & Tin", title: "Northbound Kites", videoId: ID });
const OTHER_STEM = buildStem({ artist: "Marrow & Tin", title: "Paper Weather", videoId: OTHER });
const EXTENSION_ID = "mengelecikhhdpjdebjpokcmhdkhjobj";
const PATH = `C:\\Users\\me\\Downloads\\${STEM}.opus`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let native: FakeNative;
let relay: AudioRelay;
const warn = vi.fn();

afterEach(() => {
  warn.mockReset();
  vi.restoreAllMocks();
});

function setup(settings: Partial<Settings> = {}, getSettings?: () => Promise<Settings>): void {
  native = new FakeNative();
  let count = 0;
  const store = createSettingsStore(new FakeStorageArea({ kind: "local", initial: settings }));
  relay = createAudioRelay({
    native,
    settings: getSettings ? { getSettings } : store,
    extensionId: EXTENSION_ID,
    newRequestId: () => `req-${++count}`,
    log: { warn },
  });
}

/** A content script's `audio` port, connected to the relay. */
function tab(): FakePort {
  const port = new FakePort(AUDIO_PORT, { tab: { id: 7 } });
  relay.connect(port);
  return port;
}

async function startDownload(videoId = ID, stem = STEM): Promise<FakePort> {
  const port = tab();
  port.deliver({ type: "start", videoId, stem });
  await tick();
  return port;
}

/** What the relay sent to the host, over all native ports. */
const sentToHost = () => native.ports.flatMap((port) => port.posted);

describe("a download", () => {
  it("goes to the host over a native port, relays its progress and path, then closes the port", async () => {
    setup();
    const port = await startDownload();
    expect(native.connectNative).toHaveBeenCalledExactlyOnceWith(NATIVE_HOST_NAME);
    expect(sentToHost()).toEqual([{ type: "download", requestId: "req-1", videoId: ID, stem: STEM, subfolder: false }]);
    native.reply({ type: "progress", requestId: "req-1", percent: 12.5, line: "  12.5%" });
    native.reply({ type: "progress", requestId: "req-1", percent: null, line: "  N/A%" });
    native.reply({ type: "progress", requestId: "req-1", percent: 140, line: "odd" });
    expect(native.port.connected).toBe(true);
    native.reply({ type: "done", requestId: "req-1", path: PATH });
    expect(port.posted).toEqual([
      { type: "progress", percent: 12.5 },
      { type: "progress", percent: null },
      { type: "progress", percent: 100 },
      { type: "done", path: PATH },
    ]);
    // Nothing left for the host to do: the port closes, which ends the host process.
    expect(native.port.connected).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("relays the host's error, logs yt-dlp's last lines and closes the port", async () => {
    setup();
    const port = await startDownload();
    native.reply({ type: "error", requestId: "req-1", message: "yt-dlp failed (exit code 1): ERROR: Video unavailable", stderrTail: "WARNING: x\nERROR: Video unavailable" });
    expect(port.posted).toEqual([{ type: "error", message: "yt-dlp failed (exit code 1): ERROR: Video unavailable" }]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("yt-dlp failed (exit code 1): ERROR: Video unavailable\nWARNING: x\nERROR: Video unavailable");
    expect(native.port.connected).toBe(false);
  });

  it("ends as an error when the host's done has no path", async () => {
    setup();
    const port = await startDownload();
    native.reply({ type: "done", requestId: "req-1" });
    expect(port.posted).toEqual([{ type: "error", message: AUDIO_TEXT.badReply }]);
    expect(native.port.connected).toBe(false);
  });

  it("is cancelled through the host, which answers with a cancelled error", async () => {
    setup();
    const port = await startDownload();
    native.reply({ type: "progress", requestId: "req-1", percent: 40, line: "" });
    port.deliver({ type: "cancel" });
    expect(sentToHost().at(-1)).toEqual({ type: "cancel", requestId: "req-1" });
    native.reply({ type: "error", requestId: "req-1", message: "Cancelled", cancelled: true });
    expect(port.posted).toEqual([
      { type: "progress", percent: 40 },
      { type: "error", message: "Cancelled", cancelled: true },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(native.port.connected).toBe(false);
  });

  it("cancelled before it reached the host never starts the host", async () => {
    let release!: (settings: Settings) => void;
    setup({}, () => new Promise((resolve) => (release = resolve)));
    const port = tab();
    port.deliver({ type: "start", videoId: ID, stem: STEM });
    port.deliver({ type: "cancel" });
    release({ ...DEFAULT_SETTINGS });
    await tick();
    expect(port.posted).toEqual([{ type: "error", message: AUDIO_TEXT.cancelled, cancelled: true }]);
    expect(native.connectNative).not.toHaveBeenCalled();
  });

  it("is refused before the host is started when the stem is not this video's buildStem() result", async () => {
    setup();
    for (const [videoId, stem] of [
      [ID, OTHER_STEM],
      [ID, "Marrow & Tin - Northbound Kites"],
      [ID, `Bad: name [${ID}]`],
      [ID, `trailing. [${ID}].`],
    ]) {
      const port = await startDownload(videoId, stem);
      expect(port.posted).toEqual([{ type: "error", message: expect.any(String) }]);
    }
    expect(native.connectNative).not.toHaveBeenCalled();
  });

  it("ignores malformed messages and a second start on the same port", async () => {
    setup();
    const port = tab();
    for (const message of [{ type: "start", videoId: "../x", stem: STEM }, { type: "start", videoId: ID }, { type: "download" }, "start", null]) port.deliver(message);
    await tick();
    expect(native.connectNative).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(5);
    port.deliver({ type: "start", videoId: ID, stem: STEM });
    port.deliver({ type: "start", videoId: ID, stem: STEM });
    await tick();
    expect(sentToHost()).toHaveLength(1);
    // A cancel with no download on the port does nothing.
    const idle = tab();
    idle.deliver({ type: "cancel" });
    expect(sentToHost()).toHaveLength(1);
  });

  it("goes on when the tab's port disconnects; its outcome is just not shown", async () => {
    setup();
    const port = await startDownload();
    port.remoteDisconnect();
    native.reply({ type: "progress", requestId: "req-1", percent: 50, line: "" });
    native.reply({ type: "done", requestId: "req-1", path: PATH });
    expect(port.posted).toEqual([]);
    expect(sentToHost()).toEqual([expect.objectContaining({ type: "download" })]);
    expect(native.port.connected).toBe(false);
  });

  it("says why when Chrome cannot open a native port at all", async () => {
    setup();
    native.connectNative.mockImplementationOnce(() => {
      throw new TypeError("chrome.runtime.connectNative is not a function");
    });
    const port = await startDownload();
    expect(port.posted).toEqual([{ type: "error", message: "Could not start the native host: chrome.runtime.connectNative is not a function" }]);
  });
});

describe("where the file goes", () => {
  const sentDownload = () => sentToHost()[0] as Record<string, unknown>;

  it("takes the download folder override first", async () => {
    setup({ downloadDirOverride: "D:\\Music\\Practice", learnedDownloadDir: "C:\\Users\\me\\Downloads" });
    await startDownload();
    expect(sentDownload().outputDir).toBe("D:\\Music\\Practice");
  });

  it("then the folder learned from Chrome's lyrics downloads", async () => {
    setup({ learnedDownloadDir: "C:\\Users\\me\\Downloads" });
    await startDownload();
    expect(sentDownload().outputDir).toBe("C:\\Users\\me\\Downloads");
  });

  it("else none, and the host uses its fallbackOutputDir", async () => {
    setup();
    await startDownload();
    expect(sentDownload()).not.toHaveProperty("outputDir");
  });

  it("asks for the per-song subfolder when that option is on", async () => {
    setup({ perSongSubfolder: true });
    await startDownload();
    expect(sentDownload()).toMatchObject({ subfolder: true });
  });

  it("answers with the error when the settings cannot be read", async () => {
    setup({}, () => Promise.reject(new Error("storage gone")));
    const port = await startDownload();
    expect(port.posted).toEqual([{ type: "error", message: "Could not read the extension's settings: storage gone" }]);
    expect(native.connectNative).not.toHaveBeenCalled();
  });
});

describe("the native port", () => {
  it("is shared by downloads that overlap and closed only after the last one, then opened again", async () => {
    setup();
    const first = await startDownload();
    const second = await startDownload(OTHER, OTHER_STEM);
    expect(native.connectNative).toHaveBeenCalledTimes(1);
    expect(sentToHost().map((message) => (message as { requestId: string }).requestId)).toEqual(["req-1", "req-2"]);
    native.reply({ type: "done", requestId: "req-1", path: PATH });
    expect(native.port.connected).toBe(true);
    native.reply({ type: "progress", requestId: "req-2", percent: 70, line: "" });
    native.reply({ type: "error", requestId: "req-2", message: "yt-dlp failed (exit code 1)" });
    expect(native.port.connected).toBe(false);
    expect(first.posted).toEqual([{ type: "done", path: PATH }]);
    expect(second.posted).toEqual([
      { type: "progress", percent: 70 },
      { type: "error", message: "yt-dlp failed (exit code 1)" },
    ]);
    await startDownload();
    expect(native.connectNative).toHaveBeenCalledTimes(2);
    expect(native.open()).toEqual([native.port]);
  });

  it("drops replies for requests it does not know or has finished, and malformed messages", async () => {
    setup();
    const port = await startDownload();
    native.reply({ type: "progress", requestId: "req-9", percent: 10, line: "" });
    native.reply({ type: "done", requestId: "req-9", path: PATH });
    native.reply({ type: "error", requestId: "nope", message: "No running download has requestId nope" });
    expect(port.posted).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    native.reply({ type: "pong" });
    native.reply("garbage");
    native.reply({ type: "progress", percent: 5 });
    expect(warn).toHaveBeenCalledTimes(3);
    // An error that answers none of our requests is only logged.
    native.reply({ type: "error", message: "Message is not valid JSON" });
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("Message is not valid JSON"));
    expect(port.posted).toEqual([]);
    expect(native.port.connected).toBe(true);
    // The late answer to a cancel, after the download finished, changes nothing.
    port.deliver({ type: "cancel" });
    native.reply({ type: "done", requestId: "req-1", path: PATH });
    native.reply({ type: "error", requestId: "req-1", message: "No running download has requestId req-1" });
    expect(port.posted).toEqual([{ type: "done", path: PATH }]);
  });

  it.each([
    [CHROME_HOST_ERRORS.notFound, "The native host is not installed: run native-host\\install.ps1 (see the README)."],
    [CHROME_HOST_ERRORS.forbidden, `The native host is registered for another extension ID: run install.ps1 -ExtensionId ${EXTENSION_ID}.`],
    [CHROME_HOST_ERRORS.exited, "The native host stopped unexpectedly."],
    [CHROME_HOST_ERRORS.io, "The native host sent something Chrome could not read."],
    ["Failed to start native messaging host.", "Failed to start native messaging host."],
    [undefined, "The native host stopped unexpectedly."],
  ])("ends every open request when it disconnects with lastError %j", async (lastError, message) => {
    setup();
    const first = await startDownload();
    const second = await startDownload(OTHER, OTHER_STEM);
    native.reply({ type: "progress", requestId: "req-2", percent: 3, line: "" });
    const revealed = relay.reveal({ type: "audio:reveal", path: PATH });
    native.exit(lastError);
    expect(first.posted).toEqual([{ type: "error", message }]);
    expect(second.posted).toEqual([{ type: "progress", percent: 3 }, { type: "error", message }]);
    expect(await revealed).toEqual({ ok: false, error: message });
    // The next request starts a new host.
    await startDownload();
    expect(native.connectNative).toHaveBeenCalledTimes(2);
  });

  it("maps Chrome's texts for the user", () => {
    expect(hostErrorText(CHROME_HOST_ERRORS.notFound, "abc")).toBe(AUDIO_TEXT.notInstalled);
    expect(hostErrorText(CHROME_HOST_ERRORS.forbidden, "abc")).toBe("The native host is registered for another extension ID: run install.ps1 -ExtensionId abc.");
    expect(hostErrorText("", "abc")).toBe(AUDIO_TEXT.exited);
    expect(hostErrorText("Something new.", "abc")).toBe("Something new.");
  });
});

describe("audio:ping", () => {
  const PONG = { type: "pong", hostVersion: "0.1.0", ytDlpVersion: "2026.08.19", ffmpegFound: false, problems: ["ffmpeg was not found on PATH"] };

  it("asks a one-shot host and answers with its pong", async () => {
    setup();
    native.sendNativeMessage.mockResolvedValueOnce(PONG);
    expect(await relay.ping()).toEqual({ ok: true, pong: { hostVersion: "0.1.0", ytDlpVersion: "2026.08.19", ffmpegFound: false, problems: ["ffmpeg was not found on PATH"] } });
    expect(native.sendNativeMessage).toHaveBeenCalledExactlyOnceWith(NATIVE_HOST_NAME, { type: "ping" });
    expect(native.connectNative).not.toHaveBeenCalled();
    native.sendNativeMessage.mockResolvedValueOnce({ ...PONG, ytDlpVersion: null, problems: [] });
    expect(await relay.ping()).toMatchObject({ ok: true, pong: { ytDlpVersion: null, problems: [] } });
  });

  it("answers with Chrome's error in the user's words", async () => {
    setup();
    native.sendNativeMessage.mockRejectedValueOnce(new Error(CHROME_HOST_ERRORS.notFound));
    expect(await relay.ping()).toEqual({ ok: false, error: AUDIO_TEXT.notInstalled });
    native.sendNativeMessage.mockRejectedValueOnce(new Error(CHROME_HOST_ERRORS.forbidden));
    expect(await relay.ping()).toEqual({ ok: false, error: AUDIO_TEXT.otherExtension(EXTENSION_ID) });
  });

  it("answers with the host's error, or says the answer is not understood", async () => {
    setup();
    native.sendNativeMessage.mockResolvedValueOnce({ type: "error", message: "Message has no type" });
    expect(await relay.ping()).toEqual({ ok: false, error: "Message has no type" });
    for (const answer of [undefined, { type: "pong", hostVersion: "0.1.0" }, { ...PONG, problems: [1] }, { type: "progress" }]) {
      native.sendNativeMessage.mockResolvedValueOnce(answer);
      expect(await relay.ping(), JSON.stringify(answer)).toEqual({ ok: false, error: AUDIO_TEXT.badReply });
    }
  });
});

describe("audio:reveal", () => {
  it("sends reveal and then a ping with the same id: a pong first means the host took it", async () => {
    setup();
    const revealed = relay.reveal({ type: "audio:reveal", path: PATH });
    expect(sentToHost()).toEqual([
      { type: "reveal", requestId: "req-1", path: PATH },
      { type: "ping", requestId: "req-1" },
    ]);
    native.reply({ type: "pong", requestId: "req-1", hostVersion: "0.1.0", ytDlpVersion: null, ffmpegFound: true, problems: [] });
    expect(await revealed).toEqual({ ok: true });
    expect(native.port.connected).toBe(false);
  });

  it("answers with the host's refusal, and drops the ping's pong after it", async () => {
    setup();
    const revealed = relay.reveal({ type: "audio:reveal", path: PATH });
    native.reply({ type: "error", requestId: "req-1", message: "Showing a file in its folder works on Windows only" });
    expect(await revealed).toEqual({ ok: false, error: "Showing a file in its folder works on Windows only" });
    expect(native.port.connected).toBe(false);
  });

  it("goes over the port a running download uses, which stays open for it", async () => {
    setup();
    const port = await startDownload();
    const revealed = relay.reveal({ type: "audio:reveal", path: PATH });
    expect(native.connectNative).toHaveBeenCalledTimes(1);
    native.reply({ type: "pong", requestId: "req-2", hostVersion: "0.1.0", ytDlpVersion: null, ffmpegFound: true, problems: [] });
    expect(await revealed).toEqual({ ok: true });
    expect(native.port.connected).toBe(true);
    native.reply({ type: "done", requestId: "req-1", path: PATH });
    expect(port.posted).toEqual([{ type: "done", path: PATH }]);
    expect(native.port.connected).toBe(false);
  });
});
