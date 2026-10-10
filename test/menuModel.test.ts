import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDownloadItemId } from "../src/shared/lyricsItems";
import { lyricsMenu, OTHER_SONG_NOTE_ID, type MenuItem } from "../src/shared/menuModel";
import { extractSources, type LyricsMetadata, type LyricsSource } from "../src/shared/sources";
import { parseSse } from "../src/shared/sse";
import { summarize, type CaptureSummary } from "../src/shared/summary";

const stream = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const unison = readFileSync(new URL("./fixtures/synthetic-unison.json", import.meta.url), "utf8");
const fixture = extractSources(parseSse(stream), unison);
const ID = "Synth3t1cK1";
const DASH = "\u{2014}";
const ARROW = "\u{2192}";
const byId = (id: string) => fixture.sources.find((source) => source.id === id)!;
const label = (id: string) => byId(id).label;

function summaryOf(sources: LyricsSource[], metadata: LyricsMetadata = fixture.metadata): CaptureSummary {
  return summarize({ videoId: ID, capturedAt: 1_700_000_000_000, metadata, rawStream: stream, bodySource: "getResponseBody" }, sources);
}
const FULL = summaryOf(fixture.sources);
const menu = (summary: CaptureSummary, showingName: string | null, forPlayingVideo = true) => lyricsMenu({ summary, showingName, forPlayingVideo });
const find = (items: MenuItem[], label: string) => items.find((item) => item.label === label)!;
const showingOf = (summary: CaptureSummary, name: string | null, forPlayingVideo = true) => find(menu(summary, name, forPlayingVideo), "Download what's showing");
/** A copy of a fixture source with other content (and possibly another id). */
const variant = (id: string, content: string, extra: Partial<LyricsSource> = {}): LyricsSource => ({ ...byId(id), content, ...extra });

describe("lyricsMenu on the synthetic capture", () => {
  it("lists the Tony pick, what's showing, every source with -> TTML items, raw and re-capture, in order", () => {
    const native = (id: string, showing = false): MenuItem => ({
      id: `native:${id}`,
      kind: "action",
      label: showing ? `${label(id)} (showing)` : label(id),
      detail: byId(id).ext,
      enabled: true,
      ...(showing ? { showing: true } : {}),
    });
    const toTtml = (id: string): MenuItem => ({ id: `ttml:${id}`, kind: "action", label: `${label(id)} ${ARROW} TTML`, detail: `.${id}.ttml`, enabled: true });
    expect(menu(FULL, "Better Lyrics")).toEqual([
      { id: "tony", kind: "action", label: "Download TTML for Tony", detail: `Better Lyrics ${DASH} word timing`, bold: true, enabled: true },
      { id: "tony", kind: "action", label: "Download what's showing", detail: `Better Lyrics ${DASH} word timing`, enabled: true },
      { id: "divider:1", kind: "divider", label: "", enabled: false },
      { id: "header:other-sources", kind: "header", label: "Other sources", enabled: false },
      native("lrclib"),
      native("lrclib-plain"),
      native("musixmatch-word"),
      toTtml("musixmatch-word"),
      native("musixmatch"),
      native("golyrics", true),
      native("qq"),
      toTtml("qq"),
      native("kugou"),
      native("binimum"),
      native("unison"),
      { id: "divider:2", kind: "divider", label: "", enabled: false },
      { id: "raw", kind: "action", label: "Raw response (.txt)", detail: ".lyrics-stream.txt", enabled: true },
      { id: "recapture", kind: "action", label: "Re-capture", enabled: true },
    ]);
    expect(label("musixmatch-word")).toBe(`Musixmatch ${DASH} LRC, word-synced`);
  });

  it("gives every enabled action a download item id, or recapture", () => {
    for (const name of ["Better Lyrics", "Musixmatch", "LRCLib", "YouTube", null]) {
      for (const forPlayingVideo of [true, false]) {
        for (const item of menu(FULL, name, forPlayingVideo)) {
          if (item.kind !== "action" || !item.enabled) continue;
          expect(isDownloadItemId(item.id) || item.id === "recapture", item.id).toBe(true);
        }
      }
    }
  });
});

describe("the Tony item", () => {
  it("says LRC when the pick is an LRC", () => {
    expect(menu(summaryOf([byId("lrclib-plain"), byId("lrclib")]), "LRCLib")[0]).toEqual({
      id: "tony",
      kind: "action",
      label: "Download LRC for Tony",
      detail: `LRCLib ${DASH} line timing`,
      bold: true,
      enabled: true,
    });
  });

  it("labels a converted pick as converted", () => {
    expect(menu(summaryOf([byId("qq"), byId("kugou")]), null)[0]).toMatchObject({ label: "Download TTML for Tony", detail: `Better Lyrics Portato ${DASH} word timing, converted`, enabled: true });
  });

  it("is disabled with a reason when there is no pick", () => {
    expect(menu(summaryOf([byId("lrclib-plain")]), "LRCLib")[0]).toEqual({
      id: "tony",
      kind: "action",
      label: "Download TTML for Tony",
      bold: true,
      enabled: false,
      reason: "No captured lyrics have timing Tony can read",
    });
    const doctype = variant("golyrics", `<!DOCTYPE tt>${byId("golyrics").content}`);
    expect(menu(summaryOf([doctype, byId("lrclib-plain")]), null)[0]).toMatchObject({ enabled: false, reason: "No file Tony can read: golyrics: Has a <!DOCTYPE>, which Tony refuses" });
  });

  it("is disabled, and there is no source section, when the capture has no lyrics", () => {
    const items = menu(summaryOf([]), "Better Lyrics");
    expect(items.map((item) => item.id)).toEqual(["tony", "showing", "divider:2", "raw", "recapture"]);
    expect(items[0]).toMatchObject({ enabled: false, reason: "This capture has no lyrics" });
    expect(items[1]).toMatchObject({ enabled: false, reason: "Better Lyrics lyrics are not in this capture" });
  });
});

describe("Download what's showing", () => {
  it("is the Tony item when BL shows the Tony pick's source", () => {
    expect(showingOf(FULL, "Better Lyrics")).toEqual({ id: "tony", kind: "action", label: "Download what's showing", detail: `Better Lyrics ${DASH} word timing`, enabled: true });
    const musixmatchPick = summaryOf([byId("musixmatch-word"), byId("musixmatch"), byId("lrclib")]);
    expect(showingOf(musixmatchPick, "Musixmatch")).toMatchObject({ id: "tony", detail: `Musixmatch ${DASH} word timing, converted`, enabled: true });
  });

  it("is the source's TTML or LRC as it came, when that is not the pick", () => {
    expect(showingOf(FULL, "BiniLyrics")).toEqual({ id: "native:binimum", kind: "action", label: "Download what's showing", detail: `BiniLyrics ${DASH} syllable timing`, enabled: true });
    expect(showingOf(FULL, "Unison")).toMatchObject({ id: "native:unison", detail: `Unison ${DASH} word timing`, enabled: true });
    expect(showingOf(FULL, "LRCLib")).toMatchObject({ id: "native:lrclib", detail: `LRCLib ${DASH} line timing`, enabled: true });
    expect(showingOf(FULL, "Better Lyrics Legato")).toMatchObject({ id: "native:kugou", detail: `Better Lyrics Legato ${DASH} line timing`, enabled: true });
    // Musixmatch line-synced only.
    expect(showingOf(summaryOf([byId("musixmatch"), byId("golyrics")]), "Musixmatch")).toMatchObject({ id: "native:musixmatch", enabled: true });
  });

  it("is the converted TTML for enhanced LRC and QRC (BL shows Musixmatch word-by-word when there is one)", () => {
    expect(showingOf(FULL, "Musixmatch")).toEqual({ id: "ttml:musixmatch-word", kind: "action", label: "Download what's showing", detail: `Musixmatch ${DASH} word timing, converted`, enabled: true });
    expect(showingOf(FULL, "Better Lyrics Portato")).toMatchObject({ id: "ttml:qq", detail: `Better Lyrics Portato ${DASH} word timing, converted`, enabled: true });
  });

  it("is disabled with a reason when it is not Tony-ready", () => {
    const disabled = (reason: string) => ({ id: "showing", kind: "action", label: "Download what's showing", enabled: false, reason });
    // Plain text only.
    expect(showingOf(summaryOf([byId("lrclib-plain"), byId("golyrics")]), "LRCLib")).toEqual(disabled(`${label("lrclib-plain")}: plain text has no timing for Tony`));
    // A candidate the Tony pick could not use, for the same reason.
    const doctype = variant("golyrics", `<!DOCTYPE tt>${byId("golyrics").content}`);
    expect(showingOf(summaryOf([doctype, byId("lrclib")]), "Better Lyrics")).toEqual(disabled("Has a <!DOCTYPE>, which Tony refuses"));
    const wordless = variant("qq", "[0,1000]");
    expect(showingOf(summaryOf([wordless, byId("kugou")]), "Better Lyrics Portato")).toEqual(disabled("No timed words to convert"));
  });

  it("is disabled for YouTube, sources not captured, unknown or missing names, and another song", () => {
    const reasonOf = (name: string | null, summary = FULL, forPlayingVideo = true) => {
      const item = showingOf(summary, name, forPlayingVideo);
      expect(item).toMatchObject({ id: "showing", enabled: false });
      return item.reason;
    };
    expect(reasonOf("YouTube")).toBe("YouTube lyrics come from YouTube itself, not from the captured lyrics request");
    expect(reasonOf("YouTube Captions")).toBe("YouTube Captions lyrics come from YouTube itself, not from the captured lyrics request");
    expect(reasonOf("Better Lyrics", summaryOf([byId("lrclib")]))).toBe("Better Lyrics lyrics are not in this capture");
    expect(reasonOf("Lyrically")).toBe('Unknown lyrics source "Lyrically" (checked with Better Lyrics 3.0.0.4)');
    expect(reasonOf("")).toBe("Better Lyrics shows no source name");
    expect(reasonOf(null)).toBe("Can't see which source Better Lyrics is showing");
    expect(reasonOf("Better Lyrics", FULL, false)).toBe("Better Lyrics shows the song that is playing, which this capture is not of");
  });
});

describe("Other sources", () => {
  const showingIds = (items: MenuItem[]) => items.filter((item) => item.showing).map((item) => item.id);

  it("marks the one source BL shows, the best of those under its name", () => {
    expect(showingIds(menu(FULL, "Musixmatch"))).toEqual(["native:musixmatch-word"]);
    expect(showingIds(menu(FULL, "LRCLib"))).toEqual(["native:lrclib"]);
    expect(find(menu(FULL, "LRCLib"), `${label("lrclib")} (showing)`)).toMatchObject({ id: "native:lrclib", showing: true });
    expect(showingIds(menu(summaryOf([byId("lrclib-plain")]), "LRCLib"))).toEqual(["native:lrclib-plain"]);
    for (const name of ["YouTube", "Lyrically", null]) expect(showingIds(menu(FULL, name))).toEqual([]);
    // The capture is of another song: BL is not showing any of its sources.
    expect(showingIds(menu(FULL, "Better Lyrics", false))).toEqual([]);
  });

  it("disables a -> TTML item that cannot be converted, with the reason", () => {
    const wordless = variant("qq", "[0,1000]");
    const items = menu(summaryOf([wordless, byId("kugou")]), null);
    expect(find(items, `${wordless.label} ${ARROW} TTML`)).toEqual({
      id: "ttml:qq",
      kind: "action",
      label: `${wordless.label} ${ARROW} TTML`,
      detail: ".qq.ttml",
      enabled: false,
      reason: "No timed words to convert",
    });
    expect(find(items, wordless.label)).toMatchObject({ id: "native:qq", enabled: true });
  });

  it("offers -> TTML for Unison richsync LRC, and none for raw JSON", () => {
    const richsync = variant("musixmatch-word", byId("musixmatch-word").content, { id: "unison", provider: "unison", blDisplayName: "Unison", label: `Unison ${DASH} LRC, word-synced`, ext: ".unison.lrc" });
    const raw: LyricsSource = { id: "newprov", provider: "newprov", label: `newprov ${DASH} raw JSON (unknown provider)`, timing: "unknown", format: "json", ext: ".newprov.json", mime: "application/json", content: "{}" };
    const ids = menu(summaryOf([richsync, raw]), "Unison").map((item) => item.id);
    expect(ids).toEqual(["tony", "tony", "divider:1", "header:other-sources", "native:unison", "ttml:unison", "native:newprov", "divider:2", "raw", "recapture"]);
  });
});

describe("a capture of another song", () => {
  it("starts with a disabled note naming the captured song", () => {
    const items = menu(FULL, "Better Lyrics", false);
    expect(items[0]).toEqual({
      id: OTHER_SONG_NOTE_ID,
      kind: "action",
      label: "Captured for another song",
      detail: "Marrow & Tin - Northbound Kites",
      enabled: false,
      reason: "Captured for another song: Marrow & Tin - Northbound Kites",
    });
    // Its files can still be saved: the rest is the same menu, without what BL shows.
    const playing = menu(FULL, "Better Lyrics", true);
    expect(playing.some((item) => item.id === OTHER_SONG_NOTE_ID)).toBe(false);
    expect(items).toHaveLength(playing.length + 1);
    const unrelated = (item: MenuItem) => item.label !== "Download what's showing" && item.id !== "native:golyrics";
    expect(items.slice(1).filter(unrelated)).toEqual(playing.filter(unrelated));
    expect(items[2]).toMatchObject({ id: "showing", enabled: false });
    expect(find(items, label("golyrics"))).toEqual({ id: "native:golyrics", kind: "action", label: label("golyrics"), detail: ".golyrics.ttml", enabled: true });
  });

  it("names the song by artist and title, either alone, or by video id", () => {
    const noteOf = (metadata: LyricsMetadata) => menu(summaryOf(fixture.sources, metadata), null, false)[0].reason;
    expect(noteOf({ artist: "Marrow & Tin" })).toBe("Captured for another song: Marrow & Tin");
    expect(noteOf({ song: "Northbound Kites" })).toBe("Captured for another song: Northbound Kites");
    expect(noteOf({})).toBe(`Captured for another song: video ${ID}`);
  });
});
