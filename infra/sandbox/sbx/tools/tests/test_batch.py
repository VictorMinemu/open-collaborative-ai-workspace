"""`ocw-extract --batch` (phase 07.17.1.1.1, D-04, D-05, D-11, PD-08, PD-09; E13, E17, E22).

A whole folder or archive becomes a `.txt` mirror tree with `_index.tsv` under /workspace/extracted, in chunks that
always end before the 600 s exec limit (exit 75: more to do). Originals are never copied, moved or modified. Archive
abuse is refused with exit 6. Runs as 10001 in the hardened, network-less container; the budget rule and the size
watcher are also exercised in-process with an injected step runner and clock.
"""

import contextlib
import hashlib
import io
import os
import shutil
import sys
import threading
import time
import unittest

import make_fixtures
from test_ocw_extract import FX, WS, Base, assert_reason, cli, fold, text

sys.path.insert(0, "/opt/ocw-tools/lib")

HEADER = "path\tsize\tmtime_ns\ttype\tmethod\tpages\tnext_page\tchars\tstatus\tnote"
COLUMNS = HEADER.split("\t")
SUMMARY = r"^batch: \d+/\d+ done · \d+ partial · \d+ failed · ocr pages \d+ · "


def index(out_root):
    with open(os.path.join(out_root, "_index.tsv"), encoding="utf-8") as f:
        lines = f.read().splitlines()
    rows = {}
    for line in lines[1:]:
        values = line.split("\t")
        row = dict(zip(COLUMNS, values))
        row["_line"] = line
        rows[row["path"]] = row
    return lines[0], rows


def sha_tree(root):
    """sha256 of every regular file under `root` (symlinks not followed)."""
    found = {}
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(base, name)
            if os.path.islink(path):
                continue
            with open(path, "rb") as f:
                found[os.path.relpath(path, root)] = hashlib.sha256(f.read()).hexdigest()
    return found


def listing(root):
    return sorted(os.path.relpath(os.path.join(b, n), root) for b, d, f in os.walk(root) for n in d + f)


def fresh(path):
    shutil.rmtree(path, ignore_errors=True)
    return path


def copy_fixtures(dest, names):
    fresh(dest)
    os.makedirs(dest)
    for name in names:
        shutil.copyfile(os.path.join(FX, name), os.path.join(dest, name))
    return dest


def in_process(src, **kwargs):
    from ocw_extract import batch

    out = io.StringIO()
    rc = batch.run_batch(src, stdout=out, **kwargs)
    return rc, out.getvalue()


class Folder(Base):
    def test_a_folder_becomes_a_mirror_tree_with_an_index(self):
        src = f"{FX}/pack"
        out_root = fresh(f"{WS}/extracted/pack")
        before, names_before = sha_tree(src), listing(src)
        rc, out, err = cli("--batch", "fx/pack", timeout=500)
        self.assertEqual(rc, 0, err)
        lines = text(out).splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertRegex(lines[0], SUMMARY + r"/workspace/extracted/pack/_index\.tsv$")
        header, rows = index(out_root)
        self.assertEqual(header, HEADER)
        for rel in ("sub/text.pdf", "sub/scan.pdf", "sub/plan.docx", "sub/ventas.xlsx", "docs/slides.pptx"):
            self.assertEqual(rows[rel]["status"], "done", rows[rel])
        self.assertEqual(rows["docs/blob.bin"]["status"], "unsupported")
        self.assertEqual(rows["outside-link"]["status"], "skipped")
        self.assertIn("symlink", rows["outside-link"]["note"])
        self.assertEqual(rows["pack.zip"]["status"], "done")
        self.assertEqual(rows["pack.zip!a.txt"]["status"], "done")
        self.assertEqual(rows["pack.zip!inner.zip"]["status"], "done")
        self.assertEqual(rows["pack.zip!inner.zip"]["method"], "list")
        self.assertEqual(rows["sub/scan.pdf"]["pages"], "2")
        for row in rows.values():
            self.assertIn(row["status"], ("done", "unsupported", "skipped", "failed"), row)
            if row["status"] == "failed":
                self.assertTrue(row["note"], row)
        with open(f"{out_root}/sub/text.pdf.txt", encoding="utf-8") as f:
            self.assertIn("facturación", f.read())
        with open(f"{out_root}/sub/scan.pdf.txt", encoding="utf-8") as f:
            self.assertIn("politica de devoluciones", fold(f.read()))
        with open(f"{out_root}/pack.zip.d/a.txt.txt", encoding="utf-8") as f:
            self.assertIn(make_fixtures.ZIP_TEXT, f.read())
        with open(f"{out_root}/pack.zip.d/inner.zip.txt", encoding="utf-8") as f:
            self.assertIn("b.txt · ", f.read())
        self.assertFalse(os.path.exists(f"{out_root}/pack.zip.d/inner.zip.d"))
        # Originals untouched, nothing added next to them, nothing under the output root is a copy of one.
        self.assertEqual(sha_tree(src), before)
        self.assertEqual(listing(src), names_before)
        self.assertEqual(set(sha_tree(out_root).values()) & set(before.values()), set())

    def test_one_child_at_a_time(self):
        from ocw_extract import runner

        live, peak, lock = [0], [0], threading.Lock()

        def counting(argv, timeout, **kw):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            try:
                return runner.run(argv, timeout, **kw)
            finally:
                with lock:
                    live[0] -= 1

        src = copy_fixtures(f"{WS}/seq", ["text.pdf", "plan.docx", "sign.png", "pedido.eml"])
        rc, _out = in_process(src, out=fresh(f"{WS}/extracted/seq"), steps=counting)
        self.assertEqual(rc, 0)
        self.assertEqual(peak[0], 1)

    def test_output_paths_and_the_walk(self):
        rc, _out, err = cli("--batch", "fx/pack", "--out", "/etc/x")
        self.assertEqual(rc, 4)
        assert_reason(self, err)
        src = copy_fixtures(f"{WS}/inside", ["text.pdf"])
        for _ in range(2):
            rc, _out, err = cli("--batch", src, "--out", f"{src}/_out")
            self.assertEqual(rc, 0, err)
        _header, rows = index(f"{src}/_out")
        self.assertEqual(sorted(rows), ["text.pdf"])
        rc, _out, err = cli("--batch", src, "--out", src)
        self.assertEqual(rc, 2)
        assert_reason(self, err, "--out")

    def test_the_budget_flag_is_bounded(self):
        from ocw_extract import bounds

        self.assertEqual(bounds.BATCH_MAX_BUDGET_S, 470)
        self.assertEqual(bounds.BATCH_DEFAULT_BUDGET_S, 450)
        self.assertEqual(bounds.STEP_TIMEOUT_MAX_S, 120)
        self.assertLessEqual(bounds.BATCH_MAX_BUDGET_S + bounds.STEP_TIMEOUT_MAX_S, 600)
        for value in ("471", "0", "x"):
            rc, _out, err = cli("--batch", "fx/pack", "--budget", value)
            self.assertEqual(rc, 2, value)
            assert_reason(self, err, "--budget")


class Resume(Base):
    def test_budget_1_exits_75_and_reruns_finish_without_rework(self):
        src = copy_fixtures(f"{WS}/resume", ["text.pdf", "scan.pdf", "plan.docx", "latin1.csv"])
        out_root = fresh(f"{WS}/extracted/resume")
        rc, out, err = cli("--batch", src, "--budget", "1")
        self.assertEqual(rc, 75, err)
        self.assertEqual(text(out).splitlines()[-1], "more to do: run the same command again")
        self.assertTrue(os.path.isfile(f"{out_root}/_index.tsv"))
        for _ in range(4):
            rc, out, err = cli("--batch", src, timeout=500)
            if rc == 0:
                break
            self.assertEqual(rc, 75, err)
        self.assertEqual(rc, 0, err)
        _header, rows = index(out_root)
        self.assertEqual({r["status"] for r in rows.values()}, {"done"})
        mtimes = {n: os.stat(os.path.join(out_root, n)).st_mtime_ns for n in listing(out_root) if n.endswith(".txt")}
        rc, _out, err = cli("--batch", src)
        self.assertEqual(rc, 0, err)
        _header, again = index(out_root)
        self.assertEqual({k: v["_line"] for k, v in again.items()}, {k: v["_line"] for k, v in rows.items()})
        for name, mtime in mtimes.items():
            self.assertEqual(os.stat(os.path.join(out_root, name)).st_mtime_ns, mtime, name)

    def test_a_scan_interrupted_mid_file_continues_from_its_next_page(self):
        from ocw_extract import runner

        src = copy_fixtures(f"{WS}/midfile", ["scan.pdf"])
        out_root = fresh(f"{WS}/extracted/midfile")
        now = [0.0]

        def jumping(argv, timeout, **kw):
            res = runner.run(argv, timeout, **kw)
            if os.path.basename(str(argv[0])) == "tesseract":
                now[0] = 10_000.0  # the budget is gone right after page 1's OCR
            return res

        rc, out = in_process(src, out=out_root, steps=jumping, clock=lambda: now[0])
        self.assertEqual(rc, 75, out)
        _header, rows = index(out_root)
        self.assertEqual(rows["scan.pdf"]["status"], "partial")
        self.assertEqual(rows["scan.pdf"]["next_page"], "2")
        self.assertTrue(os.path.isfile(f"{out_root}/scan.pdf.txt.partial"))
        self.assertFalse(os.path.exists(f"{out_root}/scan.pdf.txt"))
        rc, out = in_process(src, out=out_root)
        self.assertEqual(rc, 0, out)
        _header, rows = index(out_root)
        self.assertEqual(rows["scan.pdf"]["status"], "done")
        with open(f"{out_root}/scan.pdf.txt", encoding="utf-8") as f:
            result = f.read()
        self.assertEqual(result.count("--- page 1 (ocr) ---"), 1)
        self.assertEqual(result.count("--- page 2 (ocr) ---"), 1)
        self.assertIn("· text 0 · ocr 2 ===", result.splitlines()[0])
        self.assertIn("senalizacion de salidas", fold(result))
        self.assertFalse(os.path.exists(f"{out_root}/scan.pdf.txt.partial"))


class FakeSteps:
    """A step runner that takes `seconds` per step and answers like the real tools for a one-page text PDF."""

    def __init__(self, seconds=0.0, fail=None):
        self.seconds = seconds
        self.fail = fail
        self.log = []

    def __call__(self, argv, timeout, **_kw):
        from ocw_extract import bounds, runner

        tool = os.path.basename(str(argv[0]))
        self.log.append(f"{tool}:start")
        if self.fail == tool:
            self.log.append(f"{tool}:timeout")
            raise bounds.StepTimeout(f"{tool} did not finish within {timeout} s")
        time.sleep(self.seconds)
        self.log.append(f"{tool}:done")
        answers = {
            "file": b"application/pdf\n",
            "pdfinfo": b"Pages:          1\nEncrypted:      no\n",
            "pdftotext": b"Texto de prueba suficientemente largo para no necesitar OCR.\n",
        }
        return runner.Result(0, answers.get(tool, b""), b"")


class BudgetRule(Base):
    def setUp(self):
        from ocw_extract import bounds

        self.src = copy_fixtures(f"{WS}/budget", ["text.pdf"])
        shutil.copyfile(f"{FX}/text.pdf", f"{self.src}/zz.pdf")
        self.out_root = fresh(f"{WS}/extracted/budget")
        self.timeouts = dict.fromkeys(bounds.STEP_TIMEOUTS, 4)

    def test_a_step_that_does_not_fit_is_never_started(self):
        fake = FakeSteps(seconds=3)
        started = time.monotonic()
        rc, out = in_process(self.src, out=self.out_root, budget=5, steps=fake, timeouts=self.timeouts)
        elapsed = time.monotonic() - started
        self.assertEqual(rc, 75, out)
        self.assertLess(elapsed, 6)
        self.assertEqual(fake.log, ["file:start", "file:done"])
        self.assertIn("more to do: run the same command again", out)
        _header, rows = index(self.out_root)
        self.assertNotEqual(rows.get("zz.pdf", {}).get("status"), "done")
        self.assertNotIn("zz.pdf", rows)

    def test_a_budget_shorter_than_any_step_starts_nothing(self):
        fake = FakeSteps(seconds=3)
        started = time.monotonic()
        rc, _out = in_process(self.src, out=self.out_root, budget=3, steps=fake, timeouts=self.timeouts)
        self.assertEqual(rc, 75)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(fake.log, [])
        self.assertTrue(os.path.isfile(f"{self.out_root}/_index.tsv"))

    def test_a_timed_out_step_leaves_partial_then_failed(self):
        fake = FakeSteps(fail="pdftotext")
        rc, _out = in_process(self.src, out=self.out_root, budget=100, steps=fake, timeouts=self.timeouts)
        self.assertEqual(rc, 75)
        _header, rows = index(self.out_root)
        self.assertEqual(rows["text.pdf"]["status"], "partial")
        self.assertEqual(rows["text.pdf"]["next_page"], "1")
        self.assertIn("timeout", rows["text.pdf"]["note"])
        rc, out = in_process(self.src, out=self.out_root, budget=100, steps=fake, timeouts=self.timeouts)
        self.assertEqual(rc, 0, out)
        _header, rows = index(self.out_root)
        self.assertEqual(rows["text.pdf"]["status"], "failed")
        self.assertEqual(rows["text.pdf"]["note"], "timeout")
        self.assertRegex(out.splitlines()[0], SUMMARY)


class Caps(Base):
    def test_the_size_watcher_catches_a_lying_listing(self):
        from ocw_extract import archives, bounds, runner

        with runner.scratch() as where:
            dest = os.path.join(where, "x")
            with self.assertRaises(bounds.CapsError) as ctx:
                archives.extract(f"{FX}/big.zip", dest, max_bytes=1024 * 1024)
            self.assertIn("caps: extracted size", ctx.exception.reason)
            self.assertEqual(ctx.exception.code, 6)
            self.assertFalse(os.path.exists(dest))
            archives.extract(f"{FX}/big.zip", dest, max_bytes=8 * 1024 * 1024)
            self.assertEqual(os.path.getsize(os.path.join(dest, "big.bin")), 5 * 1024 * 1024)

    def test_hostile_top_level_archives_exit_6(self):
        for name, needle in (("bomb.zip", "ratio"), ("traversal.zip", "path"), ("link.zip", "link")):
            with self.subTest(name=name):
                rc, _out, err = cli("--batch", f"fx/{name}")
                self.assertEqual(rc, 6, err)
                assert_reason(self, err, "caps:", needle)
        for path in (f"{WS}/evil.txt", f"{WS}/extracted/evil.txt", f"{FX}/evil.txt"):
            self.assertFalse(os.path.exists(path), path)
        self.assertFalse(os.path.exists(f"{WS}/extracted/link.zip/link.zip.d/passwd-link.txt"))

    def test_inside_a_folder_they_are_failed_rows_and_the_walk_goes_on(self):
        out_root = fresh(f"{WS}/extracted/badpack")
        rc, out, err = cli("--batch", "fx/badpack")
        self.assertEqual(rc, 0, err)
        _header, rows = index(out_root)
        for name, needle in (("bomb.zip", "ratio"), ("traversal.zip", "path"), ("link.zip", "link")):
            self.assertEqual(rows[name]["status"], "failed", rows[name])
            self.assertTrue(rows[name]["note"].startswith("caps: "), rows[name])
            self.assertIn(needle, rows[name]["note"])
        self.assertEqual(rows["nota.txt"]["status"], "done")
        self.assertRegex(text(out).splitlines()[0], SUMMARY)
        self.assertFalse(os.path.exists(f"{WS}/evil.txt"))


if __name__ == "__main__":
    unittest.main()
