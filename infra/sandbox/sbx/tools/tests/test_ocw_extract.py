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
import signal
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
    "PYTHONPATH": "/opt/ocw-tools/venv/lib/python3.11/site-packages:/opt/ocw-packages/python",
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

    def test_a_child_past_its_timeout_is_killed_with_its_group(self):
        from ocw_extract import bounds, runner

        with runner.scratch():
            started = time.monotonic()
            with self.assertRaises(bounds.StepTimeout) as ctx:
                runner.run(["sh", "-c", "sleep 60 & sleep 60"], 1)
            self.assertLess(time.monotonic() - started, 10)
        pgid = ctx.exception.pgid
        self.assertIsInstance(pgid, int)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail("the child's process group outlived its timeout")
        self.assertEqual(ctx.exception.code, 7)

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
