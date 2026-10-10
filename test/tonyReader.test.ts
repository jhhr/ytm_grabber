// The test oracle itself, checked against the fixtures' real-shaped TTML and against the rules
// of Tony's parseTtml() it claims to follow (main/LyricsTtml.cpp in jhhr/tony).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSources } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { readTony, type TonyLyrics } from "./helpers/tonyReader";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { sources } = extractSources(parseSse(stream), unison);
const content = (id: string) => sources.find((source) => source.id === id)!.content;

const ms = (seconds: number | undefined) => (seconds === undefined ? "?" : String(Math.round(seconds * 1000)));
const tonyWords = ({ lines }: TonyLyrics) => lines.map((row) => row.words.map((w) => `${w.text}@${ms(w.begin)}-${ms(w.end)}`).join(" "));
const tt = (body: string, head = "") =>
  `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>${head}</metadata></head><body><div>${body}</div></body></tt>`;

const FIXTURE_MAIN = [
  "Paper@12250-12640 lanterns@12700-13380 on@13450-13620 the@13660-13780 water@13840-15020",
  "Half-remembered@17100-18150 names@18230-18700 we@18760-18930 wrote@19000-20240",
  "A@22300-22450 thousand@22520-23120 little@23200-23610 fires@23700-24480 (oh)@24700-25900",
  "Drifting@28050-28560 where@28640-28900 the@28940-29050 river@29120-29600 goes@29680-31200",
];

describe("readTony on the fixtures", () => {
  it("golyrics: plain seconds and m:ss.mmm, syllables joined, the backing-vocal <p> its own overlapping line", () => {
    const read = readTony(content("golyrics"));
    expect(read.title).toBe("");
    expect(read.skippedParts).toBe(0);
    expect(tonyWords(read)).toEqual([...FIXTURE_MAIN, "Carry@58400-58950 me@59050-59400 home@59500-61600", "(carry@60100-60550 me@60600-60850 home)@60900-62400"]);
  });

  it("binimum: mm:ss.mmm, and the x-bg span skipped", () => {
    const read = readTony(content("binimum"));
    expect(read.skippedParts).toBe(1);
    expect(tonyWords(read)).toEqual([...FIXTURE_MAIN, "Carry@58400-58950 me@59050-59400 home@59500-61600"]);
  });

  it("Unison: indented between elements, whole words per span", () => {
    expect(tonyWords(readTony(content("unison")))).toEqual([
      ...FIXTURE_MAIN,
      "Carry@58400-58950 me@59050-59400 home@59500-60100 (carry@60100-60550 me@60600-60850 home)@60900-62400",
    ]);
  });
});

describe("readTony rules", () => {
  it("reads h:mm:ss.mmm, `dur` for a missing end, and leaves an end it is not given undefined", () => {
    const read = readTony(tt('<p><span begin="1:02:03.5" end="1:02:04">a</span> <span begin="10.25" dur="0.5">b</span> <span begin="12">c</span></p>'));
    // In start order, as Tony sorts them.
    expect(tonyWords(read)).toEqual(["b@10250-10750 c@12000-? a@3723500-3724000"]);
  });

  it("joins spans that touch, and text between spans, into one word; white space or <br/> separates words", () => {
    const read = readTony(tt('<p><span begin="1" end="2">wa</span><span begin="2" end="3">ter</span>, <span begin="4" end="5">a</span><br/><span begin="6" end="7">b</span></p>'));
    expect(tonyWords(read)).toEqual(["water,@1000-3000 a@4000-5000 b@6000-7000"]);
  });

  it("splits a word at white space inside the edge of a span, and not at white space within it", () => {
    const read = readTony(tt('<p><span begin="1" end="2">hy-</span><span begin="2" end="3"> phen</span><span begin="3" end="4">two words</span></p>'));
    expect(tonyWords(read)).toEqual(["hy-@1000-2000 phentwo words@2000-4000"]);
  });

  it("reads an untimed span as a wrapper and skips every role Tony skips", () => {
    const read = readTony(
      tt(
        '<p><span><span begin="1" end="2">in</span></span><span ttm:role="x-translation"><span begin="2" end="3">no</span></span>' +
          '<span begin="3" end="4">side</span><span ttm:role="x-roman">no</span><span ttm:role="x-romanization">no</span></p>',
      ),
    );
    expect(read.skippedParts).toBe(3);
    expect(tonyWords(read)).toEqual(["in@1000-2000 side@3000-4000"]);
  });

  it("reads a <p> without timed spans as one line-long word, and skips one without a begin", () => {
    const read = readTony(tt('<p begin="0:05.000" end="0:09.000">  whole\n line  </p><p>untimed</p>'));
    expect(tonyWords(read)).toEqual(["whole line@5000-9000"]);
  });

  it("takes the title from <head>, sorts lines by their first start and words by start", () => {
    const read = readTony(
      tt('<p><span begin="9" end="10">later</span></p><p><span begin="3" end="4">b</span> <span begin="2" end="3">a</span></p>', "<ttm:title> A &amp; B </ttm:title>"),
    );
    expect(read.title).toBe("A & B");
    expect(tonyWords(read)).toEqual(["a@2000-3000 b@3000-4000", "later@9000-10000"]);
  });

  it("refuses a DOCTYPE, more than 1 MiB, an empty file and a file with no timed words", () => {
    const valid = tt('<p><span begin="1" end="2">a</span></p>');
    expect(() => readTony(`<?xml version="1.0"?>\n<!DOCTYPE tt>\n${valid}`)).toThrow(/DOCTYPE/);
    const padded = (bytes: number) => valid.replace("<head>", `<head><!--${"x".repeat(bytes - valid.length - 7)}-->`);
    expect(new TextEncoder().encode(padded(1024 * 1024)).length).toBe(1024 * 1024);
    expect(readTony(padded(1024 * 1024)).lines).toHaveLength(1);
    expect(() => readTony(padded(1024 * 1024 + 1))).toThrow(/1 MiB/);
    expect(() => readTony("")).toThrow(/empty/);
    expect(() => readTony(tt("<p>no begin</p>"))).toThrow(/no timed lyrics/);
  });

  it("refuses XML that is not well-formed", () => {
    expect(() => readTony(tt('<p><span begin="1" end="2">a & b</span></p>'))).toThrow(/bare &/);
    expect(() => readTony(tt('<p><span begin="1" end="2">a < b</span></p>'))).toThrow(/not well-formed/);
    expect(() => readTony(tt('<p><span begin="1" end="2">a</p></span>'))).toThrow(/not well-formed/);
    expect(() => readTony(tt('<p><span begin="1" end="2">&#1;</span></p>'))).toThrow(/not well-formed/);
  });
});
