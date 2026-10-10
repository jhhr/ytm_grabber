import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStem } from "../src/shared/filenames";
import { dataUrlFor, lyricsDownloadPath, lyricsFile, stemProblem, titleFromStem, type CaptureContents, type LyricsFile } from "../src/shared/lyricsFiles";
import { extractSources, type LyricsSource } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { summarize } from "../src/shared/summary";
import { TONY_MAX_BYTES, tonyReady } from "../src/shared/tonyPick";
import { decodeDataUrl } from "./helpers/fakeDownloads";
import { readTony } from "./helpers/tonyReader";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { metadata, sources } = extractSources(parseSse(stream), unison);
const ID = "Synth3t1cK1";
const STEM = buildStem({ artist: "Marrow & Tin", title: "Northbound Kites", videoId: ID });
const TITLE = "Marrow & Tin - Northbound Kites";
const capture: CaptureContents = { videoId: ID, metadata, rawStream: stream, sources };
const byId = (id: string) => sources.find((source) => source.id === id)!;
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

function file(itemId: string, contents: CaptureContents = capture, stem = STEM): LyricsFile {
  const result = lyricsFile(itemId, contents, stem);
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

describe("stemProblem", () => {
  it("accepts every stem buildStem() makes for the video", () => {
    expect(STEM).toBe(`Marrow & Tin - Northbound Kites [${ID}]`);
    const stems = [
      STEM,
      buildStem({ videoId: ID }),
      buildStem({ title: "P.O.D. Wait...", videoId: ID }),
      buildStem({ artist: "Bj\u{f6}rk \u{65e5}\u{672c}", title: "\u{1F3B5} song", videoId: ID }),
      buildStem({ artist: "a".repeat(200), title: "b", videoId: ID }),
      buildStem({ artist: "CON", videoId: ID }),
    ];
    for (const stem of stems) expect(stemProblem(stem, ID), stem).toBeNull();
    expect(buildStem({ artist: "a".repeat(200), title: "b", videoId: ID })).toHaveLength(150);
  });

  it("refuses a stem sanitizeFilename() would change, naming it", () => {
    for (const stem of [`${STEM}.`, `a/b [${ID}]`, ` x [${ID}]`, `x  y [${ID}]`, `x\ty [${ID}]`, `${"a".repeat(200)} [${ID}]`, "", "con"]) {
      expect(stemProblem(stem, ID), JSON.stringify(stem)).toBe(`Not a usable file name: ${JSON.stringify(stem)}`);
    }
  });

  it("refuses a stem that does not end with this video's id", () => {
    for (const stem of [buildStem({ title: "x", videoId: "Other0ther0" }), `x[${ID}]`, `x [${ID}] y`, "Marrow & Tin - Northbound Kites", `[${ID.toLowerCase()}]`]) {
      expect(stemProblem(stem, ID), stem).toBe(`The file name ${JSON.stringify(stem)} does not end with this song's video id [${ID}]`);
    }
  });
});

describe("titleFromStem", () => {
  it("is the stem without its video id suffix", () => {
    expect(titleFromStem(STEM, ID)).toBe(TITLE);
    expect(titleFromStem(`[${ID}]`, ID)).toBe("");
    expect(titleFromStem("No suffix", ID)).toBe("No suffix");
  });
});

describe("lyricsFile", () => {
  const ctx = { stem: STEM, title: TITLE, metadata };

  it("names every kind of file after the stem and keeps as-is contents unchanged", () => {
    const expected: [string, string, string, string][] = [
      ["tony", `${STEM}.ttml`, byId("golyrics").content, "application/ttml+xml"],
      ["native:golyrics", `${STEM}.golyrics.ttml`, byId("golyrics").content, "application/ttml+xml"],
      ["native:binimum", `${STEM}.binimum.ttml`, byId("binimum").content, "application/ttml+xml"],
      ["native:musixmatch-word", `${STEM}.musixmatch-word.lrc`, byId("musixmatch-word").content, "text/plain"],
      ["native:musixmatch", `${STEM}.musixmatch.lrc`, byId("musixmatch").content, "text/plain"],
      ["native:lrclib", `${STEM}.lrclib.lrc`, byId("lrclib").content, "text/plain"],
      ["native:lrclib-plain", `${STEM}.lrclib.txt`, byId("lrclib-plain").content, "text/plain"],
      ["native:qq", `${STEM}.qq.qrc.xml`, byId("qq").content, "application/xml"],
      ["native:kugou", `${STEM}.kugou.lrc`, byId("kugou").content, "text/plain"],
      ["native:unison", `${STEM}.unison.ttml`, byId("unison").content, "application/ttml+xml"],
      ["raw", `${STEM}.lyrics-stream.txt`, stream, "text/plain"],
    ];
    for (const [itemId, name, content, mime] of expected) expect(file(itemId), itemId).toEqual({ name, content, mime });
    expect(sources.map((source) => source.id).sort()).toEqual(expected.slice(1, -1).map(([itemId]) => itemId.slice("native:".length)).sort());
  });

  it("converts enhanced LRC and QRC to <stem>.<source>.ttml, titled with the stem minus its video id", () => {
    for (const id of ["musixmatch-word", "qq"]) {
      const converted = file(`ttml:${id}`);
      const ready = tonyReady(byId(id), ctx);
      expect(ready.ok && ready.converted).toBe(true);
      expect(converted).toEqual({ name: `${STEM}.${id}.ttml`, content: ready.ok ? ready.content : "", mime: "application/ttml+xml" });
      expect(converted.content).toContain("<ttm:title>Marrow &amp; Tin - Northbound Kites</ttm:title>");
      expect(readTony(converted.content).title).toBe(TITLE);
    }
    // A stem with no artist or title: no title element at all.
    expect(file("ttml:qq", capture, `[${ID}]`).content).not.toContain("ttm:title");
    // Unison richsync LRC converts too.
    const richsync: LyricsSource = { ...byId("musixmatch-word"), id: "unison", provider: "unison", blDisplayName: "Unison", ext: ".unison.lrc" };
    expect(file("ttml:unison", { ...capture, sources: [richsync] }).name).toBe(`${STEM}.unison.ttml`);
  });

  it("re-runs the Tony pick with the real stem: a converted pick gets the title", () => {
    const only = { ...capture, sources: [byId("musixmatch-word"), byId("kugou")] };
    const tony = file("tony", only);
    expect(tony.name).toBe(`${STEM}.ttml`);
    expect(tony.content).toBe(file("ttml:musixmatch-word", only).content);
    expect(readTony(tony.content).title).toBe(TITLE);
  });

  it("re-runs the Tony pick with the real title: a converted file that only fits without it gives way", () => {
    // One word padded so that the converted file is exactly Tony's limit without a title
    // (accepted), and over it with one.
    const padded = (pad: number): LyricsSource => ({ ...byId("musixmatch-word"), content: `[00:01.00] <00:01.00> ${"a".repeat(pad)} <00:02.00>` });
    const untitled = (source: LyricsSource) => {
      const ready = tonyReady(source, { stem: "", title: "", metadata });
      if (!ready.ok) throw new Error(ready.reason);
      return utf8(ready.content);
    };
    const big = padded(1 + TONY_MAX_BYTES - untitled(padded(1)));
    expect(untitled(big)).toBe(TONY_MAX_BYTES);
    const contents = { ...capture, sources: [big, byId("lrclib")] };
    // The summary's pick (placeholders) is the converted file ...
    expect(summarize({ ...contents, capturedAt: 1, bodySource: "getResponseBody" }, contents.sources).tonyPick?.sourceId).toBe("musixmatch-word");
    // ... the real one is the next candidate.
    expect(file("tony", contents)).toEqual({ name: `${STEM}.lrc`, content: byId("lrclib").content, mime: "text/plain" });
    expect(lyricsFile("ttml:musixmatch-word", contents, STEM)).toEqual({ ok: false, error: expect.stringMatching(/^Musixmatch .*: Too big for Tony: \d+ bytes/) });
  });

  it("saves an LRC pick as <stem>.lrc", () => {
    expect(file("tony", { ...capture, sources: [byId("lrclib-plain"), byId("kugou"), byId("lrclib")] })).toEqual({
      name: `${STEM}.lrc`,
      content: byId("lrclib").content,
      mime: "text/plain",
    });
  });

  it("says why there is no Tony file", () => {
    expect(lyricsFile("tony", { ...capture, sources: [byId("lrclib-plain")] }, STEM)).toEqual({ ok: false, error: "No captured lyrics have timing Tony can read" });
    expect(lyricsFile("tony", { ...capture, sources: [] }, STEM)).toEqual({ ok: false, error: "No captured lyrics have timing Tony can read" });
    const doctype = { ...byId("golyrics"), content: `<!DOCTYPE tt>${byId("golyrics").content}` };
    expect(lyricsFile("tony", { ...capture, sources: [doctype] }, STEM)).toEqual({ ok: false, error: "No file Tony can read: golyrics: Has a <!DOCTYPE>, which Tony refuses" });
  });

  it("refuses items that are not downloads, sources not captured, and conversions that cannot be made", () => {
    expect(lyricsFile("showing", capture, STEM)).toEqual({ ok: false, error: 'Unknown lyrics menu item "showing"' });
    expect(lyricsFile("recapture", capture, STEM)).toEqual({ ok: false, error: 'Unknown lyrics menu item "recapture"' });
    expect(lyricsFile("native:nope", capture, STEM)).toEqual({ ok: false, error: "There is no nope source in this capture" });
    expect(lyricsFile("ttml:nope", capture, STEM)).toEqual({ ok: false, error: "There is no nope source in this capture" });
    for (const id of ["golyrics", "lrclib", "lrclib-plain", "unison"]) {
      expect(lyricsFile(`ttml:${id}`, capture, STEM)).toEqual({ ok: false, error: `${byId(id).label} is not converted to TTML` });
    }
    const empty = { ...byId("qq"), content: "[0,1000]" };
    expect(lyricsFile("ttml:qq", { ...capture, sources: [empty] }, STEM)).toEqual({ ok: false, error: `${empty.label}: No timed words to convert` });
  });
});

describe("lyricsDownloadPath", () => {
  it("puts the file in a folder named after the stem when asked", () => {
    expect(lyricsDownloadPath(STEM, `${STEM}.ttml`, false)).toBe(`${STEM}.ttml`);
    expect(lyricsDownloadPath(STEM, `${STEM}.ttml`, true)).toBe(`${STEM}/${STEM}.ttml`);
    expect(lyricsDownloadPath(STEM, `${STEM}.lyrics-stream.txt`, true)).toBe(`${STEM}/${STEM}.lyrics-stream.txt`);
  });
});

describe("dataUrlFor", () => {
  const roundTrip = (content: string, mime = "text/plain") => {
    const url = dataUrlFor(content, mime);
    const { mediaType, bytes } = decodeDataUrl(url);
    expect(mediaType).toBe(`${mime};charset=utf-8`);
    expect(url.slice(url.indexOf(",") + 1)).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    return bytes;
  };

  it("holds UTF-8 bytes in base64, mime and charset first", () => {
    expect(dataUrlFor("<tt/>", "application/ttml+xml")).toBe(`data:application/ttml+xml;charset=utf-8;base64,${Buffer.from("<tt/>").toString("base64")}`);
    expect(dataUrlFor("", "text/plain")).toBe("data:text/plain;charset=utf-8;base64,");
  });

  it("round-trips ASCII, non-ASCII and line ends", () => {
    for (const text of ["plain ascii", "Bj\u{f6}rk \u{65e5}\u{672c}\u{8a9e} \u{1F3B5} caf\u{e9}", "a\r\nb\nc\r", "\u{FEFF}starts with a BOM"]) {
      expect(roundTrip(text).equals(Buffer.from(text, "utf8")), text).toBe(true);
    }
  });

  it("writes U+FFFD for a lone surrogate, where encodeURIComponent throws", () => {
    expect(() => encodeURIComponent("a\u{D800}b")).toThrow(URIError);
    expect([...roundTrip("a\u{D800}b")]).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
    expect([...roundTrip("\u{DC00}")]).toEqual([0xef, 0xbf, 0xbd]);
    // A pair is a character, not two replacements.
    expect([...roundTrip("\u{D83C}\u{DFB5}")]).toEqual([0xf0, 0x9f, 0x8e, 0xb5]);
  });

  it("adds no byte order mark: golyrics TTML comes back byte for byte, starting with <", () => {
    const golyrics = byId("golyrics").content;
    const bytes = roundTrip(golyrics, "application/ttml+xml");
    expect(bytes[0]).toBe(0x3c);
    expect(bytes.equals(Buffer.from(golyrics, "utf8"))).toBe(true);
    expect([...roundTrip("\u{e9}").subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it("round-trips content bigger than one encoding chunk, with characters across the chunk edges", () => {
    const text = "\u{e9}\u{65e5}\u{1F3B5}x".repeat(30_000);
    expect(utf8(text)).toBeGreaterThan(3 * 0x8000);
    expect(roundTrip(text).equals(Buffer.from(text, "utf8"))).toBe(true);
    expect(roundTrip(stream).equals(Buffer.from(stream, "utf8"))).toBe(true);
  });
});
