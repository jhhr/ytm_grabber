import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageListener, handleCaptureGet, type RequestDeps } from "../src/background/requests";
import { CAPTURE_INDEX_KEY, createCaptureStore, type IndexEntry } from "../src/background/store";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { summarize, type StoredCapture } from "../src/shared/summary";
import { FakeStorageArea } from "./helpers/fakeStorage";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { metadata, sources } = extractSources(parseSse(stream), unison);
const ID = "Synth3t1cK1";
const OTHER = "Other0ther0";
const capture = (videoId: string): StoredCapture => ({ videoId, capturedAt: 1_700_000_000_000, metadata, rawStream: stream, unisonRaw: unison, bodySource: "getResponseBody" });

async function setup() {
  const area = new FakeStorageArea();
  const store = createCaptureStore({ area });
  await store.put(capture(ID));
  return { area, store };
}

/** Calls the listener the way chrome.runtime.onMessage does; resolves with the response, if one is sent. */
function send(listener: ReturnType<typeof createMessageListener>, message: unknown) {
  const sendResponse = vi.fn();
  const kept = listener(message, { id: "mengelecikhhdpjdebjpokcmhdkhjobj" }, sendResponse);
  const response = () =>
    vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
      return sendResponse.mock.calls[0][0] as unknown;
    });
  return { kept, sendResponse, response };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCaptureGet", () => {
  it("answers with the summary of the stored capture, sources derived from the stored stream", async () => {
    const { store } = await setup();
    const { summary } = await handleCaptureGet({ type: "capture:get", videoId: ID }, { store });
    expect(summary).toEqual(summarize(capture(ID), sources));
    expect(summary!.sources).toHaveLength(sources.length);
    expect(JSON.stringify(summary)).not.toContain("lanterns");
  });

  it("answers null when there is no capture", async () => {
    const { store } = await setup();
    expect(await handleCaptureGet({ type: "capture:get", videoId: OTHER }, { store })).toEqual({ summary: null });
  });

  it("counts as a use of the capture (LRU)", async () => {
    const { area, store } = await setup();
    await store.put(capture(OTHER));
    await handleCaptureGet({ type: "capture:get", videoId: ID }, { store });
    expect((area.snapshot()[CAPTURE_INDEX_KEY] as IndexEntry[]).map((entry) => entry.videoId)).toEqual([OTHER, ID]);
  });
});

describe("createMessageListener", () => {
  it("answers capture:get asynchronously, keeping the channel open", async () => {
    const { store } = await setup();
    const call = send(createMessageListener({ store }), { type: "capture:get", videoId: ID });
    expect(call.kept).toBe(true);
    expect(await call.response()).toEqual({ summary: summarize(capture(ID), sources) });
    expect(call.sendResponse).toHaveBeenCalledTimes(1);
  });

  it("does not answer a malformed request and never reads the store for it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const get = vi.fn();
    const listener = createMessageListener({ store: { get } });
    for (const message of [{ type: "capture:get", videoId: "../../etc" }, { type: "capture:get" }, { type: "nope" }, "capture:get", null]) {
      const call = send(listener, message);
      expect(call.kept).toBe(false);
      expect(call.sendResponse).not.toHaveBeenCalled();
    }
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
  });

  it("answers with no capture when the store fails, so the sender is never left waiting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps: RequestDeps = { store: { get: () => Promise.reject(new Error("storage gone")) } };
    const call = send(createMessageListener(deps), { type: "capture:get", videoId: ID });
    expect(call.kept).toBe(true);
    expect(await call.response()).toEqual({ summary: null });
    expect(error).toHaveBeenCalled();
  });

  it("answers lyrics:download with an error until B6 builds it", async () => {
    const { store } = await setup();
    const call = send(createMessageListener({ store }), { type: "lyrics:download", videoId: ID, itemId: "tony", stem: `x [${ID}]` });
    expect(call.kept).toBe(true);
    expect(await call.response()).toEqual({ ok: false, error: expect.any(String) });
  });
});
