// Better Lyrics' page structure and source names, in one place: when BL changes, this file is
// what to check (PLAN.md sections 1.4 and 1.5).
// verified against Better Lyrics 3.0.0.4 (src/modules/ui/dom.ts mountDock(),
// src/modules/ui/lyricsDock/controls.ts buildControlsSegment(), src/core/constants.ts
// PROVIDER_CONFIGS; the lyrics wrapper ids from @braccato/core 1.16.3 constants)

import type { LyricsSource } from "./sources";

export const BL_VERIFIED_VERSION = "3.0.0.4";

export const BL_SELECTORS = {
  /** YouTube Music's side panel, which holds BL's dock and lyrics. */
  sidePanel: "#side-panel",
  /** Carries `data-position` ("top-..." opens menus downwards); persists across songs. */
  dock: ".blyrics-dock",
  /** Persists across songs: our lyrics button goes in here, after the controls. */
  dockInner: ".blyrics-dock__inner",
  /** Replaced on every song or source switch: never insert into it. */
  controls: ".blyrics-dock__controls",
  /** Clicking it makes BL fetch the lyrics again; it may be absent (dock controls are configurable). */
  refresh: ".blyrics-dock__refresh",
  /** Added to the refresh button while BL refreshes; only a rebuild of the controls takes it away. */
  refreshBusy: ".blyrics-dock__refresh--busy",
  /** The display name of the source BL shows. Its sibling `__source-position` ("2/5") is not part of it. */
  sourceName: ".blyrics-dock__source-name",
  /** The per-song offset, e.g. "+0.2s". BL's offset menu, rendered in <body>, has values of the same class. */
  offsetValue: ".blyrics-dock__offset > .blyrics-dock__offset-value",
  /** Where BL renders lyrics (LYRICS_WRAPPER_ID): lyrics up but no dock means the fallback button. */
  lyricsWrapper: "#blyrics-wrapper",
  /** BL's lyrics container (LYRICS_CLASS). */
  lyricsContainer: ".blyrics-container",
} as const;

/** The dock's attribute naming its corner, e.g. "bottom-right". */
export const BL_DOCK_POSITION_ATTRIBUTE = "data-position";

// BL writes its per-song offset as `${value > 0 ? "+" : ""}${value.toFixed(1)}s` ("+0.2s",
// "-1.5s", "0.0s", even "-0.0s"). Read leniently in case that changes: an optional sign (also
// U+2212), a decimal point or comma, white space, and an optional unit (seconds unless "ms").
const OFFSET_TEXT = /^([+\-\u{2212}]?)\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*(ms|s|secs?|seconds?)?$/iu;

/** BL's per-song offset text in seconds, or null when it is not a number (`-0.0s` is zero). */
export function parseBlOffset(text: string): number | null {
  const match = OFFSET_TEXT.exec(text.trim());
  if (!match) return null;
  const [, sign, digits, unit] = match;
  const value = Number(digits.replace(",", ".")) / (unit?.toLowerCase() === "ms" ? 1000 : 1);
  if (!Number.isFinite(value)) return null;
  // No negative zero: "-0.0s" is plain 0.
  return sign === "" || sign === "+" || value === 0 ? value : -value;
}

// Display name -> our source ids, best first. BL names a provider the same whatever its timing
// (Musixmatch word-by-word and line-synced are both "Musixmatch"), so a name can mean several
// sources. Names are not localised.
const DISPLAY_NAME_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ["Better Lyrics", ["golyrics"]],
  ["Unison", ["unison"]],
  ["BiniLyrics", ["binimum"]],
  ["Better Lyrics Portato", ["qq"]],
  ["Musixmatch", ["musixmatch-word", "musixmatch"]],
  ["LRCLib", ["lrclib", "lrclib-plain"]],
  ["Better Lyrics Legato", ["kugou"]],
]);
/** Lyrics and captions BL takes from YouTube itself, never from the request we capture. */
const YOUTUBE_NAMES: ReadonlySet<string> = new Set(["YouTube", "YouTube Captions"]);

export type ShowingSources<S = LyricsSource> =
  /** The capture's sources that BL shows under this name, best first; never empty. */
  | { downloadable: true; sources: S[] }
  | { downloadable: false; why: "youtube" | "not-captured" | "unknown-name"; reason: string };

/**
 * The captured sources behind the name `.blyrics-dock__source-name` shows (trimmed, exact case).
 * Not downloadable, with a reason for the menu: YouTube's own lyrics or captions, a known name
 * whose sources are not in this capture, and a name this map does not know. Works on sources
 * and on their summaries (the menu model's input), which carry the same id and display name.
 */
export function sourcesForDisplayName<S extends Pick<LyricsSource, "id" | "blDisplayName">>(displayName: string, sources: readonly S[]): ShowingSources<S> {
  const name = displayName.trim();
  if (YOUTUBE_NAMES.has(name)) {
    return { downloadable: false, why: "youtube", reason: `${name} lyrics come from YouTube itself, not from the captured lyrics request` };
  }
  const ids = DISPLAY_NAME_SOURCES.get(name);
  if (!ids) {
    return {
      downloadable: false,
      why: "unknown-name",
      reason: name === "" ? "Better Lyrics shows no source name" : `Unknown lyrics source "${name}" (checked with Better Lyrics ${BL_VERIFIED_VERSION})`,
    };
  }
  // Raw JSON kept for an undecodable payload has the provider's id but no display name: BL never showed it.
  const found = ids.flatMap((id) => sources.filter((source) => source.id === id && source.blDisplayName === name));
  return found.length > 0
    ? { downloadable: true, sources: found }
    : { downloadable: false, why: "not-captured", reason: `${name} lyrics are not in this capture` };
}
