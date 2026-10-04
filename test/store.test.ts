import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_INDEX_KEY,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURES,
  captureKey,
  createCaptureStore,
  type CaptureStoreOptions,
  type IndexEntry,
} from "../src/background/store";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { storedItemBytes } from "../src/shared/storageArea";
import type { StoredCapture } from "../src/shared/summary";
import { FakeStorageArea, LOCAL_QUOTA_ERROR, SESSION_QUOTA_ERROR, type FakeStorageOptions } from "./helpers/fakeStorage";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const extracted = extractSources(parseSse(stream), unison);
const VIDEO = "Synth3t1cK1";

/** Valid 11-character video ids that sort in creation order. */
const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
/** A capture whose stream is `size` characters of filler (sources are not needed here). */
function capture(videoId: string, size = 100): StoredCapture {
  return { videoId, capturedAt: 1_000, metadata: {}, rawStream: "x".repeat(size), bodySource: "getResponseBody" };
}
const bytesOf = (value: StoredCapture) => storedItemBytes(captureKey(value.videoId), value);

function setup(area: FakeStorageOptions = {}, store: Omit<CaptureStoreOptions, "area"> = {}) {
  const fake = new FakeStorageArea(area);
  let time = 1_000_000;
  return { area: fake, store: createCaptureStore({ area: fake, now: () => ++time, ...store }) };
}
/** Video ids in the stored index, least recently used first. */
const indexed = (area: FakeStorageArea) => ((area.snapshot()[CAPTURE_INDEX_KEY] ?? []) as IndexEntry[]).map((entry) => entry.videoId);
/** Video ids that have a capture item. */
const stored = (area: FakeStorageArea) =>
  area
    .keys()
    .filter((key) => key !== CAPTURE_INDEX_KEY)
    .map((key) => key.slice("capture:".length))
    .sort();
const captureWrites = (area: FakeStorageArea, videoId: string) =>
  area.calls.filter((call) => call.method === "set" && captureKey(videoId) in call.items);

describe("CaptureStore put and get", () => {
  const full: StoredCapture = {
    videoId: VIDEO,
    capturedAt: 1_700_000_000_000,
    metadata: extracted.metadata,
    rawStream: stream,
    unisonRaw: unison,
    bodySource: "stream",
  };

  it("stores the raw inputs only, under capture:<videoId>, and derives the sources on read", async () => {
    const { area, store } = setup();
    // Anything beyond the stored fields is dropped, derived sources included.
    await store.put({ ...full, sources: extracted.sources, requestBody: "token=SECRET" } as StoredCapture);
    expect(area.snapshot()[captureKey(VIDEO)]).toEqual(full);
    expect(area.writtenText()).not.toContain("SECRET");
    expect(area.writtenText()).not.toContain('"sources"');

    const loaded = await store.get(VIDEO);
    expect(loaded).toEqual({ ...full, sources: extracted.sources });
    expect(loaded!.sources.map((source) => source.id)).toContain("unison");
  });

  it("keeps an index entry with the capture's size by Chrome's rule", async () => {
    const { area, store } = setup();
    await store.put(full);
    expect(area.snapshot()[CAPTURE_INDEX_KEY]).toEqual([
      { videoId: VIDEO, capturedAt: full.capturedAt, lastUsed: expect.any(Number), bytes: bytesOf(full) },
    ]);
  });

  it("stores no unisonRaw when Unison did not answer", async () => {
    const { area, store } = setup();
    const { unisonRaw: _, ...withoutUnison } = full;
    await store.put(withoutUnison);
    expect(Object.keys(area.snapshot()[captureKey(VIDEO)] as object)).not.toContain("unisonRaw");
    expect((await store.get(VIDEO))!.sources.map((source) => source.id)).not.toContain("unison");
  });

  it("returns null for a video with no capture or an id that is not a video id", async () => {
    const { area, store } = setup();
    await store.put(full);
    expect(await store.get(vid(1))).toBeNull();
    const calls = area.calls.length;
    expect(await store.get("capture:index")).toBeNull();
    expect(await store.get(`${VIDEO}\n`)).toBeNull();
    expect(area.calls.length).toBe(calls);
  });

  it("replaces the earlier capture of the same video", async () => {
    const { area, store } = setup();
    await store.put(capture(VIDEO, 10));
    await store.put({ ...capture(VIDEO, 20), capturedAt: 2_000 });
    expect(indexed(area)).toEqual([VIDEO]);
    expect((await store.get(VIDEO))!.capturedAt).toBe(2_000);
    expect((await store.get(VIDEO))!.rawStream).toHaveLength(20);
  });

  it("refuses what is not a capture, writing nothing", async () => {
    const { area, store } = setup();
    await expect(store.put(capture("too-short"))).rejects.toThrow(TypeError);
    await expect(store.put({ ...capture(VIDEO), bodySource: "fetch" } as unknown as StoredCapture)).rejects.toThrow(TypeError);
    await expect(store.put({ ...capture(VIDEO), capturedAt: Number.NaN })).rejects.toThrow(TypeError);
    expect(area.keys()).toEqual([]);
  });
});

describe("CaptureStore eviction", () => {
  it("keeps 30: the 31st capture evicts the least recently used, and a read counts as a use", async () => {
    expect(MAX_CAPTURES).toBe(30);
    const { area, store } = setup();
    for (let n = 1; n <= 30; n++) await store.put(capture(vid(n)));
    expect(await store.get(vid(1))).not.toBeNull();
    await store.put(capture(vid(31)));

    expect(await store.get(vid(2))).toBeNull();
    expect(stored(area)).toEqual([1, ...Array.from({ length: 29 }, (_, i) => i + 3)].map(vid));
    expect(indexed(area)).toHaveLength(30);
    expect(indexed(area).slice(-2)).toEqual([vid(1), vid(31)]);
  });

  it("evicts the least recently used by size to stay within the byte budget", async () => {
    const one = bytesOf(capture(vid(1), 1_000));
    const { area, store } = setup({}, { maxBytes: Math.floor(one * 2.5) });
    await store.put(capture(vid(1), 1_000));
    await store.put(capture(vid(2), 1_000));
    await store.get(vid(1));
    await store.put(capture(vid(3), 1_000));
    expect(stored(area)).toEqual([vid(1), vid(3)]);
    expect(indexed(area)).toEqual([vid(1), vid(3)]);
    // A bigger capture makes room for itself by evicting as many as it needs.
    await store.put(capture(vid(4), 2_000));
    expect(stored(area)).toEqual([vid(4)]);
  });

  it("keeps at most MAX_CAPTURE_BYTES (8 MiB) of captures by default", async () => {
    expect(MAX_CAPTURE_BYTES).toBe(8 * 1024 * 1024);
    const { area, store } = setup();
    for (let n = 1; n <= 8; n++) await store.put(capture(vid(n), 1024 * 1024));
    expect(stored(area)).toEqual([2, 3, 4, 5, 6, 7, 8].map(vid));
    const entries = area.snapshot()[CAPTURE_INDEX_KEY] as IndexEntry[];
    expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  });

  it("refuses a capture bigger than the whole budget, writing and evicting nothing", async () => {
    const { area, store } = setup({}, { maxBytes: 5_000 });
    await store.put(capture(vid(1)));
    const sets = area.calls.filter((call) => call.method !== "get").length;
    await expect(store.put(capture(vid(2), 5_000))).rejects.toThrow(/^The capture of vid00000002 is too big to keep: \d+ bytes, more than the 5000 kept in all$/);
    expect(area.calls.filter((call) => call.method !== "get").length).toBe(sets);
    expect(stored(area)).toEqual([vid(1)]);
  });

  it("orders by use even when the clock steps back", async () => {
    const area = new FakeStorageArea();
    let time = 10_000;
    const store = createCaptureStore({ area, now: () => (time -= 1_000), maxCaptures: 2 });
    await store.put(capture(vid(1)));
    await store.put(capture(vid(2)));
    await store.get(vid(1));
    await store.put(capture(vid(3)));
    expect(stored(area)).toEqual([vid(1), vid(3)]);
  });
});

describe("CaptureStore quota errors", () => {
  const small = capture(vid(1), 2_000);
  const one = bytesOf(small);

  it("evicts the oldest capture and writes again once", async () => {
    const { area, store } = setup({ quotaBytes: Math.floor(one * 3.5) });
    for (let n = 1; n <= 4; n++) await store.put(capture(vid(n), 2_000));
    expect(stored(area)).toEqual([vid(2), vid(3), vid(4)]);
    expect(indexed(area)).toEqual([vid(2), vid(3), vid(4)]);
    expect(captureWrites(area, vid(4)).map((call) => call.method === "set" && call.ok)).toEqual([false, true]);
  });

  it("treats the local area's wording as a quota error too", async () => {
    const { area, store } = setup({ kind: "local", quotaBytes: Math.floor(one * 2.5) });
    for (let n = 1; n <= 3; n++) await store.put(capture(vid(n), 2_000));
    expect(stored(area)).toEqual([vid(2), vid(3)]);
    expect(area.calls.some((call) => call.method === "set" && !call.ok)).toBe(true);
  });

  it("gives up with a clear error when the second write fails too, leaving the index consistent", async () => {
    const big = capture(vid(3), 6_000);
    // Room for one small capture and the big one, but not for the index as well.
    const { area, store } = setup({ quotaBytes: one + bytesOf(big) });
    await store.put(capture(vid(1), 2_000));
    await store.put(capture(vid(2), 2_000));
    const put = store.put(big);
    await expect(put).rejects.toThrow(
      `Storage is full: could not keep the capture of ${vid(3)} even after evicting the oldest capture (${SESSION_QUOTA_ERROR})`,
    );
    await put.catch((error: Error) => expect(error.cause).toEqual(new Error(SESSION_QUOTA_ERROR)));
    expect(captureWrites(area, vid(3))).toHaveLength(2);
    // The oldest was evicted for the retry; the index says so.
    expect(stored(area)).toEqual([vid(2)]);
    expect(indexed(area)).toEqual([vid(2)]);
    expect(await store.get(vid(2))).not.toBeNull();
  });

  it("with nothing to evict, fails after one write and does not claim an eviction", async () => {
    const big = capture(vid(1), 6_000);
    const { area, store } = setup({ quotaBytes: bytesOf(big) });
    await expect(store.put(big)).rejects.toThrow(`Storage is full: could not keep the capture of ${vid(1)} (${SESSION_QUOTA_ERROR})`);
    expect(captureWrites(area, vid(1))).toHaveLength(1);
    expect(area.keys()).toEqual([]);
  });

  it("does not retry other errors, and rewrites the index without what it evicted", async () => {
    const { area, store } = setup({}, { maxCaptures: 2 });
    await store.put(capture(vid(1)));
    await store.put(capture(vid(2)));
    area.beforeSet = (items) => {
      if (captureKey(vid(3)) in items) throw new Error("disk on fire");
    };
    await expect(store.put(capture(vid(3)))).rejects.toThrow(/^disk on fire$/);
    expect(captureWrites(area, vid(3))).toHaveLength(1);
    expect(stored(area)).toEqual([vid(2)]);
    expect(indexed(area)).toEqual([vid(2)]);
  });
});

describe("CaptureStore index healing", () => {
  it("drops an index entry whose capture is missing when it is read", async () => {
    const { area, store } = setup();
    await store.put(capture(vid(1)));
    await store.put(capture(vid(2)));
    await area.remove(captureKey(vid(1)));
    expect(await store.get(vid(1))).toBeNull();
    expect(indexed(area)).toEqual([vid(2)]);
  });

  it("ignores and removes a capture the index does not list", async () => {
    const { area, store } = setup();
    await store.put(capture(vid(1)));
    await area.set({ [captureKey(vid(2))]: capture(vid(2)) });
    expect(await store.get(vid(2))).toBeNull();
    expect(stored(area)).toEqual([vid(1)]);
    expect(indexed(area)).toEqual([vid(1)]);
  });

  it("drops a capture item that is not a capture", async () => {
    const { area, store } = setup();
    await store.put(capture(vid(1)));
    await area.set({ [captureKey(vid(1))]: { videoId: vid(1), rawStream: 5 } });
    expect(await store.get(vid(1))).toBeNull();
    expect(area.keys()).toEqual([CAPTURE_INDEX_KEY]);
    expect(indexed(area)).toEqual([]);
  });

  it("ignores a malformed index and malformed or repeated entries", async () => {
    const entry = (videoId: string, lastUsed: number) => ({ videoId, capturedAt: 1, lastUsed, bytes: bytesOf(capture(videoId)) });
    const { area, store } = setup({
      initial: {
        [CAPTURE_INDEX_KEY]: [entry(vid(1), 5), { videoId: "nope" }, entry("not an id!!", 1), entry(vid(2), 3), entry(vid(1), 9), "junk"],
        [captureKey(vid(1))]: capture(vid(1)),
        [captureKey(vid(2))]: capture(vid(2)),
      },
    });
    expect(await store.get(vid(2))).not.toBeNull();
    expect(area.snapshot()[CAPTURE_INDEX_KEY]).toEqual([entry(vid(1), 9), { ...entry(vid(2), 3), lastUsed: expect.any(Number) }]);

    await area.set({ [CAPTURE_INDEX_KEY]: "not a list" });
    expect(await store.get(vid(1))).toBeNull();
    await store.put(capture(vid(3)));
    expect(indexed(area)).toEqual([vid(3)]);
  });

  it("heals on the next read when even the index rewrite after a failed put fails", async () => {
    const { area, store } = setup({}, { maxCaptures: 1 });
    await store.put(capture(vid(1)));
    area.beforeSet = () => {
      throw new Error("read-only");
    };
    await expect(store.put(capture(vid(2)))).rejects.toThrow("read-only");
    // vid(1) was evicted to make room, but the index could not be rewritten.
    expect(stored(area)).toEqual([]);
    expect(indexed(area)).toEqual([vid(1)]);
    area.beforeSet = undefined;
    expect(await store.get(vid(1))).toBeNull();
    expect(indexed(area)).toEqual([]);
  });
});

describe("CaptureStore concurrency", () => {
  it("serialises concurrent puts and reads, so no index update is lost", async () => {
    const { area, store } = setup();
    await store.put(capture(vid(9)));
    await Promise.all([store.put(capture(vid(1))), store.get(vid(9)), store.put(capture(vid(2))), store.get(vid(1)), store.put(capture(vid(3)))]);
    expect(stored(area)).toEqual([1, 2, 3, 9].map(vid));
    // In call order: put 1 [9 1], get 9 [1 9], put 2 [1 9 2], get 1 [9 2 1], put 3 [9 2 1 3].
    expect(indexed(area)).toEqual([9, 2, 1, 3].map(vid));
  });

  it("runs the next queued operation after one fails", async () => {
    const { area, store } = setup();
    area.beforeSet = (items) => {
      if (captureKey(vid(1)) in items) throw new Error("once");
    };
    const results = await Promise.allSettled([store.put(capture(vid(1))), store.put(capture(vid(2)))]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(indexed(area)).toEqual([vid(2)]);
  });
});
