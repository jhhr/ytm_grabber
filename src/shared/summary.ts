// What a capture is (the raw inputs the store keeps, PLAN.md section 3.4) and what the content
// script gets to see of it: a summary with every source's name, format and size and the Tony
// pick, but never a source's content. Contents stay in the service worker, which derives them
// from the stored stream when a download asks for one (B6).

import type { LyricsMetadata, LyricsSource, SourceFormat, Timing } from "./sources";
import { pickForTony } from "./tonyPick";

/** Which of the three ways of reading the lyrics response delivered the body (PLAN.md section 3.3). */
export type BodySource = "getResponseBody" | "stream" | "eventSource";

export const BODY_SOURCES: readonly BodySource[] = ["getResponseBody", "stream", "eventSource"];

/**
 * One capture as stored: raw inputs only (lead decision in PLAN.md section 3.4). Sources are
 * derived again with parseSse() + extractSources() on every read, which is cheap and keeps a
 * capture at about the size of its stream.
 */
export interface StoredCapture {
  videoId: string;
  /** Milliseconds since the epoch, when the capture finished. */
  capturedAt: number;
  metadata: LyricsMetadata;
  /** The lyrics stream exactly as received (the raw download). */
  rawStream: string;
  /** The Unison response body, when Unison answered. */
  unisonRaw?: string;
  bodySource: BodySource;
}

export interface SourceSummary {
  id: string;
  label: string;
  timing: Timing;
  format: SourceFormat;
  ext: string;
  /** UTF-8 bytes of the content, which is what the download writes. */
  size: number;
  blDisplayName?: string;
}

export interface TonyPickSummary {
  sourceId: string;
  /** Menu text, e.g. "Better Lyrics \u{2014} word timing" (an em dash). */
  label: string;
  timing: Timing;
  converted: boolean;
  ext: ".ttml" | ".lrc";
}

export interface CaptureSummary {
  videoId: string;
  capturedAt: number;
  metadata: LyricsMetadata;
  bodySource: BodySource;
  /** In the order extractSources() gives them. */
  sources: SourceSummary[];
  tonyPick: TonyPickSummary | null;
  /** Candidates tried before the pick that Tony would refuse, e.g. a TTML over 1 MiB. */
  tonySkipped: { sourceId: string; reason: string }[];
}

// The Tony pick's file name and the <ttm:title> of converted TTML come from the stem, which the
// content script sends with each download from YTM's now-playing info (PLAN.md section 7.1, stem
// decision); the capture does not have it. The summary only needs to know WHICH source wins, so
// the pick runs with placeholders and its filename and content are dropped. B6 makes the real
// file with the real stem and title. (A converted TTML within a title's length of 1 MiB could
// pass here and fail there; B6 has to check tonyReady() again anyway.)
const PLACEHOLDER_STEM = "";
const PLACEHOLDER_TITLE = "";

/** `sources` are the capture's derived sources (CaptureStore.get() returns them). */
export function summarize(capture: StoredCapture, sources: readonly LyricsSource[]): CaptureSummary {
  const { pick, skipped } = pickForTony(sources, { stem: PLACEHOLDER_STEM, title: PLACEHOLDER_TITLE, metadata: capture.metadata });
  // Every field is copied by name: spreading a capture or a source would carry its contents.
  return {
    videoId: capture.videoId,
    capturedAt: capture.capturedAt,
    metadata: metadataOf(capture.metadata),
    bodySource: capture.bodySource,
    sources: sources.map(sourceSummary),
    tonyPick: pick && { sourceId: pick.source.id, label: pick.label, timing: pick.timing, converted: pick.converted, ext: pick.ext },
    tonySkipped: skipped.map(({ sourceId, reason }) => ({ sourceId, reason })),
  };
}

function sourceSummary(source: LyricsSource): SourceSummary {
  const { id, label, timing, format, ext, blDisplayName } = source;
  const size = new TextEncoder().encode(source.content).length;
  return { id, label, timing, format, ext, size, ...(blDisplayName === undefined ? {} : { blDisplayName }) };
}

function metadataOf({ song, artist, album, duration, videoId }: LyricsMetadata): LyricsMetadata {
  const metadata: LyricsMetadata = {};
  if (song !== undefined) metadata.song = song;
  if (artist !== undefined) metadata.artist = artist;
  if (album !== undefined) metadata.album = album;
  if (duration !== undefined) metadata.duration = duration;
  if (videoId !== undefined) metadata.videoId = videoId;
  return metadata;
}
