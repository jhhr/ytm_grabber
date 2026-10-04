#!/usr/bin/env python3
"""Native messaging host for YTM Practice Grabber (host name com.jormki.ytm_grabber).

Chrome starts this script (through host.bat on Windows, which install.ps1 writes) when the
extension opens a native port, and talks to it over stdin/stdout: every message is a 4-byte
little-endian length followed by that many bytes of UTF-8 JSON (PLAN.md section 3.8).

  extension -> host                          host -> extension
  {type: "ping"}                             {type: "pong", hostVersion, ytDlpVersion,
  {type: "download", requestId, videoId,       ffmpegFound, problems}
   stem, outputDir?, subfolder?}             {type: "progress", requestId, percent, line}
  {type: "cancel", requestId}                {type: "done", requestId, path}
  {type: "reveal", path}                     {type: "error", requestId?, message,
                                               stderrTail?, cancelled?}

Every download ends with exactly one "done" or "error" for its requestId, and nothing is sent
for that requestId before it; a cancelled one ends with {type: "error", message: "Cancelled",
cancelled: true}. "cancel" and "reveal" are answered only when they fail. Any request may carry
a requestId, which error replies echo. "reveal" shows only files inside folders a download was
saved into, by this or an earlier host process (saved-folders.json next to this script).

This process is the security boundary between the browser and the machine: everything in a
message is checked before use, the yt-dlp command line is fixed apart from the user's own
config.json (next to this script), and nothing but frames may ever reach stdout.

Standard library only; Python 3.8 or newer. Run by Chrome, not by hand.
"""

import collections
import json
import math
import ntpath
import os
import random
import re
import shutil
import signal
import string
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata

HOST_VERSION = "0.1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_NAME = "config.json"
SAVED_FOLDERS_NAME = "saved-folders.json"
DEFAULT_EXTRA_ARGS = ["-x"]

MAX_INCOMING = 1024 * 1024  # our own cap: real requests are tiny; Chrome would send up to 4 GB
MAX_OUTGOING = 1024 * 1024  # Chrome's limit for one host -> extension message
LINE_LIMIT = 500  # characters kept of a progress line
TAIL_LINES = 20  # stderr lines kept for error.stderrTail
TAIL_LINE_LIMIT = 1000  # characters kept of each of them
REQUEST_ID_LIMIT = 200
VERSION_TIMEOUT = 10.0  # seconds for `yt-dlp --version`
KILL_GRACE = 1.0  # seconds between SIGTERM and SIGKILL (not Windows: taskkill /F is final)
READER_GRACE = 5.0  # seconds to drain a finished yt-dlp's pipes (a grandchild may hold them)
SHUTDOWN_WAIT = 5.0  # seconds to wait for cancelled downloads when Chrome closes the port
SAVED_FOLDERS_LIMIT = 200  # folders remembered for reveal, the most recent ones
REPLACE_TRIES = 5  # attempts at moving the new saved-folders.json into place (Windows: see _replace)
REPLACE_PAUSE = 0.05  # seconds between them

PROGRESS_MARK = "PG_PROGRESS"
PROGRESS_TEMPLATE = "download:" + PROGRESS_MARK + " %(progress._percent_str)s"


# --- File names -----------------------------------------------------------------------------
#
# A port of sanitizeFilename() in src/shared/filenames.ts; test/fixtures/sanitize-vectors.json
# is the contract both must pass. Keep the two in step. JavaScript strings are UTF-16, Python
# strings are code points, so lengths here count UTF-16 code units explicitly.

MAX_STEM_LENGTH = 150

_ILLEGAL = frozenset('<>:"/\\|?*')
# Unicode White_Space minus the controls (which become spaces anyway).
_WHITESPACE = frozenset([0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000] + list(range(0x2000, 0x200B)))
_END_JUNK = " .~"
_SPACE_RUN = re.compile(" {2,}")
_REPLACEMENT = chr(0xFFFD)
# Windows device names (with the superscript digits Windows also accepts) plus Chrome's CLOCK$,
# compared after lower-casing ASCII letters only (filenames.ts: a regex /i without the u flag
# never folds a non-ASCII letter such as the Kelvin sign onto an ASCII one).
_RESERVED_BASES = frozenset(
    ["con", "prn", "aux", "nul", "clock$"]
    + [prefix + digit for prefix in ("com", "lpt") for digit in "123456789\xb9\xb2\xb3"]
)
_RESERVED_NAMES = frozenset(["desktop.ini", "thumbs.db"])
_ASCII_LOWER = {code: code + 32 for code in range(ord("A"), ord("Z") + 1)}


def utf16_length(text):
    """Length in UTF-16 code units, the unit JavaScript string lengths count."""
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def sanitize_filename(name):
    """Makes `name` safe as one file or folder name on Windows and in chrome.downloads, exactly
    as filenames.ts sanitizeFilename() does (the steps are listed there). Idempotent."""
    result = _cap(_normalize(name).strip(_END_JUNK))
    if _is_reserved(result):
        result = _cap("_" + result)
    return result or "_"


def _normalize(text):
    # Join surrogate pairs that arrive as two code points (as a UTF-16 string would hold them);
    # what is left unpaired becomes U+FFFD, as in filenames.ts.
    text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    out = []
    for ch in text:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            out.append(_REPLACEMENT)
        elif ch in _ILLEGAL or _becomes_space(code):
            out.append(" ")
        else:
            out.append(ch)
    return _SPACE_RUN.sub(" ", "".join(out))


def _becomes_space(code):
    if code in _WHITESPACE:
        return True
    if 0xFDD0 <= code <= 0xFDEF or (code & 0xFFFE) == 0xFFFE:  # noncharacters
        return True
    # Control and format characters. Python's Unicode tables can be older than the browser's,
    # so a format character newer than this Python stays (the stem is then refused, not changed).
    return unicodedata.category(chr(code)) in ("Cc", "Cf")


def _truncate(text, limit):
    """Cuts to at most `limit` UTF-16 code units without splitting a character."""
    units = 0
    for index, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:index]
    return text


def _cap(name):
    return _truncate(name, MAX_STEM_LENGTH).rstrip(_END_JUNK)


def _is_reserved(name):
    # The base is everything before the first dot; Windows ignores spaces at its end.
    base = name.split(".", 1)[0].rstrip(" ").translate(_ASCII_LOWER)
    return base in _RESERVED_BASES or name.translate(_ASCII_LOWER) in _RESERVED_NAMES


_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def is_video_id(value):
    # fullmatch: "$" would also match before a trailing newline.
    return isinstance(value, str) and _VIDEO_ID.fullmatch(value) is not None


def stem_problem(stem, video_id):
    """Why `stem` is refused for `video_id`, or None. A stem is never changed here: it must be
    what buildStem() makes, a fixed point of sanitize_filename() ending " [<videoId>]" (the
    service worker applies the same rule to lyrics files)."""
    if not isinstance(stem, str):
        return "The file name (stem) must be a string"
    # Longer than the cap in code points means longer in UTF-16 units too: no need to sanitise
    # up to a megabyte of text to know it would change.
    if len(stem) > MAX_STEM_LENGTH or sanitize_filename(stem) != stem:
        return "Not a usable file name: %s" % _quote(stem)
    if stem != "[%s]" % video_id and not stem.endswith(" [%s]" % video_id):
        return "The file name %s does not end with this song's video id [%s]" % (_quote(stem), video_id)
    return None


def output_template(stem):
    """yt-dlp's -o value: a literal "%" is written "%%" (yt-dlp expands %(field)s). A stem has no
    ":" (sanitised away), so yt-dlp cannot read a "TYPES:" prefix into it."""
    return stem.replace("%", "%%") + ".%(ext)s"


# yt-dlp also runs os.path.expandvars (after expanduser) over -P and over the literal text of -o
# before filling in fields (utils.expand_path, YoutubeDL._outtmpl_expandpath; yt-dlp 2026.08.19):
# a title with "$HOME" or "${TEMP}" in it, or "%TEMP%" in a Windows folder name, would be replaced
# by that variable's value, which can even be a path elsewhere. No escape survives every case
# (on Windows a single quote, as in "Guns N' Roses", turns expansion off for the rest of the text),
# so the host runs the same expansion itself - same function, same environment, which yt-dlp
# inherits - and refuses what it would change, like any other stem it cannot keep as it is.


def template_expands(template):
    """Whether yt-dlp would change the -o value `template` by expanding variables in it. Like
    yt-dlp it keeps "%%" and "$$" by putting a run of random letters between their halves."""
    sep = "".join(random.choice(string.ascii_letters) for _ in range(32))
    protected = template.replace("%%", "%" + sep + "%").replace("$$", "$" + sep + "$")
    return _expanded(protected, sep) != template


def path_expands(path):
    """Whether yt-dlp would change the -P value `path` by expanding variables in it."""
    return _expanded(path, None) != path


def _expanded(text, sep):
    try:
        result = os.path.expandvars(os.path.expanduser(text))
    except (KeyError, ValueError):  # an odd variable name: count it as a change
        return None
    return result.replace(sep, "") if sep else result


# --- Progress lines -------------------------------------------------------------------------

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_PERCENT = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*%")


def parse_progress(line):
    """(percent or None, text) for one of our progress lines, or None for any other line.
    The template gives e.g. "PG_PROGRESS  42.3%"; colour codes are dropped in case extraArgs
    turns colours on."""
    text = _ANSI.sub("", line).strip()
    head, _, rest = text.partition(" ")
    if head != PROGRESS_MARK:
        return None
    rest = rest.strip()
    percent = None
    match = _PERCENT.match(rest)
    if match:
        value = float(match.group(1))
        if math.isfinite(value):
            percent = min(max(value, 0.0), 100.0)  # yt-dlp's estimate can pass 100
    return percent, _clip(rest, LINE_LIMIT)


# --- Config ---------------------------------------------------------------------------------


class HostError(Exception):
    """A failure the user should read: str(error) is the sentence for the extension."""


class Config(object):
    def __init__(self, path, ytdlp_path, ffmpeg_location, extra_args, fallback_output_dir):
        self.path = path
        self.ytdlp_path = ytdlp_path
        self.ffmpeg_location = ffmpeg_location
        self.extra_args = extra_args
        self.fallback_output_dir = fallback_output_dir


def load_config(path):
    """Reads config.json (read for every request, so edits apply without restarting Chrome).
    Raises HostError with a sentence naming the file."""
    try:
        # utf-8-sig: Notepad and Windows PowerShell 5 may add a byte order mark.
        with open(path, "r", encoding="utf-8-sig") as handle:
            text = handle.read()
    except FileNotFoundError:
        raise HostError(
            "%s is missing: run install.ps1, or copy config.example.json to config.json and edit it" % path
        )
    except (OSError, UnicodeDecodeError) as exc:
        raise HostError("Could not read %s: %s" % (path, exc))
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise HostError("%s is not valid JSON (%s); in JSON every backslash in a path is written twice" % (path, exc))
    if not isinstance(data, dict):
        raise HostError("%s must hold one JSON object" % path)

    ytdlp = data.get("ytDlpPath")
    if not isinstance(ytdlp, str) or not ytdlp.strip():
        raise HostError("Set ytDlpPath in %s to the full path of yt-dlp.exe" % path)
    ytdlp = _expand(ytdlp)
    if os.path.splitext(ytdlp)[1].lower() in (".bat", ".cmd"):
        # Windows runs batch files through cmd.exe, which would interpret characters such as
        # "&" or "%" in song titles: never hand it a stem.
        raise HostError("ytDlpPath in %s points to a batch file (%s); point it at yt-dlp.exe" % (path, ytdlp))

    ffmpeg = data.get("ffmpegLocation")
    if ffmpeg is not None and not isinstance(ffmpeg, str):
        raise HostError("ffmpegLocation in %s must be a path (or empty)" % path)
    ffmpeg = _expand(ffmpeg) if ffmpeg and ffmpeg.strip() else None

    extra = data.get("extraArgs", DEFAULT_EXTRA_ARGS)
    if not isinstance(extra, list) or not all(isinstance(arg, str) for arg in extra):
        raise HostError('extraArgs in %s must be a list of strings, e.g. ["-x"]' % path)

    fallback = data.get("fallbackOutputDir", os.path.join("~", "Downloads"))
    if not isinstance(fallback, str) or not fallback.strip():
        raise HostError("fallbackOutputDir in %s must be a folder path" % path)

    return Config(path, ytdlp, ffmpeg, list(extra), _expand(fallback))


def _expand(path):
    return os.path.expanduser(os.path.expandvars(path))


def ffmpeg_found(config):
    """ffmpeg in ffmpegLocation (the binary or its folder, as yt-dlp accepts), else on PATH."""
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    location = config.ffmpeg_location if config is not None else None
    if not location:
        return shutil.which("ffmpeg") is not None
    if os.path.isfile(location):
        return True
    return os.path.isfile(os.path.join(location, name))


def ytdlp_version(config):
    """`yt-dlp --version`'s first line; raises HostError with a readable reason."""
    try:
        proc = subprocess.Popen(
            [config.ytdlp_path, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **_child_options()
        )
    except OSError as exc:
        raise HostError(_ytdlp_start_problem(config, exc))
    try:
        out, err = proc.communicate(timeout=VERSION_TIMEOUT)
    except subprocess.TimeoutExpired:
        kill_tree(proc, 0)
        try:
            proc.communicate(timeout=2)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            pass
        raise HostError("yt-dlp at %s did not answer --version within %d s" % (config.ytdlp_path, VERSION_TIMEOUT))
    if proc.returncode != 0:
        lines = [line for line in err.decode("utf-8", "replace").splitlines() if line.strip()]
        detail = ": " + _clip(lines[-1].strip(), 300) if lines else ""
        raise HostError("yt-dlp at %s failed (exit code %s)%s" % (config.ytdlp_path, proc.returncode, detail))
    lines = [line.strip() for line in out.decode("utf-8", "replace").splitlines() if line.strip()]
    if not lines:
        raise HostError("yt-dlp at %s printed no version" % config.ytdlp_path)
    return _clip(lines[0], 100)


def _ytdlp_start_problem(config, exc):
    if isinstance(exc, FileNotFoundError):
        return "yt-dlp was not found at %s (ytDlpPath in %s)" % (config.ytdlp_path, config.path)
    reason = exc.strerror or str(exc)
    return "yt-dlp at %s could not be started (%s); check ytDlpPath in %s" % (config.ytdlp_path, reason, config.path)


def build_command(config, video_id, stem, directory):
    """The yt-dlp command line of PLAN.md section 3.8; only config.json adds to it."""
    cmd = [config.ytdlp_path] + config.extra_args
    if config.ffmpeg_location:
        cmd += ["--ffmpeg-location", config.ffmpeg_location]
    cmd += [
        "--no-playlist",
        "--encoding", "utf-8",
        "--newline", "--progress",
        "--progress-template", PROGRESS_TEMPLATE,
        "--print", "after_move:filepath",
        # An absolute path cannot be read as yt-dlp's "TYPES:PATH" form: its types are all
        # longer than a drive letter.
        "-P", directory,
        "-o", output_template(stem),
        "--", video_id,  # ids can start with "-"
    ]
    return cmd


# --- Paths ----------------------------------------------------------------------------------


def _has_control(text):
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text)


def _is_absolute(path):
    # On Windows "\\dir" counts as absolute for os.path.isabs before Python 3.13 but means
    # "on the current drive": require a drive or a UNC share.
    if not os.path.isabs(path):
        return False
    return os.name != "nt" or bool(os.path.splitdrive(path)[0])


def dir_problem(path):
    """Why `path` cannot be the folder yt-dlp saves into, or None."""
    if not isinstance(path, str) or not path or _has_control(path):
        return "is not a folder path"
    try:
        if not _is_absolute(path):
            return "is not an absolute path"
        if not os.path.isdir(path):
            return "does not exist"
    except (OSError, ValueError):
        return "is not a folder path"
    if path_expands(os.path.normpath(path)):
        return "has a part yt-dlp would replace with an environment variable's value"
    return None


def canonical_path(path):
    """For containment checks: absolute, links resolved, case-folded on Windows."""
    try:
        if not isinstance(path, str) or not path or not _is_absolute(path):
            return None
        return os.path.normcase(os.path.realpath(path))
    except (OSError, ValueError):
        return None


def is_within(path, directory):
    """Whether canonical `path` is `directory` or inside it, by path components (a plain
    string prefix would let C:\\Music2 pass for C:\\Music)."""
    try:
        return os.path.commonpath([path, directory]) == directory
    except ValueError:  # different drives, or one relative
        return False


def explorer_command(path):
    """The command line that shows `path` selected in Explorer. explorer.exe parses its own
    command line and wants /select,"<path>" with only the path quoted; subprocess's list
    quoting would quote the whole "/select,<path>" argument once the path has a space, which
    Explorer does not understand. So it is one string; a Windows path cannot contain '"'."""
    explorer = ntpath.join(os.environ.get("SystemRoot") or "C:\\Windows", "explorer.exe")
    return '"%s" /select,"%s"' % (explorer, path)


def taskkill_command(pid):
    """Ends a process and its children on Windows: yt-dlp.exe is itself two processes (a
    PyInstaller launcher and Python) and starts ffmpeg."""
    taskkill = ntpath.join(os.environ.get("SystemRoot") or "C:\\Windows", "System32", "taskkill.exe")
    return [taskkill, "/T", "/F", "/PID", str(pid)]


# --- Folders saved to -----------------------------------------------------------------------
#
# reveal shows only files inside a folder a download was saved into (PLAN.md 3.8, 7.1). The
# extension closes its port as soon as it is owed nothing, which ends this process, so the click
# on the check mark always reaches a new host process: the folders are kept next to this script
# in saved-folders.json, {"folders": [<canonical path>, ...]}, oldest first, the most recent
# SAVED_FOLDERS_LIMIT of them. Several host processes may run at once (a download port beside a
# one-shot ping or reveal), so a writer merges with what is on disk right before it writes (its
# own folders count as the most recent: the last writer decides the order) and replaces the file
# whole, through a temporary file in the same folder and os.replace, so a reader never meets half
# a file. A missing, unreadable or corrupt file counts as an empty list: at worst a reveal is
# refused.


def merge_folders(older, newer, limit=SAVED_FOLDERS_LIMIT):
    """`older` then `newer` (each oldest first) as one list without repeats, each folder where it
    comes last (so one in both takes its place in `newer`), cut to the last `limit`."""
    merged = []
    seen = set()
    for folder in reversed(list(older) + list(newer)):
        if folder not in seen:
            seen.add(folder)
            merged.append(folder)
    merged.reverse()
    return merged[max(0, len(merged) - limit):]


def _usable_folder(value):
    return isinstance(value, str) and bool(value) and not _has_control(value) and _is_absolute(value)


def load_saved_folders(path):
    """The folders in the state file at `path`, oldest first; [] when it is missing, unreadable
    or not what save_saved_folders() writes. Never raises."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return []
    except (OSError, ValueError, RecursionError) as exc:  # ValueError covers bad UTF-8 and bad JSON
        log("ignoring %s: %s" % (path, _clip(str(exc), 200)))
        return []
    except Exception as exc:  # e.g. MemoryError: still only a refused reveal, never a crash
        log("ignoring %s: %s" % (path, _clip(repr(exc), 200)))
        return []
    folders = data.get("folders") if isinstance(data, dict) else None
    if not isinstance(folders, list):
        log("ignoring %s: it holds no list of folders" % path)
        return []
    return merge_folders([folder for folder in folders if _usable_folder(folder)], [])


def save_saved_folders(path, folders):
    """Replaces the state file at `path` with `folders`, whole. Raises OSError when it cannot;
    the file is then as it was."""
    fd, temp = tempfile.mkstemp(prefix=SAVED_FOLDERS_NAME + ".", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with open(fd, "w", encoding="utf-8") as handle:
            json.dump({"folders": list(folders)}, handle, indent=1)  # ASCII: ensure_ascii
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())  # the new name never points at contents not yet on disk
        _replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def _replace(source, target):
    # On Windows os.replace fails (access denied) while another process has the target open,
    # as another host process reading the list may have for a moment: try again shortly.
    for attempt in range(REPLACE_TRIES):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt + 1 == REPLACE_TRIES:
                raise
            time.sleep(REPLACE_PAUSE)


# --- Processes ------------------------------------------------------------------------------


def _child_options():
    """Popen options for every child. Callers always pass all three std handles (never our
    stdin or stdout). Windows: no console window. Elsewhere: a process group of its own, so a
    cancel reaches ffmpeg too."""
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {"start_new_session": True}


def kill_tree(proc, grace):
    """Ends `proc` and the processes it started. Blocks for up to about `grace` seconds."""
    if os.name == "nt":
        try:
            subprocess.run(
                taskkill_command(proc.pid),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                **_child_options()
            )
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            proc.wait(timeout=max(grace, 1.0))
        except subprocess.TimeoutExpired:
            proc.kill()  # taskkill failed: end the process itself at least
        return
    _signal_group(proc, signal.SIGTERM)
    if grace > 0:
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
    # Also whatever the group still holds after its leader went (ffmpeg, a grandchild).
    _signal_group(proc, signal.SIGKILL)


def _signal_group(proc, signum):
    try:
        os.killpg(proc.pid, signum)
    except (ProcessLookupError, PermissionError):
        pass
    except OSError:
        try:
            proc.send_signal(signum)
        except OSError:
            pass


# --- Framing --------------------------------------------------------------------------------


class FrameTooLarge(Exception):
    pass


def read_exact(stream, size):
    """`size` bytes, or None at end of input (also when it ends inside a frame)."""
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream):
    """The next message's bytes, or None when Chrome has closed stdin. A message over
    MAX_INCOMING is read and dropped (keeping the stream in step), then FrameTooLarge."""
    header = read_exact(stream, 4)
    if header is None:
        return None
    (size,) = struct.unpack("<I", header)
    if size > MAX_INCOMING:
        remaining = size
        while remaining > 0:
            chunk = stream.read(min(remaining, 65536))
            if not chunk:
                return None
            remaining -= len(chunk)
        raise FrameTooLarge(size)
    return read_exact(stream, size)


def encode_message(message):
    """One frame. ensure_ascii keeps the body ASCII whatever a path or a stem holds (a lone
    surrogate from a JSON escape too); a body over Chrome's limit becomes a short error."""
    try:
        body = json.dumps(message, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    except (TypeError, ValueError) as exc:
        body = None
        problem = "Internal error: unencodable reply (%s)" % exc
    else:
        problem = None if len(body) <= MAX_OUTGOING else "Reply too large (%d bytes)" % len(body)
    if problem is not None:
        fallback = {"type": "error", "message": problem}
        if isinstance(message.get("requestId"), str):
            fallback["requestId"] = message["requestId"][:REQUEST_ID_LIMIT]
        body = json.dumps(fallback, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return struct.pack("<I", len(body)) + body


def write_all(stream, data):
    """Writes every byte: the channel is an unbuffered file, whose write() may write part."""
    view = memoryview(data)
    while len(view):
        written = stream.write(view)
        if not written:
            raise OSError("stdout accepted no bytes")
        view = view[written:]


def take_stdio():
    """(binary stdin, binary channel to Chrome). Afterwards file descriptor 1 and sys.stdout go
    to stderr (or the null device), so a stray print, a library or an inherited handle cannot
    write into the channel; the channel itself is a non-inheritable duplicate."""
    if os.name == "nt":
        import msvcrt

        # No newline translation (Chrome's own example host does this too).
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        sys.stdout.flush()
    except (OSError, ValueError, AttributeError):
        pass
    channel_fd = os.dup(1)
    if os.name == "nt":
        import msvcrt

        msvcrt.setmode(channel_fd, os.O_BINARY)
    try:
        os.dup2(2, 1)
    except OSError:  # no stderr (Chrome on Windows may give none)
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.close(devnull)
    sys.stdout = sys.stderr if sys.stderr is not None else open(os.devnull, "w")
    return sys.stdin.buffer, os.fdopen(channel_fd, "wb", buffering=0)


def log(text):
    """Diagnostics go to stderr (Chrome's log when started with --enable-logging)."""
    stream = sys.stderr
    if stream is None:
        return
    try:
        stream.write("ytm_grabber_host: %s\n" % text)
        stream.flush()
    except Exception:
        pass


def _clip(text, limit):
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _quote(value):
    """A JSON-quoted, shortened copy of `value` for an error sentence. Letters such as "\u00e4"
    stay as they are (the user reads these sentences); control characters are still escaped,
    and a lone surrogate becomes "?" so the reply stays valid UTF-8."""
    if not isinstance(value, str):
        return type(value).__name__
    text = _clip(value, 200).encode("utf-8", "replace").decode("utf-8")
    return json.dumps(text, ensure_ascii=False)


def _request_id(message):
    """The message's requestId if it is a usable one, else None."""
    value = message.get("requestId")
    if isinstance(value, str) and 0 < len(value) <= REQUEST_ID_LIMIT:
        return value
    return None


# --- Downloads ------------------------------------------------------------------------------


class Download(object):
    """One yt-dlp run: a waiter thread plus a reader thread per pipe, so neither pipe can fill
    up and stall yt-dlp. Progress is sent as it comes; the waiter sends the one final reply."""

    def __init__(self, host, request_id, cmd, output_dir, stem):
        self.host = host
        self.request_id = request_id
        self.cmd = cmd
        self.output_dir = output_dir
        self.stem = stem
        self.lock = threading.Lock()
        self.proc = None
        self.thread = None
        self.cancelled = False
        self.finished = False
        self.last_line = None  # the last stdout line that is not progress: the file's path
        self.stderr_tail = collections.deque(maxlen=TAIL_LINES)
        self.last_progress = None

    def start(self, config):
        try:
            self.proc = subprocess.Popen(
                self.cmd,
                stdin=subprocess.DEVNULL,  # never our stdin: it carries Chrome's messages
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",  # what --encoding utf-8 makes yt-dlp write
                errors="replace",
                **_child_options()
            )
        except OSError as exc:
            raise HostError(_ytdlp_start_problem(config, exc))
        self.thread = threading.Thread(target=self._run, name="download-" + self.request_id[:20])
        self.thread.daemon = True
        self.thread.start()

    def cancel(self):
        """Kills the run if it is still going; the waiter then reports "Cancelled". A run that
        has already ended reports its real outcome instead."""
        with self.lock:
            if self.finished or self.cancelled or self.proc.poll() is not None:
                return
            self.cancelled = True
        killer = threading.Thread(target=kill_tree, args=(self.proc, KILL_GRACE), name="kill")
        killer.daemon = True
        killer.start()

    def _run(self):
        try:
            readers = [
                threading.Thread(target=self._read, args=(self.proc.stdout, True), name="stdout"),
                threading.Thread(target=self._read, args=(self.proc.stderr, False), name="stderr"),
            ]
            for reader in readers:
                reader.daemon = True
                reader.start()
            code = self.proc.wait()
            for reader in readers:
                reader.join(READER_GRACE)
            outcome = None
        except Exception as exc:  # never leave a download without a final reply
            log("download %s: %s" % (self.request_id, traceback.format_exc()))
            code, outcome = None, "Internal error: %s" % exc
        self.host.finish(self, code, outcome)

    def _read(self, stream, is_stdout):
        # yt-dlp prints progress on stdout (checked with yt-dlp 2026.08.19); stderr is read
        # for it too in case another version or extraArgs moves it.
        try:
            for line in iter(stream.readline, ""):
                line = line.rstrip("\n")
                progress = parse_progress(line)
                if progress is not None:
                    self._progress(*progress)
                elif not line.strip():
                    continue
                elif is_stdout:
                    self.last_line = line
                else:
                    self.stderr_tail.append(_clip(line.rstrip(), TAIL_LINE_LIMIT))
        except (OSError, ValueError):
            pass
        finally:
            try:
                stream.close()
            except (OSError, ValueError):
                pass

    def _progress(self, percent, text):
        with self.lock:
            # Nothing after the final reply; yt-dlp repeats its last line, send it once.
            if self.finished or (percent, text) == self.last_progress:
                return
            self.last_progress = (percent, text)
            self.host.send({"type": "progress", "requestId": self.request_id, "percent": percent, "line": text})

    def outcome(self, code, cancelled):
        """The final reply for exit code `code`."""
        if cancelled:
            return {"type": "error", "requestId": self.request_id, "message": "Cancelled", "cancelled": True}
        tail = "\n".join(self.stderr_tail)
        if code != 0:
            errors = [line for line in self.stderr_tail if line.startswith("ERROR:")]
            detail = ": " + _clip(errors[-1], 300) if errors else ""
            return self._error("yt-dlp failed (exit code %s)%s" % (code, detail), tail)
        path = self.last_line
        if not path:
            return self._error("yt-dlp finished but did not print the file's path", tail)
        if not os.path.isfile(path):
            return self._error("yt-dlp reported a file that does not exist: %s" % path, tail)
        # What was asked for: <output dir>/<stem>.<ext>. Anything else means yt-dlp read the
        # command line differently than this host expects (extraArgs, a newer yt-dlp).
        if canonical_path(os.path.dirname(path)) != canonical_path(self.output_dir) or not os.path.basename(
            path
        ).startswith(self.stem + "."):
            expected = os.path.join(self.output_dir, self.stem + ".<ext>")
            return self._error("yt-dlp saved %s instead of %s" % (path, expected), tail)
        return {"type": "done", "requestId": self.request_id, "path": path}

    def _error(self, message, tail):
        reply = {"type": "error", "requestId": self.request_id, "message": message}
        if tail:
            reply["stderrTail"] = tail
        return reply


# --- The host -------------------------------------------------------------------------------


class Host(object):
    def __init__(self, stdin, channel, config_path, folders_path):
        self.stdin = stdin
        self.channel = channel
        self.config_path = config_path
        self.folders_path = folders_path  # saved-folders.json
        self.write_lock = threading.Lock()
        self.broken = False
        self.lock = threading.Lock()  # guards downloads
        self.downloads = {}
        # Canonical folders yt-dlp saved into in this process, oldest first: with the state file,
        # what reveal may show (also when the file cannot be written). One writer of the file at
        # a time in this process.
        self.folders_lock = threading.Lock()
        self.saved_folders = []
        self.handlers = {
            "ping": self.handle_ping,
            "download": self.handle_download,
            "cancel": self.handle_cancel,
            "reveal": self.handle_reveal,
        }

    def send(self, message):
        frame = encode_message(message)
        with self.write_lock:
            if self.broken:
                return
            try:
                write_all(self.channel, frame)
            except (OSError, ValueError) as exc:
                self.broken = True  # Chrome is gone; stdin's end of input follows
                log("cannot write to Chrome: %s" % exc)

    def error(self, message, text):
        reply = {"type": "error", "message": text}
        request_id = _request_id(message)
        if request_id is not None:
            reply["requestId"] = request_id
        self.send(reply)

    def serve(self):
        """Answers messages until Chrome closes stdin, then cancels every download."""
        try:
            while True:
                try:
                    body = read_frame(self.stdin)
                except FrameTooLarge as exc:
                    self.error({}, "Message too large (%d bytes; the limit is %d)" % (exc.args[0], MAX_INCOMING))
                    continue
                except OSError as exc:  # a broken pipe: as good as the end of input
                    log("cannot read from Chrome: %s" % exc)
                    break
                if body is None:
                    break
                self.dispatch(body)
        finally:
            self.shutdown()

    def dispatch(self, body):
        try:
            message = json.loads(body.decode("utf-8"))
        except UnicodeDecodeError:
            return self.error({}, "Message is not UTF-8")
        except (ValueError, RecursionError) as exc:
            return self.error({}, "Message is not valid JSON (%s)" % _clip(str(exc), 200))
        if not isinstance(message, dict):
            return self.error({}, "Message must be a JSON object")
        kind = message.get("type")
        handler = self.handlers.get(kind) if isinstance(kind, str) else None
        if handler is None:
            if isinstance(kind, str):
                return self.error(message, "Unknown message type %s" % _quote(kind))
            return self.error(message, "Message has no type")
        try:
            handler(message)
        except HostError as exc:
            self.error(message, str(exc))
        except Exception as exc:
            log(traceback.format_exc())
            self.error(message, "Internal error: %s" % _clip(str(exc), 300))

    # ping

    def handle_ping(self, message):
        # `yt-dlp --version` takes a while: answer from a thread and keep reading.
        thread = threading.Thread(target=self._pong, args=(_request_id(message),), name="ping")
        thread.daemon = True
        thread.start()

    def _pong(self, request_id):
        problems = []
        version = None
        try:
            config = load_config(self.config_path)
        except HostError as exc:
            config = None
            problems.append(str(exc))
        if config is not None:
            try:
                version = ytdlp_version(config)
            except HostError as exc:
                problems.append(str(exc))
        found = ffmpeg_found(config)
        if not found:
            if config is not None and config.ffmpeg_location:
                problems.append("ffmpeg was not found at %s (ffmpegLocation in %s)" % (config.ffmpeg_location, config.path))
            else:
                problems.append("ffmpeg was not found on PATH; set ffmpegLocation in %s" % self.config_path)
        reply = {
            "type": "pong",
            "hostVersion": HOST_VERSION,
            "ytDlpVersion": version,
            "ffmpegFound": found,
            "problems": problems,
        }
        if request_id is not None:
            reply["requestId"] = request_id
        self.send(reply)

    # download

    def handle_download(self, message):
        request_id = _request_id(message)
        if request_id is None:
            raise HostError("download needs a requestId (a string of 1 to %d characters)" % REQUEST_ID_LIMIT)
        video_id = message.get("videoId")
        if not is_video_id(video_id):
            raise HostError("Not a YouTube video id: %s" % _quote(video_id))
        stem = message.get("stem")
        problem = stem_problem(stem, video_id)
        if problem:
            raise HostError(problem)
        if template_expands(output_template(stem)):
            raise HostError(
                "yt-dlp would replace part of the file name %s with an environment variable's value "
                "($NAME or ${NAME}), so it cannot be saved under that name" % _quote(stem)
            )
        requested_dir = message.get("outputDir")
        if requested_dir is not None and not isinstance(requested_dir, str):
            raise HostError("outputDir must be a string")
        subfolder = message.get("subfolder")
        if subfolder is not None and not isinstance(subfolder, bool):
            raise HostError("subfolder must be true or false")
        with self.lock:
            if request_id in self.downloads:
                raise HostError("A download with requestId %s is already running" % _quote(request_id))

        config = load_config(self.config_path)
        directory = None
        if requested_dir is not None:
            problem = dir_problem(requested_dir)
            if problem is None:
                directory = os.path.normpath(requested_dir)
            else:
                log("outputDir %s; using fallbackOutputDir" % problem)
        if directory is None:
            problem = dir_problem(config.fallback_output_dir)
            if problem:
                raise HostError("The folder %s (fallbackOutputDir in %s) %s" % (config.fallback_output_dir, config.path, problem))
            directory = os.path.normpath(config.fallback_output_dir)
        if subfolder:
            directory = make_subfolder(directory, stem)

        download = Download(self, request_id, build_command(config, video_id, stem, directory), directory, stem)
        with self.lock:
            if request_id in self.downloads:
                raise HostError("A download with requestId %s is already running" % _quote(request_id))
            self.downloads[request_id] = download
        try:
            download.start(config)
        except Exception:
            with self.lock:
                self.downloads.pop(request_id, None)
            raise

    def finish(self, download, code, internal_error=None):
        """Called once by each download's waiter thread: sends its final reply.

        The reply goes out before the download leaves self.downloads, both under self.lock, which
        handle_cancel holds to look a download up. So a cancel that comes while the run ends
        either finds it, and the cancel of a run that is over says nothing (Download.cancel), or
        comes after the reply and gets "No running download" behind it, which the extension
        ignores. The other way round, that refusal could go out first, and the extension takes the
        first reply for a requestId as its end."""
        with download.lock:
            download.finished = True
            cancelled = download.cancelled
        try:
            if internal_error is not None:
                reply = {"type": "error", "requestId": download.request_id, "message": internal_error}
            else:
                reply = download.outcome(code, cancelled)
        except Exception as exc:  # never leave a download without a final reply
            log("download %s: %s" % (download.request_id, traceback.format_exc()))
            reply = {"type": "error", "requestId": download.request_id, "message": "Internal error: %s" % _clip(str(exc), 300)}
        if reply["type"] == "done":
            # Before the reply: the extension closes its port once it has it, which ends this
            # process, and a reveal of the file then reaches a new one.
            self.remember_folder(download.output_dir)
        with self.lock:
            self.send(reply)
            if self.downloads.get(download.request_id) is download:
                del self.downloads[download.request_id]

    def remember_folder(self, directory):
        """Adds `directory` to the folders reveal may show, in this process and in the state file."""
        folder = canonical_path(directory)
        if folder is None:
            return
        with self.folders_lock:
            self.saved_folders = merge_folders(self.saved_folders, [folder])
            try:
                save_saved_folders(self.folders_path, merge_folders(load_saved_folders(self.folders_path), self.saved_folders))
            except Exception as exc:  # reveal still works in this process; nothing else depends on it
                log("could not write %s: %s" % (self.folders_path, _clip(str(exc), 300)))

    def known_folders(self):
        """The folders reveal may show: the state file's and this process's own."""
        with self.folders_lock:
            mine = list(self.saved_folders)
        return merge_folders(load_saved_folders(self.folders_path), mine)

    # cancel

    def handle_cancel(self, message):
        request_id = _request_id(message)
        if request_id is None:
            raise HostError("cancel needs the requestId of a download")
        with self.lock:
            download = self.downloads.get(request_id)
        if download is None:
            raise HostError("No running download has requestId %s" % _quote(request_id))
        download.cancel()

    # reveal

    def handle_reveal(self, message):
        path = message.get("path")
        if not isinstance(path, str) or not path or _has_control(path) or '"' in path:
            raise HostError("reveal needs the path of a file this host saved")
        target = canonical_path(path)
        if target is None or not any(is_within(target, folder) for folder in self.known_folders()):
            raise HostError("Only files in a folder this host has saved to can be shown: %s" % _quote(path))
        if not os.path.exists(path):
            raise HostError("%s does not exist any more" % _quote(path))
        if os.name != "nt":
            raise HostError("Showing a file in its folder works on Windows only")
        proc = subprocess.Popen(
            explorer_command(os.path.normpath(path)),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **_child_options()
        )
        waiter = threading.Thread(target=proc.wait, name="explorer")  # Explorer's exit code means nothing
        waiter.daemon = True
        waiter.start()

    # end of input

    def shutdown(self):
        """Chrome closed the port: no download may outlive it."""
        with self.lock:
            downloads = list(self.downloads.values())
        for download in downloads:
            download.cancel()
        deadline = time.monotonic() + SHUTDOWN_WAIT
        for download in downloads:
            if download.thread is not None:
                download.thread.join(max(0.0, deadline - time.monotonic()))


def make_subfolder(directory, stem):
    """<directory>/<stem>, one level inside an existing folder (PLAN.md section 7.1)."""
    path = os.path.join(directory, stem)
    if path_expands(path):  # in -P a "%" is not doubled: on Windows "%TEMP%" in a title counts here
        raise HostError(
            "yt-dlp would replace part of the folder name %s with an environment variable's value" % _quote(stem)
        )
    try:
        os.mkdir(path)
    except FileExistsError:
        pass
    except OSError as exc:
        raise HostError("Could not create the folder %s: %s" % (path, exc.strerror or exc))
    if not os.path.isdir(path):
        raise HostError("%s exists and is not a folder" % path)
    return path


def main():
    stdin, channel = take_stdio()
    log("started (pid %d, Python %s)" % (os.getpid(), sys.version.split()[0]))
    host = Host(stdin, channel, os.path.join(HERE, CONFIG_NAME), os.path.join(HERE, SAVED_FOLDERS_NAME))
    try:
        host.serve()
    except KeyboardInterrupt:
        pass
    log("stdin closed; exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
