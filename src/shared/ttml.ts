// Writes timed lyrics as the TTML Tony reads best (PLAN.md section 1.6): the layout of Tony's own
// writeTtml() (main/LyricsTtml.cpp in jhhr/tony), which is also the Moises exporter's, except that
// a word's syllables are adjacent spans, which Tony joins back into one word. Only converted
// sources come through here; TTML that arrives as TTML reaches Tony unchanged.

/** One timed stretch of text: a whole word or one syllable of it. Seconds, absolute. */
export interface TimedPiece {
  text: string;
  begin: number;
  end: number;
}

/** Written as adjacent spans with nothing between them, which Tony reads as one word. */
export interface TimedWord {
  pieces: TimedPiece[];
}

export interface TimedLine {
  words: TimedWord[];
}

export interface TonyTtmlInput {
  /** Becomes <ttm:title>, which Tony shows as the lyrics title; left out when blank. */
  title?: string;
  lines: readonly TimedLine[];
}

const HEADER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">',
  "  <head>",
  "    <metadata>",
];

// What XML 1.0 forbids (C0 controls other than tab, LF and CR; U+FFFE, U+FFFF; unpaired
// surrogates). Qt's reader stops at the first one, so Tony would refuse the whole file.
const NOT_XML_CHAR = /[^\t\n\r\x20-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/**
 * Seconds as Tony's ttmlTime() writes them: M:SS.mmm to the nearest millisecond, minutes
 * unpadded and unbounded (an hour and a minute is 61:00.000), anything below zero 0:00.000.
 * Throws a RangeError for NaN or an infinity rather than write a time no reader can read.
 */
export function ttmlTime(seconds: number): string {
  if (!Number.isFinite(seconds)) throw new RangeError(`Not a time: ${seconds}`);
  // Tony's arithmetic: llround(seconds * 1000), then the clamp. Math.round takes halves up
  // where llround takes them away from zero, which differs only below zero, where both clamp.
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60000);
  const secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${minutes}:${secs}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * The whole file, ending in one "\n". A piece's text is cleaned first: characters XML 1.0
 * forbids are dropped, tabs and line breaks become spaces, and it is trimmed, because white
 * space at the edge of a span would split its word in Tony. Pieces left empty are dropped,
 * then words left without pieces, then lines left without words (they use up no
 * `itunes:key`). Times are written as given: a piece may end before it begins.
 * Throws a RangeError for a time that is not a finite number.
 */
export function writeTonyTtml({ title, lines }: TonyTtmlInput): string {
  const kept = lines.map(cleanLine).filter((words) => words.length > 0);
  const pieces = kept.flat(2);
  // As Tony's writer: the earliest begin, and the latest time of any kind, from 0. With
  // nothing to write both are 0, which Tony then reads as "no timed lyrics".
  const first = pieces.length === 0 ? 0 : pieces.reduce((min, { begin }) => Math.min(min, begin), Infinity);
  const last = pieces.reduce((max, { begin, end }) => Math.max(max, begin, end), 0);

  const cleanTitle = title === undefined ? "" : cleanText(title);
  return [
    ...HEADER,
    ...(cleanTitle ? [`      <ttm:title>${escapeText(cleanTitle)}</ttm:title>`] : []),
    '      <ttm:agent type="person" xml:id="v1"/>',
    "    </metadata>",
    "  </head>",
    `  <body dur="${ttmlTime(last)}">`,
    `    <div begin="${ttmlTime(first)}" end="${ttmlTime(last)}">`,
    ...kept.map((words, index) => paragraph(words, index + 1)),
    "    </div>",
    "  </body>",
    "</tt>",
    "",
  ].join("\n");
}

/** One <p> on one line: syllables of a word touch, words are one space apart. */
function paragraph(words: TimedPiece[][], key: number): string {
  const pieces = words.flat();
  // Tony's writer: the line's earliest begin (its first piece, for lyrics in time order) and latest end.
  const begin = pieces.reduce((min, piece) => Math.min(min, piece.begin), Infinity);
  const end = pieces.reduce((max, piece) => Math.max(max, piece.end), -Infinity);
  const spans = words.map((word) => word.map(span).join("")).join(" ");
  return `      <p begin="${ttmlTime(begin)}" end="${ttmlTime(end)}" ttm:agent="v1" itunes:key="L${key}">${spans}</p>`;
}

function span({ text, begin, end }: TimedPiece): string {
  return `<span begin="${ttmlTime(begin)}" end="${ttmlTime(end)}">${escapeText(text)}</span>`;
}

function cleanLine(line: TimedLine): TimedPiece[][] {
  return line.words
    .map((word) => word.pieces.map((piece) => ({ ...piece, text: cleanText(piece.text) })).filter((piece) => piece.text !== ""))
    .filter((pieces) => pieces.length > 0);
}

function cleanText(text: string): string {
  return text.replace(NOT_XML_CHAR, "").replace(/[\t\n\r]/g, " ").trim();
}

// Only text carries input: every attribute value is a time or a fixed name, so none needs escaping.
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
