import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseLRC } from "@braccato/parsers";
import { describe, expect, it } from "vitest";
import { parseEnhancedLrc } from "../src/shared/convert/musixmatchWord";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { writeTonyTtml, type TimedLine } from "../src/shared/ttml";
import { readTony, type TonyLyrics } from "./helpers/tonyReader";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const wordByWord = extractSources(parseSse(stream)).sources.find((source) => source.id === "musixmatch-word")!.content;
const golden = (name: string) => readFileSync(new URL(`./fixtures/golden/${name}`, import.meta.url), "utf8");

const ms = (seconds: number | undefined) => (seconds === undefined ? "?" : String(Math.round(seconds * 1000)));
/** One string per line: words apart by a space, a word's pieces joined by "+", each "text@begin-end" in ms. */
const summary = (lines: TimedLine[]) =>
  lines.map((line) => line.words.map((word) => word.pieces.map((p) => `${p.text}@${ms(p.begin)}-${ms(p.end)}`).join("+")).join(" "));
const convert = (lrc: string) => summary(parseEnhancedLrc(lrc));

/** What Tony read: "text@begin-end" per word, in ms. */
const tonyWords = ({ lines }: TonyLyrics) => lines.map((line) => line.words.map((w) => `${w.text}@${ms(w.begin)}-${ms(w.end)}`).join(" "));
/** What Tony should read from these lines: a word's pieces joined, from its first begin to its last end, sorted as Tony sorts. */
const expectedTonyWords = (lines: TimedLine[]) =>
  lines
    .map((line) =>
      line.words
        .map(({ pieces }) => ({ text: pieces.map((p) => p.text).join(""), begin: pieces[0].begin, end: pieces[pieces.length - 1].end }))
        .sort((a, b) => a.begin - b.begin),
    )
    .sort((a, b) => a[0].begin - b[0].begin)
    .map((words) => words.map((w) => `${w.text}@${ms(w.begin)}-${ms(w.end)}`).join(" "));

const collapse = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
/** Per line BL shows words for: its main (not background) text and the start of each part with text, in ms. */
const blView = (lrc: string) =>
  parseLRC(lrc, 0)
    .map((lyric) => (lyric.parts ?? []).filter((part) => !part.isBackground))
    .filter((parts) => parts.some((part) => part.words.trim() !== ""))
    .map((parts) => ({
      text: collapse(parts.map((part) => part.words).join("")),
      starts: parts.filter((part) => part.words.trim() !== "").map((part) => part.startTimeMs),
    }));
const ourView = (lines: TimedLine[]) =>
  lines.map((line) => ({
    text: collapse(line.words.map((word) => word.pieces.map((p) => p.text).join("")).join(" ")),
    starts: line.words.flatMap((word) => word.pieces.map((p) => Math.round(p.begin * 1000))),
  }));

const FIXTURE_LINES = [
  "Paper@12250-12640 lanterns@12700-13380 on@13450-13620 the@13660-13780 water@13840-15020",
  "Half-@17100-17420+remembered@17420-18150 names@18230-18700 we@18760-18930 wrote@19000-20240",
  "A@22300-22450 thousand@22520-23120 little@23200-23610 fires@23700-24480 (oh)@24700-25900",
  "Drifting@28050-28560 where@28640-28900 the@28940-29050 river@29120-29600 goes@29680-31200",
  "Carry@58400-58950 me@59050-59400 home@59500-61600",
];

describe("parseEnhancedLrc on the fixture's Musixmatch word-by-word lyrics", () => {
  it("gives every word its tags' times, joins Half- + remembered, and drops the [bg:] part", () => {
    expect(convert(wordByWord)).toEqual(FIXTURE_LINES);
  });

  it("reads CRLF line ends the same", () => {
    expect(convert(wordByWord.replace(/\n/g, "\r\n"))).toEqual(FIXTURE_LINES);
  });

  it("is written as the golden file", () => {
    expect(writeTonyTtml({ title: "Marrow & Tin - Northbound Kites", lines: parseEnhancedLrc(wordByWord) })).toBe(golden("musixmatch-word.ttml"));
  });

  it("round trip: Tony's rules read the written file back to the same words and times, to the ms", () => {
    const lines = parseEnhancedLrc(wordByWord);
    const read = readTony(writeTonyTtml({ title: "Marrow & Tin - Northbound Kites", lines }));
    expect(read.title).toBe("Marrow & Tin - Northbound Kites");
    expect(tonyWords(read)).toEqual(expectedTonyWords(lines));
    expect(tonyWords(read)[1]).toBe("Half-remembered@17100-18150 names@18230-18700 we@18760-18930 wrote@19000-20240");
  });

  it("serves Unison richsync LRC too", () => {
    const body = JSON.stringify({ data: { lyrics: "[00:01.00] <00:01.00> Paper <00:01.40>   <00:01.50> kites <00:02.00>", format: "lrc", syncType: "richsync" } });
    const [source] = extractSources([], body).sources;
    expect(source.format).toBe("enhanced-lrc");
    expect(convert(source.content)).toEqual(["Paper@1000-1400 kites@1500-2000"]);
  });
});

describe("parseEnhancedLrc rules", () => {
  it("separator style: timed white space separates words, pieces are trimmed, pieces with no separator are one word", () => {
    // Two tags with nothing between them are no separator (as BL): a and b are one word.
    const lrc = "[00:01.00] <00:01.00> hy- <00:01.40> phen <00:01.70> at <00:01.90> ed <00:02.30>   <00:02.40> a <00:02.60><00:02.70> b <00:03.00> <00:03.10> c <00:03.50>";
    expect(convert(lrc)).toEqual(["hy-@1000-1400+phen@1400-1700+at@1700-1900+ed@1900-2300 a@2400-2600+b@2700-3000 c@3100-3500"]);
  });

  it("compact style: white space at either end of a piece is a word boundary", () => {
    const expected = ["Kite@5000-5400 strings@5400-5900 un@5900-6100+rav@6100-6300+el@6300-6700"];
    expect(convert("[00:05.00]<00:05.00>Kite <00:05.40>strings <00:05.90>un<00:06.10>rav<00:06.30>el <00:06.70>")).toEqual(expected);
    expect(convert("[00:05.00]<00:05.00>Kite<00:05.40> strings<00:05.90> un<00:06.10>rav<00:06.30>el<00:06.70>")).toEqual(expected);
  });

  it("decides the style per line", () => {
    const lrc = "[00:01.00]<00:01.00>one <00:01.50>two<00:02.00>\n[00:03.00] <00:03.00> hy- <00:03.40> phen <00:03.80>   <00:03.90> x <00:04.00>";
    expect(convert(lrc)).toEqual(["one@1000-1500 two@1500-2000", "hy-@3000-3400+phen@3400-3800 x@3900-4000"]);
  });

  it("hy- + phenated: one word of two adjacent spans, which Tony reads as one word", () => {
    const lines = parseEnhancedLrc("[00:01.00] <00:01.00> hy- <00:01.40> phenated <00:02.00>   <00:02.10> word <00:02.50>");
    expect(summary(lines)).toEqual(["hy-@1000-1400+phenated@1400-2000 word@2100-2500"]);
    const ttml = writeTonyTtml({ lines });
    expect(ttml).toContain('<span begin="0:01.000" end="0:01.400">hy-</span><span begin="0:01.400" end="0:02.000">phenated</span> <span begin="0:02.100" end="0:02.500">word</span>');
    expect(tonyWords(readTony(ttml))).toEqual(["hy-phenated@1000-2000 word@2100-2500"]);
  });

  it("drops a [bg: ...] part, and a line that has nothing else", () => {
    const lrc = [
      "[00:10.00] <00:10.00> Carry <00:10.50>   <00:10.60> on <00:11.00> [bg: <00:10.20> (carry <00:10.70>   <00:10.80> on) <00:11.20>]",
      "[00:12.00] [bg: <00:12.00> ooh <00:12.50>]",
    ].join("\n");
    expect(convert(lrc)).toEqual(["Carry@10000-10500 on@10600-11000"]);
  });

  it("applies [offset:] in milliseconds, the LRC way (positive is sooner), the last one winning wherever it is", () => {
    const lyrics = "[00:10.00] <00:10.00> soon <00:10.40> unclosed\n[00:12.00] <00:12.00> next <00:12.50>";
    expect(convert(`[offset:+500]\n${lyrics}`)).toEqual(["soon@9500-9900 unclosed@9900-11500", "next@11500-12000"]);
    expect(convert(`[offset:500]\n${lyrics}\n[offset: -250]`)).toEqual(["soon@10250-10650 unclosed@10650-12250", "next@12250-12750"]);
    expect(convert(`[offset:500]\n[offset:half a second]\n${lyrics}`)).toEqual(["soon@10000-10400 unclosed@10400-12000", "next@12000-12500"]);
  });

  it("treats header tags as metadata", () => {
    const lrc = [
      "[ti:Paper Kites]",
      "[ar:Marrow & Tin]",
      "[al:Weather Almanac]",
      "[au:Ada Invented]",
      "[length: 03:12]",
      "[by:]",
      "[re:a tool]",
      "[tool:another]",
      "[ve:1.0]",
      "[#:a comment]",
      "[00:01.00] <00:01.00> only <00:01.50> line",
    ].join("\n");
    expect(convert(lrc)).toEqual(["only@1000-1500 line@1500-2500"]);
  });

  it("ends a piece after a line's last tag at the next line's earliest stamp, never before its begin, and 1 s on the last line", () => {
    const lrc = [
      "[00:05.00] <00:05.00> one <00:05.50> two",
      "[00:20.00][00:07.00] no word tags here",
      "[00:08.00] <00:08.00> three <00:08.40> four",
      "[00:04.00] <00:04.00> back <00:04.50> again",
    ].join("\n");
    expect(convert(lrc)).toEqual(["one@5000-5500 two@5500-7000", "three@8000-8400 four@8400-8400", "back@4000-4500 again@4500-5500"]);
  });

  it("ignores text before a line's first tag and skips lines with no pieces or no line stamp", () => {
    const lrc = [
      "<00:01.00> no stamp <00:01.50>",
      "[00:02.00] plain line",
      "[00:03.00] <00:03.00>   <00:03.40>",
      "[00:04.00] <00:04.00><00:04.50>",
      "[00:06] <00:06.00> no fraction in the stamp <00:06.50>",
      "[00:07.00] Intro <00:07.50> kept <00:08.00>",
    ].join("\n");
    expect(convert(lrc)).toEqual(["kept@7500-8000"]);
  });

  it("reads mm:ss.xx, mm:ss.xxx and minutes past 59", () => {
    expect(convert("[01:15.250] <01:15.250> long <01:15.875> tags <01:16.5>\n[75:00.00] <75:00.00> late <75:01.50>")).toEqual([
      "long@75250-75875 tags@75875-76500",
      "late@4500000-4501500",
    ]);
  });

  it("keeps a piece whose tags run backwards as it is", () => {
    expect(convert("[00:02.00] <00:02.00> odd <00:01.50>")).toEqual(["odd@2000-1500"]);
  });
});

describe("parseEnhancedLrc against Better Lyrics' own parseLRC (@braccato/parsers 0.3.2)", () => {
  // Offsets are left out: BL reads them as seconds. Ends are not compared: BL fixes them up later.
  const cases = {
    fixture: wordByWord,
    separator: "[00:01.00] <00:01.00> hy- <00:01.40> phen <00:01.70> at <00:01.90> ed <00:02.30>   <00:02.40> a <00:02.60><00:02.70> b <00:03.00> <00:03.10> c <00:03.50>",
    "compact, trailing spaces": "[00:05.00]<00:05.00>Kite <00:05.40>strings <00:05.90>un<00:06.10>rav<00:06.30>el <00:06.70>",
    "compact, leading spaces": "[00:07.00]<00:07.00>Kite<00:07.40> strings<00:07.90> un<00:08.10>rav<00:08.30>el<00:08.70>",
    "stamps, intro text, background, unclosed": "[00:20.00][00:10.00] Intro <00:10.00> la <00:10.50> la <00:11.00> [bg: <00:10.20> ooh <00:10.80>]\n[00:12.00] <00:12.00> on <00:12.40> and on",
    "spaces inside a piece, CRLF, accents": "[00:12.00] <00:12.00> two words <00:12.80>   <00:12.90> \u{E9}t\u{E9} <00:13.40>\r\n[01:15.250] <01:15.250> long <01:15.875> tags <01:16.5>",
  };
  for (const [name, lrc] of Object.entries(cases)) {
    it(`gives the same text and piece starts per line: ${name}`, () => {
      const ours = ourView(parseEnhancedLrc(lrc));
      expect(ours.length).toBeGreaterThan(0);
      expect(ours).toEqual(blView(lrc));
    });
  }

  it("differs on purpose: keeps a timed line that looks like a credit, which BL drops", () => {
    const lrc = "[00:01.00] <00:01.00> Written <00:01.40> by: <00:01.80> Ada <00:02.20>";
    expect(blView(lrc)).toEqual([]);
    expect(convert(lrc)).toEqual(["Written@1000-1400 by:@1400-1800 Ada@1800-2200"]);
  });
});

// Real captures (copyrighted, gitignored) when the folder has any: raw lyrics streams as *.txt.
const localDir = new URL("../fixtures/local/", import.meta.url);
const captures = existsSync(localDir) ? readdirSync(localDir).filter((name) => name.endsWith(".txt")) : [];

describe("real captures in fixtures/local/", () => {
  it.skipIf(captures.length === 0)("convert every word-by-word line as BL reads it, and Tony reads it back unchanged", () => {
    for (const name of captures) {
      const text = readFileSync(new URL(name, localDir), "utf8");
      for (const source of extractSources(parseSse(text)).sources.filter((s) => s.format === "enhanced-lrc")) {
        const lines = parseEnhancedLrc(source.content);
        expect(ourView(lines), `${name}: ${source.id} against BL`).toEqual(blView(source.content));
        expect(tonyWords(readTony(writeTonyTtml({ lines }))), `${name}: ${source.id} through Tony's rules`).toEqual(expectedTonyWords(lines));
      }
    }
  });
});
