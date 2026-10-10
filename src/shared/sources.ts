// Turns the parsed lyrics stream and the Unison response into downloadable sources, one
// per file in PLAN.md section 1.5. Decoding mirrors Better Lyrics' processStreamData() and
// unison.ts (verified against Better Lyrics 3.0.0.4, src/modules/lyrics/providers/), so a
// source exists here when BL had the same text to show. Content is kept exactly as BL
// decoded it: golyrics TTML in particular must reach Tony byte for byte.

import { isVideoId } from "./filenames";
import type { SseEvent } from "./sse";

export type Timing = "word" | "syllable" | "line" | "plain" | "unknown";

/** What a source's content is, so converters and the Tony pick dispatch on it instead of sniffing. */
export type SourceFormat = "ttml" | "lrc" | "enhanced-lrc" | "qrc" | "plain" | "json";

export interface LyricsSource {
  /** A key of SOURCE_FORMATS, "unison", or an unknown provider's sanitised name. */
  id: string;
  /** The SSE provider name as sent, or "unison". */
  provider: string;
  /** What `.blyrics-dock__source-name` shows while BL displays this source; absent for raw JSON. */
  blDisplayName?: string;
  /** Menu text, e.g. "Better Lyrics \u{2014} TTML, word-synced" (an em dash). */
  label: string;
  timing: Timing;
  format: SourceFormat;
  /** Appended to the shared stem, e.g. ".golyrics.ttml". */
  ext: string;
  mime: string;
  content: string;
}

/** From the stream's `metadata` event; every field is optional. */
export interface LyricsMetadata {
  song?: string;
  artist?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  videoId?: string;
}

export interface ExtractedSources {
  metadata: LyricsMetadata;
  /** In stream order, Unison last. */
  sources: LyricsSource[];
}

/**
 * The format of every source whose format is fixed. Unison's follows its response ("ttml",
 * "enhanced-lrc" for richsync LRC, "lrc", "plain"); raw results kept as JSON (unknown
 * providers, or a payload that could not be decoded) are "json".
 */
export const SOURCE_FORMATS = {
  golyrics: "ttml",
  binimum: "ttml",
  "musixmatch-word": "enhanced-lrc",
  musixmatch: "lrc",
  lrclib: "lrc",
  "lrclib-plain": "plain",
  qq: "qrc",
  kugou: "lrc",
} as const satisfies Record<string, SourceFormat>;

export type FixedSourceId = keyof typeof SOURCE_FORMATS;

// Display names are BL's PROVIDER_CONFIGS (src/core/constants.ts, Better Lyrics 3.0.0.4).
const FIXED: Record<FixedSourceId, { provider: string; blDisplayName: string; ext: string }> = {
  golyrics: { provider: "golyrics", blDisplayName: "Better Lyrics", ext: ".golyrics.ttml" },
  binimum: { provider: "binimum", blDisplayName: "BiniLyrics", ext: ".binimum.ttml" },
  "musixmatch-word": { provider: "musixmatch", blDisplayName: "Musixmatch", ext: ".musixmatch-word.lrc" },
  musixmatch: { provider: "musixmatch", blDisplayName: "Musixmatch", ext: ".musixmatch.lrc" },
  lrclib: { provider: "lrclib", blDisplayName: "LRCLib", ext: ".lrclib.lrc" },
  "lrclib-plain": { provider: "lrclib", blDisplayName: "LRCLib", ext: ".lrclib.txt" },
  qq: { provider: "qq", blDisplayName: "Better Lyrics Portato", ext: ".qq.qrc.xml" },
  kugou: { provider: "kugou", blDisplayName: "Better Lyrics Legato", ext: ".kugou.lrc" },
};

const UNISON = "unison";
const UNISON_DISPLAY_NAME = "Unison";
const KNOWN_IDS: ReadonlySet<string> = new Set([...Object.keys(FIXED), UNISON]);

const MIME: Record<SourceFormat, string> = {
  ttml: "application/ttml+xml",
  lrc: "text/plain",
  "enhanced-lrc": "text/plain",
  qrc: "application/xml",
  plain: "text/plain",
  json: "application/json",
};

const FORMAT_NAMES: Record<SourceFormat, string> = {
  ttml: "TTML",
  lrc: "LRC",
  "enhanced-lrc": "LRC",
  qrc: "QRC",
  plain: "plain text",
  json: "raw JSON",
};

const TIMING_NAMES: Record<Timing, string> = {
  word: "word-synced",
  syllable: "syllable-synced",
  line: "line-synced",
  plain: "not synced",
  unknown: "timing unknown",
};

// The root start tag; quoted attribute values may contain ">".
const TT_START_TAG = /<tt(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/;
// Matching name="value" pairs in order consumes each value, so text inside a value is
// never mistaken for an attribute.
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * `events` come from parseSse(); `unisonRaw` is the Unison response body, when there was
 * one. Never throws: malformed blocks, blocks without `results` and empty or blank
 * strings produce no source.
 */
export function extractSources(events: readonly SseEvent[], unisonRaw?: string): ExtractedSources {
  let metadata: LyricsMetadata = {};
  // By source id. BL can get a provider's block twice (it retries); the later block
  // replaces the sources it carries and leaves that provider's other sources alone.
  const sources = new Map<string, LyricsSource>();
  for (const { event, data } of events) {
    if (!isRecord(data)) continue;
    // A later metadata event replaces the earlier one, as BL overwrites its result.
    if (event === "metadata") metadata = readMetadata(data);
    else if (event === "provider") for (const source of providerSources(data)) sources.set(source.id, source);
  }
  const unison = unisonRaw === undefined ? null : unisonSource(unisonRaw);
  if (unison) sources.set(unison.id, unison);
  return { metadata, sources: [...sources.values()] };
}

/** Timing from `itunes:timing` on the root <tt> start tag: Word, Line, None (any case). */
export function ttmlTiming(ttml: string): Timing {
  const root = rootAttributes(ttml);
  return root ? timingOf(root) : "unknown";
}

function readMetadata(data: Record<string, unknown>): LyricsMetadata {
  const metadata: LyricsMetadata = {};
  for (const key of ["song", "artist", "album"] as const) {
    const value = data[key];
    if (hasText(value)) metadata[key] = value;
  }
  // BL takes Number(duration), so a numeric string counts too.
  const { duration, videoId } = data;
  const seconds = typeof duration === "number" ? duration : hasText(duration) ? Number(duration) : NaN;
  if (Number.isFinite(seconds)) metadata.duration = seconds;
  if (typeof videoId === "string" && isVideoId(videoId)) metadata.videoId = videoId;
  return metadata;
}

function providerSources({ provider, results }: Record<string, unknown>): LyricsSource[] {
  // BL: `if (!results) return;`
  if (!hasText(provider) || !results) return [];
  const fields = isRecord(results) ? results : {};
  let found: (LyricsSource | null)[];
  switch (provider) {
    case "musixmatch":
      found = [textSource("musixmatch-word", fields.wordByWord, "word"), textSource("musixmatch", fields.synced, "line")];
      break;
    case "lrclib":
      found = [textSource("lrclib", fields.synced, "line"), textSource("lrclib-plain", fields.plain, "plain")];
      break;
    case "golyrics":
      found = [golyricsSource(fields.lyrics, results)];
      break;
    case "binimum":
      found = [binimumSource(fields, results)];
      break;
    // QRC is timed per piece, which is a word or a syllable; BL files it as word-synced.
    case "qq":
      found = [nestedSource("qq", fields.lyrics, results, "word")];
      break;
    case "kugou":
      found = [nestedSource("kugou", fields.lyrics, results, "line")];
      break;
    default:
      // Forward compatibility: keep what an unknown provider sent.
      found = [rawJsonSource(unknownProviderId(provider), provider, results)];
  }
  return found.filter((source) => source !== null);
}

/** Usually double-encoded (a JSON string `{"ttml": "<tt ...>"}`), sometimes raw TTML. */
function golyricsSource(lyrics: unknown, results: unknown): LyricsSource | null {
  if (!hasText(lyrics)) return null;
  // As BL: use .ttml when the string is JSON that has one (a blank one is no lyrics),
  // else the string as-is.
  const parsed = parseJson(lyrics);
  if (isRecord(parsed) && typeof parsed.ttml === "string") {
    return hasText(parsed.ttml) ? ttmlSource("golyrics", parsed.ttml, results) : null;
  }
  return ttmlSource("golyrics", lyrics, results);
}

/** Raw TTML; `timingType` is "syllable" or "line" and wins over the TTML's own attribute. */
function binimumSource(fields: Record<string, unknown>, results: unknown): LyricsSource | null {
  if (!hasText(fields.lyrics)) return null;
  const { timingType } = fields;
  return ttmlSource("binimum", fields.lyrics, results, timingType === "syllable" || timingType === "line" ? timingType : undefined);
}

function ttmlSource(id: "golyrics" | "binimum", ttml: string, results: unknown, timing?: Timing): LyricsSource {
  const root = rootAttributes(ttml);
  // Without a <tt> start tag this is not TTML (BL's parser finds no lines in it either),
  // and a ".ttml" source would mislead the Tony pick: keep the raw results instead.
  if (!root) return rawJsonSource(id, FIXED[id].provider, results, FIXED[id].blDisplayName);
  return fixedSource(id, ttml, timing ?? timingOf(root));
}

/**
 * qq and kugou: `results.lyrics` is a JSON string whose `.lyrics` is the file. When that
 * does not decode BL shows nothing; we keep the raw results so they can still be saved.
 */
function nestedSource(id: "qq" | "kugou", value: unknown, results: unknown, timing: Timing): LyricsSource | null {
  // BL: `if (results.lyrics)`.
  if (!value || (typeof value === "string" && !hasText(value))) return null;
  const decoded = typeof value === "string" ? parseJson(value) : undefined;
  const inner = isRecord(decoded) ? decoded.lyrics : undefined;
  if (typeof inner !== "string") return rawJsonSource(id, FIXED[id].provider, results, FIXED[id].blDisplayName);
  return textSource(id, inner, timing);
}

function textSource(id: FixedSourceId, content: unknown, timing: Timing): LyricsSource | null {
  return hasText(content) ? fixedSource(id, content, timing) : null;
}

function fixedSource(id: FixedSourceId, content: string, timing: Timing): LyricsSource {
  const { provider, blDisplayName, ext } = FIXED[id];
  const format = SOURCE_FORMATS[id];
  return { id, provider, blDisplayName, label: label(blDisplayName, format, timing), timing, format, ext, mime: MIME[format], content };
}

/**
 * Pretty-printed `results`. No blDisplayName: BL never shows these. `undecodedName` is the
 * display name of a known provider whose payload did not decode.
 */
function rawJsonSource(id: string, provider: string, results: unknown, undecodedName?: string): LyricsSource {
  return {
    id,
    provider,
    label: undecodedName
      ? `${undecodedName} \u{2014} raw JSON (could not be decoded)`
      : `${id} \u{2014} raw JSON (unknown provider)`,
    timing: "unknown",
    format: "json",
    ext: `.${id}.json`,
    mime: MIME.json,
    content: JSON.stringify(results, null, 2),
  };
}

/**
 * Provider names come from the network and end up in file names, storage and the page:
 * lower-cased, every run of characters other than a-z 0-9 _ - becomes "_", cut to 40
 * characters, "_" and "-" trimmed from both ends ("unknown" if nothing is left). A name
 * that turns into a known source's id gets "-raw" appended, so it cannot replace that source.
 */
function unknownProviderId(provider: string): string {
  const id =
    provider
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .slice(0, 40)
      .replace(/^[_-]+|[_-]+$/g, "") || "unknown";
  return KNOWN_IDS.has(id) ? `${id}-raw` : id;
}

/**
 * BL's unison.ts: the body is `{"data": {lyrics, format, syncType, ...}}`; without data,
 * lyrics or a known format there are no Unison lyrics. `syncType` decides the timing where
 * it can apply. richsync cannot tell syllables from words (nor can `itunes:timing`, which
 * says "Word" for both), so it is "word".
 */
function unisonSource(raw: string): LyricsSource | null {
  const body = parseJson(raw);
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || !hasText(data.lyrics)) return null;
  const { lyrics, syncType } = data;
  switch (data.format) {
    case "ttml": {
      const root = rootAttributes(lyrics);
      if (!root) return null;
      const timing =
        syncType === "richsync" ? "word" : syncType === "linesync" ? "line" : syncType === "plain" ? "plain" : timingOf(root);
      return unisonOf("ttml", ".unison.ttml", timing, lyrics);
    }
    case "lrc":
      // BL treats every LRC that is not richsync as line-synced.
      return syncType === "richsync"
        ? unisonOf("enhanced-lrc", ".unison.lrc", "word", lyrics)
        : unisonOf("lrc", ".unison.lrc", "line", lyrics);
    case "plain":
      return unisonOf("plain", ".unison.txt", "plain", lyrics);
    default:
      return null;
  }
}

function unisonOf(format: SourceFormat, ext: string, timing: Timing, content: string): LyricsSource {
  return {
    id: UNISON,
    provider: UNISON,
    blDisplayName: UNISON_DISPLAY_NAME,
    label: label(UNISON_DISPLAY_NAME, format, timing),
    timing,
    format,
    ext,
    mime: MIME[format],
    content,
  };
}

/** Attributes of the first <tt> start tag, or null when there is none (a regex: the service worker has no DOMParser). */
function rootAttributes(ttml: string): Map<string, string> | null {
  const tag = TT_START_TAG.exec(ttml);
  if (!tag) return null;
  const attributes = new Map<string, string>();
  for (const [, name, double, single] of tag[0].slice("<tt".length).matchAll(ATTRIBUTE)) {
    attributes.set(name, double ?? single);
  }
  return attributes;
}

function timingOf(root: Map<string, string>): Timing {
  switch (root.get("itunes:timing")?.trim().toLowerCase()) {
    case "word":
      return "word";
    case "line":
      return "line";
    case "none":
      return "plain";
    default:
      return "unknown";
  }
}

function label(name: string, format: SourceFormat, timing: Timing): string {
  return `${name} \u{2014} ${FORMAT_NAMES[format]}, ${TIMING_NAMES[timing]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
