import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ttmlTime, writeTonyTtml, type TimedLine, type TimedWord } from "../src/shared/ttml";
import { readTony, type TonyLyrics } from "./helpers/tonyReader";

const golden = (name: string) => readFileSync(new URL(`./fixtures/golden/${name}`, import.meta.url), "utf8");

/** A word made of [text, begin, end] pieces. */
const word = (...pieces: [string, number, number][]): TimedWord => ({ pieces: pieces.map(([text, begin, end]) => ({ text, begin, end })) });
const line = (...words: TimedWord[]): TimedLine => ({ words });
/** The <p> lines of a written file. */
const paragraphs = (ttml: string) => ttml.split("\n").filter((row) => row.startsWith("      <p "));
const ms = (seconds: number | undefined) => (seconds === undefined ? "?" : String(Math.round(seconds * 1000)));
/** What Tony would read, one string per line: "text@begin-end" per word, in ms. */
const tonyWords = ({ lines }: TonyLyrics) => lines.map((row) => row.words.map((w) => `${w.text}@${ms(w.begin)}-${ms(w.end)}`).join(" "));

describe("ttmlTime", () => {
  it("writes M:SS.mmm with the minutes unpadded", () => {
    expect(ttmlTime(0)).toBe("0:00.000");
    expect(ttmlTime(0.48)).toBe("0:00.480");
    expect(ttmlTime(12.25)).toBe("0:12.250");
    expect(ttmlTime(61.4)).toBe("1:01.400");
  });

  it("lets the minutes pass 9 and 59, with no hours field", () => {
    expect(ttmlTime(600)).toBe("10:00.000");
    expect(ttmlTime(754.321)).toBe("12:34.321");
    expect(ttmlTime(3600)).toBe("60:00.000");
    expect(ttmlTime(3725.5)).toBe("62:05.500");
    expect(ttmlTime(10 * 3600 + 1.002)).toBe("600:01.002");
  });

  it("rounds seconds * 1000 to the nearest millisecond as Tony does, carrying into the minute", () => {
    expect(ttmlTime(1.2344)).toBe("0:01.234");
    expect(ttmlTime(1.2346)).toBe("0:01.235");
    expect(ttmlTime(59.9996)).toBe("1:00.000");
    // The double nearest 1.0005 lies just below it, but times 1000 it is exactly 1000.5,
    // which llround (and Math.round) take up: Tony writes 0:01.001, and so must we.
    expect(1.0005 * 1000).toBe(1000.5);
    expect(1.0005.toFixed(3)).toBe("1.000");
    expect(ttmlTime(1.0005)).toBe("0:01.001");
  });

  it("writes times below zero as zero", () => {
    expect(ttmlTime(-0.0004)).toBe("0:00.000");
    expect(ttmlTime(-3)).toBe("0:00.000");
  });

  it("refuses NaN and infinities", () => {
    expect(() => ttmlTime(Number.NaN)).toThrow(RangeError);
    expect(() => ttmlTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("writeTonyTtml", () => {
  const basic = {
    title: "Marrow & Tin - Paper Kites",
    lines: [
      line(word(["Kite", 0.48, 0.75]), word(["strings", 0.81, 1.24]), word(["un", 1.3, 1.42], ["rav", 1.42, 1.71], ["el", 1.71, 2.05])),
      // Neither of these is written, nor uses up a key.
      line(),
      line(word([" \t", 3, 3.5]), word(["", 3.5, 4])),
      line(word(["Rope", 4.37, 4.69]), word(["&", 4.72, 4.88]), word(["<string>", 4.95, 5.83])),
      line(word(["Fly", 61.4, 61.92]), word(["home", 62.05, 63.75])),
    ],
  };

  it("matches the golden file byte for byte", () => {
    expect(writeTonyTtml(basic)).toBe(golden("writer-basic.ttml"));
  });

  it("is read back by Tony's rules with the same title, words and times", () => {
    const read = readTony(writeTonyTtml(basic));
    expect(read.title).toBe("Marrow & Tin - Paper Kites");
    expect(tonyWords(read)).toEqual([
      "Kite@480-750 strings@810-1240 unravel@1300-2050",
      "Rope@4370-4690 &@4720-4880 <string>@4950-5830",
      "Fly@61400-61920 home@62050-63750",
    ]);
  });

  it("starts with the XML declaration, never has a DOCTYPE, and ends with exactly one line break", () => {
    const ttml = writeTonyTtml(basic);
    expect(ttml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<tt ')).toBe(true);
    expect(ttml).not.toMatch(/<!DOCTYPE/i);
    expect(ttml.endsWith("</tt>\n")).toBe(true);
    expect(ttml.endsWith("\n\n")).toBe(false);
  });

  it("leaves out <ttm:title> when there is no title or a blank one", () => {
    for (const title of [undefined, "", " \t\x01"]) {
      const ttml = writeTonyTtml({ title, lines: basic.lines });
      expect(ttml).not.toContain("title");
      expect(ttml).toContain('    <metadata>\n      <ttm:agent type="person" xml:id="v1"/>\n    </metadata>\n');
    }
  });

  it("numbers only the lines it writes", () => {
    const ttml = writeTonyTtml({ lines: [line(), line(word(["a", 1, 2])), line(word(["  ", 3, 4])), line(word(["b", 5, 6]))] });
    expect(paragraphs(ttml).map((row) => /itunes:key="(L\d+)"/.exec(row)?.[1])).toEqual(["L1", "L2"]);
  });

  it("writes times past 10 and 60 minutes as minutes", () => {
    const ttml = writeTonyTtml({ lines: [line(word(["late", 754.321, 755.5])), line(word(["later", 3725.5, 3726.25]))] });
    expect(paragraphs(ttml)).toEqual([
      '      <p begin="12:34.321" end="12:35.500" ttm:agent="v1" itunes:key="L1"><span begin="12:34.321" end="12:35.500">late</span></p>',
      '      <p begin="62:05.500" end="62:06.250" ttm:agent="v1" itunes:key="L2"><span begin="62:05.500" end="62:06.250">later</span></p>',
    ]);
    expect(ttml).toContain('<body dur="62:06.250">\n    <div begin="12:34.321" end="62:06.250">');
    expect(tonyWords(readTony(ttml))).toEqual(["late@754321-755500", "later@3725500-3726250"]);
  });

  it("escapes &, < and > in the text and the title", () => {
    const ttml = writeTonyTtml({
      title: 'A&B <"Live">',
      lines: [line(word(["rock&roll", 1, 2]), word(["<3", 2, 3]), word(["a>b", 3, 4]), word(['"so"', 4, 5]), word(["it's", 5, 6]))],
    });
    expect(ttml).toContain('<ttm:title>A&amp;B &lt;"Live"&gt;</ttm:title>');
    expect(paragraphs(ttml)[0]).toContain('>rock&amp;roll</span> <span begin="0:02.000" end="0:03.000">&lt;3</span>');
    expect(paragraphs(ttml)[0]).toContain(">a&gt;b</span>");
    const read = readTony(ttml);
    expect(read.title).toBe('A&B <"Live">');
    expect(read.lines[0].words.map((w) => w.text)).toEqual(["rock&roll", "<3", "a>b", '"so"', "it's"]);
  });

  it("drops characters XML 1.0 does not allow and keeps every other one", () => {
    const text = "a\x00b\x01c\x1fd\u{FFFE}e\u{FFFF}f\u{D800}g\u{DC00}h\x7f\u{E9}\u{6F22}\u{1F600}";
    const ttml = writeTonyTtml({ title: "T\x07itle", lines: [line(word([text, 1, 2]))] });
    expect(ttml).toContain("<ttm:title>Title</ttm:title>");
    expect(ttml).toContain(">abcdefgh\x7f\u{E9}\u{6F22}\u{1F600}</span>");
    // The oracle refuses any such character, as Qt's reader does.
    expect(() => readTony(`<tt><body><p><span begin="1" end="2">a\x01</span></p></body></tt>`)).toThrow(/XML 1.0/);
    expect(readTony(ttml).lines[0].words[0].text).toBe("abcdefgh\u{E9}\u{6F22}\u{1F600}");
  });

  it("makes tabs and line breaks spaces and trims each piece, so a <p> stays on one line and words stay whole", () => {
    const ttml = writeTonyTtml({ lines: [line(word(["\n hy-", 1, 1.4], ["phen\t", 1.4, 1.8]), word(["two\twords\r\n", 2, 3]))] });
    expect(paragraphs(ttml)).toEqual([
      '      <p begin="0:01.000" end="0:03.000" ttm:agent="v1" itunes:key="L1"><span begin="0:01.000" end="0:01.400">hy-</span><span begin="0:01.400" end="0:01.800">phen</span> <span begin="0:02.000" end="0:03.000">two words</span></p>',
    ]);
    expect(tonyWords(readTony(ttml))).toEqual(["hy-phen@1000-1800 two words@2000-3000"]);
  });

  it("drops pieces left empty but keeps the rest of their word", () => {
    const ttml = writeTonyTtml({ lines: [line(word(["hy-", 1, 1.4], [" ", 1.4, 1.5], ["phen", 1.5, 1.8]))] });
    expect(paragraphs(ttml)[0]).toContain('<span begin="0:01.000" end="0:01.400">hy-</span><span begin="0:01.500" end="0:01.800">phen</span></p>');
  });

  it("keeps zero- and negative-length pieces as given; body and div end at the latest time of either kind, as Tony's writer", () => {
    const ttml = writeTonyTtml({ lines: [line(word(["still", 5, 5]), word(["back", 7, 6.5]))] });
    expect(paragraphs(ttml)).toEqual([
      '      <p begin="0:05.000" end="0:06.500" ttm:agent="v1" itunes:key="L1"><span begin="0:05.000" end="0:05.000">still</span> <span begin="0:07.000" end="0:06.500">back</span></p>',
    ]);
    expect(ttml).toContain('<body dur="0:07.000">\n    <div begin="0:05.000" end="0:07.000">');
  });

  it("takes each <p>'s span from its own pieces and the div's from all of them", () => {
    const ttml = writeTonyTtml({ lines: [line(word(["late", 30, 31])), line(word(["then", 9, 10]), word(["first", 8, 8.5])), line(word(["long", 12, 40]))] });
    expect(paragraphs(ttml).map((row) => /^ *<p begin="([^"]*)" end="([^"]*)"/.exec(row)?.slice(1).join("-"))).toEqual([
      "0:30.000-0:31.000",
      "0:08.000-0:10.000",
      "0:12.000-0:40.000",
    ]);
    expect(ttml).toContain('<body dur="0:40.000">\n    <div begin="0:08.000" end="0:40.000">');
  });

  it("writes an empty div when nothing is left to write, which Tony then refuses", () => {
    const ttml = writeTonyTtml({ title: "Empty", lines: [line(), line(word(["\x01", 1, 2]))] });
    expect(ttml).toContain('  <body dur="0:00.000">\n    <div begin="0:00.000" end="0:00.000">\n    </div>\n  </body>\n</tt>\n');
    expect(() => readTony(ttml)).toThrow(/no timed lyrics/);
  });

  it("refuses a time that is not a finite number", () => {
    expect(() => writeTonyTtml({ lines: [line(word(["a", Number.NaN, 1]))] })).toThrow(RangeError);
    expect(() => writeTonyTtml({ lines: [line(word(["a", 1, Number.POSITIVE_INFINITY]))] })).toThrow(RangeError);
  });
});
