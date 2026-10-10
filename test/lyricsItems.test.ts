import { describe, expect, it } from "vitest";
import {
  convertsToTtml,
  isDownloadItemId,
  nativeItemId,
  parseDownloadItemId,
  RAW_ITEM,
  RECAPTURE_ITEM,
  SHOWING_ITEM,
  TONY_ITEM,
  ttmlItemId,
} from "../src/shared/lyricsItems";
import type { SourceFormat } from "../src/shared/sources";

describe("lyrics item ids", () => {
  it("are tony, raw, native:<source> and ttml:<source> for downloads", () => {
    expect([TONY_ITEM, RAW_ITEM, SHOWING_ITEM, RECAPTURE_ITEM]).toEqual(["tony", "raw", "showing", "recapture"]);
    expect(parseDownloadItemId("tony")).toEqual({ kind: "tony" });
    expect(parseDownloadItemId("raw")).toEqual({ kind: "raw" });
    expect(parseDownloadItemId("native:golyrics")).toEqual({ kind: "native", sourceId: "golyrics" });
    expect(parseDownloadItemId("native:musixmatch-word")).toEqual({ kind: "native", sourceId: "musixmatch-word" });
    expect(parseDownloadItemId("ttml:qq")).toEqual({ kind: "ttml", sourceId: "qq" });
    // An unknown provider's sanitised id, and one renamed away from a known id.
    expect(parseDownloadItemId("native:new_provider-2")).toEqual({ kind: "native", sourceId: "new_provider-2" });
    expect(parseDownloadItemId(`native:${"a".repeat(40)}-raw`)).toEqual({ kind: "native", sourceId: `${"a".repeat(40)}-raw` });
  });

  it("round-trip through the builders", () => {
    for (const id of ["golyrics", "unison", "lrclib-plain", "x_y"]) {
      expect(parseDownloadItemId(nativeItemId(id))).toEqual({ kind: "native", sourceId: id });
      expect(parseDownloadItemId(ttmlItemId(id))).toEqual({ kind: "ttml", sourceId: id });
    }
  });

  it("refuse showing, recapture and anything malformed", () => {
    const bad = [
      "showing",
      "recapture",
      "",
      "TONY",
      " tony",
      "tony ",
      "raw\n",
      "native:",
      "ttml:",
      "native:Golyrics",
      "native:../golyrics",
      "native:a b",
      "native:a/b",
      "native:a\\b",
      "native:a.b",
      "ttml:qq:x",
      `native:${"a".repeat(65)}`,
      "lrc:golyrics",
      "native golyrics",
      "nativegolyrics",
    ];
    for (const id of bad) {
      expect(parseDownloadItemId(id), JSON.stringify(id)).toBeNull();
      expect(isDownloadItemId(id), JSON.stringify(id)).toBe(false);
    }
    for (const value of [undefined, null, 1, ["tony"], { toString: () => "tony" }]) expect(isDownloadItemId(value)).toBe(false);
    expect(isDownloadItemId(`native:${"a".repeat(64)}`)).toBe(true);
  });

  it("convert enhanced LRC and QRC to TTML, nothing else", () => {
    const formats: SourceFormat[] = ["ttml", "lrc", "enhanced-lrc", "qrc", "plain", "json"];
    expect(formats.filter(convertsToTtml)).toEqual(["enhanced-lrc", "qrc"]);
  });
});
