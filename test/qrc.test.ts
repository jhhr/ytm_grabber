import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseQRC } from "@braccato/parsers";
import { describe, expect, it } from "vitest";
import { parseQrc, type QrcContext } from "../src/shared/convert/qrc";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { writeTonyTtml, type TimedLine } from "../src/shared/ttml";
import { readTony, type TonyLyrics } from "./helpers/tonyReader";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const fixtureQrc = extractSources(parseSse(stream)).sources.find((source) => source.id === "qq")!.content;
const golden = (name: string) => readFileSync(new URL(`./fixtures/golden/${name}`, import.meta.url), "utf8");
const SONG: QrcContext = { title: "Northbound Kites", artist: "Marrow & Tin" };
const TITLE = "Marrow & Tin - Northbound Kites";

const ms = (seconds: number | undefined) => (seconds === undefined ? "?" : String(Math.round(seconds * 1000)));
/** One string per line: words apart by a space, a word's pieces joined by "+", each "text@begin-end" in ms. */
const summary = (lines: TimedLine[]) =>
  lines.map((line) => line.words.map((word) => word.pieces.map((p) => `${p.text}@${ms(p.begin)}-${ms(p.end)}`).join("+")).join(" "));
const convert = (qrc: string, context?: QrcContext) => summary(parseQrc(qrc, context));
const rows = (...lines: string[]) => lines.join("\n");
/** QQ's XML around a LyricContent value, which is used as given (already escaped). */
const qqXml = (value: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>\n<QrcHeadInfo SaveTime="1" Version="100"/>\n<LyricInfo LyricCount="1">\n<Lyric_1 LyricType="1" LyricContent="${value}"/>\n</LyricInfo>\n</QrcInfos>`;
/** A plain lyric line: two pieces, so never a credit by timing. */
const LYRIC = "[9000,1000]la (9000,300)la(9300,700)";
const LYRIC_OUT = "la@9000-9300 la@9300-10000";

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

const FIXTURE_LINES = [
  "Paper@12250-12640 lanterns@12700-13380 on@13450-13620 the@13660-13780 water@13840-15020",
  "Half-@17100-17420+remembered@17420-18150 names@18230-18700 we@18760-18930 wrote@19000-20240",
  "A@22300-22450 thou@22520-22800+sand@22800-23120 little@23200-23610 fires@23700-24480 (oh)@24700-25900",
  "Drifting@28050-28560 where@28640-28900 the@28940-29050 river@29120-29600 goes@29680-31200",
  "Carry@58400-58950 me@59050-59400 home@59500-60100 (carry@60100-60550 me@60600-60850 home)@60900-62400",
];

describe("parseQrc on the fixture's QQ lyrics", () => {
  it("drops the two credit lines, joins thou + sand and keeps the lyrics' parentheses", () => {
    expect(convert(fixtureQrc, SONG)).toEqual(FIXTURE_LINES);
  });

  it("finds the same credits without the capture's metadata, from QQ's headers and timing", () => {
    expect(convert(fixtureQrc)).toEqual(FIXTURE_LINES);
  });

  it("reads CRLF line ends the same", () => {
    expect(fixtureQrc).toContain("\n");
    expect(convert(fixtureQrc.replace(/\n/g, "\r\n"), SONG)).toEqual(FIXTURE_LINES);
  });

  it("is written as the golden file", () => {
    expect(writeTonyTtml({ title: TITLE, lines: parseQrc(fixtureQrc, SONG) })).toBe(golden("qq.ttml"));
  });

  it("round trip: Tony's rules read the written file back to the same words and times, to the ms", () => {
    const lines = parseQrc(fixtureQrc, SONG);
    const read = readTony(writeTonyTtml({ title: TITLE, lines }));
    expect(read.title).toBe(TITLE);
    expect(tonyWords(read)).toEqual(expectedTonyWords(lines));
    expect(tonyWords(read)[2]).toBe("A@22300-22450 thousand@22520-23120 little@23200-23610 fires@23700-24480 (oh)@24700-25900");
  });
});

describe("parseQrc rules", () => {
  it("decodes the attribute's entities, numeric ones included, once", () => {
    const value =
      "[0,2000]R&amp;B (0,100)&lt;3&gt; (100,110)&quot;hi&quot; (210,120)it&apos;s (330,130)&#233;t&#xE9; (460,140)&#X41; (600,150)" +
      "&amp;lt; (750,160)&nbsp; (910,170)&#0;&#xD800;&#x110000;&#99999999999999999999; (1080,180)& &#; &#x; (1260,190)";
    // The last piece has spaces inside, so it stays one piece.
    expect(convert(qqXml(value))).toEqual([
      "R&B@0-100 <3>@100-210 \"hi\"@210-330 it's@330-460 \u{E9}t\u{E9}@460-600 A@600-750 &lt;@750-910 &nbsp;@910-1080 " +
        "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}@1080-1260 & &#; &#x;@1260-1450",
    ]);
  });

  it("takes the attribute up to the quote that ends the tag or starts another attribute", () => {
    expect(convert('<Lyric_1 LyricContent="[0,1000]say (0,300)"hi"(300,400)" LyricType="1"/>')).toEqual(['say@0-300 "hi"@300-700']);
    expect(convert('<Lyric_1 LyricContent="[0,1000]say (0,300)"hi"(300,400)">')).toEqual(['say@0-300 "hi"@300-700']);
  });

  it("reads QRC without the XML around it, and does not decode it, since it is not XML", () => {
    expect(convert("[0,1000]Rock (0,300)&amp; (300,400)roll(700,300)")).toEqual(["Rock@0-300 &amp;@300-700 roll@700-1000"]);
  });

  it("skips header lines of any name and lines without a [start,duration] stamp, read as BL reads it", () => {
    const qrc = rows(
      "[ti:Paper Kites]",
      "[kana:1abc]",
      "[total:72000]",
      "[by:]",
      "[ti:unclosed",
      "no stamp (0,500)here(500,300)",
      "[1000]no comma (1000,500)here(1500,300)",
      "[a,b]not numbers (2000,500)here(2500,300)",
      "[ 3000 , 1000 ]spaced (3000,500)stamp(3500,300)",
      "[4000,1000x]junk (4000,500)after(4500,300)",
    );
    expect(convert(qrc)).toEqual(["spaced@3000-3500 stamp@3500-3800", "junk@4000-4500 after@4500-4800"]);
  });

  it("applies [offset:] in milliseconds, the LRC way (positive is sooner), the last one winning wherever it is", () => {
    const lyrics = "[1000,1000]soon (1000,400)now(1400,600)";
    expect(convert(rows("[offset:+500]", lyrics))).toEqual(["soon@500-900 now@900-1500"]);
    expect(convert(rows("[offset:500]", lyrics, "[offset: -250]"))).toEqual(["soon@1250-1650 now@1650-2250"]);
    expect(convert(rows("[offset:500]", "[offset:half a second]", lyrics))).toEqual(["soon@1000-1400 now@1400-2000"]);
    expect(convert(rows("[offset:0]", lyrics))).toEqual(["soon@1000-1400 now@1400-2000"]);
  });

  it("keeps parentheses in lyrics: only digit pairs are times", () => {
    expect(convert("[0,3000](oh)(0,500) (yeah (500,400)baby)(900,700) (1, 2) (1600,300)(12,ab) (1900,600)")).toEqual([
      "(oh)@0-500 (yeah@500-900 baby)@900-1600 (1, 2)@1600-1900 (12,ab)@1900-2500",
    ]);
  });

  it("joins pieces with no white space between them, splits at white space on either side, and ignores text after the last times", () => {
    expect(convert("[0,3000]thou(0,200)sand (200,300)a(500,100) (600,50)b(650,150)(800,50)c(850,150) d(1000,200) tail")).toEqual([
      "thou@0-200+sand@200-500 a@500-600 b@650-800+c@850-1000 d@1000-1200",
    ]);
    // CJK: a syllable per character, words ended by an ideographic space (U+3000).
    expect(convert("[0,1000]\u{6211}(0,200)\u{7231}(200,300)\u{4F60}\u{3000}(500,250)\u{5440}(750,250)")).toEqual([
      "\u{6211}@0-200+\u{7231}@200-500+\u{4F60}@500-750 \u{5440}@750-1000",
    ]);
  });

  it("skips a line whose pieces have no text, and a stamp with no pieces", () => {
    expect(convert(rows("[0,500]", "[500,500] (500,100)  (600,150)", "[1000,500]la (1000,200)la(1200,300)"))).toEqual([
      "la@1000-1200 la@1200-1500",
    ]);
  });

  it("keeps the times as given, a piece of no duration included", () => {
    expect(convert("[5000,1000]late (5000,0)early(4000,300)")).toEqual(["late@5000-5000 early@4000-4300"]);
  });
});

describe("parseQrc credit lines (BL's rules, leading lines only)", () => {
  const naming = "[0,2000]Marrow & Tin (0,700)- (700,500)Northbound Kites(1200,800)";

  it("drops a line naming the song by the capture's title and artist, normalised", () => {
    expect(convert(rows(naming, LYRIC), SONG)).toEqual([LYRIC_OUT]);
    expect(convert(rows("[0,2000]NORTHBOUND-KITES (0,700)/ (700,500)marrow&tin(1200,800)", LYRIC), SONG)).toEqual([LYRIC_OUT]);
    expect(convert(rows(naming, LYRIC))).toHaveLength(2);
  });

  it("names the song by QQ's [ti:] and [ar:] headers too", () => {
    expect(convert(rows("[ti:Northbound Kites]", "[ar:Marrow &amp; Tin]", naming, LYRIC))).toHaveLength(2); // raw QRC: not decoded
    expect(convert(rows("[ti:Northbound Kites]", "[ar:Marrow & Tin]", naming, LYRIC))).toEqual([LYRIC_OUT]);
    expect(convert(rows(naming, LYRIC, "[ar:Marrow & Tin]", "[ti:Northbound Kites]"))).toEqual([LYRIC_OUT]);
  });

  it("with no artist known, drops a line holding the title that is less than 15 characters longer", () => {
    expect(convert(rows("[0,1000]Kites (0,300)(live)(300,700)", LYRIC), { title: "Kites" })).toEqual([LYRIC_OUT]);
    // "kitesovertheharbour" is 14 characters longer than "kites", "kitesovertheharbours" 15.
    expect(convert(rows("[0,1000]Kites (0,300)over (300,250)the (550,200)harbour(750,450)", LYRIC), { title: "Kites" })).toEqual([LYRIC_OUT]);
    expect(convert(rows("[0,1000]Kites (0,300)over (300,250)the (550,200)harbours(750,450)", LYRIC), { title: "Kites" })).toHaveLength(2);
  });

  it("drops a line that is the artist and nothing else", () => {
    expect(convert(rows("[0,1000]MARROW (0,300)& (300,250)TIN(550,450)", LYRIC), { artist: "Marrow & Tin" })).toEqual([LYRIC_OUT]);
    expect(convert(rows("[0,1000]Marrow (0,300)& (300,250)Tin (550,450)forever(1000,200)", LYRIC), { artist: "Marrow & Tin" })).toHaveLength(2);
  });

  it("drops a line of more than 2 pieces whose durations are all within 10 ms of the first, pieces without text included", () => {
    expect(convert(rows("[0,1500]one (0,500)two (500,505)three(1005,491)", LYRIC))).toEqual([LYRIC_OUT]);
    expect(convert(rows("[0,1500]one (0,500)(500,500)three(1000,500)", LYRIC))).toEqual([LYRIC_OUT]);
    expect(convert(rows("[0,1500]one (0,500)two (500,510)three(1010,500)", LYRIC))).toHaveLength(2);
    expect(convert(rows("[0,1000]one (0,500)two(500,500)", LYRIC))).toHaveLength(2);
  });

  it("drops `Key: value` with a credit key, half-width or full-width colon, the key read across pieces", () => {
    const credits = [
      "[0,1000]Written (0,300)by: (300,250)Ada(550,450)",
      "[0,1000]Producer: Bob(0,1000)",
      "[0,1000]\u{4F5C}\u{8BCD}\u{FF1A}Ada(0,1000)", // zuoci (lyrics)
      "[0,1000]\u{4F5C}\u{8BCD}/\u{4F5C}\u{66F2}\u{FF1A}Ada(0,1000)", // zuoci/zuoqu: every role a credit role
      "[0,1000]Producer/\u{5236}\u{4F5C}\u{4EBA}: Bob(0,1000)", // Latin words removed, zhizuoren left
      "[0,1000]\u{5973}\u{58F0}\u{FF1A}Ada(0,1000)", // nvsheng (female voice): a short role ending in sheng
      "[0,1000]MIXING : Bob(0,1000)",
    ];
    for (const credit of credits) expect(convert(rows(credit, LYRIC)), credit).toEqual([LYRIC_OUT]);
  });

  it("keeps `Key: value` whose key is no credit key, and a credit key whose colon comes after 40 characters", () => {
    expect(convert(rows("[0,1000]Lyrics: (0,300)none(300,700)", LYRIC))).toHaveLength(2);
    expect(convert(rows("[0,1000]: (0,300)Bob(300,700)", LYRIC))).toHaveLength(2);
    const pieces = (count: number) => Array.from({ length: count }, (_, i) => `aaaaaaaaaa(${i * 100},${100 + i * 10})`).join("");
    expect(convert(rows(`[0,3000]${pieces(3)}\u{4F5C}\u{66F2}\u{FF1A}x(600,300)`, LYRIC))).toEqual([LYRIC_OUT]);
    expect(convert(rows(`[0,3000]${pieces(5)}\u{4F5C}\u{66F2}\u{FF1A}x(600,300)`, LYRIC))).toHaveLength(2);
  });

  it("stops at the first line that is not a credit", () => {
    const qrc = rows("[0,1000]Producer: Bob(0,1000)", "[1000,1000]Paper (1000,400)kites(1400,600)", "[2000,1000]Mixing: Bob(2000,1000)", LYRIC);
    expect(convert(qrc)).toEqual(["Paper@1000-1400 kites@1400-2000", "Mixing: Bob@2000-3000", LYRIC_OUT]);
  });

  it("drops any number of leading credit-key lines; lines without text are not counted", () => {
    const credit = (i: number) => `[${i * 1000},900]Mixing: (${i * 1000},300)Bob${i}(${i * 1000 + 300},600)`;
    expect(convert(rows(credit(1), credit(2), credit(3), credit(4), credit(5), credit(6), LYRIC))).toEqual([LYRIC_OUT]);
    // The uniform-timing window counts lyric lines only: 4 credits and 2 empty lines leave
    // the evenly timed line 5th, still inside the window.
    const even = "[7000,900]la (7000,300)la (7300,300)la(7600,300)";
    expect(convert(rows(credit(1), "[1500,100]", "[1600,100] (1600,50)", credit(2), credit(3), credit(4), even, LYRIC))).toEqual([LYRIC_OUT]);
  });
});

describe("parseQrc against Better Lyrics' own parseQRC (@braccato/parsers 0.3.2)", () => {
  const collapse = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
  /** Per line with text (BL also returns instrumental gaps and empty lines): its text and the start of each part with text, in ms. */
  const blView = (qrc: string, context?: QrcContext) =>
    parseQRC(qrc, 600000, context)
      .filter((lyric) => lyric.words.trim() !== "")
      .map((lyric) => ({
        text: collapse(lyric.words),
        starts: (lyric.parts ?? []).filter((part) => part.words.trim() !== "").map((part) => part.startTimeMs),
      }));
  const ourView = (lines: TimedLine[]) =>
    lines.map((line) => ({
      text: collapse(line.words.map((word) => word.pieces.map((p) => p.text).join("")).join(" ")),
      starts: line.words.flatMap((word) => word.pieces.map((p) => Math.round(p.begin * 1000))),
    }));

  const cases: Record<string, [string, QrcContext?]> = {
    fixture: [fixtureQrc, SONG],
    "fixture, CRLF": [fixtureQrc.replace(/\n/g, "\r\n"), SONG],
    "fixture, no metadata": [fixtureQrc],
    "joins and boundaries": ["[0,3000]thou(0,200)sand (200,300)a(500,100) (600,50)b(650,150)(800,50)c(850,150) d(1000,200) tail"],
    parentheses: ["[0,3000](oh)(0,500) (yeah (500,400)baby)(900,700) (1, 2) (1600,300)(12,ab) (1900,600)"],
    "song named": [rows("[0,2000]Marrow & Tin (0,700)- (700,500)Northbound Kites(1200,800)", LYRIC), SONG],
    "title only": [rows("[0,1000]Kites (0,300)(live)(300,700)", LYRIC), { title: "Kites" }],
    "credits by timing and key, then lyrics": [
      rows("[0,1500]one (0,500)two (500,505)three(1005,491)", "[2000,1000]\u{4F5C}\u{8BCD}/\u{4F5C}\u{66F2}\u{FF1A}Ada(2000,1000)", "[3000,1000]Written (3000,300)by: (3300,250)Ada(3550,450)", LYRIC),
    ],
    "40-character key rule": [rows(`[0,3000]${"aaaaaaaaaa(0,100)".repeat(5)}\u{4F5C}\u{66F2}\u{FF1A}x(600,300)`, LYRIC)],
    "&quot; and &amp; in the attribute": [qqXml("[0,1000]say (0,300)&quot;R&amp;B&quot;(300,700)\n[1000,1000]la (1000,400)la(1400,600)")],
    "headers and stamps": [rows("[ti:x]", "[kana:1abc]", "[1000]no (1000,500)comma(1500,300)", "[ 3000 , 1000 ]spaced (3000,500)stamp(3500,300)")],
  };
  for (const [name, [qrc, context]] of Object.entries(cases)) {
    it(`gives the same lines, text and piece starts: ${name}`, () => {
      const ours = ourView(parseQrc(qrc, context));
      expect(ours.length).toBeGreaterThan(0);
      expect(ours).toEqual(blView(qrc, context));
    });
  }

  it("differs on purpose: applies [offset:] (BL ignores it)", () => {
    const qrc = rows("[offset:500]", "[1000,1000]soon (1000,400)now(1400,600)");
    expect(blView(qrc)[0].starts).toEqual([1000, 1400]);
    expect(ourView(parseQrc(qrc))[0].starts).toEqual([500, 900]);
  });

  it("differs on purpose: decodes every entity (BL only &quot; and &amp;)", () => {
    const qrc = qqXml("[0,1000]&lt;3 (0,300)&#233;(300,700)");
    expect(blView(qrc)[0].text).toBe("&lt;3 &#233;");
    expect(ourView(parseQrc(qrc))[0].text).toBe("<3 \u{E9}");
  });

  it("differs on purpose: keeps a first lyric line that is merely similar to the title and artist", () => {
    const qrc = rows("[1000,2000]Carry (1000,400)me (1400,300)home (1700,500)tonight(2200,800)", LYRIC);
    const song = { title: "Carry Me Home", artist: "Marrow & Tin" };
    expect(blView(qrc, song).map((line) => line.text)).toEqual(["la la"]);
    expect(ourView(parseQrc(qrc, song)).map((line) => line.text)).toEqual(["Carry me home tonight", "la la"]);
  });

  it("differs on purpose: credit keys only at the start (BL drops them anywhere)", () => {
    const middle = rows("[1000,1000]Paper (1000,400)kites(1400,600)", "[3000,1000]Producer: (3000,300)Bob(3300,700)", LYRIC);
    expect(blView(middle).map((line) => line.text)).toEqual(["Paper kites", "la la"]);
    expect(ourView(parseQrc(middle)).map((line) => line.text)).toEqual(["Paper kites", "Producer: Bob", "la la"]);
  });

  it("drops any number of leading credit-key lines, as BL does", () => {
    const six = rows(...[1, 2, 3, 4, 5, 6].map((i) => `[${i * 1000},900]Mixing: (${i * 1000},300)Bob${i}(${i * 1000 + 300},600)`), LYRIC);
    expect(blView(six).map((line) => line.text)).toEqual(["la la"]);
    expect(ourView(parseQrc(six)).map((line) => line.text)).toEqual(["la la"]);
  });

  it("applies the uniform-timing test to the first 5 lyric lines only", () => {
    const credit = (i: number) => `[${i * 1000},900]Mixing: (${i * 1000},300)Bob${i}(${i * 1000 + 300},600)`;
    const even = (at: number) => `[${at},900]la (${at},300)la (${at + 300},300)la(${at + 600},300)`;
    // An evenly timed line right after 5 credit lines is the song's first real line: kept.
    const late = rows(credit(1), credit(2), credit(3), credit(4), credit(5), even(6000), LYRIC);
    expect(ourView(parseQrc(late)).map((line) => line.text)).toEqual(["la la la", "la la"]);
    // Within the first 5 it reads as a QQ credit line, as BL treats it.
    const early = rows(credit(1), even(2000), LYRIC);
    expect(ourView(parseQrc(early)).map((line) => line.text)).toEqual(["la la"]);
  });

  it("differs on purpose: keeps a singer label such as `Ada:` as a word (BL strips it and sets the line's agent)", () => {
    const qrc = "[1000,1000]Ada: (1000,300)Paper (1300,300)kites(1600,400)";
    expect(blView(qrc)[0].text).toBe("Paper kites");
    expect(ourView(parseQrc(qrc))[0].text).toBe("Ada: Paper kites");
  });
});

// Real captures (copyrighted, gitignored) when the folder has any: raw lyrics streams as *.txt.
const localDir = new URL("../fixtures/local/", import.meta.url);
const captures = existsSync(localDir) ? readdirSync(localDir).filter((name) => name.endsWith(".txt")) : [];

describe("real captures in fixtures/local/", () => {
  it.skipIf(captures.length === 0)("convert every QQ source so that Tony reads it back unchanged", () => {
    for (const name of captures) {
      const { metadata, sources } = extractSources(parseSse(readFileSync(new URL(name, localDir), "utf8")));
      for (const source of sources.filter((s) => s.format === "qrc")) {
        const lines = parseQrc(source.content, { title: metadata.song, artist: metadata.artist });
        expect(tonyWords(readTony(writeTonyTtml({ lines }))), `${name}: ${source.id} through Tony's rules`).toEqual(expectedTonyWords(lines));
      }
    }
  });
});
