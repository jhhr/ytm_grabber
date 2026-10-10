// Lyrics menu item ids: the contract between the menu model (menuModel.ts), the content script
// that renders it, and the service worker that saves the files (`itemId` of lyrics:download).
//
//   tony              the Tony pick (PLAN.md section 3.2.3): <stem>.ttml, or <stem>.lrc
//   native:<source>   a captured source as it came: <stem><source ext>, e.g. <stem>.golyrics.ttml
//   ttml:<source>     an enhanced-LRC or QRC source converted to TTML: <stem>.<source>.ttml
//   raw               the whole lyrics stream: <stem>.lyrics-stream.txt
//   showing           "Download what's showing": the menu model resolves it into one of the
//                     above, and keeps this id only on the item when it is disabled
//   recapture         an action of the content script; never sent to the service worker
//
// <source> is a LyricsSource id (sources.ts): the fixed ids, "unison", or an unknown provider's
// name made of lower-case letters, digits, "_" and "-". Only tony, native:, ttml: and raw are
// downloads; the service worker refuses anything else.

import type { SourceFormat } from "./sources";

export const TONY_ITEM = "tony";
export const RAW_ITEM = "raw";
export const SHOWING_ITEM = "showing";
export const RECAPTURE_ITEM = "recapture";

/** The raw item's file: `<stem>.lyrics-stream.txt`. */
export const RAW_EXT = ".lyrics-stream.txt";

const NATIVE_PREFIX = "native:";
const TTML_PREFIX = "ttml:";
// sources.ts makes unknown ids at most 40 characters plus "-raw"; the rest is headroom.
const SOURCE_ID = /^[a-z0-9_-]{1,64}$/;

/** What a download item id asks for. */
export type DownloadItem = { kind: "tony" } | { kind: "raw" } | { kind: "native"; sourceId: string } | { kind: "ttml"; sourceId: string };

export function nativeItemId(sourceId: string): string {
  return NATIVE_PREFIX + sourceId;
}

export function ttmlItemId(sourceId: string): string {
  return TTML_PREFIX + sourceId;
}

/** The download an item id asks for, or null when it is not one (showing, recapture, anything malformed). */
export function parseDownloadItemId(itemId: string): DownloadItem | null {
  if (itemId === TONY_ITEM) return { kind: "tony" };
  if (itemId === RAW_ITEM) return { kind: "raw" };
  for (const [prefix, kind] of [
    [NATIVE_PREFIX, "native"],
    [TTML_PREFIX, "ttml"],
  ] as const) {
    if (!itemId.startsWith(prefix)) continue;
    const sourceId = itemId.slice(prefix.length);
    return SOURCE_ID.test(sourceId) ? { kind, sourceId } : null;
  }
  return null;
}

export function isDownloadItemId(value: unknown): value is string {
  return typeof value === "string" && parseDownloadItemId(value) !== null;
}

/**
 * Formats that get a "-> TTML" item: the ones tonyReady() converts (enhanced LRC from Musixmatch
 * word-by-word or Unison richsync, and QQ's QRC). TTML and LRC are Tony-ready as they are.
 */
export function convertsToTtml(format: SourceFormat): boolean {
  return format === "enhanced-lrc" || format === "qrc";
}
