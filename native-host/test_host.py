"""Tests for ytm_grabber_host.py: its sanitiser against the vectors filenames.ts must also pass,
its pure helpers, and the real host driven over stdin/stdout with a fake yt-dlp.

    python3 -m unittest discover -s native-host -p "test_*.py"

The fake yt-dlp picks its behaviour from the video id's first four letters (after any leading
"-"): see FAKE_YTDLP. It prints progress on stdout, where yt-dlp 2026.08.19 prints it.
"""

import io
import json
import ntpath
import os
import posixpath
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import ytm_grabber_host as host

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_SCRIPT = os.path.join(HERE, "ytm_grabber_host.py")
VECTORS = os.path.join(HERE, "..", "test", "fixtures", "sanitize-vectors.json")
TIMEOUT = 10.0
POSIX_ONLY = unittest.skipIf(os.name == "nt", "the fake yt-dlp is a shebang script")

FAKE_YTDLP = r'''
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def out(text):
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def err(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


args = sys.argv[1:]
if args == ["--version"]:
    out("2099.01.01-fake")
    sys.exit(0)

video_id = args[args.index("--") + 1]
mode = video_id.lstrip("-")[:4]
with open(os.path.join(HERE, "argv-%s.json" % video_id), "w", encoding="utf-8") as handle:
    json.dump(args, handle)
folder = args[args.index("-P") + 1]
name = args[args.index("-o") + 1].replace("%(ext)s", "m4a").replace("%%", "%")
path = os.path.join(folder, name)


def pids(*more):
    with open(os.path.join(HERE, "pids-%s.json" % video_id), "w") as handle:
        json.dump([os.getpid()] + list(more), handle)


def finish():
    with open(path, "wb") as handle:
        handle.write(b"fake audio")
    out(path)


if mode == "okay":  # what yt-dlp prints under --print + --progress + --newline
    out("PG_PROGRESS  10.0%")
    out("PG_PROGRESS   N/A%")
    out("PG_PROGRESS  55.5%")
    sys.stdout.buffer.write(b"\xff\xfe not UTF-8\n")
    out("PG_PROGRESS 100.0%")
    out("PG_PROGRESS 100.0%")
    finish()
elif mode == "errp":  # progress on stderr instead
    for text in ("  20.0%", " 100.0%"):
        err("PG_PROGRESS" + text)
    err("WARNING: a warning")
    finish()
elif mode == "fail":
    for number in range(1, 30):
        err("WARNING: line %02d" % number)
    err("ERROR: boom 30")
    sys.exit(2)
elif mode == "slow":
    pids()
    out("PG_PROGRESS   1.0%")
    time.sleep(30)
    finish()
elif mode == "kids":  # a child that also holds our stdout, like ffmpeg under yt-dlp
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    pids(child.pid)
    out("PG_PROGRESS   2.0%")
    time.sleep(30)
elif mode == "wait":  # runs until the test creates release-<id>
    out("PG_PROGRESS   5.0%")
    release = os.path.join(HERE, "release-" + video_id)
    for _ in range(200):
        if os.path.exists(release):
            break
        time.sleep(0.05)
    finish()
elif mode == "nopa":
    out("PG_PROGRESS 100.0%")
elif mode == "gone":
    out(os.path.join(folder, "missing.m4a"))
elif mode == "elsw":  # saves somewhere it was not asked to
    path = os.path.join(os.path.dirname(folder), name)
    finish()
elif mode == "huge":
    out("PG_PROGRESS  50.0% " + "x" * 200000)
    for number in range(30):
        err("ERROR: %02d " % number + "y" * 5000)
    sys.exit(1)
else:
    err("ERROR: unknown fake mode " + mode)
    sys.exit(3)
'''


def frame(message):
    body = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(body)) + body


def raw_frame(body):
    return struct.pack("<I", len(body)) + body


def process_alive(pid):
    """Whether `pid` runs (a zombie waiting for its parent counts as gone)."""
    try:
        with open("/proc/%d/stat" % pid) as handle:
            state = handle.read().rsplit(")", 1)[1].split()[0]
        return state not in ("Z", "X")
    except FileNotFoundError:
        return False
    except OSError:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True


def wait_until(predicate, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


class HostProcess(object):
    """The real host in a temp folder of its own (config.json sits next to the script), with
    a fake yt-dlp and a fake ffmpeg in bin/ and an output folder out/."""

    def __init__(self, test, config=None, overrides=None, raw_config=None, env=None):
        self.test = test
        self.dir = tempfile.mkdtemp(prefix="ytm-host-")
        test.addCleanup(self.cleanup)
        self.host_dir = os.path.join(self.dir, "host")
        self.bin = os.path.join(self.dir, "bin")
        self.out = os.path.join(self.dir, "out")
        for folder in (self.host_dir, self.bin, self.out):
            os.mkdir(folder)
        shutil.copy(HOST_SCRIPT, self.host_dir)
        self.ytdlp = os.path.join(self.bin, "yt-dlp")
        interpreter = sys.executable if " " not in sys.executable else "/usr/bin/env python3"
        self._executable(self.ytdlp, "#!" + interpreter + "\n" + FAKE_YTDLP)
        self._executable(os.path.join(self.bin, "ffmpeg"), "#!/bin/sh\nexit 0\n")
        self.config_path = os.path.join(self.host_dir, "config.json")
        if raw_config is not None:
            with open(self.config_path, "w", encoding="utf-8") as handle:
                handle.write(raw_config)
        elif config is not False:
            settings = config or {
                "ytDlpPath": self.ytdlp,
                "ffmpegLocation": self.bin,
                "extraArgs": ["-x"],
                "fallbackOutputDir": self.out,
            }
            settings.update(overrides or {})
            with open(self.config_path, "w", encoding="utf-8") as handle:
                json.dump(settings, handle)

        self.proc = subprocess.Popen(
            [sys.executable, "-u", os.path.join(self.host_dir, "ytm_grabber_host.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.host_dir,
            env=dict(os.environ, **(env or {})),
        )
        self.messages = queue.Queue()
        self.problems = []  # anything on stdout that is not a well-formed frame
        self.sizes = []
        self.stderr = []
        self.stdout_thread = threading.Thread(target=self._read_frames, daemon=True)
        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.stdout_thread.start()
        self.stderr_thread.start()

    @staticmethod
    def _executable(path, text):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(path, 0o755)

    def _read_frames(self):
        stream = self.proc.stdout
        while True:
            header = stream.read(4)
            if not header:
                break
            if len(header) < 4:
                self.problems.append("stdout ended inside a frame header")
                break
            (size,) = struct.unpack("<I", header)
            if size > 1024 * 1024:
                self.problems.append("frame of %d bytes is over Chrome's 1 MB limit" % size)
            body = stream.read(size)
            if len(body) < size:
                self.problems.append("stdout ended inside a frame body")
                break
            try:
                message = json.loads(body.decode("ascii"))
            except ValueError as exc:
                self.problems.append("frame is not ASCII JSON: %s %r" % (exc, body[:80]))
                continue
            if not isinstance(message, dict) or not isinstance(message.get("type"), str):
                self.problems.append("frame without a type: %r" % body[:80])
                continue
            self.sizes.append(size)
            self.messages.put(message)
        self.messages.put(None)

    def _read_stderr(self):
        for line in iter(self.proc.stderr.readline, b""):
            self.stderr.append(line.decode("utf-8", "replace"))

    def send(self, message):
        self.send_raw(frame(message))

    def send_raw(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def recv(self, timeout=TIMEOUT):
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty:
            self.test.fail("no reply within %s s; host stderr:\n%s" % (timeout, "".join(self.stderr)))
        if message is None:
            self.test.fail("host closed stdout; stderr:\n%s" % "".join(self.stderr))
        return message

    def until(self, predicate, timeout=TIMEOUT):
        """Every message up to and including the first that satisfies `predicate`."""
        seen = []
        deadline = time.monotonic() + timeout
        while True:
            message = self.recv(max(0.01, deadline - time.monotonic()))
            seen.append(message)
            if predicate(message):
                return seen

    def final(self, request_id, timeout=TIMEOUT):
        """(progress messages, final done/error) for one download."""
        seen = self.until(
            lambda m: m.get("requestId") == request_id and m["type"] in ("done", "error"), timeout
        )
        mine = [m for m in seen if m.get("requestId") == request_id]
        return [m for m in mine if m["type"] == "progress"], mine[-1]

    def ping(self):
        self.send({"type": "ping"})
        return self.until(lambda m: m["type"] == "pong")[-1]

    def download(self, video_id, request_id=None, stem=None, **extra):
        message = {
            "type": "download",
            "requestId": request_id or "r-" + video_id,
            "videoId": video_id,
            "stem": stem if stem is not None else "Artist - Title [%s]" % video_id,
        }
        message.update(extra)
        self.send(message)
        return message["requestId"]

    def argv(self, video_id):
        path = os.path.join(self.bin, "argv-%s.json" % video_id)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def pids(self, video_id):
        path = os.path.join(self.bin, "pids-%s.json" % video_id)
        self.test.assertTrue(wait_until(lambda: os.path.exists(path)), "the fake never wrote " + path)
        with open(path) as handle:
            return json.load(handle)

    def close(self):
        """Closes stdin as Chrome does and checks the host exits cleanly with only frames on stdout."""
        self.proc.stdin.close()
        self.test.assertEqual(self.proc.wait(timeout=TIMEOUT), 0, "".join(self.stderr))
        self.stdout_thread.join(TIMEOUT)
        self.test.assertEqual(self.problems, [])

    def cleanup(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        for name in os.listdir(self.bin):
            if name.startswith("pids-"):
                with open(os.path.join(self.bin, name)) as handle:
                    for pid in json.load(handle):
                        try:
                            os.kill(pid, 9)
                        except OSError:
                            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        shutil.rmtree(self.dir, ignore_errors=True)


# --- Pure parts -----------------------------------------------------------------------------


class SanitizeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(VECTORS, encoding="utf-8") as handle:
            cls.vectors = json.load(handle)

    def test_matches_every_vector_of_filenames_ts(self):
        self.assertEqual(self.vectors["maxLength"], host.MAX_STEM_LENGTH)
        self.assertGreater(len(self.vectors["sanitizeFilename"]), 40)
        for vector in self.vectors["sanitizeFilename"]:
            with self.subTest(vector["note"]):
                result = host.sanitize_filename(vector["input"])
                self.assertEqual(result, vector["expected"])
                self.assertEqual(host.sanitize_filename(result), result)
                self.assertLessEqual(host.utf16_length(result), host.MAX_STEM_LENGTH)

    def test_accepts_every_stem_build_stem_makes(self):
        for vector in self.vectors["buildStem"]:
            with self.subTest(vector["note"]):
                self.assertIsNone(host.stem_problem(vector["expected"], vector["videoId"]))

    def test_counts_utf16_code_units(self):
        note = chr(0x1F3B5)
        self.assertEqual(host.utf16_length("a" + note), 3)
        self.assertEqual(host.sanitize_filename(note * 80), note * 75)

    def test_joins_a_surrogate_pair_given_as_two_code_points(self):
        pair = chr(0xD83C) + chr(0xDFB5)
        self.assertEqual(host.sanitize_filename("a" + pair), "a" + chr(0x1F3B5))
        self.assertEqual(host.sanitize_filename("a" + chr(0xDFB5) + chr(0xD83C)), "a" + chr(0xFFFD) * 2)


class ValidationTest(unittest.TestCase):
    def test_video_ids(self):
        for good in ("dQw4w9WgXcQ", "-abcdefghij", "abc_def-123"):
            self.assertTrue(host.is_video_id(good), good)
        bad = ["dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9WgXc\n", "dQw4w9WgX Q", "dQw4w9WgXc!",
               "dQw4w9WgXc" + chr(0x661), None, 12345678901, ["dQw4w9WgXcQ"]]
        for value in bad:
            self.assertFalse(host.is_video_id(value), repr(value))

    def test_stem_rules(self):
        vid = "abcdefghijk"
        self.assertIsNone(host.stem_problem("Artist - Title [abcdefghijk]", vid))
        self.assertIsNone(host.stem_problem("[abcdefghijk]", vid))
        self.assertIsNone(host.stem_problem("100% Pure [abcdefghijk]", vid))
        refused = {
            "AC/DC - Title [abcdefghijk]": "Not a usable file name",
            "Title  [abcdefghijk]": "Not a usable file name",
            "Title [abcdefghijk] ": "Not a usable file name",
            "con.x [abcdefghijk]": "Not a usable file name",
            "Title [abcdefghijX]": "does not end with",
            "Title[abcdefghijk]": "does not end with",
            "Title": "does not end with",
            "": "Not a usable file name",
        }
        for stem, reason in refused.items():
            self.assertIn(reason, host.stem_problem(stem, vid), stem)
        self.assertIn("must be a string", host.stem_problem(None, vid))

    def test_output_template_doubles_percent(self):
        self.assertEqual(host.output_template("100% Pure [abcdefghijk]"), "100%% Pure [abcdefghijk].%(ext)s")
        self.assertEqual(host.output_template("%(title)s [abcdefghijk]"), "%%(title)s [abcdefghijk].%(ext)s")

    def test_names_yt_dlp_would_expand(self):
        # Expectations checked against yt-dlp 2026.08.19's own prepare_filename() for both
        # platforms' expandvars (thousands of random names, no disagreement).
        tmpl = host.output_template
        with mock.patch.dict(os.environ, {"YTM_TEST_VAR": "/elsewhere"}):
            os.environ.pop("ha", None)
            for expandvars, rules in ((posixpath.expandvars, "posix"), (ntpath.expandvars, "windows")):
                with mock.patch.object(os.path, "expandvars", expandvars):
                    for stem in ("Walk $YTM_TEST_VAR [id]", "a ${YTM_TEST_VAR} [id]", "$$YTM_TEST_VAR [id]",
                                 "a 'b' $YTM_TEST_VAR [id]"):
                        self.assertTrue(host.template_expands(tmpl(stem)), (rules, stem))
                    for stem in ("Ke$ha - A$AP $ [id]", "100% %YTM_TEST_VAR% [id]", "$$ [id]", "Plain [id]"):
                        self.assertFalse(host.template_expands(tmpl(stem)), (rules, stem))
                    self.assertTrue(host.path_expands("/out/$YTM_TEST_VAR"), rules)
                    self.assertFalse(host.path_expands("/out/100% Ke$ha"), rules)
            with mock.patch.object(os.path, "expandvars", ntpath.expandvars):
                # Windows: a single quote stops expansion up to the next one (or the end);
                # in a folder "%NAME%" and "$$" count too.
                self.assertFalse(host.template_expands(tmpl("Guns N' Roses $YTM_TEST_VAR [id]")))
                self.assertTrue(host.path_expands("C:\\%YTM_TEST_VAR%\\x"))
                self.assertTrue(host.path_expands("C:\\a$$b"))
            with mock.patch.object(os.path, "expandvars", posixpath.expandvars):
                self.assertTrue(host.template_expands(tmpl("Guns N' Roses $YTM_TEST_VAR [id]")))
                self.assertFalse(host.path_expands("/out/%YTM_TEST_VAR%"))

    def test_progress_lines(self):
        cases = {
            "PG_PROGRESS  42.3%": (42.3, "42.3%"),
            "PG_PROGRESS 100.0%": (100.0, "100.0%"),
            "PG_PROGRESS   N/A%": (None, "N/A%"),
            "PG_PROGRESS NA": (None, "NA"),
            "PG_PROGRESS": (None, ""),
            "PG_PROGRESS 101.5%": (100.0, "101.5%"),
            "\x1b[0;94m PG_PROGRESS  7.0%\x1b[0m": (7.0, "7.0%"),
        }
        for line, expected in cases.items():
            self.assertEqual(host.parse_progress(line), expected, repr(line))
        for line in ("C:\\Music\\a.m4a", "PG_PROGRESSX 5%", "[download]  5.0%", ""):
            self.assertIsNone(host.parse_progress(line), repr(line))
        self.assertEqual(len(host.parse_progress("PG_PROGRESS 5% " + "x" * 9000)[1]), host.LINE_LIMIT)

    def test_explorer_command_quotes_only_the_path(self):
        with mock.patch.dict(os.environ, {"SystemRoot": "C:\\WINDOWS"}):
            path = "C:\\Users\\J\xf6rmki\\Music\\A, B [abcdefghijk].m4a"
            self.assertEqual(
                host.explorer_command(path),
                '"C:\\WINDOWS\\explorer.exe" /select,"C:\\Users\\J\xf6rmki\\Music\\A, B [abcdefghijk].m4a"',
            )
            self.assertEqual(host.taskkill_command(42), ["C:\\WINDOWS\\System32\\taskkill.exe", "/T", "/F", "/PID", "42"])

    def test_is_within_compares_path_components(self):
        self.assertTrue(host.is_within("/music/a.m4a", "/music"))
        self.assertTrue(host.is_within("/music/sub/a.m4a", "/music"))
        self.assertTrue(host.is_within("/music", "/music"))
        self.assertFalse(host.is_within("/music2/a.m4a", "/music"))
        self.assertFalse(host.is_within("/mus", "/music"))
        self.assertFalse(host.is_within("relative", "/music"))

    def test_frames_are_ascii_and_bounded(self):
        message = {"type": "done", "requestId": "r", "path": "C:\\J\xf6rmki\\" + chr(0xD800) + chr(0x1F3B5)}
        data = host.encode_message(message)
        self.assertEqual(struct.unpack("<I", data[:4])[0], len(data) - 4)
        self.assertEqual(json.loads(data[4:].decode("ascii")), message)
        huge = host.encode_message({"type": "done", "requestId": "r", "path": "\xe9" * 400000})
        self.assertLess(len(huge), 1000)
        self.assertEqual(json.loads(huge[4:].decode("ascii"))["type"], "error")
        self.assertEqual(json.loads(huge[4:].decode("ascii"))["requestId"], "r")

    def test_read_frame_survives_short_reads(self):
        class Trickle(io.RawIOBase):
            def __init__(self, data):
                self.data = data

            def read(self, size=-1):
                count = min(size, 3)  # a pipe may return less than asked, never more
                chunk, self.data = self.data[:count], self.data[count:]
                return chunk

        stream = Trickle(frame({"type": "ping", "pad": "x" * 70000}) + frame({"type": "ping"}) + b"\x05\x00")
        self.assertEqual(json.loads(host.read_frame(stream))["pad"], "x" * 70000)
        self.assertEqual(json.loads(host.read_frame(stream)), {"type": "ping"})
        self.assertIsNone(host.read_frame(stream))  # input ends inside a header


class StdoutGuardTest(unittest.TestCase):
    def test_only_frames_reach_stdout(self):
        code = "\n".join([
            "import os, subprocess, sys",
            "sys.path.insert(0, %r)" % HERE,
            "import ytm_grabber_host as h",
            "stdin, channel = h.take_stdio()",
            "print('stray print')",
            "os.write(1, b'stray fd 1\\n')",
            "subprocess.run([sys.executable, '-c', 'print(\"inherited stdout\")'])",
            "h.write_all(channel, h.encode_message({'type': 'pong'}))",
        ])
        result = subprocess.run([sys.executable, "-c", code], stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, host.encode_message({"type": "pong"}))
        for text in (b"stray print", b"stray fd 1", b"inherited stdout"):
            self.assertIn(text, result.stderr)


# --- The host over stdin/stdout -------------------------------------------------------------


@POSIX_ONLY
class ProtocolTest(unittest.TestCase):
    def test_ping(self):
        h = HostProcess(self)
        pong = h.ping()
        self.assertEqual(pong, {
            "type": "pong", "hostVersion": host.HOST_VERSION, "ytDlpVersion": "2099.01.01-fake",
            "ffmpegFound": True, "problems": [],
        })
        h.send({"type": "ping", "requestId": "p1"})
        self.assertEqual(h.until(lambda m: m["type"] == "pong")[-1]["requestId"], "p1")
        h.close()

    def test_ping_names_a_missing_yt_dlp_and_ffmpeg(self):
        h = HostProcess(self, overrides={"ytDlpPath": "/nowhere/yt-dlp", "ffmpegLocation": "/nowhere/ffmpeg"})
        pong = h.ping()
        self.assertIsNone(pong["ytDlpVersion"])
        self.assertFalse(pong["ffmpegFound"])
        self.assertIn("yt-dlp was not found at /nowhere/yt-dlp (ytDlpPath in %s)" % h.config_path, pong["problems"])
        self.assertIn("ffmpeg was not found at /nowhere/ffmpeg", pong["problems"][1])
        h.close()

    def test_ping_without_config(self):
        h = HostProcess(self, config=False)
        pong = h.ping()
        self.assertEqual(pong["hostVersion"], host.HOST_VERSION)
        self.assertIsNone(pong["ytDlpVersion"])
        self.assertIn(h.config_path + " is missing: run install.ps1", pong["problems"][0])
        h.close()

    def test_large_message_and_several_in_one_write(self):
        h = HostProcess(self)
        big = {"type": "ping", "requestId": "big", "pad": "\xe9" * 70000}  # > 64 KB as UTF-8 and as JSON
        self.assertGreater(len(frame(big)), 128 * 1024)
        h.send_raw(frame(big) + frame({"type": "ping", "requestId": "p2"}) + frame({"type": "ping", "requestId": "p3"}))
        pongs = [h.recv() for _ in range(3)]
        self.assertEqual(sorted(m["requestId"] for m in pongs), ["big", "p2", "p3"])
        self.assertTrue(all(m["type"] == "pong" for m in pongs))
        h.close()

    def test_message_split_across_writes(self):
        h = HostProcess(self)
        data = frame({"type": "ping", "requestId": "split"})
        for part in (data[:2], data[2:9], data[9:]):
            h.send_raw(part)
            time.sleep(0.05)
        self.assertEqual(h.recv()["requestId"], "split")
        h.close()

    def test_too_large_message_is_skipped(self):
        h = HostProcess(self)
        h.send_raw(frame({"type": "ping", "requestId": "huge", "pad": "x" * (1536 * 1024)}))
        reply = h.recv()
        self.assertEqual(reply["type"], "error")
        self.assertIn("Message too large", reply["message"])
        self.assertEqual(h.ping()["type"], "pong")  # still in step
        h.close()

    def test_malformed_messages(self):
        h = HostProcess(self)
        cases = [
            (b"not json", "not valid JSON"),
            (b"", "not valid JSON"),
            (b"\xff\xfe{}", "not UTF-8"),
            (b"[" * 100000, "not valid JSON"),
            (b"[1, 2]", "must be a JSON object"),
            (b"{}", "has no type"),
            (b'{"type": 5}', "has no type"),
            (b'{"type": "explode", "requestId": "x1"}', 'Unknown message type "explode"'),
            (b'{"type": "cancel"}', "cancel needs the requestId"),
            (b'{"type": "reveal", "path": 5}', "reveal needs the path"),
        ]
        h.send_raw(b"".join(raw_frame(body) for body, _ in cases))
        for body, expected in cases:
            reply = h.recv()
            self.assertEqual(reply["type"], "error", body[:40])
            self.assertIn(expected, reply["message"], body[:40])
        self.assertEqual(h.ping()["type"], "pong")
        h.close()


@POSIX_ONLY
class DownloadTest(unittest.TestCase):
    def test_command_line_progress_and_final_path(self):
        h = HostProcess(self)
        vid = "okayAAAAAAA"
        stem = "M\xf6tley 100% Pure [" + vid + "]"
        h.download(vid, stem=stem)
        progress, final = h.final("r-" + vid)
        self.assertEqual(h.argv(vid), [
            "-x",
            "--ffmpeg-location", h.bin,
            "--no-playlist",
            "--encoding", "utf-8",
            "--newline", "--progress",
            "--progress-template", "download:PG_PROGRESS %(progress._percent_str)s",
            "--print", "after_move:filepath",
            "-P", h.out,
            "-o", "M\xf6tley 100%% Pure [okayAAAAAAA].%(ext)s",
            "--", vid,
        ])
        self.assertEqual([(m["percent"], m["line"]) for m in progress],
                         [(10.0, "10.0%"), (None, "N/A%"), (55.5, "55.5%"), (100.0, "100.0%")])
        expected = os.path.join(h.out, "M\xf6tley 100% Pure [okayAAAAAAA].m4a")
        self.assertEqual(final, {"type": "done", "requestId": "r-" + vid, "path": expected})
        self.assertTrue(os.path.isfile(expected))
        h.close()

    def test_id_starting_with_a_dash_follows_the_double_dash(self):
        h = HostProcess(self, overrides={"ffmpegLocation": ""})
        vid = "-okayAAAAAA"
        h.download(vid)
        self.assertEqual(h.final("r-" + vid)[1]["type"], "done")
        argv = h.argv(vid)
        self.assertEqual(argv[-2:], ["--", vid])
        self.assertEqual(argv[:2], ["-x", "--no-playlist"])  # no --ffmpeg-location when it is empty
        h.close()

    def test_config_is_read_for_every_request(self):
        h = HostProcess(self)
        settings = {"ytDlpPath": h.ytdlp, "ffmpegLocation": None, "fallbackOutputDir": h.out}
        with open(h.config_path, "w") as handle:
            json.dump(settings, handle)  # no extraArgs: the default ["-x"]
        h.download("okayAAAAAAB")
        self.assertEqual(h.final("r-okayAAAAAAB")[1]["type"], "done")
        self.assertEqual(h.argv("okayAAAAAAB")[:2], ["-x", "--no-playlist"])
        with open(h.config_path, "w") as handle:
            json.dump(dict(settings, extraArgs=["--audio-format", "mp3", "-x"]), handle)
        h.download("okayAAAAAAC")
        h.final("r-okayAAAAAAC")
        self.assertEqual(h.argv("okayAAAAAAC")[:4], ["--audio-format", "mp3", "-x", "--no-playlist"])
        h.close()

    def test_progress_on_stderr(self):
        h = HostProcess(self)
        progress, final = h.final(h.download("errpAAAAAAA"))
        self.assertEqual([m["percent"] for m in progress], [20.0, 100.0])
        self.assertEqual(final["type"], "done")
        h.close()

    def test_output_dir_and_fallback(self):
        h = HostProcess(self)
        other = os.path.join(h.dir, "other")
        os.mkdir(other)
        a_file = os.path.join(h.dir, "a-file")
        open(a_file, "w").close()
        cases = [
            ("okayAAAAAA1", other + os.sep, other),
            ("okayAAAAAA2", "relative/dir", h.out),
            ("okayAAAAAA3", os.path.join(h.dir, "missing"), h.out),
            ("okayAAAAAA4", other + "\n", h.out),
            ("okayAAAAAA5", a_file, h.out),
            ("okayAAAAAA6", None, h.out),
        ]
        for vid, requested, used in cases:
            extra = {} if requested is None else {"outputDir": requested}
            final = h.final(h.download(vid, **extra))[1]
            self.assertEqual(final["type"], "done", requested)
            argv = h.argv(vid)
            self.assertEqual(argv[argv.index("-P") + 1], used, requested)
        h.close()

    def test_missing_fallback_folder(self):
        h = HostProcess(self, overrides={"fallbackOutputDir": "/nowhere/Downloads"})
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertEqual(final["type"], "error")
        self.assertIn("/nowhere/Downloads (fallbackOutputDir in %s) does not exist" % h.config_path, final["message"])
        self.assertIsNone(h.argv("okayAAAAAAA"))
        h.close()

    def test_subfolder(self):
        h = HostProcess(self)
        stem = "Artist - Title [okayAAAAAAA]"
        folder = os.path.join(h.out, stem)
        final = h.final(h.download("okayAAAAAAA", subfolder=True))[1]
        self.assertEqual(final["path"], os.path.join(folder, stem + ".m4a"))
        argv = h.argv("okayAAAAAAA")
        self.assertEqual(argv[argv.index("-P") + 1], folder)
        # The folder exists now: used again. A file in its place: refused.
        self.assertEqual(h.final(h.download("okayAAAAAAA", request_id="again", subfolder=True))[1]["type"], "done")
        open(os.path.join(h.out, "Artist - Title [okayBBBBBBB]"), "w").close()
        final = h.final(h.download("okayBBBBBBB", subfolder=True))[1]
        self.assertEqual(final["type"], "error")
        self.assertIn("exists and is not a folder", final["message"])
        self.assertIsNone(h.argv("okayBBBBBBB"))
        self.assertEqual(h.final(h.download("okayCCCCCCC", subfolder=False))[1]["path"],
                         os.path.join(h.out, "Artist - Title [okayCCCCCCC].m4a"))
        h.close()

    def test_every_validation_rule(self):
        h = HostProcess(self)
        vid = "okayAAAAAAA"
        good = {"type": "download", "requestId": "v", "videoId": vid, "stem": "A - T [%s]" % vid}
        cases = [
            ({"requestId": None}, "needs a requestId", False),
            ({"requestId": ""}, "needs a requestId", False),
            ({"requestId": "r" * 201}, "needs a requestId", False),
            ({"requestId": 7}, "needs a requestId", False),
            ({"videoId": "okayAAAAAA"}, "Not a YouTube video id", True),
            ({"videoId": "okayAAAAAA\n"}, "Not a YouTube video id", True),
            ({"videoId": "okayAAAAAAAA"}, "Not a YouTube video id", True),
            ({"videoId": "okayAAAAA;x"}, "Not a YouTube video id", True),
            ({"videoId": 5}, "Not a YouTube video id", True),
            ({"stem": "AC/DC - T [%s]" % vid}, "Not a usable file name", True),
            ({"stem": "A - T [%s] " % vid}, "Not a usable file name", True),
            ({"stem": "A - T [okayBBBBBBB]"}, "does not end with this song's video id [%s]" % vid, True),
            ({"stem": "A - T"}, "does not end with", True),
            ({"stem": 5}, "must be a string", True),
            ({"outputDir": 5}, "outputDir must be a string", True),
            ({"subfolder": "yes"}, "subfolder must be true or false", True),
            ({"subfolder": 1}, "subfolder must be true or false", True),
        ]
        for change, expected, echoed in cases:
            with self.subTest(change):
                message = dict(good, **change)
                h.send(message)
                reply = h.recv()
                self.assertEqual(reply["type"], "error")
                self.assertIn(expected, reply["message"])
                self.assertEqual(reply.get("requestId"), "v" if echoed else None)
        self.assertEqual(sorted(os.listdir(h.bin)), ["ffmpeg", "yt-dlp"])  # yt-dlp never ran
        h.close()

    def test_failure_reports_the_stderr_tail(self):
        h = HostProcess(self)
        final = h.final(h.download("failAAAAAAA"))[1]
        self.assertEqual(final["type"], "error")
        self.assertEqual(final["message"], "yt-dlp failed (exit code 2): ERROR: boom 30")
        lines = final["stderrTail"].split("\n")
        self.assertEqual(len(lines), 20)
        self.assertEqual(lines[0], "WARNING: line 11")
        self.assertEqual(lines[-1], "ERROR: boom 30")
        h.close()

    def test_no_path_or_a_missing_file(self):
        h = HostProcess(self)
        self.assertEqual(h.final(h.download("nopaAAAAAAA"))[1]["message"], "yt-dlp finished but did not print the file's path")
        self.assertIn("yt-dlp reported a file that does not exist", h.final(h.download("goneAAAAAAA"))[1]["message"])
        h.close()

    def test_unexpected_final_path(self):
        h = HostProcess(self)
        final = h.final(h.download("elswAAAAAAA", subfolder=True))[1]
        self.assertEqual(final["type"], "error")
        self.assertIn("yt-dlp saved %s instead of %s" % (
            os.path.join(h.out, "Artist - Title [elswAAAAAAA].m4a"),
            os.path.join(h.out, "Artist - Title [elswAAAAAAA]", "Artist - Title [elswAAAAAAA].<ext>"),
        ), final["message"])
        h.close()

    def test_names_yt_dlp_would_expand_are_not_used(self):
        h = HostProcess(self, env={"YTM_TEST_VAR": "/elsewhere"})
        final = h.final(h.download("okayAAAAAAA", stem="Walk $YTM_TEST_VAR [okayAAAAAAA]"))[1]
        self.assertIn("yt-dlp would replace part of the file name", final["message"])
        self.assertIsNone(h.argv("okayAAAAAAA"))
        final = h.final(h.download("okayAAAAAAB", stem="100%YTM_TEST_VAR% [okayAAAAAAB]", subfolder=True))[1]
        self.assertEqual(final["type"], "done")  # POSIX expandvars leaves %NAME% alone
        expanding = os.path.join(h.out, "$YTM_TEST_VAR")
        os.mkdir(expanding)
        final = h.final(h.download("okayAAAAAAC", stem="Ke$ha - Song [okayAAAAAAC]", outputDir=expanding))[1]
        self.assertEqual(final["path"], os.path.join(h.out, "Ke$ha - Song [okayAAAAAAC].m4a"))  # the fallback
        h.close()

    def test_huge_output_stays_under_chromes_limit(self):
        h = HostProcess(self)
        progress, final = h.final(h.download("hugeAAAAAAA"))
        self.assertEqual(progress[0]["percent"], 50.0)
        self.assertEqual(len(progress[0]["line"]), host.LINE_LIMIT)
        self.assertEqual(len(final["stderrTail"].split("\n")), 20)
        self.assertLessEqual(len(final["stderrTail"]), 20 * 1001)
        self.assertLess(max(h.sizes), 64 * 1024)
        h.close()

    def test_yt_dlp_missing_or_not_runnable(self):
        h = HostProcess(self, overrides={"ytDlpPath": "/nowhere/yt-dlp.exe"})
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertEqual(final["message"], "yt-dlp was not found at /nowhere/yt-dlp.exe (ytDlpPath in %s)" % h.config_path)
        h.close()
        h = HostProcess(self)
        os.chmod(h.ytdlp, 0o644)
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertIn("yt-dlp at %s could not be started" % h.ytdlp, final["message"])
        self.assertIn("check ytDlpPath in " + h.config_path, final["message"])
        h.close()

    def test_batch_file_is_refused(self):
        h = HostProcess(self)
        script = os.path.join(h.bin, "yt-dlp.CMD")
        shutil.copy(h.ytdlp, script)
        with open(h.config_path, "w") as handle:
            json.dump({"ytDlpPath": script, "fallbackOutputDir": h.out}, handle)
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertIn("points to a batch file", final["message"])
        self.assertIsNone(h.argv("okayAAAAAAA"))
        h.close()

    def test_bad_or_missing_config(self):
        h = HostProcess(self, raw_config='{"ytDlpPath": "C:\\Tools\\yt-dlp.exe"}')
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertIn(h.config_path + " is not valid JSON", final["message"])
        self.assertIn("every backslash in a path is written twice", final["message"])
        self.assertIn("is not valid JSON", h.ping()["problems"][0])
        h.close()
        for raw, expected in (("[]", "must hold one JSON object"), ('{"ytDlpPath": 5}', "Set ytDlpPath in"),
                              ('{"ytDlpPath": "x", "extraArgs": "-x"}', "extraArgs in")):
            h = HostProcess(self, raw_config=raw)
            self.assertIn(expected, h.final(h.download("okayAAAAAAA"))[1]["message"])
            h.close()
        h = HostProcess(self, config=False)
        final = h.final(h.download("okayAAAAAAA"))[1]
        self.assertIn("config.json is missing: run install.ps1, or copy config.example.json", final["message"])
        h.close()

    def test_config_with_a_byte_order_mark(self):
        h = HostProcess(self)
        with open(h.config_path, "w", encoding="utf-8-sig") as handle:
            json.dump({"ytDlpPath": h.ytdlp, "fallbackOutputDir": h.out}, handle)
        self.assertEqual(h.final(h.download("okayAAAAAAA"))[1]["type"], "done")
        h.close()


@POSIX_ONLY
class CancelAndConcurrencyTest(unittest.TestCase):
    def test_cancel_ends_the_process(self):
        h = HostProcess(self)
        request = h.download("slowAAAAAAA")
        h.until(lambda m: m["type"] == "progress")
        (pid,) = h.pids("slowAAAAAAA")
        self.assertTrue(process_alive(pid))
        started = time.monotonic()
        h.send({"type": "cancel", "requestId": request})
        final = h.final(request)[1]
        self.assertEqual(final, {"type": "error", "requestId": request, "message": "Cancelled", "cancelled": True})
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(wait_until(lambda: not process_alive(pid), 2))
        h.send({"type": "cancel", "requestId": request})  # it is over now
        reply = h.recv()
        self.assertEqual((reply["type"], reply["requestId"]), ("error", request))
        self.assertIn("No running download", reply["message"])
        h.close()

    def test_cancel_ends_the_children_too(self):
        h = HostProcess(self)
        request = h.download("kidsAAAAAAA")
        h.until(lambda m: m["type"] == "progress")
        pids = h.pids("kidsAAAAAAA")
        self.assertEqual(len(pids), 2)
        h.send({"type": "cancel", "requestId": request})
        self.assertEqual(h.final(request)[1]["message"], "Cancelled")
        for pid in pids:
            self.assertTrue(wait_until(lambda: not process_alive(pid), 2), pid)
        h.close()

    def test_two_downloads_run_at_once(self):
        h = HostProcess(self)
        first = h.download("waitAAAAAAA")
        second = h.download("waitBBBBBBB")
        seen = h.until(lambda m: m["type"] == "progress" and m["requestId"] == second)
        if not any(m["type"] == "progress" and m["requestId"] == first for m in seen):
            seen += h.until(lambda m: m["type"] == "progress" and m["requestId"] == first)
        open(os.path.join(h.bin, "release-waitBBBBBBB"), "w").close()
        done_second = h.final(second)[1]
        self.assertEqual(done_second["type"], "done")
        open(os.path.join(h.bin, "release-waitAAAAAAA"), "w").close()
        self.assertEqual(h.final(first)[1]["type"], "done")
        h.close()

    def test_duplicate_request_id(self):
        h = HostProcess(self)
        h.download("slowAAAAAAA", request_id="same")
        h.until(lambda m: m["type"] == "progress")
        h.download("okayAAAAAAA", request_id="same")
        reply = h.recv()
        self.assertEqual((reply["type"], reply["requestId"]), ("error", "same"))
        self.assertIn('requestId "same" is already running', reply["message"])
        self.assertIsNone(h.argv("okayAAAAAAA"))
        h.send({"type": "cancel", "requestId": "same"})
        self.assertEqual(h.final("same")[1]["message"], "Cancelled")
        h.close()

    def test_closing_stdin_stops_every_download(self):
        h = HostProcess(self)
        slow = h.download("slowAAAAAAA")
        kids = h.download("kidsAAAAAAA")
        h.until(lambda m: m["type"] == "progress" and m["requestId"] == slow)
        pids = h.pids("slowAAAAAAA") + h.pids("kidsAAAAAAA")
        started = time.monotonic()
        h.close()  # exits with 0, only frames on stdout
        self.assertLess(time.monotonic() - started, 5)
        for pid in pids:
            self.assertTrue(wait_until(lambda: not process_alive(pid), 2), pid)
        finals = []
        while True:
            message = h.messages.get(timeout=TIMEOUT)
            if message is None:
                break
            if message["type"] == "error":
                finals.append((message["requestId"], message["message"]))
        self.assertEqual(sorted(finals), sorted([(slow, "Cancelled"), (kids, "Cancelled")]))


@POSIX_ONLY
class RevealTest(unittest.TestCase):
    def test_only_inside_folders_this_host_saved_to(self):
        h = HostProcess(self)
        script = os.path.join(h.host_dir, "ytm_grabber_host.py")

        def reveal(path):
            h.send({"type": "reveal", "path": path, "requestId": "rv"})
            reply = h.recv()
            self.assertEqual((reply["type"], reply["requestId"]), ("error", "rv"))
            return reply["message"]

        self.assertIn("Only files in a folder this host has saved to", reveal(script))
        path = h.final(h.download("okayAAAAAAA"))[1]["path"]
        self.assertIn("works on Windows only", reveal(path))  # inside: passes every other check
        self.assertIn("works on Windows only", reveal(h.out))
        sibling = h.out + "2"  # a string prefix of a folder we saved to, but not inside it
        os.mkdir(sibling)
        open(os.path.join(sibling, "x.m4a"), "w").close()
        os.symlink(h.host_dir, os.path.join(h.out, "link"))
        refused = [
            os.path.join(sibling, "x.m4a"),
            script,
            os.path.join(h.out, "..", "host", "ytm_grabber_host.py"),
            os.path.join(h.out, "link", "ytm_grabber_host.py"),
            "out/x.m4a",
            h.dir,
        ]
        for other in refused:
            self.assertIn("Only files in a folder this host has saved to", reveal(other), other)
        self.assertIn("does not exist any more", reveal(os.path.join(h.out, "gone.m4a")))
        for bad in ("", 'C:\\a"b', "a\nb"):
            self.assertIn("reveal needs the path", reveal(bad))
        h.close()


if __name__ == "__main__":
    unittest.main()
