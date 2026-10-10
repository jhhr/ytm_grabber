// File names shared by the audio file and every lyrics file: "Artist - Title [videoId]".
//
// The rules must produce names that both Windows and chrome.downloads accept. Chrome is
// the stricter one: it also rejects format characters (zero-width joiner, bidi marks,
// soft hyphen, ...), C1 controls and noncharacters anywhere, whitespace, "." and "~" at
// either end, and CLOCK$, desktop.ini, thumbs.db (checked in Chromium 141).
//
// The native host re-implements sanitizeFilename() in Python; test/fixtures/
// sanitize-vectors.json is the contract both must pass. Keep the two in step.

/** Longest stem in UTF-16 code units, the unit JavaScript string lengths count. */
export const MAX_STEM_LENGTH = 150;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Without the u flag a regex sees UTF-16 code units, so unpaired halves can be matched.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ILLEGAL = /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}]/gu;
// Unicode White_Space minus the controls, which ILLEGAL has already turned into spaces.
const WHITESPACE_RUN = /[ \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}]+/gu;
const LEADING_JUNK = /^[ .~]+/;
const TRAILING_JUNK = /[ .~]+$/;
const LEADING_SPACES = /^ +/;
const TRAILING_SPACES = / +$/;
// Windows device names (with the superscript digits Windows also accepts) plus Chrome's
// CLOCK$; reserved alone or before an extension, e.g. "con.txt" or "con .txt".
const RESERVED_BASE = /^(?:con|prn|aux|nul|clock\$|com[1-9\xB9\xB2\xB3]|lpt[1-9\xB9\xB2\xB3])$/i;
const RESERVED_NAME = /^(?:desktop\.ini|thumbs\.db)$/i;

export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

/**
 * Makes `name` safe as one file or folder name on Windows and in chrome.downloads.
 * Meant for stems: append extensions afterwards. In order:
 * 1. unpaired surrogates become U+FFFD;
 * 2. `< > : " / \ | ? *`, control (Cc) and format (Cf) characters and noncharacters
 *    become spaces;
 * 3. every run of whitespace becomes one ASCII space;
 * 4. spaces, dots and tildes are stripped from both ends;
 * 5. the name is cut to MAX_STEM_LENGTH UTF-16 code units, one less if the cut would
 *    split a surrogate pair, and step 4's end stripping runs again;
 * 6. a reserved name gets a "_" prefix, then step 5 runs again (the prefix may push
 *    the name over the cap; checking after the cut also catches names the cut exposes);
 * 7. an empty result becomes "_".
 * Idempotent: sanitizing a result again returns it unchanged.
 */
export function sanitizeFilename(name: string): string {
  let result = cap(normalize(name).replace(LEADING_JUNK, "").replace(TRAILING_JUNK, ""));
  if (isReserved(result)) result = cap("_" + result);
  return result || "_";
}

export interface StemParts {
  artist?: string | null;
  title?: string | null;
  videoId: string;
}

/**
 * "Artist - Title [videoId]", or "Title [videoId]" / "Artist [videoId]" when one part is
 * missing or empty after cleaning, or "[videoId]" when both are. Within the stem the
 * parts keep their own dots and tildes ("P.O.D.", "Wait..."): only the stem's ends must
 * avoid them, and its end is always "]". When the stem would exceed MAX_STEM_LENGTH the
 * "Artist - Title" part is cut, never the " [videoId]" suffix.
 * The result is a fixed point of sanitizeFilename(), so the service worker and the native
 * host can re-sanitise a stem they receive without changing it.
 * Throws when `videoId` is not an 11-character YouTube video id.
 */
export function buildStem({ artist, title, videoId }: StemParts): string {
  if (!isVideoId(videoId)) throw new Error(`Not a YouTube video id: ${JSON.stringify(videoId)}`);
  const label = [artist, title]
    .map((part) => normalize(part ?? "").replace(LEADING_SPACES, "").replace(TRAILING_SPACES, ""))
    .filter((part) => part !== "")
    .join(" - ")
    .replace(LEADING_JUNK, "");
  if (label === "") return `[${videoId}]`;

  const suffix = ` [${videoId}]`;
  const budget = MAX_STEM_LENGTH - suffix.length;
  let head = truncate(label, budget).replace(TRAILING_SPACES, "");
  if (isReserved(head + suffix)) head = truncate("_" + head, budget).replace(TRAILING_SPACES, "");
  return head + suffix;
}

function normalize(text: string): string {
  return text.replace(LONE_SURROGATE, "\u{FFFD}").replace(ILLEGAL, " ").replace(WHITESPACE_RUN, " ");
}

function cap(name: string): string {
  return truncate(name, MAX_STEM_LENGTH).replace(TRAILING_JUNK, "");
}

/** Cuts to at most `max` UTF-16 code units without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function isReserved(name: string): boolean {
  // The base is everything before the first dot; Windows ignores spaces at its end.
  const base = name.split(".", 1)[0].replace(TRAILING_SPACES, "");
  return RESERVED_BASE.test(base) || RESERVED_NAME.test(name);
}
