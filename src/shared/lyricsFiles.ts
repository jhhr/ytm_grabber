// The file behind a lyrics menu item (lyricsItems.ts), made in the service worker from the stored
// capture (PLAN.md sections 3.5 and 3.6). Names all start with the stem the content script sends,
// built by buildStem() from YTM's now-playing info (PLAN.md section 7.1, stem decision), so the
// audio file and every lyrics file sort together:
//
//   tony             <stem>.ttml or <stem>.lrc (no infix: the obvious file to import into Tony)
//   native:<source>  <stem><source ext>, e.g. <stem>.golyrics.ttml, <stem>.musixmatch-word.lrc
//   ttml:<source>    <stem>.<source>.ttml, e.g. <stem>.musixmatch-word.ttml, <stem>.qq.ttml
//   raw              <stem>.lyrics-stream.txt
//
// with the per-song subfolder option: <stem>/<name>. Contents are the source text exactly as
// captured for every as-is file (golyrics TTML reaches Tony byte for byte), or what tonyReady()
// converts; BL's per-song offset is never applied (the content script tells the user about it).

import { sanitizeFilename } from "./filenames";
import { convertsToTtml, parseDownloadItemId, RAW_EXT } from "./lyricsItems";
import type { LyricsMetadata, LyricsSource } from "./sources";
import { noPickReason, pickForTony, tonyReady, type TonyContext } from "./tonyPick";

const TTML_MIME = "application/ttml+xml";
const TEXT_MIME = "text/plain";

/** What lyricsFile() reads of a capture; the store's LoadedCapture has it all. */
export interface CaptureContents {
  videoId: string;
  metadata: LyricsMetadata;
  rawStream: string;
  sources: readonly LyricsSource[];
}

export interface LyricsFile {
  /** `<stem><ext>`, without the per-song folder (lyricsDownloadPath() adds it). */
  name: string;
  content: string;
  mime: string;
}

export type LyricsFileResult = { ok: true; file: LyricsFile } | { ok: false; error: string };

/**
 * Why `stem` cannot name this video's files, or null when it can. A stem from buildStem() always
 * can: it is a fixed point of sanitizeFilename() and ends with " [videoId]" (or is "[videoId]").
 * Anything else did not come from buildStem(), so it is refused rather than quietly changed: the
 * lyrics would no longer share their name with the audio file, and the title of converted TTML
 * is the stem without that suffix.
 */
export function stemProblem(stem: string, videoId: string): string | null {
  if (sanitizeFilename(stem) !== stem) return `Not a usable file name: ${JSON.stringify(stem)}`;
  if (stem !== `[${videoId}]` && !stem.endsWith(` [${videoId}]`)) {
    return `The file name ${JSON.stringify(stem)} does not end with this song's video id [${videoId}]`;
  }
  return null;
}

/** "Artist - Title": the stem without its " [videoId]" suffix; "" for a stem that is only "[videoId]". */
export function titleFromStem(stem: string, videoId: string): string {
  const suffix = `[${videoId}]`;
  if (stem === suffix) return "";
  return stem.endsWith(` ${suffix}`) ? stem.slice(0, -(suffix.length + 1)) : stem;
}

/**
 * The file for menu item `itemId`, or why there is none (a sentence for the user). The Tony pick
 * and converted TTML are made again here with the real stem and title: the capture summary's
 * pick ran with placeholders. `stem` must have passed stemProblem().
 */
export function lyricsFile(itemId: string, capture: CaptureContents, stem: string): LyricsFileResult {
  const item = parseDownloadItemId(itemId);
  if (!item) return { ok: false, error: `Unknown lyrics menu item ${JSON.stringify(itemId)}` };
  const ctx: TonyContext = { stem, title: titleFromStem(stem, capture.videoId), metadata: capture.metadata };

  switch (item.kind) {
    case "raw":
      return ok(`${stem}${RAW_EXT}`, capture.rawStream, TEXT_MIME);
    case "tony": {
      const { pick, skipped } = pickForTony(capture.sources, ctx);
      if (!pick) return { ok: false, error: noPickReason(skipped) };
      return ok(pick.filename, pick.content, pick.ext === ".ttml" ? TTML_MIME : TEXT_MIME);
    }
    case "native": {
      const source = capture.sources.find((candidate) => candidate.id === item.sourceId);
      if (!source) return notCaptured(item.sourceId);
      return ok(`${stem}${source.ext}`, source.content, source.mime);
    }
    case "ttml": {
      const source = capture.sources.find((candidate) => candidate.id === item.sourceId);
      if (!source) return notCaptured(item.sourceId);
      if (!convertsToTtml(source.format)) return { ok: false, error: `${source.label} is not converted to TTML` };
      const ready = tonyReady(source, ctx);
      if (!ready.ok) return { ok: false, error: `${source.label}: ${ready.reason}` };
      return ok(`${stem}.${source.id}.ttml`, ready.content, TTML_MIME);
    }
  }
}

/** The path chrome.downloads gets, relative to Chrome's download folder ("/" works on Windows too). */
export function lyricsDownloadPath(stem: string, name: string, perSongSubfolder: boolean): string {
  return perSongSubfolder ? `${stem}/${name}` : name;
}

/**
 * A data URL holding `content` as UTF-8 with no byte order mark (Tony takes a file for TTML when
 * its first character is "<"). Base64 of TextEncoder's bytes rather than encodeURIComponent,
 * which throws on a lone surrogate (JSON can carry "\ud800"): TextEncoder writes U+FFFD for one,
 * the only change a file can see. Service workers have no URL.createObjectURL.
 */
export function dataUrlFor(content: string, mime: string): string {
  const bytes = new TextEncoder().encode(content);
  // btoa() takes one character per byte; String.fromCharCode() takes a bounded number of arguments.
  const CHUNK = 0x8000;
  let binary = "";
  for (let start = 0; start < bytes.length; start += CHUNK) binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  return `data:${mime};charset=utf-8;base64,${btoa(binary)}`;
}

function ok(name: string, content: string, mime: string): LyricsFileResult {
  return { ok: true, file: { name, content, mime } };
}

function notCaptured(sourceId: string): LyricsFileResult {
  return { ok: false, error: `There is no ${sourceId} source in this capture` };
}
