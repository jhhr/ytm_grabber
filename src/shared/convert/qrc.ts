// QQ Music QRC (the `qq` provider's lyrics) -> lines of timed words for writeTonyTtml(). The rules
// are PLAN.md section 3.2.2 and the lead check under it, which follow Better Lyrics' parseQRC
// (@braccato/parsers 0.3.2, MIT): the lines, words and start times are the ones BL shows, except
// where a comment here says why not.

import type { TimedLine, TimedPiece, TimedWord } from "../ttml";

/** The song as the capture's metadata names it. QQ's own [ti:] and [ar:] headers are used as well. */
export interface QrcContext {
  title?: string;
  artist?: string;
}

// BL's patterns. The attribute value ends at a quote followed by the end of the tag or by another
// attribute, so a stray quote inside the value does not cut it short.
const LYRIC_CONTENT = /LyricContent="([\s\S]*?)"\s*(?:\/?>|[a-zA-Z]+=)/;
const HEADER = /^\[[a-zA-Z]+:/;
const HEADER_VALUE = /^\[([a-zA-Z]+):(.*)\]$/;
// "[start,duration]" as BL reads it with parseInt: each number may have white space and a sign
// before it and anything after it. The numbers themselves are not used: pieces carry their own times.
const LINE_STAMP = /^\[\s*[+-]?\d[^,\]]*,\s*[+-]?\d[^\]]*\]/;
// Only digit pairs are times, so lyrics such as "(oh)" stay text.
const PIECE_TIME = /\((\d+),(\d+)\)/g;
const OFFSET = /^\s*([+-]?\d+(?:\.\d+)?)\s*$/;
const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#[xX]([0-9A-Fa-f]+));/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * How many lyric lines at the start the uniform-timing test may look at (lines with no text are
 * not counted). That test is the only one a real lyric line can pass ("la la la" timed evenly),
 * so it is kept to where QQ puts credits; the other tests drop any number of leading credits.
 */
const UNIFORM_TIMING_WINDOW = 5;
/** BL's colon, half-width or full-width (U+FF1A). */
const COLON = /[:\u{FF1A}]/u;
// BL's credit keys, compared lower-cased with all white space removed. The Chinese ones, in pinyin,
// each in simplified then traditional characters where those differ.
const CREDIT_KEYS: ReadonlySet<string> = new Set([
  // ci, zuoci (lyrics); qu, zuoqu (music); ciqu, zuoci zuoqu (both)
  "\u{8BCD}", "\u{8A5E}", "\u{4F5C}\u{8BCD}", "\u{4F5C}\u{8A5E}", "\u{66F2}", "\u{4F5C}\u{66F2}",
  "\u{8BCD}\u{66F2}", "\u{8A5E}\u{66F2}", "\u{4F5C}\u{8BCD}\u{4F5C}\u{66F2}", "\u{4F5C}\u{8A5E}\u{4F5C}\u{66F2}",
  "writtenby", "lyricsby", "composedby", "lyricist", "composer",
  // bianqu (arranger), hesheng (harmony), hunyin (mixing), jita (guitar), zhizuoren (producer)
  "\u{7F16}\u{66F2}", "\u{7DE8}\u{66F2}", "\u{548C}\u{58F0}", "\u{548C}\u{8072}", "\u{6DF7}\u{97F3}", "\u{5409}\u{4ED6}",
  "\u{5236}\u{4F5C}\u{4EBA}", "\u{88FD}\u{4F5C}\u{4EBA}",
  // yanchang (performer), yuanchang (original singer), fanchang (cover), houqi (post-production),
  // heyin (backing vocals), luyin (recording), cehua (planning), banzou (accompaniment),
  // meigong (artwork), haibao (poster), pangbai (narration)
  "\u{6F14}\u{5531}", "\u{539F}\u{5531}", "\u{7FFB}\u{5531}", "\u{540E}\u{671F}", "\u{5F8C}\u{671F}", "\u{548C}\u{97F3}",
  "\u{5F55}\u{97F3}", "\u{9304}\u{97F3}", "\u{7B56}\u{5212}", "\u{7B56}\u{5283}", "\u{4F34}\u{594F}", "\u{7F8E}\u{5DE5}",
  "\u{6D77}\u{62A5}", "\u{6D77}\u{5831}", "\u{65C1}\u{767D}",
  "producedby", "arrangedby", "mixing", "mastering", "vocal", "vocals", "guitar", "bass", "drums", "producer", "arranger",
]);
// BL also takes a short role (up to 4 characters) that ends in ci, qu, sheng or yin, e.g. nvsheng (female voice).
const CREDIT_SUFFIXES = ["\u{8BCD}", "\u{8A5E}", "\u{66F2}", "\u{58F0}", "\u{8072}", "\u{97F3}"];
const MAX_SUFFIX_ROLE = 4;
/** Between roles in one key ("zuoci/zuoqu"): / & , and their CJK forms (U+3001, U+FF0C, U+30FB, U+B7). */
const ROLE_SEPARATOR = /[/&\u{3001},\u{FF0C}\u{30FB}\u{B7}]/u;
/** BL's title/artist normalisation keeps a-z, 0-9, CJK (U+3000-U+9FFF) and Hangul (U+AC00-U+D7AF) only. */
const NOT_NAME_CHAR = /[^a-z0-9\u{3000}-\u{9FFF}\u{AC00}-\u{D7AF}]/gu;

interface RawPiece {
  /** Untrimmed: its white space decides the word boundaries. */
  text: string;
  startMs: number;
  durationMs: number;
}

/**
 * Lines with at least one piece of text, in file order. The QRC is the `LyricContent` attribute
 * of QQ's XML, entities decoded once; without the attribute the text itself is read as QRC (BL
 * does the same), and is not decoded, since it is not XML. A lyric line is `[start,duration]`
 * then pieces `text(start,duration)` in ms, each piece's text BEFORE its times; text after a
 * line's last times is ignored. Header lines (`[ti:...]`, `[offset:...]`, ...) are metadata.
 *
 * Words: a piece whose text ends in white space ends a word and one that starts with white
 * space starts one; pieces with neither join (`thou` + `sand`). Span text is trimmed.
 *
 * Credits: among the first 5 lyric lines, leading lines are dropped while they are credits by
 * BL's rules (see isCredit); the first line that is not one ends the search, so real lyrics are
 * never dropped from the middle of the song. (BL tests every line until 5 have been KEPT, so it
 * drops any number of leading credits, and it drops a `Key: value` credit line anywhere.)
 *
 * Unlike BL: a non-zero `[offset:]` is applied (BL ignores it); every entity is decoded (BL
 * decodes only &quot; and &amp;); a line with no text is left out (BL keeps an empty line); a
 * singer label such as "Ada: " stays in the text (BL strips it and sets the line's agent); a
 * piece with white space inside stays one piece (BL's renderer splits it; Tony reads one word).
 */
export function parseQrc(text: string, context: QrcContext = {}): TimedLine[] {
  const headers = new Map<string, string>();
  const rows: RawPiece[][] = [];
  for (const raw of lyricContent(text).split("\n")) {
    // trim() also takes the "\r" of a CRLF line end.
    const line = raw.trim();
    if (HEADER.test(line)) {
      // A later header replaces an earlier one; the offset applies wherever it stands.
      const header = HEADER_VALUE.exec(line);
      if (header) headers.set(header[1].toLowerCase(), header[2].trim());
      continue;
    }
    const stamp = LINE_STAMP.exec(line);
    if (!stamp) continue;
    const pieces = rawPieces(line.slice(stamp[0].length));
    if (pieces.some((piece) => piece.text.trim() !== "")) rows.push(pieces);
  }

  const offsetMs = readOffset(headers.get("offset") ?? "");
  const names = [context, { title: headers.get("ti"), artist: headers.get("ar") }];
  let first = 0;
  while (first < rows.length && isCredit(rows[first], names, first < UNIFORM_TIMING_WINDOW)) first++;
  return rows.slice(first).map((pieces) => ({ words: lineWords(pieces, offsetMs) }));
}

function lyricContent(text: string): string {
  const match = LYRIC_CONTENT.exec(text);
  return match ? decodeEntities(match[1]) : text;
}

/**
 * The five XML entities and character references, in one pass (so "&amp;lt;" is "&lt;"). A
 * reference to something that is not a Unicode scalar value (0, a surrogate, past U+10FFFF) is
 * U+FFFD; an unknown name such as "&nbsp;" stays as it is.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (_whole, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name];
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
    const scalar = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return scalar ? String.fromCodePoint(code) : "\u{FFFD}";
  });
}

function rawPieces(rest: string): RawPiece[] {
  const pieces: RawPiece[] = [];
  let from = 0;
  for (const match of rest.matchAll(PIECE_TIME)) {
    pieces.push({ text: rest.slice(from, match.index), startMs: Number(match[1]), durationMs: Number(match[2]) });
    from = match.index + match[0].length;
  }
  return pieces;
}

function lineWords(pieces: RawPiece[], offsetMs: number): TimedWord[] {
  const words: TimedWord[] = [];
  let current: TimedPiece[] = [];
  const endWord = () => {
    if (current.length > 0) words.push({ pieces: current });
    current = [];
  };
  for (const { text: raw, startMs, durationMs } of pieces) {
    if (/^\s/.test(raw)) endWord();
    const text = raw.trim();
    // A piece with no text adds nothing, and without white space it is no word boundary either.
    if (text !== "") {
      current.push({ text, begin: (startMs - offsetMs) / 1000, end: (startMs + durationMs - offsetMs) / 1000 });
    }
    if (/\s$/.test(raw)) endWord();
  }
  endWord();
  return words;
}

/**
 * BL's credit tests, on the line's raw pieces: it names the song (by the capture's title and
 * artist, or by QQ's [ti:]/[ar:] headers); or it has more than 2 pieces whose durations are all
 * within 10 ms of the first (QQ times credit lines uniformly); or it reads `Key: value` with a
 * credit key (half-width or full-width colon).
 *
 * BL also drops an early line whose text is merely similar to "title artist" (a bigram score
 * above 0.5). That is left out: a first lyric line that shares words with the title scores that
 * high, and real lyrics must never be dropped.
 */
function isCredit(pieces: RawPiece[], names: QrcContext[], uniformTimingCounts: boolean): boolean {
  const text = pieces.map((piece) => piece.text).join("");
  return (
    names.some((name) => namesTheSong(text, name)) ||
    (uniformTimingCounts && isUniformlyTimed(pieces)) ||
    hasCreditKey(pieces)
  );
}

/**
 * BL's rules after normalising all three: the line contains the title and the artist; or,
 * with no artist known, it contains the title and is less than 15 characters longer; or it is
 * the artist and nothing else.
 */
function namesTheSong(text: string, { title = "", artist = "" }: QrcContext): boolean {
  const line = normaliseName(text);
  const t = normaliseName(title);
  const a = normaliseName(artist);
  if (t !== "" && line.includes(t)) return a !== "" ? line.includes(a) : line.length < t.length + 15;
  return a !== "" && line === a;
}

function normaliseName(text: string): string {
  return text.toLowerCase().replace(NOT_NAME_CHAR, "");
}

function isUniformlyTimed(pieces: RawPiece[]): boolean {
  return pieces.length > 2 && pieces.every((piece) => Math.abs(piece.durationMs - pieces[0].durationMs) < 10);
}

/** As BL: the key is the text before the first colon, read piece by piece; past 40 characters without a colon it is no key. */
function hasCreditKey(pieces: RawPiece[]): boolean {
  let prefix = "";
  for (const { text } of pieces) {
    prefix += text;
    const colon = prefix.search(COLON);
    if (colon >= 0) return isCreditKey(prefix.slice(0, colon));
    if (prefix.length > 40) return false;
  }
  return false;
}

/** BL's test: a known key, or a key whose roles (Latin words removed, split at separators) all are credit roles. */
function isCreditKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/\s+/g, "");
  if (CREDIT_KEYS.has(compact)) return true;
  const roles = compact.replace(/[a-z]+/g, "").split(ROLE_SEPARATOR).filter(Boolean);
  return (
    roles.length > 0 &&
    roles.every((role) => CREDIT_KEYS.has(role) || (role.length <= MAX_SUFFIX_ROLE && CREDIT_SUFFIXES.some((suffix) => role.endsWith(suffix))))
  );
}

/**
 * `[offset:+500]` in the LRC sense, as for enhanced LRC: milliseconds, positive shows lyrics
 * sooner, so a time becomes t - offset. Anything but a plain number counts as no offset.
 */
function readOffset(value: string): number {
  const match = OFFSET.exec(value);
  return match ? Number(match[1]) : 0;
}
