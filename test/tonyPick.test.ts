import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractSources, type LyricsSource, type SourceFormat, type Timing } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { pickForTony, TONY_MAX_BYTES, tonyReady, type TonyContext } from "../src/shared/tonyPick";
import { readTony, type TonyLyrics } from "./helpers/tonyReader";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unisonFixture = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const fixture = extractSources(parseSse(stream), unisonFixture);
const DASH = "\u{2014}";
const STEM = "Marrow & Tin - Northbound Kites [abcdefghijk]";
const CTX: TonyContext = { stem: STEM, title: "Marrow & Tin - Northbound Kites", metadata: fixture.metadata };

const ms = (seconds: number | undefined) => (seconds === undefined ? "?" : String(Math.round(seconds * 1000)));
/** What Tony read: "text@begin-end" per word, in ms. */
const tonyWords = ({ lines }: TonyLyrics) => lines.map((line) => line.words.map((w) => `${w.text}@${ms(w.begin)}-${ms(w.end)}`).join(" "));

const NAMES: Record<string, string> = {
  golyrics: "Better Lyrics",
  binimum: "BiniLyrics",
  "musixmatch-word": "Musixmatch",
  musixmatch: "Musixmatch",
  lrclib: "LRCLib",
  "lrclib-plain": "LRCLib",
  qq: "Better Lyrics Portato",
  kugou: "Better Lyrics Legato",
  unison: "Unison",
};
const CONTENT: Record<SourceFormat, string> = {
  ttml: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.000" end="2.000"><span begin="1.000" end="2.000">la</span></p></div></body></tt>',
  lrc: "[00:01.00]la la\n",
  "enhanced-lrc": "[00:01.00] <00:01.00> la <00:01.50>   <00:01.60> la <00:02.00>",
  qrc: "[1000,1000]la (1000,500)la(1600,400)",
  plain: "la la",
  json: "{}",
};
/** A source shaped as extractSources() makes it; raw JSON has no display name. */
function source(id: string, format: SourceFormat, timing: Timing, content = CONTENT[format]): LyricsSource {
  return { id, provider: id, ...(format === "json" ? {} : { blDisplayName: NAMES[id] }), label: `${id} (test)`, timing, format, ext: `.${id}`, mime: "text/plain", content };
}
const picked = (sources: LyricsSource[]) => {
  const { pick } = pickForTony(sources, CTX);
  return pick && `${pick.source.id}:${pick.source.format}:${pick.source.timing}`;
};
/** The pick, then the pick once that source is gone, and so on until nothing is left to pick. */
function cascade(sources: LyricsSource[]): string[] {
  const order: string[] = [];
  let rest = [...sources];
  for (;;) {
    const { pick } = pickForTony(rest, CTX);
    if (!pick) return order;
    order.push(pick.source.id);
    rest = rest.filter((candidate) => candidate !== pick.source);
  }
}
const huge = (prefix: string, bytes: number) => prefix + "a".repeat(bytes - prefix.length);

describe("pickForTony on the synthetic capture", () => {
  it("picks golyrics as-is: the same bytes, <stem>.ttml, word timing", () => {
    const golyrics = fixture.sources.find((s) => s.id === "golyrics")!;
    const { pick, skipped } = pickForTony(fixture.sources, CTX);
    expect(pick).toEqual({
      source: golyrics,
      content: golyrics.content,
      ext: ".ttml",
      filename: `${STEM}.ttml`,
      timing: "word",
      converted: false,
      label: `Better Lyrics ${DASH} word timing`,
    });
    expect(skipped).toEqual([]);
  });

  it("falls back in the order of PLAN section 3.2.3 as sources go missing; plain text never", () => {
    expect(cascade(fixture.sources)).toEqual(["golyrics", "unison", "binimum", "musixmatch-word", "qq", "musixmatch", "lrclib", "kugou"]);
  });

  it("converts QQ with the capture's metadata, so its credit lines are gone", () => {
    const { pick } = pickForTony(fixture.sources.filter((s) => s.format === "qrc"), CTX);
    expect(pick).toMatchObject({ ext: ".ttml", converted: true, timing: "word", label: `Better Lyrics Portato ${DASH} word timing, converted` });
    const read = readTony(pick!.content);
    expect(read.title).toBe("Marrow & Tin - Northbound Kites");
    expect(read.lines).toHaveLength(5);
    expect(tonyWords(read)[0]).toBe("Paper@12250-12640 lanterns@12700-13380 on@13450-13620 the@13660-13780 water@13840-15020");
  });
});

describe("pickForTony order, branch by branch", () => {
  it("1. golyrics first, word-timed or of unknown timing", () => {
    const rest = [source("unison", "ttml", "word"), source("binimum", "ttml", "syllable"), source("musixmatch-word", "enhanced-lrc", "word")];
    expect(picked([...rest, source("golyrics", "ttml", "word")])).toBe("golyrics:ttml:word");
    expect(picked([...rest, source("golyrics", "ttml", "unknown")])).toBe("golyrics:ttml:unknown");
  });

  it("lead decision: golyrics timed by line, or not at all, drops to group 6 (line-timed TTML), first in it", () => {
    for (const timing of ["line", "plain"] as const) {
      const golyrics = source("golyrics", "ttml", timing);
      expect(picked([golyrics, source("qq", "qrc", "word")])).toBe("qq:qrc:word");
      expect(picked([golyrics, source("musixmatch-word", "enhanced-lrc", "word")])).toBe("musixmatch-word:enhanced-lrc:word");
      expect(picked([source("unison", "ttml", "line"), source("binimum", "ttml", "line"), golyrics])).toBe(`golyrics:ttml:${timing}`);
      expect(picked([source("musixmatch", "lrc", "line"), golyrics])).toBe(`golyrics:ttml:${timing}`);
    }
  });

  it("2. Unison TTML with word or syllable timing comes before binimum", () => {
    for (const timing of ["word", "syllable"] as const) {
      expect(picked([source("binimum", "ttml", "syllable"), source("unison", "ttml", timing)])).toBe(`unison:ttml:${timing}`);
    }
  });

  it("lead decision: Unison TTML of unknown timing goes to group 6, after binimum's", () => {
    const unison = source("unison", "ttml", "unknown");
    expect(picked([unison, source("qq", "qrc", "word")])).toBe("qq:qrc:word");
    expect(picked([unison, source("binimum", "ttml", "line")])).toBe("binimum:ttml:line");
    expect(picked([unison, source("musixmatch", "lrc", "line")])).toBe("unison:ttml:unknown");
  });

  it("3. binimum syllable (or word, when its TTML says so) before Musixmatch word-by-word", () => {
    for (const timing of ["syllable", "word"] as const) {
      expect(picked([source("musixmatch-word", "enhanced-lrc", "word"), source("binimum", "ttml", timing)])).toBe(`binimum:ttml:${timing}`);
    }
  });

  it("4. Musixmatch word-by-word, then Unison richsync LRC, converted; both before QQ", () => {
    const mxm = source("musixmatch-word", "enhanced-lrc", "word");
    const richsync = source("unison", "enhanced-lrc", "word");
    expect(picked([source("qq", "qrc", "word"), richsync, mxm])).toBe("musixmatch-word:enhanced-lrc:word");
    expect(picked([source("qq", "qrc", "word"), richsync])).toBe("unison:enhanced-lrc:word");
    const { pick } = pickForTony([richsync], CTX);
    expect(pick).toMatchObject({ converted: true, ext: ".ttml", filename: `${STEM}.ttml`, label: `Unison ${DASH} word timing, converted` });
  });

  it("5. QQ converted before line-timed TTML", () => {
    expect(picked([source("binimum", "ttml", "line"), source("unison", "ttml", "line"), source("qq", "qrc", "word")])).toBe("qq:qrc:word");
  });

  it("6. line-timed TTML as-is: binimum before Unison; any of it before LRC", () => {
    expect(picked([source("unison", "ttml", "line"), source("binimum", "ttml", "line")])).toBe("binimum:ttml:line");
    expect(picked([source("musixmatch", "lrc", "line"), source("unison", "ttml", "line")])).toBe("unison:ttml:line");
    expect(picked([source("lrclib", "lrc", "line"), source("binimum", "ttml", "unknown")])).toBe("binimum:ttml:unknown");
  });

  it("7. line-synced LRC as .lrc: Musixmatch, LRCLib, KuGou, then Unison's", () => {
    const lrcs = [source("unison", "lrc", "line"), source("kugou", "lrc", "line"), source("lrclib", "lrc", "line"), source("musixmatch", "lrc", "line")];
    expect(cascade(lrcs)).toEqual(["musixmatch", "lrclib", "kugou", "unison"]);
    const { pick } = pickForTony([source("lrclib", "lrc", "line")], CTX);
    expect(pick).toMatchObject({ content: CONTENT.lrc, ext: ".lrc", filename: `${STEM}.lrc`, converted: false, label: `LRCLib ${DASH} line timing` });
  });

  it("never picks plain text or raw JSON, even under a known id, and does not list them as skipped", () => {
    const unusable = [source("lrclib-plain", "plain", "plain"), source("unison", "plain", "plain"), source("golyrics", "json", "unknown"), source("qq", "json", "unknown")];
    expect(pickForTony(unusable, CTX)).toEqual({ pick: null, skipped: [] });
    expect(pickForTony([], CTX)).toEqual({ pick: null, skipped: [] });
  });
});

describe("pickForTony skips what Tony would refuse", () => {
  it("skips a golyrics file over 1 MiB, says why, and picks the next", () => {
    const big = source("golyrics", "ttml", "word", huge('<tt xmlns="http://www.w3.org/ns/ttml">', TONY_MAX_BYTES + 1));
    const { pick, skipped } = pickForTony([big, source("binimum", "ttml", "syllable")], CTX);
    expect(pick?.source.id).toBe("binimum");
    expect(skipped).toEqual([{ sourceId: "golyrics", reason: `Too big for Tony: ${TONY_MAX_BYTES + 1} bytes, over its limit of 1 MiB` }]);
  });

  it("skips a DOCTYPE in any case, and a conversion with no words, in the order tried", () => {
    const doctype = source("binimum", "ttml", "syllable", `<!doctype tt>${CONTENT.ttml}`);
    const empty = source("musixmatch-word", "enhanced-lrc", "word", "[00:01.00] no word tags");
    const { pick, skipped } = pickForTony([source("kugou", "lrc", "line"), empty, doctype], CTX);
    expect(pick?.source.id).toBe("kugou");
    expect(skipped).toEqual([
      { sourceId: "binimum", reason: "Has a <!DOCTYPE>, which Tony refuses" },
      { sourceId: "musixmatch-word", reason: "No timed words to convert" },
    ]);
  });

  it("gives no pick when every candidate is refused", () => {
    const { pick, skipped } = pickForTony([source("qq", "qrc", "word", "<QrcInfos/>"), source("golyrics", "ttml", "word", `<!DOCTYPE tt>${CONTENT.ttml}`)], CTX);
    expect(pick).toBeNull();
    expect(skipped.map((s) => s.sourceId)).toEqual(["golyrics", "qq"]);
  });
});

describe("tonyReady", () => {
  it("TTML as-is: the same string, word timing kept", () => {
    const golyrics = source("golyrics", "ttml", "word");
    expect(tonyReady(golyrics, CTX)).toEqual({
      ok: true,
      content: golyrics.content,
      ext: ".ttml",
      filename: `${STEM}.ttml`,
      timing: "word",
      converted: false,
      label: `Better Lyrics ${DASH} word timing`,
    });
    expect(tonyReady(source("golyrics", "ttml", "unknown"), CTX)).toMatchObject({ ok: true, label: `Better Lyrics ${DASH} timing unknown` });
  });

  it("enhanced LRC: converted TTML titled `Artist - Title`, read back by Tony's rules", () => {
    const ready = tonyReady(source("musixmatch-word", "enhanced-lrc", "word"), CTX);
    expect(ready).toMatchObject({ ok: true, ext: ".ttml", filename: `${STEM}.ttml`, timing: "word", converted: true, label: `Musixmatch ${DASH} word timing, converted` });
    if (!ready.ok) throw new Error(ready.reason);
    const read = readTony(ready.content);
    expect(read.title).toBe("Marrow & Tin - Northbound Kites");
    expect(tonyWords(read)).toEqual(["la@1000-1500 la@1600-2000"]);
  });

  it("QRC: converted, its credit lines found by the capture's metadata", () => {
    const qrc = "[0,2000]Marrow & Tin (0,700)- (700,500)Northbound Kites(1200,800)\n[3000,1000]Paper (3000,400)kites(3400,600)";
    const words = (ctx: TonyContext) => {
      const ready = tonyReady(source("qq", "qrc", "word", qrc), ctx);
      if (!ready.ok) throw new Error(ready.reason);
      return tonyWords(readTony(ready.content));
    };
    expect(words(CTX)).toEqual(["Paper@3000-3400 kites@3400-4000"]);
    expect(words({ stem: STEM, title: CTX.title })).toHaveLength(2);
  });

  it("LRC as-is, as <stem>.lrc", () => {
    expect(tonyReady(source("kugou", "lrc", "line"), CTX)).toEqual({
      ok: true,
      content: CONTENT.lrc,
      ext: ".lrc",
      filename: `${STEM}.lrc`,
      timing: "line",
      converted: false,
      label: `Better Lyrics Legato ${DASH} line timing`,
    });
  });

  it("not ready: plain text, raw JSON, conversions that leave no words or cannot be written", () => {
    expect(tonyReady(source("lrclib-plain", "plain", "plain"), CTX)).toEqual({ ok: false, reason: "Plain text: no timing for Tony" });
    expect(tonyReady(source("golyrics", "json", "unknown"), CTX)).toEqual({ ok: false, reason: "Raw JSON: not lyrics Tony can read" });
    const noWords = { ok: false, reason: "No timed words to convert" };
    expect(tonyReady(source("musixmatch-word", "enhanced-lrc", "word", "[00:01.00] plain line"), CTX)).toEqual(noWords);
    expect(tonyReady(source("qq", "qrc", "word", "[0,1000]"), CTX)).toEqual(noWords);
    // A piece of nothing but a control character survives trimming, but the writer cannot write it.
    expect(tonyReady(source("qq", "qrc", "word", "[0,1000]\x01(0,1000)"), CTX)).toEqual(noWords);
    // A time of 400 digits is not a finite number of seconds.
    expect(tonyReady(source("qq", "qrc", "word", `[0,1000]la(${"9".repeat(400)},1)`), CTX)).toEqual({ ok: false, reason: "Could not be converted: Not a time: Infinity" });
  });

  it("counts UTF-8 bytes against Tony's 1 MiB: exactly 1 MiB is fine, one byte more is not", () => {
    expect(tonyReady(source("lrclib", "lrc", "line", huge("[00:01.00]", TONY_MAX_BYTES)), CTX).ok).toBe(true);
    expect(tonyReady(source("lrclib", "lrc", "line", huge("[00:01.00]", TONY_MAX_BYTES + 1)), CTX)).toEqual({
      ok: false,
      reason: `Too big for Tony: ${TONY_MAX_BYTES + 1} bytes, over its limit of 1 MiB`,
    });
    // U+00E9 is one UTF-16 unit but two UTF-8 bytes: about 512 Ki characters already reach the limit.
    const accents = (count: number) => `[00:01.00]${"\u{E9}".repeat(count)}`;
    expect(tonyReady(source("lrclib", "lrc", "line", accents((TONY_MAX_BYTES - 10) / 2)), CTX).ok).toBe(true);
    expect(tonyReady(source("lrclib", "lrc", "line", accents((TONY_MAX_BYTES - 10) / 2 + 1)), CTX)).toMatchObject({ ok: false });
  });

  it("refuses converted TTML that comes out over 1 MiB", () => {
    const qrc = Array.from({ length: 7000 }, (_, i) => `[${i * 1000},500]word${i} (${i * 1000},250)x(${i * 1000 + 250},250)`).join("\n");
    const ready = tonyReady(source("qq", "qrc", "word", qrc), CTX);
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.reason).toMatch(/^Too big for Tony: \d+ bytes/);
  });

  it("refuses a DOCTYPE in any case, anywhere", () => {
    for (const doctype of ["<!DOCTYPE tt>", "<!doctype tt>", "<!DocType tt>"]) {
      const content = `<?xml version="1.0"?>\n${doctype}\n${CONTENT.ttml}`;
      expect(tonyReady(source("golyrics", "ttml", "word", content), CTX)).toEqual({ ok: false, reason: "Has a <!DOCTYPE>, which Tony refuses" });
    }
  });
});
