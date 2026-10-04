// Which file to give Tony (PLAN.md section 3.2.3): every captured source in the order of that
// list, made Tony-ready (TTML as it came, converted TTML, or LRC as it came), and the first one
// Tony would accept wins. Tony reads TTML best: every word gets an end, which LRC lacks.

import { parseEnhancedLrc } from "./convert/musixmatchWord";
import { parseQrc } from "./convert/qrc";
import type { LyricsMetadata, LyricsSource, SourceFormat, Timing } from "./sources";
import { writeTonyTtml, type TimedLine } from "./ttml";

export interface TonyContext {
  /** From buildStem(): the file is `<stem>.ttml` or `<stem>.lrc`, with no provider infix. */
  stem: string;
  /** "Artist - Title", the <ttm:title> of converted TTML. */
  title: string;
  /** The capture's metadata: QQ credit lines that name the song are found by its song and artist. */
  metadata?: LyricsMetadata;
}

export interface TonyFile {
  content: string;
  ext: ".ttml" | ".lrc";
  /** `<stem><ext>`. */
  filename: string;
  timing: Timing;
  /** True when the source was turned into TTML here; false when its content is saved unchanged. */
  converted: boolean;
  /** Menu text, e.g. "Musixmatch \u{2014} word timing, converted" (an em dash). */
  label: string;
}

export type TonyReadiness = ({ ok: true } & TonyFile) | { ok: false; reason: string };

export interface TonyPick extends TonyFile {
  source: LyricsSource;
}

export interface TonyPickResult {
  /** Null when no captured source can be made into a file Tony accepts. */
  pick: TonyPick | null;
  /** Candidates tried before the pick that could not be made Tony-ready, in the order tried. */
  skipped: { sourceId: string; reason: string }[];
}

/** Tony refuses a lyrics file of more bytes than this (`Lyrics::maxFileBytes`), LRC or TTML. */
export const TONY_MAX_BYTES = 1024 * 1024;

const TIMING_LABELS: Record<Timing, string> = {
  word: "word timing",
  syllable: "syllable timing",
  line: "line timing",
  plain: "no timing",
  unknown: "timing unknown",
};

/**
 * One source as the file Tony would get, or why it cannot be one: TTML and LRC are saved
 * unchanged, enhanced LRC (Musixmatch word-by-word, Unison richsync) and QRC are converted to
 * TTML; plain text and raw JSON have nothing Tony can time. A file Tony would refuse (over 1 MiB
 * in UTF-8, or a DOCTYPE) is not ready either.
 */
export function tonyReady(source: LyricsSource, ctx: TonyContext): TonyReadiness {
  const made = makeFile(source, ctx);
  if (!made.ok) return made;
  const refusal = tonyRefusal(made.content);
  return refusal === null ? made : { ok: false, reason: refusal };
}

/**
 * Section 3.2.3, best first; the first candidate that is Tony-ready wins. Candidates that are
 * not (too big, a DOCTYPE, nothing left after conversion) are listed in `skipped` so the menu
 * can warn. Plain text and raw JSON are never candidates.
 */
export function pickForTony(sources: readonly LyricsSource[], ctx: TonyContext): TonyPickResult {
  const skipped: TonyPickResult["skipped"] = [];
  for (const slot of PICK_ORDER) {
    const source = sources.find((candidate) => candidate.id === slot.id && candidate.format === slot.format && slot.when(candidate.timing));
    if (!source) continue;
    const ready = tonyReady(source, ctx);
    if (ready.ok) {
      const { ok: _ok, ...made } = ready;
      return { pick: { ...made, source }, skipped };
    }
    skipped.push({ sourceId: source.id, reason: ready.reason });
  }
  return { pick: null, skipped };
}

interface Slot {
  id: string;
  format: SourceFormat;
  when: (timing: Timing) => boolean;
}

const wordLevel = (timing: Timing) => timing === "word" || timing === "syllable";
const notWordLevel = (timing: Timing) => !wordLevel(timing);
const always = () => true;

// The predicates split each TTML source between its word-timed slot and group 6, so a source
// matches one slot at most. Lead decisions (PLAN.md section 7.1): golyrics timed by line or not
// at all drops to group 6 (the user wants word timing; "golyrics first" assumed it), and so
// does a Unison TTML whose timing is unknown; golyrics of unknown timing stays first. Where
// section 3.2.3 is silent (B4): binimum TTML that says it is word-timed counts as group 3, every
// other TTML without word timing goes to group 6, and Unison's line LRC comes last in group 7.
const PICK_ORDER: readonly Slot[] = [
  // 1. golyrics TTML as-is
  { id: "golyrics", format: "ttml", when: (timing) => timing !== "line" && timing !== "plain" },
  // 2. Unison TTML with word or syllable timing
  { id: "unison", format: "ttml", when: wordLevel },
  // 3. binimum TTML with syllable timing (or word timing, read from the TTML when timingType is missing)
  { id: "binimum", format: "ttml", when: wordLevel },
  // 4. Musixmatch word-by-word, then Unison richsync LRC, converted
  { id: "musixmatch-word", format: "enhanced-lrc", when: always },
  { id: "unison", format: "enhanced-lrc", when: always },
  // 5. QQ, converted
  { id: "qq", format: "qrc", when: always },
  // 6. TTML without word timing, as-is: golyrics (listed first in section 3.2.3), binimum, Unison
  { id: "golyrics", format: "ttml", when: (timing) => timing === "line" || timing === "plain" },
  { id: "binimum", format: "ttml", when: notWordLevel },
  { id: "unison", format: "ttml", when: notWordLevel },
  // 7. Line-synced LRC as .lrc; Unison's (not in section 3.2.3) last
  { id: "musixmatch", format: "lrc", when: always },
  { id: "lrclib", format: "lrc", when: always },
  { id: "kugou", format: "lrc", when: always },
  { id: "unison", format: "lrc", when: always },
];

function makeFile(source: LyricsSource, ctx: TonyContext): TonyReadiness {
  switch (source.format) {
    case "ttml":
      return { ok: true, ...fileOf(source, ctx, source.content, ".ttml", false) };
    case "lrc":
      return { ok: true, ...fileOf(source, ctx, source.content, ".lrc", false) };
    case "enhanced-lrc":
      return converted(source, ctx, () => parseEnhancedLrc(source.content));
    case "qrc":
      return converted(source, ctx, () => parseQrc(source.content, { title: ctx.metadata?.song, artist: ctx.metadata?.artist }));
    case "plain":
      return { ok: false, reason: "Plain text: no timing for Tony" };
    case "json":
      return { ok: false, reason: "Raw JSON: not lyrics Tony can read" };
  }
}

function converted(source: LyricsSource, ctx: TonyContext, parse: () => TimedLine[]): TonyReadiness {
  let ttml: string;
  try {
    ttml = writeTonyTtml({ title: ctx.title, lines: parse() });
  } catch (error) {
    // writeTonyTtml throws a RangeError for a time too big to be a number. Whatever fails, it
    // makes this one source unusable, not the whole pick (and the menu built from it).
    return { ok: false, reason: `Could not be converted: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The writer drops pieces it cannot write; a file without a <p> has no words, which Tony refuses.
  if (!ttml.includes("<p ")) return { ok: false, reason: "No timed words to convert" };
  return { ok: true, ...fileOf(source, ctx, ttml, ".ttml", true) };
}

function fileOf(source: LyricsSource, ctx: TonyContext, content: string, ext: TonyFile["ext"], isConverted: boolean): TonyFile {
  const name = source.blDisplayName ?? source.id;
  const label = `${name} \u{2014} ${TIMING_LABELS[source.timing]}${isConverted ? ", converted" : ""}`;
  return { content, ext, filename: `${ctx.stem}${ext}`, timing: source.timing, converted: isConverted, label };
}

/**
 * What Tony refuses before reading a word: more than TONY_MAX_BYTES in UTF-8 (the bytes the
 * download writes), and a document type declaration, which its TTML reader rejects (and Tony
 * reads any file starting with "<" as TTML). The reader meets a DOCTYPE only before the root
 * element; "<!doctype" in any case, anywhere, is refused here: simpler, and loses nothing real.
 */
function tonyRefusal(content: string): string | null {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > TONY_MAX_BYTES) return `Too big for Tony: ${bytes} bytes, over its limit of 1 MiB`;
  if (/<!doctype/i.test(content)) return "Has a <!DOCTYPE>, which Tony refuses";
  return null;
}
