"""Archives (phase 07.17.1.1.1, D-05, PD-09; RESEARCH "Security Domain", "Don't Hand-Roll").

Single-file mode only lists. `--batch` lists first and refuses the archive (exit 6 when it is the top-level argument)
when the listing breaks a cap: a total over ARCHIVE_MAX_TOTAL_BYTES or the room left in /workspace (its free space,
and the room under the bot's soft quota that sandboxd exports), more than ARCHIVE_MAX_ENTRIES entries, an entry over
10 MiB packed more than ARCHIVE_MAX_RATIO to 1, an absolute or `..` path, a link or a special file. A listing can lie,
so the extraction runs with RLIMIT_FSIZE and under a size watcher that sums the bytes really written every 0.25 s
against min(cap, room − 64 MiB): above it the child's process tree is killed, the destination removed and the archive
refused (`caps: extracted size`). Every extracted path is re-checked to stay under the destination. Symbolic links
are never stored on extraction.

zip and 7z go through 7-Zip (`7zz`); tar and tar.gz through the stdlib `tarfile` in a child interpreter (7-Zip lists
a .tar.gz as the single .tar inside it), which writes regular files and folders only.
"""

import contextlib
import json
import os
import re
import shutil
import signal
import stat
import sys
import tarfile
import tempfile
import time

from . import bounds, runner

SEVEN_ZIP = ("zip", "7z")
TAR = ("tar", "tgz")
_MODE = re.compile(r"([-dlcbps0])[-rwxsStT]{9}$")


class Entry:
    def __init__(self, path, size=0, packed=None, is_dir=False, link=False, special=False):
        self.path = path
        self.size = size
        self.packed = packed
        self.is_dir = is_dir
        self.link = link
        self.special = special


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_7z_listing(text):
    """Entries from `7zz l -slt` (the blocks after the `----------` line)."""
    _, sep, rest = text.partition("\n----------\n")
    if not sep:
        return []
    entries = []
    for chunk in re.split(r"\n\s*\n", rest):
        fields = {}
        for line in chunk.splitlines():
            key, eq, value = line.partition(" = ")
            if eq:
                fields[key.strip()] = value.strip()
            elif line.endswith(" ="):
                fields[line[:-2].strip()] = ""
        if "Path" not in fields:
            continue
        attrs = fields.get("Attributes", "")
        token = attrs.split()[-1] if attrs.split() else ""
        m = _MODE.search(token)
        kind = m.group(1) if m else ""
        is_dir = fields.get("Folder") == "+" or kind == "d" or attrs.startswith("D")
        link = kind == "l" or bool(fields.get("Symbolic Link")) or bool(fields.get("Hard Link"))
        entries.append(
            Entry(
                fields["Path"],
                _int(fields.get("Size")) or 0,
                _int(fields.get("Packed Size")),
                is_dir=is_dir,
                link=link,
                special=kind in ("c", "b", "p", "s"),
            )
        )
    return entries


def tar_list_child(args):
    """Child entry: `tar_list_child <path>`: one JSON object per member."""
    try:
        with tarfile.open(args[0], "r:*") as tf:
            for m in tf:
                row = {
                    "path": m.name,
                    "size": m.size if m.isfile() else 0,
                    "dir": m.isdir(),
                    "link": m.issym() or m.islnk(),
                    "special": not (m.isfile() or m.isdir() or m.issym() or m.islnk()),
                }
                sys.stdout.write(json.dumps(row) + "\n")
    except (tarfile.TarError, OSError, EOFError) as exc:
        sys.stderr.write(f"not a readable tar archive: {exc}\n")
        return bounds.EXIT_FAILED
    return 0


def _encrypted(res):
    blob = (res.stdout + res.stderr).decode("utf-8", "replace")
    return "Enter password" in blob or "Wrong password" in blob or "encrypted" in blob.lower()


def list_archive(path, type_name, steps):
    """The entries of an archive (7zz for zip/7z, tarfile for tar/tgz)."""
    name = os.path.basename(path)
    if type_name in TAR:
        res = steps("7zz_list", runner.python_argv("ocw_extract.archives", "tar_list_child", path))
        if res.returncode != 0:
            raise bounds.ConversionError(f"could not list {name}: {res.err_line()}")
        rows = [json.loads(line) for line in res.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        return [Entry(r["path"], r["size"], None, r["dir"], r["link"], r["special"]) for r in rows]
    res = steps("7zz_list", ["7zz", "l", "-slt", "-bd", path])
    if res.returncode != 0:
        if _encrypted(res):
            raise bounds.EncryptedError(f"{name} is encrypted and needs a password; ocw-extract cannot open it")
        raise bounds.ConversionError(f"7-Zip could not list {name}: {res.err_line() or 'damaged archive'}")
    return parse_7z_listing(res.stdout.decode("utf-8", "replace"))


def bad_path(path):
    parts = re.split(r"[\\/]+", path)
    return path.startswith(("/", "\\")) or bool(re.match(r"^[A-Za-z]:", path)) or ".." in parts or "\x00" in path


def check_caps(entries, free, archive_size=None):
    """The first PD-09 violation as `caps: …`, or None."""
    for e in entries:
        if bad_path(e.path):
            return f"caps: path {e.path!r} leaves the archive's folder"
        if e.link:
            return f"caps: link entry {e.path!r} (links are never extracted)"
        if e.special:
            return f"caps: special file {e.path!r}"
    if len(entries) > bounds.ARCHIVE_MAX_ENTRIES:
        return f"caps: entries {len(entries)} over {bounds.ARCHIVE_MAX_ENTRIES}"
    for e in entries:
        if e.size > bounds.ARCHIVE_RATIO_MIN_ENTRY_BYTES and e.packed:
            ratio = e.size / e.packed
            if ratio > bounds.ARCHIVE_MAX_RATIO:
                return f"caps: ratio {e.path!r} {e.size} bytes packed {int(ratio)} to 1 (at most {bounds.ARCHIVE_MAX_RATIO})"
    total = sum(e.size for e in entries)
    limit = min(bounds.ARCHIVE_MAX_TOTAL_BYTES, free)
    if total > limit:
        return f"caps: total size {total} bytes over {limit}"
    if archive_size and total > bounds.ARCHIVE_RATIO_MIN_ENTRY_BYTES and total / archive_size > bounds.ARCHIVE_MAX_RATIO:
        return f"caps: ratio {total} bytes packed {int(total / archive_size)} to 1 (at most {bounds.ARCHIVE_MAX_RATIO})"
    return None


def tar_extract_child(args):
    """Child entry: `tar_extract_child <path> <dest> <max_bytes>`: regular files and folders only."""
    src, dest, max_bytes = args[0], args[1], int(args[2])
    written = 0
    try:
        with tarfile.open(src, "r:*") as tf:
            for m in tf:
                if bad_path(m.name):
                    sys.stderr.write(f"caps: path {m.name!r}\n")
                    return bounds.EXIT_CAPS
                target = os.path.join(dest, m.name)
                if m.isdir():
                    os.makedirs(target, mode=0o700, exist_ok=True)
                    continue
                if not m.isfile():
                    sys.stderr.write(f"caps: link or special entry {m.name!r}\n")
                    return bounds.EXIT_CAPS
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with tf.extractfile(m) as fin, open(target, "xb") as fout:
                    while True:
                        chunk = fin.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > max_bytes:
                            sys.stderr.write("caps: extracted size\n")
                            return bounds.EXIT_CAPS
                        fout.write(chunk)
                os.utime(target, (m.mtime, m.mtime))
    except (tarfile.TarError, OSError, EOFError) as exc:
        sys.stderr.write(f"not a readable tar archive: {exc}\n")
        return bounds.EXIT_FAILED
    return 0


def tree_bytes(root):
    total = 0
    for base, dirs, files in os.walk(root):
        for name in dirs + files:
            with contextlib.suppress(OSError):
                st = os.lstat(os.path.join(base, name))
                if not stat.S_ISDIR(st.st_mode):
                    total += max(st.st_size, st.st_blocks * 512)
    return total


def check_tree(dest):
    """Every extracted path stays under `dest`, and nothing is a link or a special file."""
    real_dest = os.path.realpath(dest)
    for base, dirs, files in os.walk(dest):
        for name in dirs + files:
            path = os.path.join(base, name)
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                return f"caps: link entry {os.path.relpath(path, dest)!r} (links are never extracted)"
            if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                return f"caps: special file {os.path.relpath(path, dest)!r}"
            real = os.path.realpath(path)
            if real != real_dest and not real.startswith(real_dest + "/"):
                return f"caps: path {os.path.relpath(path, dest)!r} leaves the archive's folder"
    return None


def extract(path, dest, max_bytes=None, timeout=bounds.STEP_TIMEOUTS["7zz_extract"], type_name="zip"):
    """Extract `path` into the new folder `dest` under the PD-09 size watcher. On a cap the child's process group is
    killed, `dest` removed and CapsError raised (exit 6); on its timeout StepTimeout (exit 7)."""
    limit = min(max_bytes or bounds.ARCHIVE_MAX_TOTAL_BYTES, runner.room_bytes() - bounds.ARCHIVE_FREE_MARGIN_BYTES)
    if limit <= 0:
        raise bounds.CapsError("caps: extracted size (no room left in /workspace or under its quota)")
    os.makedirs(dest, mode=0o700, exist_ok=False)
    if type_name in TAR:
        argv = runner.python_argv("ocw_extract.archives", "tar_extract_child", path, dest, limit)
    else:
        # -snl (store symbolic links) is never passed: links are refused before and checked after extraction.
        argv = ["7zz", "x", "-y", "-bd", "-bb0", f"-o{dest}", path]
    fsize = max(1, min(limit + 1, bounds.ARCHIVE_MAX_TOTAL_BYTES))
    where = runner.current_scratch() or tempfile.gettempdir()
    ok = False
    try:
        with tempfile.TemporaryFile(dir=where) as out:
            proc = runner.spawn(argv, timeout, cwd=dest, stdout=out, stderr=out, fsize=fsize)
            deadline = time.monotonic() + timeout
            over = False
            try:
                while True:
                    if runner.wait_exited(proc, bounds.ARCHIVE_WATCH_INTERVAL_S):
                        break
                    if tree_bytes(dest) > limit:
                        over = True
                        break
                    if time.monotonic() > deadline:
                        runner.reap(proc)
                        raise bounds.StepTimeout(
                            f"extracting {os.path.basename(path)} did not finish within {int(timeout)} s",
                            pgid=proc.pid,
                        )
            finally:
                runner.reap(proc)
            if over or tree_bytes(dest) > limit or proc.returncode == -signal.SIGXFSZ:
                raise bounds.CapsError(f"caps: extracted size over {limit} bytes")
            out.seek(0)
            log = out.read(64 * 1024).decode("utf-8", "replace")
        if proc.returncode != 0:
            if "Enter password" in log or "Wrong password" in log:
                raise bounds.EncryptedError(f"{os.path.basename(path)} is encrypted and needs a password")
            if "caps:" in log:
                raise bounds.CapsError(log.strip().splitlines()[-1])
            lines = [line for line in log.splitlines() if line.strip()]
            raise bounds.ConversionError(
                f"could not extract {os.path.basename(path)}: {lines[-1] if lines else 'damaged archive'}"
            )
        problem = check_tree(dest)
        if problem:
            raise bounds.CapsError(problem)
        ok = True
        return dest
    finally:
        if not ok:
            shutil.rmtree(dest, ignore_errors=True)


def listing_doc(path, type_name, opts):
    """Single-file mode: one `<path> · <size> bytes` line per entry; nothing is extracted."""
    entries = list_archive(path, type_name, opts.steps)
    doc = bounds.Doc(type_name, "list")
    files = [e for e in entries if not e.is_dir]
    doc.extra = f"entries {len(files)}"
    for e in files:
        mark = " · link" if e.link else ""
        doc.add(f"{e.path} · {e.size} bytes{mark}")
    if not files:
        doc.notes.append("[the archive is empty]")
    return doc

