import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStem, isVideoId, MAX_STEM_LENGTH, sanitizeFilename } from "../src/shared/filenames";

interface Vectors {
  maxLength: number;
  sanitizeFilename: { note: string; input: string; expected: string }[];
  buildStem: { note: string; artist?: string | null; title?: string | null; videoId: string; expected: string }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./fixtures/sanitize-vectors.json", import.meta.url), "utf8"),
);

const DEVICES = ["con", "prn", "aux", "nul", "clock$"];
for (let n = 1; n <= 9; n++) DEVICES.push(`com${n}`, `lpt${n}`);
const SUPERSCRIPTS = ["\xB9", "\xB2", "\xB3"];

/**
 * What Windows or chrome.downloads (checked in Chromium 141) would reject, written
 * independently of filenames.ts so the property tests below check its rules, not echo them.
 */
function problems(name: string, maxLength = MAX_STEM_LENGTH): string[] {
  const found: string[] = [];
  if (name.length === 0 || name.length > maxLength) found.push("length");
  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    const next = name.charCodeAt(i + 1);
    if (high && next >= 0xdc00 && next <= 0xdfff) i++;
    else if (high || low) found.push(`unpaired surrogate at ${i}`);
  }
  const chars = [...name];
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if ('<>:"/\\|?*'.includes(ch)) found.push(`illegal ${ch}`);
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) found.push(`control U+${cp.toString(16)}`);
    if (/^\p{Cf}$/u.test(ch)) found.push(`format U+${cp.toString(16)}`);
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) found.push(`noncharacter U+${cp.toString(16)}`);
  }
  const atEnd = (ch: string | undefined) => ch !== undefined && /^[\s.~]$/u.test(ch);
  if (atEnd(chars[0])) found.push("bad first character");
  if (atEnd(chars[chars.length - 1])) found.push("bad last character");
  // Chrome: ASCII-lowercased name equals a device, or starts with device + ".".
  const lower = name.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (DEVICES.some((device) => lower === device || lower.startsWith(device + "."))) found.push("Chrome device name");
  if (lower === "desktop.ini" || lower === "thumbs.db") found.push("Chrome shell file name");
  // Windows: the part before the first dot, trailing spaces ignored.
  const base = lower.split(".")[0].replace(/ +$/, "");
  if (["com", "lpt"].some((prefix) => SUPERSCRIPTS.some((digit) => base === prefix + digit)) || DEVICES.includes(base)) {
    found.push("Windows device name");
  }
  return found;
}

/** Deterministic PRNG (mulberry32) so a failing random case can be reproduced. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a", "B", "z", "7", " ", " ", ".", "~", "<", ">", ":", '"', "/", "\\", "|", "?", "*", "%", "-", "[", "]",
  "\t", "\n", "\u0000", "\u007F", "\u0085", "\u{A0}", "\u{3000}", "\u{2028}", "\u{200B}", "\u{200D}", "\u{200E}",
  "\u{FEFF}", "\u{AD}", "\u{FDD0}", "\u{FFFF}", "\uD800", "\uDC00", "\u{1F3B5}", "\u{E0067}", "\u{65E5}", "e\u{301}",
  "con", "CON", "com1", "LPT\xB2", "clock$", "nul", "desktop.ini", "thumbs.db", "cloc\u{212A}$",
];

function randomText(next: () => number): string {
  // Up to ~220 pieces so names often run past the cap.
  const count = Math.floor(next() ** 2 * 220);
  let text = "";
  for (let i = 0; i < count; i++) text += PIECES[Math.floor(next() * PIECES.length)];
  return text;
}

describe("sanitize-vectors.json", () => {
  it("uses the same cap as the code", () => {
    expect(vectors.maxLength).toBe(MAX_STEM_LENGTH);
  });

  it("covers both functions", () => {
    expect(vectors.sanitizeFilename.length).toBeGreaterThanOrEqual(25);
    expect(vectors.buildStem.length).toBeGreaterThanOrEqual(10);
  });
});

describe("sanitizeFilename", () => {
  it.each(vectors.sanitizeFilename)("$note", ({ input, expected }) => {
    expect(sanitizeFilename(input)).toBe(expected);
    expect(problems(expected)).toEqual([]);
    expect(sanitizeFilename(expected)).toBe(expected);
  });

  it("always returns a name Windows and Chrome accept, and is idempotent (random inputs)", () => {
    const next = random(20261004);
    for (let i = 0; i < 3000; i++) {
      const input = randomText(next);
      const once = sanitizeFilename(input);
      expect(problems(once), JSON.stringify(input)).toEqual([]);
      expect(sanitizeFilename(once), JSON.stringify(input)).toBe(once);
    }
  });
});

describe("buildStem", () => {
  it.each(vectors.buildStem)("$note", ({ artist, title, videoId, expected }) => {
    expect(buildStem({ artist, title, videoId })).toBe(expected);
    expect(sanitizeFilename(expected)).toBe(expected);
  });

  it("keeps the [videoId] suffix, stays within the cap and survives re-sanitising (random parts)", () => {
    const next = random(42);
    for (let i = 0; i < 3000; i++) {
      const artist = randomText(next);
      const title = randomText(next);
      const stem = buildStem({ artist, title, videoId: "dQw4w9WgXcQ" });
      const context = JSON.stringify({ artist, title });
      expect(stem.endsWith("[dQw4w9WgXcQ]"), context).toBe(true);
      expect(problems(stem), context).toEqual([]);
      // Lyrics files append an extension; 255 is the NTFS limit for one name.
      expect(problems(stem + ".musixmatch-word.lrc", 255), context).toEqual([]);
      expect(sanitizeFilename(stem), context).toBe(stem);
    }
  });

  it.each(["", "abc", "abcdefghij!", "abcdefghijkl", "abcdefghij/", " abcdefghij"])(
    "throws on the invalid video id %j",
    (videoId) => {
      expect(() => buildStem({ title: "Song", videoId })).toThrow(/video id/);
    },
  );
});

describe("isVideoId", () => {
  it("accepts 11 characters of A-Z a-z 0-9 _ - only", () => {
    expect(isVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isVideoId("-_abcXYZ019")).toBe(true);
    expect(isVideoId("dQw4w9WgXc")).toBe(false);
    expect(isVideoId("dQw4w9WgXcQ\n")).toBe(false);
    expect(isVideoId("dQw4w9WgXc%")).toBe(false);
  });
});
