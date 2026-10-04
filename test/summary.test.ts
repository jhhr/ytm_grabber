import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSources, type LyricsSource } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { summarize, type StoredCapture } from "../src/shared/summary";
import { TONY_MAX_BYTES } from "../src/shared/tonyPick";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { metadata, sources } = extractSources(parseSse(stream), unison);
const DASH = "\u{2014}";
const capture: StoredCapture = { videoId: "Synth3t1cK1", capturedAt: 1_700_000_000_000, metadata, rawStream: stream, unisonRaw: unison, bodySource: "eventSource" };
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

describe("summarize", () => {
  const summary = summarize(capture, sources);

  it("describes the capture and every source by name, format and size", () => {
    expect(summary).toEqual({
      videoId: "Synth3t1cK1",
      capturedAt: 1_700_000_000_000,
      metadata: { song: "Northbound Kites", artist: "Marrow & Tin", album: "Weather Almanac", duration: 72 },
      bodySource: "eventSource",
      sources: sources.map((source) => ({
        id: source.id,
        label: source.label,
        timing: source.timing,
        format: source.format,
        ext: source.ext,
        size: utf8(source.content),
        ...(source.blDisplayName === undefined ? {} : { blDisplayName: source.blDisplayName }),
      })),
      tonyPick: { sourceId: "golyrics", label: `Better Lyrics ${DASH} word timing`, timing: "word", converted: false, ext: ".ttml" },
      tonySkipped: [],
    });
    expect(summary.sources.map((source) => source.id)).toEqual(sources.map((source) => source.id));
    expect(summary.sources[0]).toEqual({
      id: "lrclib",
      label: `LRCLib ${DASH} LRC, line-synced`,
      timing: "line",
      format: "lrc",
      ext: ".lrclib.lrc",
      size: utf8(sources[0].content),
      blDisplayName: "LRCLib",
    });
  });

  it("never contains a source's content, the raw stream or the Unison body", () => {
    // "lanterns" is in every source's lyrics; it must be in the inputs for this test to mean anything.
    expect(sources.filter((source) => source.content.includes("lanterns")).length).toBeGreaterThan(5);
    const text = JSON.stringify(summary);
    expect(text).not.toContain("lanterns");
    expect(text).not.toContain("<tt");
    for (const key of ["content", "rawStream", "unisonRaw", "mime", "filename"]) expect(text).not.toContain(`"${key}"`);
  });

  it("counts sizes in UTF-8 bytes", () => {
    const source: LyricsSource = { ...sources[0], content: "[00:01.00] caf\u{E9} \u{1F3B5}" };
    expect(summarize(capture, [source]).sources[0].size).toBe(11 + 5 + 1 + 4);
  });

  it("summarises a converted pick and the candidates Tony would refuse", () => {
    const golyrics = sources.find((source) => source.id === "golyrics")!;
    const tooBig: LyricsSource = { ...golyrics, content: golyrics.content + " ".repeat(TONY_MAX_BYTES) };
    const result = summarize(capture, [tooBig, ...sources.filter((source) => source.id === "musixmatch-word")]);
    expect(result.tonyPick).toEqual({ sourceId: "musixmatch-word", label: `Musixmatch ${DASH} word timing, converted`, timing: "word", converted: true, ext: ".ttml" });
    expect(result.tonySkipped).toEqual([{ sourceId: "golyrics", reason: expect.stringMatching(/^Too big for Tony/) }]);
  });

  it("has a null pick when no source suits Tony", () => {
    const plain = sources.filter((source) => source.id === "lrclib-plain");
    expect(summarize(capture, plain).tonyPick).toBeNull();
    expect(summarize(capture, []).sources).toEqual([]);
  });

  it("copies only the metadata fields it knows", () => {
    const odd = { ...capture, metadata: { ...metadata, lyrics: "Paper lanterns" } as StoredCapture["metadata"] };
    expect(summarize(odd, sources).metadata).toEqual(summary.metadata);
  });
});
