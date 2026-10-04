import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BL_DOCK_POSITION_ATTRIBUTE, BL_SELECTORS, BL_VERIFIED_VERSION, sourcesForDisplayName } from "../src/shared/blyrics";
import { extractSources, type LyricsSource } from "../src/shared/sources";
import { parseSse, type SseEvent } from "../src/shared/sse";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unisonFixture = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const { sources } = extractSources(parseSse(stream), unisonFixture);
const ids = (found: LyricsSource[]) => found.map((source) => source.id);

describe("BL selectors", () => {
  it("are BL 3.0.0.4's", () => {
    expect(BL_VERIFIED_VERSION).toBe("3.0.0.4");
    expect(BL_SELECTORS).toEqual({
      sidePanel: "#side-panel",
      dock: ".blyrics-dock",
      dockInner: ".blyrics-dock__inner",
      controls: ".blyrics-dock__controls",
      refresh: ".blyrics-dock__refresh",
      refreshBusy: ".blyrics-dock__refresh--busy",
      sourceName: ".blyrics-dock__source-name",
      offsetValue: ".blyrics-dock__offset > .blyrics-dock__offset-value",
      lyricsWrapper: "#blyrics-wrapper",
      lyricsContainer: ".blyrics-container",
    });
    expect(BL_DOCK_POSITION_ATTRIBUTE).toBe("data-position");
  });
});

describe("sourcesForDisplayName", () => {
  const table: [string, string[]][] = [
    ["Better Lyrics", ["golyrics"]],
    ["Unison", ["unison"]],
    ["BiniLyrics", ["binimum"]],
    ["Better Lyrics Portato", ["qq"]],
    ["Musixmatch", ["musixmatch-word", "musixmatch"]],
    ["LRCLib", ["lrclib", "lrclib-plain"]],
    ["Better Lyrics Legato", ["kugou"]],
  ];
  for (const [name, expected] of table) {
    it(`"${name}" -> ${expected.join(", ")}`, () => {
      const result = sourcesForDisplayName(name, sources);
      expect(result.downloadable).toBe(true);
      if (result.downloadable) expect(ids(result.sources)).toEqual(expected);
    });
  }

  it("keeps the preference order whatever order the capture lists the sources in", () => {
    const result = sourcesForDisplayName("Musixmatch", [...sources].reverse());
    expect(result.downloadable && ids(result.sources)).toEqual(["musixmatch-word", "musixmatch"]);
  });

  it("matches after trimming, with BL's exact case", () => {
    const trimmed = sourcesForDisplayName("  LRCLib \n", sources);
    expect(trimmed.downloadable && ids(trimmed.sources)).toEqual(["lrclib", "lrclib-plain"]);
    expect(sourcesForDisplayName("lrclib", sources)).toMatchObject({ downloadable: false, why: "unknown-name" });
  });

  it("YouTube lyrics and captions are not downloadable", () => {
    for (const name of ["YouTube", "YouTube Captions", " YouTube Captions "]) {
      expect(sourcesForDisplayName(name, sources)).toEqual({
        downloadable: false,
        why: "youtube",
        reason: `${name.trim()} lyrics come from YouTube itself, not from the captured lyrics request`,
      });
    }
  });

  it("an unknown name, or none, is not downloadable", () => {
    expect(sourcesForDisplayName("Lyrically", sources)).toEqual({
      downloadable: false,
      why: "unknown-name",
      reason: 'Unknown lyrics source "Lyrically" (checked with Better Lyrics 3.0.0.4)',
    });
    expect(sourcesForDisplayName("constructor", sources)).toMatchObject({ downloadable: false, why: "unknown-name" });
    expect(sourcesForDisplayName("  ", sources)).toEqual({ downloadable: false, why: "unknown-name", reason: "Better Lyrics shows no source name" });
  });

  it("a known name whose sources the capture does not have is not downloadable", () => {
    const onlyLrclib = sources.filter((source) => source.provider === "lrclib");
    expect(sourcesForDisplayName("Musixmatch", onlyLrclib)).toEqual({ downloadable: false, why: "not-captured", reason: "Musixmatch lyrics are not in this capture" });
    const musixmatchLine = sources.filter((source) => source.id === "musixmatch");
    const result = sourcesForDisplayName("Musixmatch", musixmatchLine);
    expect(result.downloadable && ids(result.sources)).toEqual(["musixmatch"]);
  });

  it("never offers raw JSON kept for a payload BL could not decode either", () => {
    const undecodable: SseEvent = { event: "provider", data: { provider: "golyrics", results: { lyrics: "not TTML" } } };
    const raw = extractSources([undecodable]).sources;
    expect(raw.map((source) => [source.id, source.format])).toEqual([["golyrics", "json"]]);
    expect(sourcesForDisplayName("Better Lyrics", raw)).toMatchObject({ downloadable: false, why: "not-captured" });
  });
});
