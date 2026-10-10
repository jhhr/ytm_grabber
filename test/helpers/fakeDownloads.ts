// An in-memory chrome.downloads for tests (B6; meant for reuse).
//
// What it copies from Chrome: download() resolves with a new id once the download has started,
// or rejects with "Invalid filename" for a filename chrome.downloads refuses (empty, absolute, a
// ".." or empty segment, a backslash, a character Windows forbids); the file lands at
// <downloadDir><separator><filename>, "/" turned into the folder's separator ("\" unless the
// folder is a POSIX path); conflictAction "uniquify" turns "name.ext" into "name (1).ext" when
// that path is taken (compared ignoring case for a Windows folder); search({ id }) returns copies;
// onChanged fires { id, state: { previous, current } }. Downloads stay in progress until the test
// calls complete() or interrupt(), unless `completeAtOnce` is set.
// Not copied: other conflict actions, Save As, Chrome's own file name clean-up, dangerous files.

import type { DownloadOptionsLike } from "../../src/background/downloads";
import { FakeEvent } from "./fakeStorage";

export interface FakeDownloadItem {
  id: number;
  url: string;
  /** Absolute path. */
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  byExtensionId?: string;
}

export interface FakeDownloadDelta {
  id: number;
  state?: { previous?: string; current?: string };
}

export const INVALID_FILENAME = "Invalid filename";
const WINDOWS_FORBIDDEN = /[<>:"|?*\x00-\x1F\\]/;

export class FakeDownloads {
  readonly onChanged = new FakeEvent<(delta: FakeDownloadDelta) => void>();
  readonly items: FakeDownloadItem[] = [];
  /** Every download() call's options, refused ones too. */
  readonly calls: DownloadOptionsLike[] = [];
  /** Makes the next download() reject with this message (then clears itself). */
  failNext?: string;
  /** Fires "complete" while download() is still pending (its id not yet given to the caller). */
  completeAtOnce = false;
  private nextId = 1;

  /** `extensionId` is what downloads started through download() carry as byExtensionId. */
  constructor(
    readonly extensionId: string,
    readonly downloadDir = "C:\\Users\\Tester\\Downloads",
  ) {}

  get separator(): string {
    return this.downloadDir.startsWith("/") ? "/" : "\\";
  }

  async download(options: DownloadOptionsLike): Promise<number> {
    this.calls.push({ ...options });
    if (this.failNext !== undefined) {
      const message = this.failNext;
      this.failNext = undefined;
      throw new Error(message);
    }
    const segments = options.filename.split("/");
    if (options.filename === "" || /^[A-Za-z]:/.test(options.filename) || segments.some((segment) => segment === "" || segment === "." || segment === ".." || WINDOWS_FORBIDDEN.test(segment))) {
      throw new Error(INVALID_FILENAME);
    }
    const id = this.add(this.uniquePath(segments), options.url, this.extensionId);
    if (this.completeAtOnce) this.complete(id);
    return id;
  }

  async search(query: { id?: number }): Promise<FakeDownloadItem[]> {
    return this.items.filter((item) => query.id === undefined || item.id === query.id).map((item) => ({ ...item }));
  }

  complete(id: number): void {
    this.finish(id, "complete");
  }

  interrupt(id: number): void {
    this.finish(id, "interrupted");
  }

  /** A download started by another extension or, without `byExtensionId`, by the user; returns its id. */
  addForeign(relativePath: string, byExtensionId?: string): number {
    return this.add(this.uniquePath(relativePath.split("/")), "https://example.com/file", byExtensionId);
  }

  item(id: number): FakeDownloadItem {
    const found = this.items.find((item) => item.id === id);
    if (!found) throw new Error(`no download ${id}`);
    return found;
  }

  private add(filename: string, url: string, byExtensionId: string | undefined): number {
    const id = this.nextId++;
    this.items.push({ id, url, filename, state: "in_progress", ...(byExtensionId === undefined ? {} : { byExtensionId }) });
    return id;
  }

  private finish(id: number, state: "complete" | "interrupted"): void {
    const item = this.item(id);
    const previous = item.state;
    item.state = state;
    this.onChanged.dispatch({ id, state: { previous, current: state } });
  }

  private uniquePath(segments: string[]): string {
    const path = [this.downloadDir, ...segments].join(this.separator);
    const windows = this.separator === "\\";
    const taken = (candidate: string) => this.items.some((item) => (windows ? item.filename.toLowerCase() === candidate.toLowerCase() : item.filename === candidate));
    if (!taken(path)) return path;
    const dot = path.lastIndexOf(".");
    const cut = dot > path.lastIndexOf(this.separator) ? dot : path.length;
    for (let n = 1; ; n++) {
      const candidate = `${path.slice(0, cut)} (${n})${path.slice(cut)}`;
      if (!taken(candidate)) return candidate;
    }
  }
}

/** Splits a base64 data URL: its media type with parameters, and its bytes. */
export function decodeDataUrl(url: string): { mediaType: string; bytes: Buffer } {
  const match = /^data:([^,]*);base64,(.*)$/s.exec(url);
  if (!match) throw new Error(`not a base64 data URL: ${url.slice(0, 40)}`);
  return { mediaType: match[1], bytes: Buffer.from(match[2], "base64") };
}
