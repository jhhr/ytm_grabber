// Lyrics downloads (PLAN.md section 3.6): lyrics:download makes the menu item's file from the
// stored capture (shared/lyricsFiles.ts) and hands it to chrome.downloads as a data URL; when one
// of these downloads finishes, its absolute path teaches us Chrome's download folder, kept in the
// `learnedDownloadDir` setting for the audio flow.
//
// Lyrics always go where Chrome saves downloads: the `downloadDirOverride` option only tells the
// native host where to put audio (chrome.downloads cannot write outside the download folder).
//
// sw.ts registers chrome.downloads.onChanged at top level and forwards it here; every Chrome API
// is injected so tests drive this with a fake (test/helpers/fakeDownloads.ts).

import { dirFromDownloadedPath } from "../shared/downloadDir";
import { dataUrlFor, lyricsDownloadPath, lyricsFile, stemProblem } from "../shared/lyricsFiles";
import type { LyricsDownloadRequest, LyricsDownloadResponse } from "../shared/messages";
import type { SettingsStore } from "../shared/settings";
import type { CaptureStore } from "./store";

const LOG_PREFIX = "[YTM Practice Grabber]";

// --- Seams: the slice of chrome.downloads used here --------------------------------------------

export interface DownloadOptionsLike {
  url: string;
  /** Relative to Chrome's download folder; "/" separates folders on every platform. */
  filename: string;
  conflictAction: "uniquify";
  saveAs: boolean;
}

export interface DownloadItemLike {
  /** Absolute path of the file on disk. */
  filename: string;
  /** Set when an extension started the download. */
  byExtensionId?: string;
}

export interface DownloadsApi {
  /** Resolves with the download id once Chrome has started it; rejects e.g. with "Invalid filename". */
  download(options: DownloadOptionsLike): Promise<number>;
  search(query: { id: number }): Promise<DownloadItemLike[]>;
}

/** chrome.downloads.onChanged's argument, the fields read here. */
export interface DownloadDeltaLike {
  id: number;
  state?: { current?: string };
}

export interface LyricsDownloadsDeps {
  downloads: DownloadsApi;
  store: Pick<CaptureStore, "get">;
  settings: Pick<SettingsStore, "getSettings" | "setSettings">;
  /** chrome.runtime.id: only this extension's downloads teach the download folder. */
  extensionId: string;
  log?: Pick<Console, "warn">;
}

/** Bound methods: sw.ts passes them on as they are. */
export interface LyricsDownloads {
  /**
   * Answers lyrics:download. Every expected failure resolves `{ ok: false, error }` with a sentence
   * for the user; a storage failure rejects, and the message listener answers it as an error.
   */
  download(request: LyricsDownloadRequest): Promise<LyricsDownloadResponse>;
  /** chrome.downloads.onChanged */
  handleChanged(delta: DownloadDeltaLike): void;
}

export function createLyricsDownloads({ downloads, store, settings, extensionId, log = console }: LyricsDownloadsDeps): LyricsDownloads {
  // Download id -> the relative path we asked for, until the download completes or fails. In
  // memory only: a download that finishes after the worker restarted teaches nothing, and the
  // next one will (a data URL download takes milliseconds, so this is rare).
  const asked = new Map<number, string>();
  // Downloads whose id Chrome has not given us yet (each settles once it has, or has failed):
  // their onChanged may come first.
  const starting = new Set<Promise<void>>();

  async function download({ videoId, itemId, stem }: LyricsDownloadRequest): Promise<LyricsDownloadResponse> {
    const problem = stemProblem(stem, videoId);
    if (problem) return { ok: false, error: problem };
    const capture = await store.get(videoId);
    if (!capture) return { ok: false, error: "This song's capture is no longer kept (a browser restart or newer captures removed it): capture it again" };
    const made = lyricsFile(itemId, capture, stem);
    if (!made.ok) return made;
    const { perSongSubfolder } = await settings.getSettings();
    const filename = lyricsDownloadPath(stem, made.file.name, perSongSubfolder);

    // Marked before the call: Chrome may report the download finished before it gives us its id.
    let settled!: () => void;
    const pending = new Promise<void>((resolve) => (settled = resolve));
    starting.add(pending);
    try {
      asked.set(await downloads.download({ url: dataUrlFor(made.file.content, made.file.mime), filename, conflictAction: "uniquify", saveAs: false }), filename);
    } catch (error) {
      return { ok: false, error: `Chrome did not save ${made.file.name}: ${messageOf(error)}` };
    } finally {
      starting.delete(pending);
      settled();
    }
    return { ok: true };
  }

  async function learnFrom(id: number, completed: boolean): Promise<void> {
    if (!asked.has(id) && starting.size > 0) await Promise.allSettled([...starting]);
    const relative = asked.get(id);
    asked.delete(id);
    // Not one of ours (or asked for before the worker restarted), or it failed.
    if (relative === undefined || !completed) return;
    const [item] = await downloads.search({ id });
    if (!item || item.byExtensionId !== extensionId) return;
    const dir = dirFromDownloadedPath(item.filename, relative);
    // The file is not where we asked (a Save As dialog, say): nothing to learn.
    if (dir === null) return;
    const { learnedDownloadDir } = await settings.getSettings();
    if (dir !== learnedDownloadDir) await settings.setSettings({ learnedDownloadDir: dir });
  }

  return {
    download,
    handleChanged(delta) {
      const state = delta.state?.current;
      if (state !== "complete" && state !== "interrupted") return;
      learnFrom(delta.id, state === "complete").catch((error: unknown) => {
        // No paths in the log: only that it failed and Chrome's or the storage's words.
        log.warn(`${LOG_PREFIX} could not learn the download folder: ${messageOf(error)}`);
      });
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
