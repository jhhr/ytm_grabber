// The capture store (PLAN.md section 3.4): captures in chrome.storage.session (10 MiB, cleared
// when the browser closes, not readable by content scripts), one item per capture plus a small
// index, so eviction never has to load the captures themselves.
//
//   "capture:<videoId>"  StoredCapture: raw inputs only (lead decision); sources are derived on read
//   "capture:index"      IndexEntry[], least recently used first
//
// Kept: the 30 most recently used captures, at most ~8 MiB in all by Chrome's local-area rule
// (key + JSON in UTF-8), which over-counts what the session area charges for long strings. A
// write that still hits the quota evicts the oldest capture and is tried once more.
//
// Consistency: a capture and the index are written in one set() call, which Chrome applies
// whole or not at all. Evicted captures are removed before that write, to make room; if the
// write then fails the index is rewritten without them, and if even that fails, get() drops
// index entries whose capture is missing. A capture the index does not list is treated as
// absent (and removed when get() meets it).
//
// Writes are serialised through one promise chain, so two captures finishing at once (two
// tabs) cannot interleave their index updates. That only holds within one store: the service
// worker creates exactly one.

import { isVideoId } from "../shared/filenames";
import { extractSources, type LyricsSource } from "../shared/sources";
import { parseSse } from "../shared/sse";
import { isQuotaError, storedItemBytes, type StorageAreaLike } from "../shared/storageArea";
import { BODY_SOURCES, type StoredCapture } from "../shared/summary";

export const MAX_CAPTURES = 30;
/** Of chrome.storage.session's 10 MiB; the rest is headroom for the index and estimate error. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const CAPTURE_INDEX_KEY = "capture:index";

export function captureKey(videoId: string): string {
  return `capture:${videoId}`;
}

export interface IndexEntry {
  videoId: string;
  capturedAt: number;
  /** When the capture was last stored or read; the index is kept in this order. */
  lastUsed: number;
  /** storedItemBytes() of its item. */
  bytes: number;
}

/** A stored capture with its sources derived (parseSse + extractSources). */
export interface LoadedCapture extends StoredCapture {
  sources: LyricsSource[];
}

export interface CaptureStore {
  /**
   * Stores (or replaces) the capture of `capture.videoId`, evicting the least recently used
   * captures beyond MAX_CAPTURES or MAX_CAPTURE_BYTES. Rejects with an Error that says why when
   * it cannot be kept: a capture bigger than the whole budget, or storage still full after
   * evicting the oldest capture and trying again.
   */
  put(capture: StoredCapture): Promise<void>;
  /** The capture with its sources, or null; reading makes it the most recently used. */
  get(videoId: string): Promise<LoadedCapture | null>;
}

export interface CaptureStoreOptions {
  area: StorageAreaLike;
  /** Milliseconds since the epoch; Date.now by default. */
  now?: () => number;
  maxCaptures?: number;
  maxBytes?: number;
}

export function createCaptureStore({ area, now = Date.now, maxCaptures = MAX_CAPTURES, maxBytes = MAX_CAPTURE_BYTES }: CaptureStoreOptions): CaptureStore {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `task` after every task queued before it has settled. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }

  async function loadIndex(): Promise<IndexEntry[]> {
    return readIndex((await area.get(CAPTURE_INDEX_KEY))[CAPTURE_INDEX_KEY]);
  }

  /** A use time no earlier than any in the index, so the index order and lastUsed agree even if the clock steps back. */
  function stamp(index: readonly IndexEntry[]): number {
    return Math.max(now(), ...index.map((entry) => entry.lastUsed));
  }

  async function put(capture: StoredCapture): Promise<void> {
    const record = storedCapture(capture);
    const key = captureKey(record.videoId);
    const bytes = storedItemBytes(key, record);
    if (bytes > maxBytes) {
      throw new Error(`The capture of ${record.videoId} is too big to keep: ${bytes} bytes, more than the ${maxBytes} kept in all`);
    }
    const index = await loadIndex();
    // The capture's earlier version, if any, is replaced in place by the write below.
    const kept = index.filter((entry) => entry.videoId !== record.videoId);
    const evicted: IndexEntry[] = [];
    const total = () => kept.reduce((sum, entry) => sum + entry.bytes, 0);
    while (kept.length > 0 && (kept.length + 1 > maxCaptures || total() + bytes > maxBytes)) evicted.push(kept.shift()!);
    const entry: IndexEntry = { videoId: record.videoId, capturedAt: record.capturedAt, lastUsed: stamp(index), bytes };
    const write = () => area.set({ [key]: record, [CAPTURE_INDEX_KEY]: [...kept, entry] });

    const removed: IndexEntry[] = [];
    const evict = async (entries: IndexEntry[]) => {
      if (entries.length === 0) return;
      await area.remove(entries.map((gone) => captureKey(gone.videoId)));
      removed.push(...entries);
    };
    try {
      await evict(evicted);
      let full: unknown;
      try {
        return await write();
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        full = error;
      }
      // The estimate was low (or something else uses the area): evict the oldest and try once more.
      let retried = false;
      if (kept.length > 0) {
        await evict([kept.shift()!]);
        retried = true;
        try {
          return await write();
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          full = error;
        }
      }
      const reason = full instanceof Error ? full.message : String(full);
      throw new Error(
        `Storage is full: could not keep the capture of ${record.videoId}${retried ? " even after evicting the oldest capture" : ""} (${reason})`,
        { cause: full },
      );
    } catch (error) {
      // The failed write changed nothing, but the removals happened: keep the index from
      // listing captures that are gone (best effort; get() drops such entries too).
      if (removed.length > 0) await area.set({ [CAPTURE_INDEX_KEY]: index.filter((old) => !removed.includes(old)) }).catch(() => undefined);
      throw error;
    }
  }

  async function load(videoId: string): Promise<StoredCapture | null> {
    const key = captureKey(videoId);
    const items = await area.get([CAPTURE_INDEX_KEY, key]);
    const index = readIndex(items[CAPTURE_INDEX_KEY]);
    const value = items[key];
    const position = index.findIndex((entry) => entry.videoId === videoId);
    if (position < 0) {
      // Not listed, so not stored as far as anyone was told: never returned, and its space is
      // not counted, so free it.
      if (value !== undefined) await area.remove(key).catch(() => undefined);
      return null;
    }
    const [entry] = index.splice(position, 1);
    if (!isStoredCapture(value, videoId)) {
      // Missing or unreadable: drop it from the index (best effort; a later get() tries again).
      await area.set({ [CAPTURE_INDEX_KEY]: index }).catch(() => undefined);
      if (value !== undefined) await area.remove(key).catch(() => undefined);
      return null;
    }
    // Most recently used now. Failing to record that only leaves the capture's LRU position
    // stale, so it does not fail the read.
    await area.set({ [CAPTURE_INDEX_KEY]: [...index, { ...entry, lastUsed: stamp(index.concat(entry)) }] }).catch(() => undefined);
    return value;
  }

  return {
    put: (capture) => serial(() => put(capture)),
    async get(videoId) {
      if (!isVideoId(videoId)) return null;
      const capture = await serial(() => load(videoId));
      return capture && { ...capture, sources: extractSources(parseSse(capture.rawStream), capture.unisonRaw).sources };
    },
  };
}

/** Exactly the stored fields, so nothing derived (or secret) a caller added gets stored. */
function storedCapture(capture: StoredCapture): StoredCapture {
  const { videoId, capturedAt, metadata, rawStream, unisonRaw, bodySource } = capture;
  const record: StoredCapture = { videoId, capturedAt, metadata, rawStream, bodySource };
  if (unisonRaw !== undefined) record.unisonRaw = unisonRaw;
  if (typeof videoId !== "string" || !isVideoId(videoId) || !isStoredCapture(record, videoId)) {
    throw new TypeError(`Not a capture that can be stored (video id ${JSON.stringify(videoId)})`);
  }
  return record;
}

function isStoredCapture(value: unknown, videoId: string): value is StoredCapture {
  if (!isRecord(value)) return false;
  const { capturedAt, metadata, rawStream, unisonRaw, bodySource } = value;
  return (
    value.videoId === videoId &&
    typeof capturedAt === "number" &&
    Number.isFinite(capturedAt) &&
    isRecord(metadata) &&
    typeof rawStream === "string" &&
    (unisonRaw === undefined || typeof unisonRaw === "string") &&
    (BODY_SOURCES as readonly unknown[]).includes(bodySource)
  );
}

/** The stored index, least recently used first; entries that are malformed are dropped, and of two for one video the later one is kept. */
function readIndex(value: unknown): IndexEntry[] {
  if (!Array.isArray(value)) return [];
  const byVideo = new Map<string, IndexEntry>();
  for (const item of value) {
    if (!isIndexEntry(item)) continue;
    byVideo.delete(item.videoId);
    byVideo.set(item.videoId, { videoId: item.videoId, capturedAt: item.capturedAt, lastUsed: item.lastUsed, bytes: item.bytes });
  }
  // Stable: entries used at the same millisecond keep their order.
  return [...byVideo.values()].sort((a, b) => a.lastUsed - b.lastUsed);
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (!isRecord(value)) return false;
  const { videoId, capturedAt, lastUsed, bytes } = value;
  return (
    typeof videoId === "string" &&
    isVideoId(videoId) &&
    typeof capturedAt === "number" &&
    Number.isFinite(capturedAt) &&
    typeof lastUsed === "number" &&
    Number.isFinite(lastUsed) &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
