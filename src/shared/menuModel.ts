// The lyrics menu as data (PLAN.md section 3.5): what the content script's popover shows for a
// capture, in order, with a reason on every disabled item. Pure: it works from the capture
// summary (no contents), the source name BL's dock shows, and whether the capture is of the
// video that is playing. Item ids are lyricsItems.ts's: a click sends an action's id as the
// `itemId` of lyrics:download, except "recapture", which the content script handles.
//
//   [note: captured for another song]            only when the capture is not of the playing video
//   Download TTML for Tony (bold)                the Tony pick; "LRC" when the pick is an LRC
//   Download what's showing                      resolved into tony, native:<id> or ttml:<id>
//   ---
//   Other sources (header)
//   <source label> [(showing)]                   native:<id>, one per source, in capture order
//   <source label> -> TTML                       ttml:<id>, after each enhanced-LRC or QRC source
//   ---
//   Raw response (.txt)                          raw
//   Re-capture                                   recapture

import { sourcesForDisplayName } from "./blyrics";
import { convertsToTtml, nativeItemId, RAW_EXT, RAW_ITEM, RECAPTURE_ITEM, SHOWING_ITEM, TONY_ITEM, ttmlItemId } from "./lyricsItems";
import type { CaptureSummary, SourceSummary } from "./summary";
import { noPickReason, tonyLabel } from "./tonyPick";

export interface MenuItem {
  /**
   * An action's lyrics item id. Two actions can share one ("Download what's showing" repeats
   * another item); dividers, the header and the note have ids of their own, never sent anywhere.
   */
  id: string;
  kind: "action" | "divider" | "header";
  /** Empty for a divider. */
  label: string;
  /** A second line: what the file is, or which file. */
  detail?: string;
  bold?: boolean;
  /** Always false for dividers and headers. */
  enabled: boolean;
  /** Why a disabled action is disabled, for the user. */
  reason?: string;
  /** The source item of what BL is showing (its label ends with "(showing)"). */
  showing?: boolean;
}

export interface MenuInput {
  summary: CaptureSummary;
  /** The text of BL's `.blyrics-dock__source-name`, or null when the page has none (no dock). */
  showingName: string | null;
  /** False when the capture is of another video than the one playing (PLAN.md section 3.3). */
  forPlayingVideo: boolean;
}

export const OTHER_SONG_NOTE_ID = "note:other-song";
const ARROW = "\u{2192}";

export function lyricsMenu({ summary, showingName, forPlayingVideo }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [];
  if (!forPlayingVideo) {
    const title = songTitle(summary);
    items.push({ id: OTHER_SONG_NOTE_ID, kind: "action", label: "Captured for another song", detail: title, enabled: false, reason: `Captured for another song: ${title}` });
  }
  items.push(tonyItem(summary));
  const showing = forPlayingVideo ? showingSource(summary, showingName) : { reason: "Better Lyrics shows the song that is playing, which this capture is not of" };
  items.push(showingItem(summary, showing));

  if (summary.sources.length > 0) {
    items.push(divider(1), { id: "header:other-sources", kind: "header", label: "Other sources", enabled: false });
    const showingId = "source" in showing ? showing.source.id : null;
    for (const source of summary.sources) items.push(...sourceItems(summary, source, source.id === showingId));
  }

  items.push(
    divider(2),
    { id: RAW_ITEM, kind: "action", label: "Raw response (.txt)", detail: RAW_EXT, enabled: true },
    { id: RECAPTURE_ITEM, kind: "action", label: "Re-capture", enabled: true },
  );
  return items;
}

function tonyItem(summary: CaptureSummary): MenuItem {
  const pick = summary.tonyPick;
  if (!pick) {
    const reason = summary.sources.length === 0 ? "This capture has no lyrics" : noPickReason(summary.tonySkipped);
    return { id: TONY_ITEM, kind: "action", label: "Download TTML for Tony", bold: true, enabled: false, reason };
  }
  return { id: TONY_ITEM, kind: "action", label: `Download ${pick.ext === ".lrc" ? "LRC" : "TTML"} for Tony`, detail: pick.label, bold: true, enabled: true };
}

/** The source BL is showing, or why there is none to name. */
function showingSource(summary: CaptureSummary, showingName: string | null): { source: SourceSummary } | { reason: string } {
  if (showingName === null) return { reason: "Can't see which source Better Lyrics is showing" };
  const found = sourcesForDisplayName(showingName, summary.sources);
  // BL names a provider the same whatever its timing (Musixmatch word-by-word and line-synced),
  // and shows the best one unless the user picks another in its source menu: take the best.
  return found.downloadable ? { source: found.sources[0] } : { reason: found.reason };
}

/** "Download what's showing", Tony-ready: the Tony pick itself, TTML or LRC as-is, or converted TTML. */
function showingItem(summary: CaptureSummary, showing: { source: SourceSummary } | { reason: string }): MenuItem {
  const label = "Download what's showing";
  const disabled = (reason: string): MenuItem => ({ id: SHOWING_ITEM, kind: "action", label, enabled: false, reason });
  if (!("source" in showing)) return disabled(showing.reason);
  const { source } = showing;
  if (summary.tonyPick?.sourceId === source.id) return { id: TONY_ITEM, kind: "action", label, detail: summary.tonyPick.label, enabled: true };
  // A candidate the summary's Tony pick tried and could not use (too big for Tony, nothing left
  // after conversion) fails the same way with the real title.
  const skipped = summary.tonySkipped.find((entry) => entry.sourceId === source.id);
  if (skipped) return disabled(skipped.reason);
  switch (source.format) {
    case "ttml":
    case "lrc":
      return { id: nativeItemId(source.id), kind: "action", label, detail: tonyLabel(source, false), enabled: true };
    case "enhanced-lrc":
    case "qrc":
      return { id: ttmlItemId(source.id), kind: "action", label, detail: tonyLabel(source, true), enabled: true };
    case "plain":
      return disabled(`${source.label}: plain text has no timing for Tony`);
    case "json":
      return disabled(`${source.label}: not lyrics Tony can read`);
  }
}

function sourceItems(summary: CaptureSummary, source: SourceSummary, showing: boolean): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: nativeItemId(source.id),
      kind: "action",
      label: showing ? `${source.label} (showing)` : source.label,
      detail: source.ext,
      enabled: true,
      ...(showing ? { showing: true } : {}),
    },
  ];
  if (convertsToTtml(source.format)) {
    const skipped = summary.tonySkipped.find((entry) => entry.sourceId === source.id);
    items.push({
      id: ttmlItemId(source.id),
      kind: "action",
      label: `${source.label} ${ARROW} TTML`,
      detail: `.${source.id}.ttml`,
      enabled: !skipped,
      ...(skipped ? { reason: skipped.reason } : {}),
    });
  }
  return items;
}

function divider(n: number): MenuItem {
  return { id: `divider:${n}`, kind: "divider", label: "", enabled: false };
}

/** "Artist - Title" from the capture's metadata (what BL's lyrics API matched), else the video id. */
function songTitle({ metadata, videoId }: CaptureSummary): string {
  const parts = [metadata.artist, metadata.song].filter((part): part is string => part !== undefined && part.trim() !== "");
  return parts.length > 0 ? parts.join(" - ") : `video ${videoId}`;
}
