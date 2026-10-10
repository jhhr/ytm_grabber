import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSources, SOURCE_FORMATS, ttmlTiming, type LyricsSource } from "../src/shared/sources";
import { parseSse, type SseEvent } from "../src/shared/sse";

// Read byte for byte and never normalised; CRLF variants are made here.
const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unisonFixture = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const DASH = "\u{2014}";

interface Payload {
  provider: string;
  results: Record<string, string>;
}

/** A provider's data line, decoded here with JSON.parse alone (not through the code under test). */
function payload(provider: string): Payload {
  const prefix = `data: {"provider":"${provider}"`;
  const line = stream.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`no ${provider} block in the fixture`);
  return JSON.parse(line.slice("data:".length));
}

const providerEvent = (provider: unknown, results?: unknown): SseEvent => ({ event: "provider", data: { provider, results } });
const metadataEvent = (data: unknown): SseEvent => ({ event: "metadata", data });
const sourcesOf = (events: SseEvent[], unisonRaw?: string) => extractSources(events, unisonRaw).sources;
const ids = (events: SseEvent[], unisonRaw?: string) => sourcesOf(events, unisonRaw).map((source) => source.id);
const only = (events: SseEvent[], unisonRaw?: string): LyricsSource => {
  const sources = sourcesOf(events, unisonRaw);
  expect(sources).toHaveLength(1);
  return sources[0];
};
const unisonBody = (data: unknown) => JSON.stringify({ data });

const TTML_WORD = '<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Word"><body><div><p begin="1.000" end="2.000"><span begin="1.000" end="2.000">la</span></p></div></body></tt>';

describe("extractSources on the synthetic stream and Unison response", () => {
  const { metadata, sources } = extractSources(parseSse(stream), unisonFixture);

  it("reads the metadata event", () => {
    expect(metadata).toEqual({ song: "Northbound Kites", artist: "Marrow & Tin", album: "Weather Almanac", duration: 72 });
  });

  it("gives one source per file of PLAN 1.5, in stream order with Unison last", () => {
    expect(sources.map(({ content, ...summary }) => summary)).toEqual([
      { id: "lrclib", provider: "lrclib", blDisplayName: "LRCLib", label: `LRCLib ${DASH} LRC, line-synced`, timing: "line", format: "lrc", ext: ".lrclib.lrc", mime: "text/plain" },
      { id: "lrclib-plain", provider: "lrclib", blDisplayName: "LRCLib", label: `LRCLib ${DASH} plain text, not synced`, timing: "plain", format: "plain", ext: ".lrclib.txt", mime: "text/plain" },
      { id: "musixmatch-word", provider: "musixmatch", blDisplayName: "Musixmatch", label: `Musixmatch ${DASH} LRC, word-synced`, timing: "word", format: "enhanced-lrc", ext: ".musixmatch-word.lrc", mime: "text/plain" },
      { id: "musixmatch", provider: "musixmatch", blDisplayName: "Musixmatch", label: `Musixmatch ${DASH} LRC, line-synced`, timing: "line", format: "lrc", ext: ".musixmatch.lrc", mime: "text/plain" },
      { id: "golyrics", provider: "golyrics", blDisplayName: "Better Lyrics", label: `Better Lyrics ${DASH} TTML, word-synced`, timing: "word", format: "ttml", ext: ".golyrics.ttml", mime: "application/ttml+xml" },
      { id: "qq", provider: "qq", blDisplayName: "Better Lyrics Portato", label: `Better Lyrics Portato ${DASH} QRC, word-synced`, timing: "word", format: "qrc", ext: ".qq.qrc.xml", mime: "application/xml" },
      { id: "kugou", provider: "kugou", blDisplayName: "Better Lyrics Legato", label: `Better Lyrics Legato ${DASH} LRC, line-synced`, timing: "line", format: "lrc", ext: ".kugou.lrc", mime: "text/plain" },
      { id: "binimum", provider: "binimum", blDisplayName: "BiniLyrics", label: `BiniLyrics ${DASH} TTML, syllable-synced`, timing: "syllable", format: "ttml", ext: ".binimum.ttml", mime: "application/ttml+xml" },
      { id: "unison", provider: "unison", blDisplayName: "Unison", label: `Unison ${DASH} TTML, word-synced`, timing: "word", format: "ttml", ext: ".unison.ttml", mime: "application/ttml+xml" },
    ]);
  });

  it("keeps every content exactly as BL decodes it", () => {
    const content = Object.fromEntries(sources.map((source) => [source.id, source.content]));
    expect(content).toEqual({
      lrclib: payload("lrclib").results.synced,
      "lrclib-plain": payload("lrclib").results.plain,
      "musixmatch-word": payload("musixmatch").results.wordByWord,
      musixmatch: payload("musixmatch").results.synced,
      golyrics: JSON.parse(payload("golyrics").results.lyrics).ttml,
      qq: JSON.parse(payload("qq").results.lyrics).lyrics,
      kugou: JSON.parse(payload("kugou").results.lyrics).lyrics,
      binimum: payload("binimum").results.lyrics,
      unison: JSON.parse(unisonFixture).data.lyrics,
    });
    expect(content.golyrics.startsWith('<tt xmlns="http://www.w3.org/ns/ttml"')).toBe(true);
    expect(content.golyrics.endsWith("</tt>")).toBe(true);
    expect(content.qq.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>')).toBe(true);
    expect(content.kugou).toContain("\r\n");
  });

  it("agrees with SOURCE_FORMATS, which covers every fixed source", () => {
    expect(Object.keys(SOURCE_FORMATS).sort()).toEqual(
      ["binimum", "golyrics", "kugou", "lrclib", "lrclib-plain", "musixmatch", "musixmatch-word", "qq"],
    );
    for (const source of sources) {
      if (source.id !== "unison") expect(source.format).toBe(SOURCE_FORMATS[source.id as keyof typeof SOURCE_FORMATS]);
    }
  });

  it("is the same with CRLF line ends", () => {
    expect(extractSources(parseSse(stream.replace(/\n/g, "\r\n")), unisonFixture)).toEqual({ metadata, sources });
  });

  it("is the same when a block's JSON is split across two data: lines", () => {
    const split = stream.replace('data: {"provider":"qq",', 'data: {"provider":"qq",\ndata: ');
    expect(split).not.toBe(stream);
    expect(extractSources(parseSse(split), unisonFixture)).toEqual({ metadata, sources });
  });

  it("drops only the provider whose block is malformed", () => {
    const broken = stream.replace('data: {"provider":"golyrics",', 'data: {"provider":"golyrics" ');
    expect(broken).not.toBe(stream);
    const result = extractSources(parseSse(broken), unisonFixture);
    expect(result.metadata).toEqual(metadata);
    expect(result.sources).toEqual(sources.filter((source) => source.id !== "golyrics"));
  });
});

describe("the fixtures hold what later phases test against", () => {
  it("golyrics: Apple-style TTML on one line, syllable spans, plain seconds and m:ss.mmm, a group-agent backing line", () => {
    const ttml: string = JSON.parse(payload("golyrics").results.lyrics).ttml;
    expect(ttml).not.toContain("\n");
    expect(ttml).toMatch(/^<tt xmlns="[^"]+" xmlns:itunes="[^"]+" xmlns:ttm="[^"]+" itunes:timing="Word"/);
    expect(ttml).toContain('<ttm:agent type="group" xml:id="v1000"/>');
    expect(ttml.match(/<p [^>]*ttm:agent="v1000"/g)).toHaveLength(1);
    expect(ttml).toContain('<span begin="22.520" end="22.800">thou</span><span begin="22.800" end="23.120">sand</span>');
    expect(ttml).toContain('<span begin="59.500" end="1:01.600">home</span>');
  });

  it("musixmatch wordByWord: separator style, a hyphen-split word, a [bg:] part", () => {
    const lrc = payload("musixmatch").results.wordByWord;
    expect(lrc).toContain("<00:12.64>   <00:12.70>");
    expect(lrc).toContain("<00:17.10> Half- <00:17.42> remembered <00:18.15>");
    expect(lrc).toMatch(/\[bg: <01:00\.10> \(carry /);
  });

  it("qq: QRC with credit lines first, thou + sand, parentheses and an entity", () => {
    const qrc: string = JSON.parse(payload("qq").results.lyrics).lyrics;
    expect(qrc).toContain("[0,3000]Northbound (0,500)Kites (500,500)");
    expect(qrc).toContain("thou(22520,280)sand (22800,320)");
    expect(qrc).toContain("fires (23700,780)(oh)(24700,1200)");
    expect(qrc).toContain("[ar:Marrow &amp; Tin]");
  });

  it("unison: richsync TTML wrapped in data", () => {
    const { data } = JSON.parse(unisonFixture);
    expect([data.format, data.syncType]).toEqual(["ttml", "richsync"]);
  });
});

describe("extractSources, provider by provider", () => {
  it("musixmatch: wordByWord and synced are separate sources", () => {
    expect(ids([providerEvent("musixmatch", { wordByWord: "[00:01.00] <00:01.00> a <00:02.00>" })])).toEqual(["musixmatch-word"]);
    expect(ids([providerEvent("musixmatch", { synced: "[00:01.00] a" })])).toEqual(["musixmatch"]);
  });

  it("lrclib: synced and plain are separate sources", () => {
    expect(ids([providerEvent("lrclib", { plain: "a" })])).toEqual(["lrclib-plain"]);
    expect(ids([providerEvent("lrclib", { synced: "[00:01.00] a", plain: "a" })])).toEqual(["lrclib", "lrclib-plain"]);
  });

  it("golyrics: raw TTML (not double-encoded) is used as-is, timed from itunes:timing", () => {
    const source = only([providerEvent("golyrics", { lyrics: TTML_WORD })]);
    expect([source.id, source.content, source.timing, source.ext]).toEqual(["golyrics", TTML_WORD, "word", ".golyrics.ttml"]);
    const line = TTML_WORD.replace('"Word"', '"Line"');
    expect(only([providerEvent("golyrics", { lyrics: line })]).timing).toBe("line");
    const none = TTML_WORD.replace('"Word"', '"None"');
    expect(only([providerEvent("golyrics", { lyrics: none })]).timing).toBe("plain");
    const missing = TTML_WORD.replace(' itunes:timing="Word"', "");
    expect(only([providerEvent("golyrics", { lyrics: missing })]).timing).toBe("unknown");
  });

  it("golyrics: double-encoded TTML is unwrapped", () => {
    const source = only([providerEvent("golyrics", { lyrics: JSON.stringify({ ttml: TTML_WORD }) })]);
    expect(source.content).toBe(TTML_WORD);
  });

  it("golyrics: anything that is not TTML is kept as raw results instead of a .ttml file", () => {
    for (const lyrics of [JSON.stringify({ lines: [] }), "Not found", "[1,2]"]) {
      const results = { lyrics };
      expect(only([providerEvent("golyrics", results)])).toEqual({
        id: "golyrics",
        provider: "golyrics",
        label: `Better Lyrics ${DASH} raw JSON (could not be decoded)`,
        timing: "unknown",
        format: "json",
        ext: ".golyrics.json",
        mime: "application/json",
        content: JSON.stringify(results, null, 2),
      });
    }
  });

  it("binimum: timingType decides the timing; without it the TTML's itunes:timing does", () => {
    const timing = (results: object) => only([providerEvent("binimum", { lyrics: TTML_WORD, ...results })]).timing;
    expect(timing({ timingType: "syllable" })).toBe("syllable");
    expect(timing({ timingType: "line" })).toBe("line");
    expect(timing({})).toBe("word");
    expect(timing({ timingType: "word" })).toBe("word");
    expect(only([providerEvent("binimum", { lyrics: TTML_WORD.replace(' itunes:timing="Word"', "") })]).timing).toBe("unknown");
    expect(only([providerEvent("binimum", { lyrics: TTML_WORD })]).content).toBe(TTML_WORD);
  });

  it("qq and kugou: the nested JSON's .lyrics is the file", () => {
    const qq = only([providerEvent("qq", { lyrics: JSON.stringify({ lyrics: "<QrcInfos/>" }) })]);
    expect([qq.id, qq.content, qq.format, qq.timing, qq.ext]).toEqual(["qq", "<QrcInfos/>", "qrc", "word", ".qq.qrc.xml"]);
    const kugou = only([providerEvent("kugou", { lyrics: JSON.stringify({ lyrics: "[00:01.00]a" }) })]);
    expect([kugou.id, kugou.content, kugou.format, kugou.timing, kugou.ext]).toEqual(["kugou", "[00:01.00]a", "lrc", "line", ".kugou.lrc"]);
  });

  it("qq and kugou: a payload that does not decode is kept as raw results, and only that source is affected", () => {
    for (const [provider, name] of [["qq", "Better Lyrics Portato"], ["kugou", "Better Lyrics Legato"]]) {
      for (const lyrics of ['{"lyrics": "<QrcInfos', JSON.stringify({ text: "x" }), JSON.stringify("x"), { lyrics: "x" }]) {
        const results = { lyrics };
        const events = [providerEvent("lrclib", { plain: "a" }), providerEvent(provider, results), providerEvent("musixmatch", { synced: "[00:01.00] a" })];
        const sources = sourcesOf(events);
        expect(sources.map((source) => source.id)).toEqual(["lrclib-plain", provider, "musixmatch"]);
        expect(sources[1]).toEqual({
          id: provider,
          provider,
          label: `${name} ${DASH} raw JSON (could not be decoded)`,
          timing: "unknown",
          format: "json",
          ext: `.${provider}.json`,
          mime: "application/json",
          content: JSON.stringify(results, null, 2),
        });
      }
    }
  });

  it("an unknown provider is kept as pretty-printed JSON", () => {
    const results = { lyrics: "x", extra: [1, 2] };
    expect(only([providerEvent("spotify", results)])).toEqual({
      id: "spotify",
      provider: "spotify",
      label: `spotify ${DASH} raw JSON (unknown provider)`,
      timing: "unknown",
      format: "json",
      ext: ".spotify.json",
      mime: "application/json",
      content: JSON.stringify(results, null, 2),
    });
    // results that are not an object are kept too
    expect(only([providerEvent("spotify", "text")]).content).toBe('"text"');
  });

  it("an unknown provider's name is sanitised for file names and cannot replace a known source", () => {
    const idOf = (provider: string) => only([providerEvent(provider, { a: 1 })]).id;
    expect(idOf("Apple Music!")).toBe("apple_music");
    expect(idOf("../..\\etc/passwd")).toBe("etc_passwd");
    expect(idOf("a<b>:c\"d|e?f*g")).toBe("a_b_c_d_e_f_g");
    expect(idOf("\u{540D}\u{524D}")).toBe("unknown");
    expect(idOf("--x--")).toBe("x");
    expect(idOf("y".repeat(60))).toBe("y".repeat(40));
    expect(idOf("Unison")).toBe("unison-raw");
    expect(idOf("lrclib-plain")).toBe("lrclib-plain-raw");
    expect(idOf("golyrics ")).toBe("golyrics-raw");
    const source = only([providerEvent("My Provider", { a: 1 })]);
    expect([source.provider, source.ext]).toEqual(["My Provider", ".my_provider.json"]);
    expect(source.blDisplayName).toBeUndefined();
  });

  it("a provider block without results, or without a provider name, produces nothing", () => {
    for (const results of [undefined, null, "", 0, false]) {
      expect(ids([providerEvent("golyrics", results), providerEvent("spotify", results)])).toEqual([]);
    }
    expect(ids([providerEvent("musixmatch", {}), providerEvent("qq", { other: "x" })])).toEqual([]);
    expect(ids([providerEvent(undefined, { a: 1 }), providerEvent("", { a: 1 }), providerEvent(7, { a: 1 })])).toEqual([]);
  });

  it("empty or blank strings, and fields that are not strings, produce no source", () => {
    const events = [
      providerEvent("musixmatch", { wordByWord: "", synced: " \n " }),
      providerEvent("lrclib", { synced: 42, plain: ["a"] }),
      providerEvent("golyrics", { lyrics: "" }),
      providerEvent("golyrics", { lyrics: JSON.stringify({ ttml: "  " }) }),
      providerEvent("binimum", { lyrics: "\n", timingType: "syllable" }),
      providerEvent("qq", { lyrics: "" }),
      providerEvent("qq", { lyrics: JSON.stringify({ lyrics: "" }) }),
      providerEvent("kugou", { lyrics: JSON.stringify({ lyrics: " " }) }),
    ];
    expect(ids(events, unisonBody({ lyrics: "  ", format: "lrc" }))).toEqual([]);
  });

  it("a second block for the same provider replaces only the sources it carries", () => {
    const sources = sourcesOf([
      providerEvent("musixmatch", { wordByWord: "first word", synced: "first synced" }),
      providerEvent("lrclib", { plain: "plain" }),
      providerEvent("musixmatch", { synced: "second synced" }),
      providerEvent("musixmatch", null),
    ]);
    expect(sources.map((source) => [source.id, source.content])).toEqual([
      ["musixmatch-word", "first word"],
      ["musixmatch", "second synced"],
      ["lrclib-plain", "plain"],
    ]);
  });

  it("ignores events that are not metadata or provider, and malformed ones", () => {
    const events: SseEvent[] = [
      { event: "done", data: { provider: "lrclib", results: { plain: "a" } } },
      { event: "", data: { provider: "lrclib", results: { plain: "a" } } },
      { event: "provider", data: null, error: "Unexpected end of JSON input", rawData: '{"provider":' },
      { event: "provider", data: ["lrclib"] },
      { event: "provider", data: "lrclib" },
    ];
    expect(extractSources(events)).toEqual({ metadata: {}, sources: [] });
  });
});

describe("extractSources metadata", () => {
  it("is empty without a metadata event", () => {
    expect(extractSources([providerEvent("lrclib", { plain: "a" })]).metadata).toEqual({});
    expect(extractSources([]).metadata).toEqual({});
  });

  it("takes the last metadata event; a malformed one does not count", () => {
    const events: SseEvent[] = [
      metadataEvent({ song: "One", artist: "A", album: "X", duration: 100 }),
      metadataEvent({ song: "Two", duration: 200 }),
      { event: "metadata", data: null, error: "bad", rawData: "{" },
    ];
    expect(extractSources(events).metadata).toEqual({ song: "Two", duration: 200 });
  });

  it("keeps non-blank strings, a finite duration (numeric strings too, as BL's Number()) and a valid videoId", () => {
    expect(extractSources([metadataEvent({ song: "S", artist: " ", album: 5, duration: "215.5", videoId: "dQw4w9WgXcQ", isrc: "X" })]).metadata).toEqual(
      { song: "S", duration: 215.5, videoId: "dQw4w9WgXcQ" },
    );
    for (const duration of ["abc", "", null, true, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(extractSources([metadataEvent({ duration })]).metadata).toEqual({});
    }
    for (const videoId of ["dQw4w9WgXc", "dQw4w9WgXcQ\n", "../etc/pass", 12345678901]) {
      expect(extractSources([metadataEvent({ videoId })]).metadata).toEqual({});
    }
  });
});

describe("extractSources, Unison", () => {
  const ttml = JSON.parse(unisonFixture).data.lyrics as string;
  const lrc = "[00:01.00] <00:01.00> a <00:02.00>";

  it("TTML, LRC and plain give .unison.ttml, .unison.lrc and .unison.txt", () => {
    const source = (data: object) => {
      const { content, ...summary } = only([], unisonBody(data));
      return summary;
    };
    expect(source({ lyrics: lrc, format: "lrc", syncType: "richsync" })).toEqual({
      id: "unison", provider: "unison", blDisplayName: "Unison", label: `Unison ${DASH} LRC, word-synced`, timing: "word", format: "enhanced-lrc", ext: ".unison.lrc", mime: "text/plain",
    });
    expect(source({ lyrics: lrc, format: "lrc", syncType: "linesync" })).toEqual({
      id: "unison", provider: "unison", blDisplayName: "Unison", label: `Unison ${DASH} LRC, line-synced`, timing: "line", format: "lrc", ext: ".unison.lrc", mime: "text/plain",
    });
    expect(source({ lyrics: "a\nb", format: "plain", syncType: "plain" })).toEqual({
      id: "unison", provider: "unison", blDisplayName: "Unison", label: `Unison ${DASH} plain text, not synced`, timing: "plain", format: "plain", ext: ".unison.txt", mime: "text/plain",
    });
    expect(only([], unisonBody({ lyrics: "a\nb", format: "plain" })).content).toBe("a\nb");
  });

  it("syncType decides the timing where it applies; without it LRC is line-synced (as BL) and TTML uses itunes:timing", () => {
    const timing = (data: object) => only([], unisonBody(data)).timing;
    expect(timing({ lyrics: ttml, format: "ttml", syncType: "linesync" })).toBe("line");
    expect(timing({ lyrics: ttml, format: "ttml", syncType: "plain" })).toBe("plain");
    expect(timing({ lyrics: ttml, format: "ttml" })).toBe("word");
    expect(timing({ lyrics: ttml.replace('itunes:timing="Word"', 'itunes:timing="Line"'), format: "ttml", syncType: "other" })).toBe("line");
    expect(timing({ lyrics: lrc, format: "lrc" })).toBe("line");
    expect(timing({ lyrics: lrc, format: "lrc", syncType: "plain" })).toBe("line");
    expect(timing({ lyrics: "a", format: "plain", syncType: "richsync" })).toBe("plain");
  });

  it("gives no source without data, lyrics or a known format, or for a body that is not JSON", () => {
    const bodies = [
      "",
      "Not Found",
      "{}",
      '{"data":null}',
      '{"error":"not found"}',
      JSON.stringify([{ lyrics: lrc, format: "lrc" }]),
      unisonBody({ format: "lrc" }),
      unisonBody({ lyrics: lrc }),
      unisonBody({ lyrics: lrc, format: "srt" }),
      unisonBody({ lyrics: 7, format: "lrc" }),
      unisonBody({ lyrics: "no tt here", format: "ttml" }),
    ];
    for (const body of bodies) expect(ids([], body), body).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  it("is not replaced by a stream provider that happens to be called unison", () => {
    expect(ids([providerEvent("unison", { a: 1 })], unisonFixture)).toEqual(["unison-raw", "unison"]);
  });
});

describe("ttmlTiming", () => {
  it.each([
    ['<tt itunes:timing="Word">', "word"],
    ["<tt itunes:timing='Line'>", "line"],
    ['<tt xml:lang="en" itunes:timing="None" xmlns="http://www.w3.org/ns/ttml">', "plain"],
    ['<tt\n\txmlns="http://www.w3.org/ns/ttml"\n\titunes:timing = "Word"\n>', "word"],
    ['<tt itunes:timing="WORD"/>', "word"],
    ['<?xml version="1.0"?><!-- c --><tt itunes:timing="Line"><body/></tt>', "line"],
    ['<tt a="x > y" itunes:timing="Line">', "line"],
    ['<tt a=\'say "hi"\' itunes:timing="Line">', "line"],
    ['<tt a="itunes:timing=\'Line\'">', "unknown"],
    ['<tt b="1" itunes:timing="Syllable">', "unknown"],
    ['<tt xmlns="http://www.w3.org/ns/ttml">', "unknown"],
    ["<tt>", "unknown"],
    ['<ttm:agent itunes:timing="Word"/>', "unknown"],
    ['<p itunes:timing="Word"></p>', "unknown"],
    ["", "unknown"],
  ])("%j -> %s", (ttml, expected) => {
    expect(ttmlTiming(ttml)).toBe(expected);
  });

  it("reads only the root start tag", () => {
    expect(ttmlTiming('<tt xmlns="x"><body><div itunes:timing="Word"/></body></tt>')).toBe("unknown");
  });
});
