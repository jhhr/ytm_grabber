import { describe, expect, it } from "vitest";
import { dirFromDownloadedPath } from "../src/shared/downloadDir";

const STEM = "Marrow & Tin - Northbound Kites [Synth3t1cK1]";

describe("dirFromDownloadedPath", () => {
  // [absolute path Chrome reports, relative filename we asked for, folder learned]
  const table: [string, string, string | null][] = [
    // Windows, no subfolder; uniquify's " (1)" changes only the file name.
    ["C:\\Users\\x\\Downloads\\a.ttml", "a.ttml", "C:\\Users\\x\\Downloads"],
    [`C:\\Users\\x\\Downloads\\${STEM}.ttml`, `${STEM}.ttml`, "C:\\Users\\x\\Downloads"],
    [`C:\\Users\\x\\Downloads\\${STEM}.golyrics (1).ttml`, `${STEM}.golyrics.ttml`, "C:\\Users\\x\\Downloads"],
    // Windows, per-song subfolder: the <stem> folder goes too, compared ignoring case.
    [`C:\\Users\\x\\Downloads\\${STEM}\\${STEM}.ttml`, `${STEM}/${STEM}.ttml`, "C:\\Users\\x\\Downloads"],
    ["C:\\Users\\x\\Downloads\\stem\\stem.ttml", "stem/stem.ttml", "C:\\Users\\x\\Downloads"],
    ["C:\\Users\\x\\Downloads\\STEM\\stem (2).ttml", "stem/stem.ttml", "C:\\Users\\x\\Downloads"],
    ["d:/Music/Practice/stem/stem.lrc", "stem/stem.lrc", "d:\\Music\\Practice"],
    // A drive's root keeps its backslash ("C:" alone is a drive's current folder).
    ["C:\\a.ttml", "a.ttml", "C:\\"],
    ["C:\\stem\\a.ttml", "stem/a.ttml", "C:\\"],
    // UNC.
    ["\\\\nas\\music\\Downloads\\a.ttml", "a.ttml", "\\\\nas\\music\\Downloads"],
    ["\\\\nas\\music\\Downloads\\stem\\a.ttml", "stem/a.ttml", "\\\\nas\\music\\Downloads"],
    ["\\\\nas\\music\\a.ttml", "a.ttml", "\\\\nas\\music"],
    // POSIX: case matters, a backslash is part of a name.
    ["/home/x/Downloads/a.ttml", "a.ttml", "/home/x/Downloads"],
    ["/home/x/Downloads/stem/stem (1).ttml", "stem/stem.ttml", "/home/x/Downloads"],
    ["/home/x/Down\\loads/a.ttml", "a.ttml", "/home/x/Down\\loads"],
    ["/a.ttml", "a.ttml", "/"],
    ["/stem/a.ttml", "stem/a.ttml", "/"],
    // Not where we asked: the subfolder is missing or different (a Save As dialog, say).
    ["C:\\Users\\x\\Downloads\\a.ttml", "stem/a.ttml", null],
    ["C:\\Users\\x\\Downloads\\other\\a.ttml", "stem/a.ttml", null],
    ["/home/x/Downloads/STEM/a.ttml", "stem/a.ttml", null],
    ["C:\\a.ttml", "x/y/a.ttml", null],
    // Not absolute, or no file in it.
    ["a.ttml", "a.ttml", null],
    ["Downloads\\a.ttml", "a.ttml", null],
    ["C:a.ttml", "a.ttml", null],
    ["", "a.ttml", null],
    ["C:\\", "a.ttml", null],
    ["\\\\nas\\music", "a.ttml", null],
    ["/", "a.ttml", null],
  ];

  it.each(table)("%s minus %s", (path, relative, expected) => {
    expect(dirFromDownloadedPath(path, relative)).toBe(expected);
  });

  it("ignores doubled and trailing separators", () => {
    expect(dirFromDownloadedPath("C:\\Users\\\\x\\Downloads\\\\stem\\a.ttml", "stem/a.ttml")).toBe("C:\\Users\\x\\Downloads");
    expect(dirFromDownloadedPath("/home//x/Downloads/a.ttml", "a.ttml")).toBe("/home/x/Downloads");
  });
});
