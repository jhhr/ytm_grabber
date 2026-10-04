"""A fake yt-dlp for the host's tests (native-host/test_host.py) and the end-to-end test
(test-e2e/nativeHost.ts). Never a real download: the tests copy this file into a folder of
their own, put "#!<python>" in front of it and make it executable.

It answers --version with "2099.01.01-fake". Otherwise it picks its behaviour from the video id's
first four letters (after any leading "-") and writes argv-<id>.json (its arguments) next to
itself; modes that run a while also write pids-<id>.json (its pid and any child's). Progress goes
to stdout, where yt-dlp 2026.08.19 prints it. The "file" it saves is <-P>/<-o with ext m4a>.

  okay  progress, a line that is not UTF-8, the final path
  errp  progress on stderr instead
  fail  29 warnings and an ERROR on stderr, exit code 2
  slow  writes <file>.part (as yt-dlp does while downloading), 1 %, then sleeps 30 s
  kids  starts a child that holds stdout too (as ffmpeg under yt-dlp), then sleeps
  wait  5 %, then waits up to 10 s for release-<id> next to itself, then saves
  nopa  progress only, no path
  gone  prints a path that does not exist
  elsw  saves into the parent of the folder it was given
  huge  a 200,000-character progress line and 30 long ERROR lines, exit code 1
"""

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
    with open(path + ".part", "wb") as handle:
        handle.write(b"fake au")
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
