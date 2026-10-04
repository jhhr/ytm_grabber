// The real native host (native-host/ytm_grabber_host.py) registered for the end-to-end test's
// Chromium profile, with the fake yt-dlp of the host's own tests (native-host/testing/
// fake_yt_dlp.py: its behaviour comes from the video id's first four letters).
//
// Linux Chromium looks for a user-level host's manifest in <user-data-dir>/NativeMessagingHosts/
// <host name>.json (and system-wide in /etc/chromium/native-messaging-hosts/); on Windows the
// registry points to it (install.ps1). The manifest's `path` here is a shell wrapper, as host.bat is
// on Windows: it notes each start's pid and runs python3 on a COPY of the host script in a folder
// of its own, next to its own config.json (and the saved-folders.json it writes), so nothing in
// native-host/ is touched.
//
//   <work>/native-host/  ytm_grabber_host.py, config.json, saved-folders.json, host.sh,
//                        host-pids.log (one line per host process), host-stderr.log
//   <work>/native-host/bin/  yt-dlp (the fake), ffmpeg (a stub), argv-<id>.json, pids-<id>.json,
//                        release-<id> (lets a "wait" download finish)
//   <work>/fallback/     the config's fallbackOutputDir: nothing should land here
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../src/shared/messages";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SCRIPT = path.join(root, "native-host", "ytm_grabber_host.py");
const FAKE_YTDLP = path.join(root, "native-host", "testing", "fake_yt_dlp.py");

export interface TestHost {
  /** The host's folder (script copy, config.json, saved-folders.json). */
  dir: string;
  /** The fake yt-dlp's folder: argv-/pids-/release- files are kept here. */
  bin: string;
  /** config.json's fallbackOutputDir. */
  fallbackDir: string;
  /** <user-data-dir>/NativeMessagingHosts/com.jormki.ytm_grabber.json */
  manifestPath: string;
  /** Writes the manifest, allowing `extensionId` (the extension's own by default). */
  register(extensionId?: string): void;
  /** Removes the manifest: the host is then "not installed". */
  unregister(): void;
  /** The pid of every host process Chrome started so far, in order. */
  hostPids(): number[];
  /** The fake yt-dlp's arguments for `videoId`, or null when it never ran for it. */
  argv(videoId: string): string[] | null;
  /** The fake yt-dlp's pid (and its children's) for a "slow" or "kids" run, or null. */
  fakePids(videoId: string): number[] | null;
  /** Lets the "wait" fake for `videoId` save its file and finish. */
  release(videoId: string): void;
  /** saved-folders.json's folders, or null when there is no such file. */
  savedFolders(): string[] | null;
  /** The host processes' stderr so far (their log lines). */
  stderr(): string;
}

function quote(value: string): string {
  if (value.includes("'")) throw new Error(`Cannot quote ${value} for sh`);
  return `'${value}'`;
}

function executable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

export function installTestHost({ work, userDataDir, extensionId }: { work: string; userDataDir: string; extensionId: string }): TestHost {
  const dir = path.join(work, "native-host");
  const bin = path.join(dir, "bin");
  const fallbackDir = path.join(work, "fallback");
  for (const folder of [dir, bin, fallbackDir]) mkdirSync(folder, { recursive: true });
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();

  copyFileSync(HOST_SCRIPT, path.join(dir, "ytm_grabber_host.py"));
  executable(path.join(bin, "yt-dlp"), `#!${python}\n${readFileSync(FAKE_YTDLP, "utf8")}`);
  executable(path.join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ytDlpPath: path.join(bin, "yt-dlp"), ffmpegLocation: bin, extraArgs: ["-x"], fallbackOutputDir: fallbackDir }, null, 2),
  );
  const pidLog = path.join(dir, "host-pids.log");
  const stderrLog = path.join(dir, "host-stderr.log");
  const wrapper = path.join(dir, "host.sh");
  executable(
    wrapper,
    [
      "#!/bin/sh",
      "# Started by Chromium for each native port or sendNativeMessage (as host.bat on Windows).",
      `echo $$ >> ${quote(pidLog)}`,
      `exec ${quote(python)} -u ${quote(path.join(dir, "ytm_grabber_host.py"))} "$@" 2>> ${quote(stderrLog)}`,
      "",
    ].join("\n"),
  );

  const manifestDir = path.join(userDataDir, "NativeMessagingHosts");
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  const readJson = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

  const host: TestHost = {
    dir,
    bin,
    fallbackDir,
    manifestPath,
    register(allowed = extensionId) {
      mkdirSync(manifestDir, { recursive: true });
      const manifest = {
        name: NATIVE_HOST_NAME,
        description: "YTM Practice Grabber native host (end-to-end test)",
        path: wrapper,
        type: "stdio",
        allowed_origins: [`chrome-extension://${allowed}/`],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
    unregister() {
      rmSync(manifestPath, { force: true });
    },
    hostPids() {
      if (!existsSync(pidLog)) return [];
      return readFileSync(pidLog, "utf8").split("\n").filter(Boolean).map(Number);
    },
    argv: (videoId) => readJson(path.join(bin, `argv-${videoId}.json`)) as string[] | null,
    fakePids: (videoId) => readJson(path.join(bin, `pids-${videoId}.json`)) as number[] | null,
    release(videoId) {
      writeFileSync(path.join(bin, `release-${videoId}`), "");
    },
    savedFolders() {
      const saved = readJson(path.join(dir, "saved-folders.json")) as { folders: string[] } | null;
      return saved === null ? null : saved.folders;
    },
    stderr: () => (existsSync(stderrLog) ? readFileSync(stderrLog, "utf8") : ""),
  };
  host.register();
  return host;
}

/** Whether process `pid` runs (a zombie counts as gone), from /proc. */
export function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
