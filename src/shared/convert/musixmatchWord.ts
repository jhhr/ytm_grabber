// Enhanced LRC (word tags <mm:ss.xx> inside [mm:ss.xx] lines) -> lines of timed words for
// writeTonyTtml(). Musixmatch `wordByWord` and Unison richsync LRC share the syntax, so both come
// through here. The rules are PLAN.md section 3.2.1 and the lead check under it, which follow
// Better Lyrics' parseLRC (@braccato/parsers 0.3.2, MIT): the words and start times are the
// ones BL shows. Where BL and this converter differ, a comment says why.

import type { TimedLine, TimedPiece, TimedWord } from "../ttml";

// BL's patterns: a line stamp and a word tag take any number of digits on each side of the
// point, a header is a whole line, and a background part runs from "[bg:" to the line's end.
const LINE_STAMP = /\[(\d+:\d+\.\d+)\]/g;
const WORD_TAG = /<(\d+:\d+\.\d+)>/; // with its group, split() keeps the times
const HEADER = /^\[(\w+):(.*)\]$/;
const HEADER_NAMES: ReadonlySet<string> = new Set(["ti", "ar", "al", "au", "lr", "length", "by", "offset", "re", "tool", "ve"]);
const BACKGROUND = /\[bg:(.*)\]\s*$/;
const OFFSET = /^\s*([+-]?\d+(?:\.\d+)?)\s*$/;

/** How long a piece with no closing tag lasts on the last line, which has no next line to end at. */
const LAST_PIECE_MS = 1000;

interface Row {
  /** The line's earliest stamp, in ms: where the line before it ends an unclosed piece. */
  startMs: number;
  /** The main part split at its word tags: text, time, text, time, ..., text. */
  segments: string[];
}

/**
 * Lines with at least one piece, in file order. Per line, as BL decides it: in separator
 * style (some text between two tags is white space only; Musixmatch times the gaps that
 * way) a white-space-only segment separates words and every other segment is trimmed; in
 * compact style (`<t0>Word <t1>next <t2>`) white space at either end of a segment does.
 * Either way, pieces with no separator between them are one word (`hy-` + `phenated`).
 * Text before a line's first tag, lines without word tags or without a line stamp, header
 * lines and `[bg: ...]` parts (Tony skips backing vocals anyway) give no pieces. A piece
 * after a line's last tag ends at the next line's start, as in BL, but not before it
 * begins; on the last line it ends 1 s after it begins (BL: at the song's end).
 *
 * Unlike BL: a piece with white space inside stays one piece (BL's renderer splits it into
 * words with times shared out by length; Tony reads it as one word), and a line that looks
 * like a credit ("Written by: ...") is kept (BL drops it; it has word tags, so it was timed).
 */
export function parseEnhancedLrc(text: string): TimedLine[] {
  let offsetMs = 0;
  const rows: Row[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = HEADER.exec(line);
    if (header && HEADER_NAMES.has(header[1])) {
      // A later [offset:] replaces an earlier one, as in BL.
      if (header[1] === "offset") offsetMs = readOffset(header[2]);
      continue;
    }
    const stamps = [...line.matchAll(LINE_STAMP)].map((match) => lrcMs(match[1]));
    if (stamps.length === 0) continue;
    // A line can be stamped more than once (a repeated chorus); its word tags are absolute anyway.
    const rest = line.replace(LINE_STAMP, "").trim();
    const background = BACKGROUND.exec(rest);
    const main = background ? rest.slice(0, background.index) : rest;
    rows.push({ startMs: Math.min(...stamps), segments: main.split(WORD_TAG) });
  }

  const lines: TimedLine[] = [];
  rows.forEach((row, index) => {
    const words = rowWords(row.segments, rows[index + 1]?.startMs, offsetMs);
    if (words.length > 0) lines.push({ words });
  });
  return lines;
}

function rowWords(segments: string[], nextStartMs: number | undefined, offsetMs: number): TimedWord[] {
  const last = segments.length - 1;
  const separatorStyle = segments.some((segment, i) => i % 2 === 0 && i > 0 && i < last && isBlank(segment));
  const words: TimedWord[] = [];
  let pieces: TimedPiece[] = [];
  const endWord = () => {
    if (pieces.length > 0) words.push({ pieces });
    pieces = [];
  };
  const seconds = (ms: number) => (ms - offsetMs) / 1000;

  // segments[0] is the text before the first tag; each later text follows the tag before it.
  for (let i = 2; i <= last; i += 2) {
    const raw = segments[i];
    if (isBlank(raw)) {
      endWord();
      continue;
    }
    const text = raw.trim();
    // Two tags with nothing between them: no text, so no word boundary either (as BL).
    if (text === "") continue;
    // BL's renderer splits every part at white space, so in compact style a leading space
    // starts a word just as a trailing one ends it.
    if (!separatorStyle && /^\s/.test(raw)) endWord();
    const beginMs = lrcMs(segments[i - 1]);
    const endMs =
      i < last ? lrcMs(segments[i + 1]) : nextStartMs === undefined ? beginMs + LAST_PIECE_MS : Math.max(beginMs, nextStartMs);
    pieces.push({ text, begin: seconds(beginMs), end: seconds(endMs) });
    if (!separatorStyle && /\s$/.test(raw)) endWord();
  }
  endWord();
  return words;
}

/** `mm:ss.xx` (any digits) to whole milliseconds, with BL's arithmetic. */
function lrcMs(time: string): number {
  const [minutes, secs] = time.split(":");
  return Math.round(Number(minutes) * 60000 + Number(secs) * 1000);
}

/**
 * `[offset:+500]` in the LRC sense: milliseconds, positive shows lyrics sooner, so a time
 * becomes t - offset. BL multiplies the value by 1000 as if it were seconds; we follow the
 * LRC convention. Anything but a plain number counts as no offset.
 */
function readOffset(value: string): number {
  const match = OFFSET.exec(value);
  return match ? Number(match[1]) : 0;
}

/** Not empty, and nothing but white space (what BL renders as a gap between words). */
function isBlank(segment: string): boolean {
  return segment.length > 0 && segment.trim() === "";
}
