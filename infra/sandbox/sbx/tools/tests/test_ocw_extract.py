"""`ocw-extract` single-file mode (phase 07.17.1.1.1, D-04, D-05, D-08, D-11, PD-06, PD-07, PD-11; E1 - E16, E18, E22).

Runs as 10001 in the hardened, network-less container (`infra/sandbox/test/run-sbx-image-tests.sh`); fixtures are
generated once into /workspace/fx by `make_fixtures.make_all`. The CLI is run as a bot runs it (argv, the shell's
environment with a proxy variable set); its internals are imported from /opt/ocw-tools/lib for the runner cases.
"""

import contextlib
import io
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import unittest

import make_fixtures

sys.path.insert(0, "/opt/ocw-tools/lib")

EXTRACT = "/usr/local/bin/ocw-extract"
WS = "/workspace"
FX = f"{WS}/fx"
STDOUT_MAX_BYTES = 16_384
# The bot shell's environment (apps/sandboxd/src/spec.ts SHELL_ENV), with the egress proxy variables a child must
# never see.
BOT_ENV = {
    "HOME": WS,
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/ocw-tools/bin:/opt/ocw-packages/bin",
    "NODE_PATH": "/opt/ocw-packages/node_modules",
    "PYTHONPATH": "/opt/ocw-packages/python:/opt/ocw-tools/venv/lib/python3.11/site-packages",
    "HTTP_PROXY": "http://sandbox-egress.invalid:3128",
    "HTTPS_PROXY": "http://sandbox-egress.invalid:3128",
    "http_proxy": "http://sandbox-egress.invalid:3128",
    "https_proxy": "http://sandbox-egress.invalid:3128",
    "NO_PROXY": "localhost",
}

_fixtures = {}


def fixtures():
    if not _fixtures:
        _fixtures.update(make_fixtures.make_all(FX))
    return _fixtures


def cli(*args, timeout=240, cwd=WS, env=None):
    """Run ocw-extract like a bot: argv only. Returns (returncode, stdout bytes, stderr text)."""
    proc = subprocess.run(
        [EXTRACT, *args], capture_output=True, timeout=timeout, cwd=cwd, env=env or BOT_ENV, check=False
    )
    return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")


def text(data):
    return data.decode("utf-8")


def fold(value):
    """NFC, casefold, accents stripped: OCR may drop an accent, never a letter."""
    decomposed = unicodedata.normalize("NFD", unicodedata.normalize("NFC", value).casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def assert_reason(case, err, *needles):
    lines = [line for line in err.splitlines() if line.strip()]
    case.assertTrue(lines, "a non-zero exit prints one reason line")
    case.assertTrue(lines[-1].startswith("ocw-extract: "), err)
    for needle in needles:
        case.assertIn(needle, lines[-1])


def leftovers():
    """Scratch and LibreOffice profiles that a run failed to remove."""
    found = [n for n in os.listdir("/tmp") if n.startswith("ocw-lo-")]
    root = f"{WS}/.ocw-extract-tmp"
    if os.path.isdir(root):
        found += [os.path.join(root, n) for n in os.listdir(root)]
    return found


def live_comms():
    """(pid, comm) of every live (not zombie) process in the container."""
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as f:
                data = f.read()
        except OSError:
            continue
        comm = data[data.index(b"(") + 1 : data.rindex(b")")].decode("utf-8", "replace")
        state = data[data.rindex(b")") + 2 :].split()[0]
        if state != b"Z":
            found.append((int(name), comm))
    return found


def office_processes():
    return sorted(comm for _pid, comm in live_comms() if comm in ("soffice.bin", "oosplash", "soffice"))


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = fixtures()

    def assertBounded(self, out):
        self.assertLessEqual(len(out), STDOUT_MAX_BYTES)
        out.decode("utf-8")  # valid UTF-8 always
        self.assertNotIn("﻿", out.decode("utf-8"))
        self.assertNotIn("�", out.decode("utf-8"))

    def tearDown(self):
        self.assertEqual(leftovers(), [])


class Isolation(Base):
    def test_a_planted_module_and_pythonpath_never_load(self):
        os.makedirs(f"{WS}/shadow/pypdf", exist_ok=True)
        with open(f"{WS}/json.py", "w", encoding="utf-8") as f:
            f.write("raise SystemExit('planted json.py was imported')\n")
        with open(f"{WS}/shadow/pypdf/__init__.py", "w", encoding="utf-8") as f:
            f.write("raise SystemExit('planted pypdf was imported')\n")
        try:
            env = dict(BOT_ENV, PYTHONPATH=f"{WS}/shadow")
            rc, out, err = cli("fx/text.pdf", cwd=WS, env=env)
            self.assertEqual(rc, 0, err)
            self.assertIn("facturación", text(out))
        finally:
            os.unlink(f"{WS}/json.py")
            shutil.rmtree(f"{WS}/shadow")


class Runner(Base):
    def test_child_env_is_fresh_and_minimal(self):
        from ocw_extract import runner

        saved = dict(os.environ)
        try:
            os.environ.update(
                {
                    "HTTP_PROXY": "http://proxy.invalid:1",
                    "https_proxy": "http://proxy.invalid:1",
                    "NO_PROXY": "x",
                    "PYTHONPATH": "/workspace/shadow",
                }
            )
            env = runner.child_env()
            self.assertEqual(
                sorted(env), ["HOME", "LC_ALL", "OMP_THREAD_LIMIT", "OPENBLAS_NUM_THREADS", "PATH", "TMPDIR"]
            )
            self.assertEqual(env["LC_ALL"], "C.UTF-8")
            self.assertEqual(env["OMP_THREAD_LIMIT"], "1")
            self.assertEqual(env["OPENBLAS_NUM_THREADS"], "1")
            self.assertNotIn("/opt/ocw", env["PATH"])
            with runner.scratch() as where:
                res = runner.run(["env"], 30)
                seen = dict(line.split("=", 1) for line in res.stdout.decode().splitlines() if "=" in line)
                self.assertEqual(sorted(seen), sorted(runner.child_env()))
                self.assertEqual(seen["HOME"], where)
                self.assertEqual(seen["TMPDIR"], where)
                self.assertTrue(where.startswith(f"{WS}/.ocw-extract-tmp/"))
                self.assertEqual(os.stat(where).st_mode & 0o777, 0o700)
            self.assertFalse(os.path.exists(where))
        finally:
            os.environ.clear()
            os.environ.update(saved)

    def test_a_child_past_its_timeout_is_killed_with_its_tree(self):
        from ocw_extract import bounds, runner

        sleeps = lambda: [pid for pid, comm in live_comms() if comm == "sleep"]  # noqa: E731
        with runner.scratch():
            started = time.monotonic()
            with self.assertRaises(bounds.StepTimeout) as ctx:
                # A grandchild in the background and one whose parent exits first (reparented to the subreaper).
                runner.run(["sh", "-c", "sleep 60 & (sleep 61 &) ; sleep 62"], 1)
            self.assertLess(time.monotonic() - started, 10)
        self.assertIsInstance(ctx.exception.pgid, int)
        deadline = time.monotonic() + 5
        while sleeps() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(sleeps(), [], "a process of the child's tree outlived its timeout")
        self.assertEqual(ctx.exception.code, 7)

    def test_a_child_that_exits_leaves_no_orphan_running(self):
        from ocw_extract import runner

        with runner.scratch():
            res = runner.run(["sh", "-c", "(sleep 63 &) ; echo done"], 30)
        self.assertEqual(res.stdout, b"done\n")
        self.assertEqual([pid for pid, comm in live_comms() if comm == "sleep"], [])

    def test_a_step_timeout_is_exit_7_at_the_cli(self):
        from ocw_extract import bounds, cli as cli_module, runner

        def slow(argv, timeout, **_kw):
            raise bounds.StepTimeout(f"{argv[0]} did not finish within {timeout} s")

        original = runner.run
        runner.run = slow
        err = io.StringIO()
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                rc = cli_module.main([f"{FX}/text.pdf"])
        finally:
            runner.run = original
        self.assertEqual(rc, 7)
        assert_reason(self, err.getvalue(), "did not finish")

    def test_killing_ocw_extract_through_ocw_run_kills_libreoffice_too(self):
        """07.17.1.1.1 review WR-01: `ocw-run --kill` (and its exec timeout) SIGKILL ocw-extract's process group; every
        child, LibreOffice's soffice.bin grandchild included, must be in it and die with it."""
        import docx

        path = f"{WS}/slow.docx"
        document = docx.Document()
        for i in range(30_000):
            document.add_paragraph(f"Párrafo {i}: texto de relleno para que LibreOffice tarde en convertirlo.")
        document.save(path)
        rid = f"wr01x{os.getpid()}"
        proc = subprocess.Popen(
            ["/usr/local/bin/ocw-run", rid, "600", "--", EXTRACT, path, "-o", f"{WS}/slow.txt"],
            cwd=WS,
            env=BOT_ENV,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 90
            while not office_processes() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIn("soffice.bin", office_processes(), "LibreOffice never started")
            kill = subprocess.run(["/usr/local/bin/ocw-run", "--kill", rid], capture_output=True, check=False)
            self.assertEqual(kill.returncode, 0, kill.stderr)
            proc.wait(timeout=10)
            deadline = time.monotonic() + 2
            while office_processes() and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertEqual(office_processes(), [], "LibreOffice outlived the kill of ocw-extract")
        finally:
            proc.kill()
            proc.wait()
            for name in ("slow.docx", "slow.txt"):
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(f"{WS}/{name}")
            # A SIGKILLed run cannot remove its scratch; the next run does (review WR-06, tested there).
            shutil.rmtree(f"{WS}/.ocw-extract-tmp", ignore_errors=True)
            for name in os.listdir("/tmp"):
                if name.startswith("ocw-lo-"):
                    shutil.rmtree(f"/tmp/{name}", ignore_errors=True)

    def test_killing_ocw_extract_through_ocw_run_kills_every_grandchild(self):
        """07.17.1.1.1 review WR-01: a grandchild without a death signal (any program that forks, as soffice forks
        soffice.bin) dies with the group ocw-run kills; nothing runs on in a session nobody kills."""
        code = (
            "import sys; sys.path.insert(0, '/opt/ocw-tools/lib'); from ocw_extract import runner\n"
            "with runner.scratch():\n"
            "    runner.run(['sh', '-c', 'sleep 300 & sleep 301; wait'], 600)\n"
        )
        rid = f"wr01g{os.getpid()}"
        proc = subprocess.Popen(
            ["/usr/local/bin/ocw-run", rid, "600", "--", "/opt/ocw-tools/venv/bin/python3", "-I", "-c", code],
            cwd=WS,
            env=BOT_ENV,
        )
        sleeps = lambda: sorted(comm for _pid, comm in live_comms() if comm == "sleep")  # noqa: E731
        try:
            deadline = time.monotonic() + 30
            while len(sleeps()) < 2 and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(sleeps(), ["sleep", "sleep"])
            kill = subprocess.run(["/usr/local/bin/ocw-run", "--kill", rid], capture_output=True, check=False)
            self.assertEqual(kill.returncode, 0, kill.stderr)
            proc.wait(timeout=10)
            deadline = time.monotonic() + 2
            while sleeps() and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertEqual(sleeps(), [], "a grandchild outlived the kill of ocw-extract")
        finally:
            proc.kill()
            proc.wait()
            for pid, comm in live_comms():
                if comm == "sleep":
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(pid, 9)
            shutil.rmtree(f"{WS}/.ocw-extract-tmp", ignore_errors=True)

    def test_the_next_run_removes_what_a_killed_run_left(self):
        """07.17.1.1.1 review WR-06: a SIGKILLed run's scratch folder and LibreOffice profile are removed by the next
        run at once (their owner is gone), never only after an hour; a live run's are kept."""
        from ocw_extract import runner

        root = f"{WS}/.ocw-extract-tmp"
        me = f"{os.getpid()}-{runner.start_time(os.getpid())}"
        dead = [f"{root}/run-999999-1-dead", "/tmp/ocw-lo-999999-1-dead", f"{root}/run-1-1-reused"]
        live = [f"{root}/run-{me}-live", f"/tmp/ocw-lo-{me}-live"]
        legacy_old, legacy_new = f"{root}/run-legacyold", f"{root}/run-legacynew"
        for path in dead + live + [legacy_old, legacy_new]:
            os.makedirs(path, exist_ok=True)
            with open(f"{path}/left.bin", "wb") as f:
                f.write(b"x" * 1024)
        old = time.time() - 2 * 3600
        os.utime(legacy_old, (old, old))
        try:
            with runner.scratch():
                pass
            for path in dead + [legacy_old]:
                self.assertFalse(os.path.exists(path), path)
            for path in live + [legacy_new]:
                self.assertTrue(os.path.isdir(path), path)
        finally:
            for path in dead + live + [legacy_old, legacy_new]:
                shutil.rmtree(path, ignore_errors=True)
            with contextlib.suppress(OSError):
                os.rmdir(root)

    def test_argv_is_never_a_string(self):
        from ocw_extract import runner

        with runner.scratch(), self.assertRaises(TypeError):
            runner.run("echo hi; id", 5)


class Pdf(Base):
    def test_text_pdf_prints_both_pages_with_the_header(self):
        rc, out, err = cli("fx/text.pdf")
        self.assertEqual(rc, 0, err)
        self.assertBounded(out)
        lines = text(out).splitlines()
        self.assertEqual(lines[0], "=== text.pdf · pdf · pages 1-2 of 2 · text 2 · ocr 0 ===")
        body = text(out)
        p1, p2 = body.index("--- page 1 ---"), body.index("--- page 2 ---")
        self.assertLess(p1, p2)
        self.assertIn("facturación", body[p1:p2])
        self.assertIn("Señalización", body[p2:])

    def test_a_page_range_prints_only_those_pages(self):
        rc, out, err = cli("fx/text.pdf", "--pages", "2-2")
        self.assertEqual(rc, 0, err)
        body = text(out)
        self.assertTrue(body.startswith("=== text.pdf · pdf · pages 2-2 of 2 · text 1 · ocr 0 ==="), body[:120])
        self.assertNotIn("--- page 1 ---", body)
        self.assertIn("--- page 2 ---", body)
        self.assertNotIn("facturación", body)

    def test_a_bad_page_range_is_a_usage_error(self):
        rc, _out, err = cli("fx/text.pdf", "--pages", "3-4")
        self.assertEqual(rc, 2)
        assert_reason(self, err, "out of range", "2 pages")
        rc, _out, err = cli("fx/text.pdf", "--pages", "x")
        self.assertEqual(rc, 2)
        assert_reason(self, err, "--pages")

    def test_max_chars_cuts_the_head_and_names_the_way_out(self):
        rc, out, err = cli("fx/text.pdf", "--max-chars", "50")
        self.assertEqual(rc, 0, err)
        lines = text(out).rstrip("\n").splitlines()
        self.assertRegex(lines[-1], r"^\[truncated: \d+ more characters; use -o FILE or --pages\]$")
        body = "\n".join(lines[1:-1])
        self.assertLessEqual(len(body), 50)

    def test_stdout_never_exceeds_the_tail_sandboxd_keeps(self):
        rc, out, err = cli("fx/long.pdf", "--max-chars", "100000")
        self.assertEqual(rc, 0, err)
        self.assertBounded(out)
        lines = text(out).rstrip("\n").splitlines()
        self.assertRegex(lines[-1], r"^\[truncated: \d+ more characters")
        body = "\n".join(lines[1:-1])
        self.assertLessEqual(len(body), 15_000)
        self.assertGreater(len(body), 10_000)
        rc, out, _err = cli("fx/long.pdf")
        self.assertEqual(rc, 0)
        self.assertBounded(out)
        self.assertLessEqual(len("\n".join(text(out).splitlines()[1:-1])), 12_000)

    def test_dash_o_writes_the_whole_text_and_prints_one_line(self):
        os.makedirs(f"{WS}/out", exist_ok=True)
        rc, out, err = cli("fx/long.pdf", "-o", f"{WS}/out/long.txt")
        self.assertEqual(rc, 0, err)
        lines = text(out).splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertRegex(lines[0], r"^wrote /workspace/out/long\.txt · \d+ characters · pages 1-\d+ of \d+ · ocr 0$")
        with open(f"{WS}/out/long.txt", "rb") as f:
            data = f.read()
        self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
        written = data.decode("utf-8")
        self.assertIn("Línea 0000", written)
        self.assertIn("Línea 0479", written)
        self.assertNotIn("[truncated", written)

    def test_paths_outside_the_workspace_are_refused(self):
        for args in (
            ("fx/text.pdf", "-o", "/tmp/x.txt"),
            ("fx/text.pdf", "-o", "/etc/x"),
            ("/etc/hostname",),
            ("fx/missing.pdf",),
        ):
            rc, _out, err = cli(*args)
            self.assertEqual(rc, 4, (args, err))
            assert_reason(self, err)
        self.assertFalse(os.path.exists("/tmp/x.txt"))

    def test_types_and_help(self):
        rc, out, err = cli("--types")
        self.assertEqual(rc, 0, err)
        types = text(out).split()
        self.assertIn("pdf", types)
        self.assertEqual(len(types), len(set(types)))
        rc, out, err = cli("--help")
        self.assertEqual(rc, 0, err)
        for flag in ("--batch", "-o", "--pages", "--ocr"):
            self.assertIn(flag, text(out))
        rc, _out, err = cli()
        self.assertEqual(rc, 2)
        assert_reason(self, err)


def lol_run(value):
    """The longest run of consecutive `lol` in `value` (an expanded billion-laughs payload would be thousands)."""
    runs = [len(m.group(0)) // 3 for m in re.finditer(r"(?:lol)+", value)]
    return max(runs, default=0)


def body_of(out):
    return "\n".join(text(out).splitlines()[1:])


class Ocr(Base):
    def test_a_scanned_pdf_is_ocrd_page_by_page(self):
        rc, out, err = cli("fx/scan.pdf")
        self.assertEqual(rc, 0, err)
        self.assertBounded(out)
        result = text(out)
        self.assertTrue(result.splitlines()[0].endswith("· text 0 · ocr 2 ==="), result.splitlines()[0])
        p1, p2 = result.index("--- page 1 (ocr) ---"), result.index("--- page 2 (ocr) ---")
        self.assertIn("politica de devoluciones", fold(result[p1:p2]))
        self.assertIn("senalizacion de salidas", fold(result[p2:]))

    def test_ocr_never_reports_pages_without_a_text_layer(self):
        rc, out, err = cli("fx/scan.pdf", "--ocr", "never")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertTrue(result.splitlines()[0].endswith("· text 2 · ocr 0 ==="), result.splitlines()[0])
        self.assertIn("no text layer", result)
        self.assertNotIn("devoluciones", fold(result))

    def test_a_mixed_pdf_reads_one_page_and_ocrs_the_other(self):
        rc, out, err = cli("fx/mixed.pdf")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertIn("· text 1 · ocr 1 ===", result.splitlines()[0])
        self.assertIn("--- page 1 ---", result)
        self.assertIn("--- page 2 (ocr) ---", result)
        self.assertIn("facturación", result)
        self.assertIn("politica de devoluciones", fold(result))

    def test_ocr_always_ocrs_text_pages_too(self):
        rc, out, err = cli("fx/text.pdf", "--ocr", "always")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertIn("· text 0 · ocr 2 ===", result.splitlines()[0])
        self.assertIn("--- page 1 (ocr) ---", result)
        self.assertIn("--- page 2 (ocr) ---", result)
        self.assertIn("facturacion", fold(result))

    def test_a_huge_mediabox_is_rasterized_within_bounds(self):
        started = time.monotonic()
        rc, out, err = cli("fx/huge.pdf", timeout=180)
        self.assertEqual(rc, 0, err)
        self.assertLess(time.monotonic() - started, 120)
        self.assertBounded(out)

    def test_an_encrypted_pdf_exits_5_naming_the_password(self):
        rc, _out, err = cli("fx/encrypted.pdf")
        self.assertEqual(rc, 5, err)
        assert_reason(self, err, "password")

    def test_ocr_stops_at_50_pages_per_call(self):
        rc, out, err = cli("fx/ocr55.pdf", timeout=900)
        self.assertEqual(rc, 0, err)
        self.assertBounded(out)
        lines = text(out).rstrip("\n").splitlines()
        self.assertEqual(lines[0], "=== ocr55.pdf · pdf · pages 1-50 of 55 · text 0 · ocr 50 ===")
        self.assertEqual(lines[-1], "[ocr stopped at page 50 (50 pages per call): use --pages 51-55 or --batch]")

    def test_only_spanish_and_english_are_accepted(self):
        rc, _out, err = cli("fx/scan.pdf", "--lang", "deu")
        self.assertEqual(rc, 2)
        assert_reason(self, err, "--lang")


class Images(Base):
    def test_every_claimed_image_format_is_ocrd(self):
        for name, label in (
            ("sign.png", "PNG"),
            ("sign.webp", "WEBP"),
            ("sign.tiff", "TIFF"),
            ("sign.avif", "AVIF"),
            ("sign.heic", "HEIC"),
        ):
            with self.subTest(name=name):
                rc, out, err = cli(f"fx/{name}")
                self.assertEqual(rc, 0, err)
                self.assertBounded(out)
                result = text(out)
                kind = name.split(".")[1]
                self.assertTrue(result.startswith(f"=== {name} · {kind}"), result[:80])
                self.assertIn(f"image: {label} · 1400x240", result)
                self.assertIn("emergencia", fold(result))
        rc, out, _err = cli("--types")
        for kind in ("png", "webp", "tiff", "avif", "heic"):
            self.assertIn(kind, text(out).split())

    def test_an_image_over_the_pixel_cap_is_refused_before_it_is_decoded(self):
        """07.17.1.1.1 review WR-02: Pillow's own bomb error fires only above twice MAX_IMAGE_PIXELS; the cap is the
        documented 128 MP, so a 130 MP image is refused (exit 6), never decoded."""
        from PIL import Image

        path = f"{WS}/wide.png"
        Image.new("1", (13_000, 10_000), 1).save(path, "PNG")
        try:
            rc, _out, err = cli("wide.png", "--ocr", "always")
            self.assertEqual(rc, 6, err)
            assert_reason(self, err, "128000000 pixels")
        finally:
            os.unlink(path)

    def test_a_multi_page_tiff_is_checked_frame_by_frame(self):
        """A small first frame no longer hides a huge second one from the pixel cap (exiftool reads IFD0 only), and
        every frame within the cap is OCR'd."""
        import make_fixtures
        from PIL import Image

        huge = f"{WS}/pages-huge.tiff"
        small = make_fixtures.text_image(["Primera hoja del fax"], (1400, 240), 48)
        small.save(huge, "TIFF", save_all=True, append_images=[Image.new("1", (12_000, 11_000), 1)],
                   compression="tiff_deflate")
        both = f"{WS}/pages.tiff"
        second = make_fixtures.text_image(["Segunda hoja del fax"], (1400, 240), 48)
        small.save(both, "TIFF", save_all=True, append_images=[second], compression="tiff_deflate")
        try:
            rc, _out, err = cli("pages-huge.tiff")
            self.assertEqual(rc, 6, err)
            assert_reason(self, err, "frame 2", "128000000 pixels")
            rc, out, err = cli("pages.tiff")
            self.assertEqual(rc, 0, err)
            result = fold(text(out))
            self.assertIn("primera hoja", result)
            self.assertIn("segunda hoja", result)
            self.assertIn("--- frame 2 ---", result)
        finally:
            for path in (huge, both):
                os.unlink(path)

    def test_a_tiny_image_gets_metadata_only_in_auto_mode(self):
        rc, out, err = cli("fx/tiny.png")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertIn("image: PNG · 40x40", result)
        self.assertIn("too small to OCR", result)


class Office(Base):
    def test_writer_documents_come_out_as_clean_utf8(self):
        for name in ("plan.docx", "plan.odt", "plan.doc", "plan.rtf"):
            with self.subTest(name=name):
                rc, out, err = cli(f"fx/{name}")
                self.assertEqual(rc, 0, err)
                self.assertBounded(out)
                result = text(out)
                self.assertIn("Plan anual 2026", result)
                self.assertIn("Región Norte", result)

    def test_slides_keep_their_order(self):
        for name in ("slides.pptx", "slides.odp", "slides.ppt"):
            with self.subTest(name=name):
                rc, out, err = cli(f"fx/{name}")
                self.assertEqual(rc, 0, err)
                self.assertBounded(out)
                result = text(out)
                s1, s2 = result.index("### slide 1"), result.index("### slide 2")
                self.assertLess(s1, s2)
                self.assertIn("Plan de acción", result[s1:s2])
                self.assertIn("Próximos pasos", result[s2:])

    def test_slides_take_a_page_range(self):
        rc, out, err = cli("fx/slides.pptx", "--pages", "2-2")
        self.assertEqual(rc, 0, err)
        self.assertNotIn("### slide 1", text(out))
        self.assertIn("### slide 2", text(out))


class Sheets(Base):
    def test_every_sheet_is_csv_under_its_name(self):
        # .xls goes through LibreOffice (xlrd was dropped for its license): converted to .xlsx, then read like one.
        for name in ("ventas.xlsx", "ventas.xls", "ventas.ods"):
            with self.subTest(name=name):
                rc, out, err = cli(f"fx/{name}")
                self.assertEqual(rc, 0, err)
                self.assertBounded(out)
                result = text(out)
                v = result.index("### sheet: Ventas")
                self.assertIn("Región,Importe", result[v:])
                self.assertIn("Norte,1200", result[v:])
                self.assertIn("### sheet: Notas", result)
                self.assertLess(v, result.index("### sheet: Notas"))


class TextFormats(Base):
    def test_a_latin1_csv_comes_out_as_utf8(self):
        rc, out, err = cli("fx/latin1.csv")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertIn("### sheet: latin1", result)
        self.assertIn("Región;Importe;Año", result)
        self.assertIn("Logística, almacén y distribución", result)

    def test_json_is_text(self):
        rc, out, err = cli("fx/data.json")
        self.assertEqual(rc, 0, err)
        self.assertIn("Señora Pérez", text(out))

    def test_html_without_script_or_style(self):
        rc, out, err = cli("fx/page.html")
        self.assertEqual(rc, 0, err)
        result = text(out)
        self.assertIn("Texto visible", result)
        self.assertIn("Información pública", result)
        self.assertNotIn(make_fixtures.HTML_SCRIPT_TEXT, result)
        self.assertNotIn(make_fixtures.HTML_STYLE_TEXT, result)

    def test_entity_expansion_payloads_stay_unexpanded(self):
        with open(f"{FX}/lol.xml", encoding="utf-8") as f:
            source_run = lol_run(f.read())
        started = time.monotonic()
        rc, out, err = cli("fx/lol.xml", timeout=60)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(rc, 0, err)
        self.assertIn("Texto XML", text(out))
        self.assertLessEqual(lol_run(text(out)), source_run)
        started = time.monotonic()
        rc, out, err = cli("fx/lol.xlsx", timeout=60)
        self.assertLess(time.monotonic() - started, 10)
        self.assertIn(rc, (0, 7), err)
        self.assertLessEqual(lol_run(text(out) + err), source_run)
        if rc == 7:
            assert_reason(self, err, "entit")


class Hostile(Base):
    def test_a_load_event_macro_never_runs(self):
        marker = f"{FX}/{make_fixtures.MACRO_MARKER}"
        rc, out, err = cli("fx/macro.fodt")
        self.assertEqual(rc, 0, err)
        self.assertIn(make_fixtures.MACRO_TEXT, text(out))
        self.assertFalse(os.path.exists(marker))
        # A bot's own plain conversion, with its profile in /workspace, does not run it either (finalized ocw.xcd).
        profile = f"{WS}/.config/lo-test"
        try:
            proc = subprocess.run(
                [
                    "soffice",
                    "--headless",
                    "--norestore",
                    f"-env:UserInstallation=file://{profile}",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    f"{WS}/out-macro",
                    f"{FX}/macro.fodt",
                ],
                capture_output=True,
                timeout=180,
                env=make_fixtures.env(WS),
                cwd=WS,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-400:])
            self.assertTrue(os.path.isfile(f"{WS}/out-macro/macro.pdf"))
            self.assertFalse(os.path.exists(marker))
        finally:
            shutil.rmtree(f"{WS}/.config", ignore_errors=True)
            shutil.rmtree(f"{WS}/out-macro", ignore_errors=True)

    def test_an_office_zip_bomb_is_refused_before_any_parser(self):
        """07.17.1.1.1 review WR-04: an OOXML or ODF file is a zip too; its entries meet the archive caps (ratio, total,
        count) before python-pptx, openpyxl or LibreOffice decompresses anything (exit 6)."""
        import zipfile

        made = []

        def bombed(name, extra):
            path = f"{WS}/bomb-{name}"
            shutil.copyfile(f"{FX}/{name}", path)
            with zipfile.ZipFile(path, "a", zipfile.ZIP_DEFLATED) as z:
                for member, size in extra:
                    with z.open(member, "w", force_zip64=True) as f:
                        chunk = b"\0" * (1024 * 1024)
                        for _ in range(size):
                            f.write(chunk)
            made.append(path)
            return os.path.basename(path)

        try:
            for name in ("slides.pptx", "plan.docx", "ventas.xlsx", "plan.odt"):
                with self.subTest(name=name, kind="one entry packed 1000:1"):
                    rc, _out, err = cli(bombed(name, [("media/zeros.bin", 20)]), timeout=120)
                    self.assertEqual(rc, 6, err)
                    assert_reason(self, err, "caps: ratio")
            with self.subTest(kind="many small entries"):
                rc, _out, err = cli(bombed("ventas.xlsx", [(f"media/z{i}.bin", 9) for i in range(12)]), timeout=120)
                self.assertEqual(rc, 6, err)
                assert_reason(self, err, "caps: ratio")
            # The batch refuses the same file as a failed row, and the walk goes on.
            src = f"{WS}/bomb-pack"
            shutil.rmtree(src, ignore_errors=True)
            os.makedirs(src)
            shutil.move(made[0], f"{src}/bomb.pptx")
            shutil.copyfile(f"{FX}/latin1.csv", f"{src}/ok.csv")
            rc, _out, err = cli("--batch", src, timeout=300)
            self.assertEqual(rc, 0, err)
            with open(f"{WS}/extracted/bomb-pack/_index.tsv", encoding="utf-8") as f:
                rows = {line.split("\t")[0]: line.split("\t") for line in f.read().splitlines()[1:]}
            self.assertEqual(rows["bomb.pptx"][8], "failed")
            self.assertTrue(rows["bomb.pptx"][9].startswith("caps: ratio"), rows["bomb.pptx"])
            self.assertEqual(rows["ok.csv"][8], "done")
        finally:
            for path in made:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(path)
            shutil.rmtree(f"{WS}/bomb-pack", ignore_errors=True)
            shutil.rmtree(f"{WS}/extracted/bomb-pack", ignore_errors=True)

    def test_an_unknown_binary_is_unsupported(self):
        rc, _out, err = cli("fx/blob.bin")
        self.assertEqual(rc, 3)
        assert_reason(self, err, "application/octet-stream", "--types")


def workspace_files():
    found = set()
    for root, dirs, files in os.walk(WS):
        dirs[:] = [d for d in dirs if d != ".ocw-extract-tmp"]
        found.update(os.path.join(root, n) for n in files)
    return found


class Mail(Base):
    def test_an_eml_prints_headers_body_and_attachments(self):
        rc, out, err = cli("fx/pedido.eml")
        self.assertEqual(rc, 0, err)
        self.assertBounded(out)
        result = text(out)
        self.assertIn("From: Ana Gómez <ana@example.invalid>", result)
        self.assertIn("To: Equipo de ventas <ventas@example.invalid>", result)
        self.assertIn("Subject: Pedido 42", result)
        self.assertIn("Date: ", result)
        self.assertIn("Hola equipo", result)
        size = os.path.getsize(f"{FX}/text.pdf")
        self.assertIn(f"### attachment: factura.pdf · application/pdf · {size} bytes", result)

    def test_a_file_that_is_not_an_outlook_message_fails_naming_msgconvert(self):
        rc, _out, err = cli("fx/fake.msg")
        self.assertEqual(rc, 7, err)
        assert_reason(self, err, "msgconvert")


class Listing(Base):
    def test_archives_are_listed_never_extracted(self):
        before = workspace_files()
        sizes = {
            "a.txt": len(make_fixtures.ZIP_TEXT) + 1,
            "informe.pdf": os.path.getsize(f"{FX}/text.pdf"),
        }
        for name in ("pack.zip", "pack.7z", "pack.tar.gz"):
            with self.subTest(name=name):
                rc, out, err = cli(f"fx/{name}")
                self.assertEqual(rc, 0, err)
                self.assertBounded(out)
                result = text(out)
                self.assertIn("· entries 3 ===", result.splitlines()[0])
                for member, size in sizes.items():
                    self.assertIn(f"{member} · {size} bytes", result)
                self.assertRegex(result, r"(?m)^inner\.zip · \d+ bytes$")
        self.assertEqual(workspace_files(), before)

    def test_a_hostile_archive_is_only_listed(self):
        rc, out, err = cli("fx/traversal.zip")
        self.assertEqual(rc, 0, err)
        self.assertIn("../evil.txt · 8 bytes", text(out))
        self.assertFalse(os.path.exists(f"{WS}/evil.txt"))


if __name__ == "__main__":
    unittest.main()
