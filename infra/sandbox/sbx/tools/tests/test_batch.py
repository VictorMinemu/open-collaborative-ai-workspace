"""`ocw-extract --batch` (phase 07.17.1.1.1, D-04, D-05, D-11, PD-08, PD-09; E13, E17, E22).

A whole folder or archive becomes a `.txt` mirror tree with `_index.tsv` under /workspace/extracted, in chunks that
always end before the 600 s exec limit (exit 75: more to do). Originals are never copied, moved or modified. Archive
abuse is refused with exit 6. Runs as 10001 in the hardened, network-less container; the budget rule and the size
watcher are also exercised in-process with an injected step runner and clock.
"""

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
        # 07.17.1.1.1 review CR-02: a budget shorter than the longest step (plus 10 s) could never finish an Office,
        # sheet, image or archive entry, so it is a usage error instead of an endless exit 75.
        self.assertEqual(bounds.BATCH_MIN_BUDGET_S, 130)
        self.assertEqual(bounds.parse_budget("130"), 130)
        for value in ("471", "0", "x", "1", "129"):
            rc, _out, err = cli("--batch", "fx/pack", "--budget", value)
            self.assertEqual(rc, 2, value)
            assert_reason(self, err, "--budget")


OCW_RUN = "/usr/local/bin/ocw-run"


def via_ocw_run(seconds, *args, timeout=700):
    """Run ocw-extract exactly as sandboxd runs a bot's argv: `ocw-run <id> <timeoutSeconds> -- argv`."""
    import subprocess

    from test_ocw_extract import BOT_ENV, EXTRACT

    proc = subprocess.run(
        [OCW_RUN, f"t{os.getpid()}x{seconds}", str(seconds), "--", EXTRACT, *args],
        capture_output=True,
        timeout=timeout,
        cwd=WS,
        env=BOT_ENV,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")


class ExecDeadline(Base):
    """07.17.1.1.1 review CR-01: the batch sizes its budget from the exec timeout `ocw-run` really gives it."""

    def test_ocw_run_exports_the_deadline_to_the_command(self):
        import subprocess

        proc = subprocess.run(
            [OCW_RUN, f"t{os.getpid()}env", "77", "--", "sh", "-c", 'printf %s "$OCW_EXEC_DEADLINE_S"'],
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, b"77")

    def test_the_budget_follows_the_deadline(self):
        from ocw_extract import bounds

        self.assertEqual(bounds.batch_budget(450, None), 450)
        self.assertEqual(bounds.batch_budget(450, 600), 450)
        self.assertEqual(bounds.batch_budget(470, 600), 470)
        self.assertEqual(bounds.batch_budget(450, 300), 300 - bounds.BATCH_END_MARGIN_S)
        self.assertEqual(bounds.batch_budget(450, 260), bounds.BATCH_MIN_BUDGET_S)
        for deadline in (120, 259, 1):
            with self.subTest(deadline=deadline), self.assertRaises(bounds.UsageError) as ctx:
                bounds.batch_budget(450, deadline)
            self.assertIn("timeoutSeconds 600", ctx.exception.reason)
            self.assertIn("background true", ctx.exception.reason)
        self.assertEqual(bounds.exec_deadline({"OCW_EXEC_DEADLINE_S": "600"}), 600)
        for bad in ({}, {"OCW_EXEC_DEADLINE_S": ""}, {"OCW_EXEC_DEADLINE_S": "x"}, {"OCW_EXEC_DEADLINE_S": "-5"}):
            self.assertIsNone(bounds.exec_deadline(bad), bad)

    def test_the_bots_default_120_s_is_a_clear_usage_error_never_a_kill(self):
        out_root = fresh(f"{WS}/extracted/deadline-default")
        src = copy_fixtures(f"{WS}/deadline-default", ["text.pdf"])
        started = time.monotonic()
        rc, _out, err = via_ocw_run(120, "--batch", src)
        self.assertEqual(rc, 2, err)  # never 137 (SIGKILL by ocw-run's timeout)
        self.assertLess(time.monotonic() - started, 30)
        assert_reason(self, err, "timeoutSeconds 600", "background true")
        self.assertFalse(os.path.exists(f"{out_root}/_index.tsv"))

    def test_the_documented_600_s_runs_the_batch_to_the_end(self):
        src = copy_fixtures(f"{WS}/deadline-600", ["text.pdf", "latin1.csv"])
        out_root = fresh(f"{WS}/extracted/deadline-600")
        rc, out, err = via_ocw_run(600, "--batch", src)
        self.assertEqual(rc, 0, err)
        self.assertRegex(text(out).splitlines()[0], SUMMARY)
        _header, rows = index(out_root)
        self.assertEqual({r["status"] for r in rows.values()}, {"done"})


class Resume(Base):
    def test_a_chunk_that_runs_out_exits_75_and_reruns_finish_without_rework(self):
        from ocw_extract import runner

        src = copy_fixtures(f"{WS}/resume", ["text.pdf", "scan.pdf", "plan.docx", "latin1.csv"])
        out_root = fresh(f"{WS}/extracted/resume")
        now = [0.0]

        def jumping(argv, timeout, **kw):
            res = runner.run(argv, timeout, **kw)
            if "text_child" in [str(a) for a in argv]:
                now[0] = 10_000.0  # the budget is gone right after latin1.csv, the first entry
            return res

        rc, out = in_process(src, out=out_root, steps=jumping, clock=lambda: now[0])
        self.assertEqual(rc, 75, out)
        self.assertEqual(out.splitlines()[-1], "more to do: run the same command again")
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
    """A step runner that takes `seconds` per step (or `per_tool[tool]`) and answers like the real tools for a
    one-page text PDF."""

    def __init__(self, seconds=0.0, fail=None, per_tool=None):
        self.seconds = seconds
        self.fail = fail
        self.per_tool = per_tool or {}
        self.log = []

    def __call__(self, argv, timeout, **_kw):
        from ocw_extract import bounds, runner

        tool = os.path.basename(str(argv[0]))
        self.log.append(f"{tool}:start")
        if self.fail == tool:
            self.log.append(f"{tool}:timeout")
            raise bounds.StepTimeout(f"{tool} did not finish within {timeout} s")
        time.sleep(self.per_tool.get(tool, self.seconds))
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
        fake = FakeSteps(per_tool={"pdftotext": 3})
        started = time.monotonic()
        rc, out = in_process(self.src, out=self.out_root, budget=5, steps=fake, timeouts=self.timeouts)
        elapsed = time.monotonic() - started
        self.assertEqual(rc, 75, out)
        self.assertLess(elapsed, 6)
        self.assertEqual(fake.log[-2:], ["pdftotext:start", "pdftotext:done"])
        self.assertEqual(sum(1 for line in fake.log if line == "file:start"), 1)
        self.assertIn("more to do: run the same command again", out)
        _header, rows = index(self.out_root)
        self.assertEqual(rows["text.pdf"]["status"], "done")
        self.assertNotIn("zz.pdf", rows)

    def test_a_run_that_starts_nothing_stops_with_exit_8_not_75(self):
        # 07.17.1.1.1 review CR-02: the no-progress guard. Only injected timeouts can get here (the CLI refuses a
        # budget under 130 s); the same index twice is a clear error, never another "run again".
        from ocw_extract import bounds

        fake = FakeSteps(seconds=3)
        for attempt in range(2):
            started = time.monotonic()
            with self.subTest(attempt=attempt), self.assertRaises(bounds.StuckError) as ctx:
                in_process(self.src, out=self.out_root, budget=3, steps=fake, timeouts=self.timeouts)
            self.assertEqual(ctx.exception.code, 8)
            self.assertIn("no progress", ctx.exception.reason)
            self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(fake.log, [])
        self.assertTrue(os.path.isfile(f"{self.out_root}/_index.tsv"))
        self.assertEqual(bounds.EXIT_STUCK, 8)

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


class Lock(Base):
    """07.17.1.1.1 review WR-07: one batch at a time writes an output folder; a second is refused, never interleaved."""

    def test_a_second_batch_on_the_same_output_folder_is_refused(self):
        import fcntl
        import subprocess

        src = copy_fixtures(f"{WS}/locked", ["latin1.csv"])
        out_root = fresh(f"{WS}/extracted/locked")
        os.makedirs(out_root)
        holder = subprocess.Popen(
            [sys.executable, "-I", "-c",
             "import fcntl, sys, time; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); "
             "print('held', flush=True); time.sleep(60)", f"{out_root}/_index.tsv.lock"],
            stdout=subprocess.PIPE,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), b"held")
            rc, _out, err = cli("--batch", src)
            self.assertEqual(rc, 2, err)
            assert_reason(self, err, "another ocw-extract --batch", out_root)
            self.assertFalse(os.path.exists(f"{out_root}/_index.tsv"))
        finally:
            holder.kill()
            holder.wait()
        rc, _out, err = cli("--batch", src)
        self.assertEqual(rc, 0, err)
        # The lock is held for the whole run and released at its end: the next run takes it at once.
        with open(f"{out_root}/_index.tsv.lock", "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)


class VirtualSteps:
    """A step runner on a virtual clock (07.17.1.1.1 review CR-02): each step takes `seconds(tool, argv)` virtual
    seconds, no real time. It answers like the real tools: `file` from the extension, soffice writes a PDF, pdfinfo
    gives `pages`, pdftotext gives `layer` text (empty: a scan), pdftoppm writes a PNG, tesseract reads the page."""

    MIMES = {".pdf": "application/pdf", ".txt": "text/plain", ".docx": "application/zip",
             ".ods": "application/vnd.oasis.opendocument.spreadsheet"}

    def __init__(self, seconds, pages=3, layer=""):
        self.now = 0.0
        self.seconds = seconds
        self.pages = pages
        self.layer = layer
        self.log = []

    def clock(self):
        return self.now

    def __call__(self, argv, timeout, **_kw):
        from ocw_extract import bounds, runner

        argv = [str(a) for a in argv]
        tool = os.path.basename(argv[0])
        if tool.startswith("python"):
            tool = argv[6]
        page = None
        if tool in ("pdftotext", "pdftoppm"):
            page = int(argv[argv.index("-f") + 1])
        elif tool == "tesseract":
            page = int(os.path.basename(argv[1]).split("-")[1].split(".")[0])
        took = self.seconds(tool, page)
        self.log.append((tool, page))
        if took > timeout:
            self.now += timeout
            raise bounds.StepTimeout(f"{tool} did not finish within {timeout} s")
        self.now += took
        out = b""
        if tool == "file":
            out = (self.MIMES[os.path.splitext(argv[-1])[1]] + "\n").encode()
        elif tool == "soffice":
            outdir, src = argv[argv.index("--outdir") + 1], argv[-1]
            with open(os.path.join(outdir, os.path.splitext(os.path.basename(src))[0] + ".pdf"), "wb") as f:
                f.write(b"%PDF-1.4 virtual\n")
        elif tool == "pdfinfo":
            out = f"Pages:          {self.pages}\n".encode()
        elif tool == "pdftotext":
            out = self.layer.encode()
        elif tool == "pdftoppm":
            with open(argv[-1] + ".png", "wb") as f:
                f.write(b"png")
        elif tool == "tesseract":
            out = f"Texto reconocido de la pagina {page} con bastantes caracteres.".encode()
        elif tool == "text_child":
            out = b"una nota de texto"
        elif tool == "xlsx_child":
            out = b"### sheet: Hoja1\na,b\n"
        return runner.Result(0, out, b"")


def dummies(dest, names):
    fresh(dest)
    os.makedirs(dest)
    for name in names:
        with open(os.path.join(dest, name), "wb") as f:
            f.write(b"x")
    return dest


class Progress(Base):
    """07.17.1.1.1 review CR-02: every run of a batch either moves an entry on or stops with exit 8; one entry that
    needs more than one budget never makes the batch exit 75 forever."""

    def run3(self, src, out_root, fake, runs=4, **kwargs):
        codes = []
        for _ in range(runs):
            fake.now = 0.0
            rc, _out = in_process(src, out=out_root, budget=130, steps=fake, clock=fake.clock, **kwargs)
            codes.append(rc)
            if rc == 0:
                break
        return codes

    def test_an_entry_that_needs_more_than_one_budget_ends_failed_within_two_runs(self):
        src = dummies(f"{WS}/cr02-sheet", ["a.ods", "b.txt"])
        out_root = fresh(f"{WS}/extracted/cr02-sheet")
        # a.ods: LibreOffice's export takes 110 s, then openpyxl's 120 s step no longer fits a 130 s budget.
        fake = VirtualSteps(lambda tool, _page: {"file": 5, "soffice": 110}.get(tool, 1))
        codes = self.run3(src, out_root, fake)
        self.assertEqual(codes, [75, 0])
        _header, rows = index(out_root)
        self.assertEqual(rows["a.ods"]["status"], "failed", rows["a.ods"])
        self.assertIn("did not fit in one run", rows["a.ods"]["note"])
        self.assertEqual(rows["b.txt"]["status"], "done")

    def test_a_pdf_page_that_does_not_fit_a_fresh_run_is_skipped_and_the_pdf_goes_on(self):
        src = dummies(f"{WS}/cr02-pdf", ["scan.pdf"])
        out_root = fresh(f"{WS}/extracted/cr02-pdf")

        def seconds(tool, page):
            if page == 2 and tool in ("pdftotext", "pdftoppm"):
                return 50  # page 2 alone leaves less than tesseract's 120 s, even in a fresh run
            return {"tesseract": 30}.get(tool, 1)

        fake = VirtualSteps(seconds)
        codes = self.run3(src, out_root, fake)
        self.assertEqual(codes[-1], 0, codes)
        self.assertLessEqual(len(codes), 3, codes)
        _header, rows = index(out_root)
        row = rows["scan.pdf"]
        self.assertEqual(row["status"], "done", row)
        self.assertIn("skipped page 2", row["note"])
        with open(f"{out_root}/scan.pdf.txt", encoding="utf-8") as f:
            body = f.read()
        self.assertEqual(body.count("--- page 1 (ocr) ---"), 1)
        self.assertEqual(body.count("--- page 2 (skipped) ---"), 1)
        self.assertEqual(body.count("--- page 3 (ocr) ---"), 1)
        self.assertIn("--pages 2", body)
        self.assertFalse(os.path.exists(f"{out_root}/scan.pdf.txt.partial"))

    def test_an_office_file_read_through_its_pdf_resumes_at_the_next_page(self):
        src = dummies(f"{WS}/cr02-docx", ["plan.docx"])
        out_root = fresh(f"{WS}/extracted/cr02-docx")
        # --ocr always: soffice to PDF, then pdftoppm + tesseract per page; two pages never fit one 130 s run.
        fake = VirtualSteps(lambda tool, _page: {"soffice": 5, "tesseract": 60}.get(tool, 1))
        fake.now = 0.0
        rc, _out = in_process(src, out=out_root, budget=130, steps=fake, clock=fake.clock, ocr="always")
        self.assertEqual(rc, 75)
        _header, rows = index(out_root)
        self.assertEqual(rows["plan.docx"]["status"], "partial", rows["plan.docx"])
        self.assertEqual(rows["plan.docx"]["next_page"], "2")
        self.assertTrue(os.path.isfile(f"{out_root}/plan.docx.txt.partial"))
        codes = self.run3(src, out_root, fake, ocr="always")
        self.assertEqual(codes, [75, 0])
        _header, rows = index(out_root)
        self.assertEqual(rows["plan.docx"]["status"], "done", rows["plan.docx"])
        self.assertEqual(rows["plan.docx"]["method"], "soffice+ocr")
        with open(f"{out_root}/plan.docx.txt", encoding="utf-8") as f:
            body = f.read()
        for n in (1, 2, 3):
            self.assertEqual(body.count(f"--- page {n} (ocr) ---"), 1, body)
        self.assertIn("· pages 1-3 of 3 · text 0 · ocr 3 ===", body.splitlines()[0])
        tesseract_pages = [p for tool, p in fake.log if tool == "tesseract"]
        self.assertEqual(sorted(tesseract_pages), [1, 2, 3])  # no page OCR'd twice


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

    def test_the_archive_cap_respects_the_workspace_room_sandboxd_passes(self):
        """07.17.1.1.1 review WR-06: the room left under the bot's soft quota (OCW_DISK_ROOM_BYTES, set by sandboxd on
        every exec) caps an extraction, not only the disk's free space."""
        from test_ocw_extract import BOT_ENV

        from ocw_extract import bounds

        margin = bounds.ARCHIVE_FREE_MARGIN_BYTES
        tight = dict(BOT_ENV, OCW_DISK_ROOM_BYTES=str(margin + 3 * 1024 * 1024))
        fresh(f"{WS}/extracted/big.zip")
        rc, _out, err = cli("--batch", "fx/big.zip", env=tight)
        self.assertEqual(rc, 6, err)
        assert_reason(self, err, "caps: total size")
        roomy = dict(BOT_ENV, OCW_DISK_ROOM_BYTES=str(margin + 64 * 1024 * 1024))
        fresh(f"{WS}/extracted/big.zip")
        rc, _out, err = cli("--batch", "fx/big.zip", env=roomy)
        self.assertEqual(rc, 0, err)
        self.assertEqual(bounds.workspace_room({"OCW_DISK_ROOM_BYTES": "123"}), 123)
        for bad in ({}, {"OCW_DISK_ROOM_BYTES": "x"}, {"OCW_DISK_ROOM_BYTES": "-1"}):
            self.assertIsNone(bounds.workspace_room(bad), bad)

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
