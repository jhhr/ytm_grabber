// Learning Chrome's download folder (PLAN.md section 3.6): when one of our lyrics downloads
// finishes, chrome.downloads reports its absolute path; that path minus the relative path we asked
// for is the folder Chrome saves into. The audio flow passes it to the native host, so yt-dlp
// writes next to the lyrics.

/**
 * The folder Chrome saved into, from a finished download's absolute `path` and the
 * `relativeFilename` we asked chrome.downloads for ("name.ext" or "stem/name.ext", always "/").
 * Only the directory part of the relative path is compared, segment by segment (ignoring case in
 * Windows paths): conflictAction "uniquify" may have renamed the file itself to "name (1).ext".
 * Null when the path does not end with the folders we asked for (the user picked another place
 * in a Save As dialog, say), or is not absolute.
 *
 * Windows paths ("C:\Users\me\Downloads\x.ttml", UNC "\\server\share\x.ttml"; either slash) come
 * back with backslashes, without a trailing one except for a drive's root ("C:\"); POSIX paths
 * ("/home/me/Downloads/x.ttml") come back as they were, "/" for the root.
 */
export function dirFromDownloadedPath(path: string, relativeFilename: string): string | null {
  const parsed = parseAbsolute(path);
  if (!parsed) return null;
  const askedDirs = relativeFilename.split("/").slice(0, -1);
  // The file itself, then the folders we asked for.
  const dirs = parsed.segments.slice(0, -1);
  if (parsed.segments.length === 0 || dirs.length < askedDirs.length) return null;
  const tail = dirs.slice(dirs.length - askedDirs.length);
  const same = parsed.windows ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  if (!tail.every((segment, index) => same(segment, askedDirs[index]))) return null;
  return parsed.join(dirs.slice(0, dirs.length - askedDirs.length));
}

interface AbsolutePath {
  windows: boolean;
  /** Below the root; empty segments (doubled or trailing separators) are dropped. */
  segments: string[];
  join(segments: string[]): string;
}

const UNC_ROOT = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/;
const DRIVE_ROOT = /^([A-Za-z]):(?=[\\/])/;

function parseAbsolute(path: string): AbsolutePath | null {
  const windowsSegments = (rest: string) => rest.split(/[\\/]/).filter((segment) => segment !== "");
  const unc = UNC_ROOT.exec(path);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    return { windows: true, segments: windowsSegments(path.slice(unc[0].length)), join: (segments) => [root, ...segments].join("\\") };
  }
  const drive = DRIVE_ROOT.exec(path);
  if (drive) {
    const root = `${drive[1]}:\\`;
    return { windows: true, segments: windowsSegments(path.slice(drive[0].length)), join: (segments) => root + segments.join("\\") };
  }
  if (path.startsWith("/")) {
    // A POSIX file name may contain a backslash: split on "/" only.
    return { windows: false, segments: path.split("/").filter((segment) => segment !== ""), join: (segments) => "/" + segments.join("/") };
  }
  return null;
}
