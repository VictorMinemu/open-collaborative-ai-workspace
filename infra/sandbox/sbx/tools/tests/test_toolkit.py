"""The `sbx` document toolkit (phase 07.17.1.1.1, D-01, D-02, D-05, D-07, D-09; ADR-0043).

Stdlib `unittest` only, never copied into the image: `infra/sandbox/test/run-sbx-image-tests.sh <image>` streams this
directory into a container hardened exactly like a bot's shell (uid 10001, read-only root, cap-drop ALL,
no-new-privileges, noexec /tmp, 1 CPU, 1 GiB, 256 pids, no network) and runs it there.

Every child is an argv list with a timeout (never a shell). Nothing here touches the network: the ImageMagick URL case
is refused by the policy before any I/O, and the container has no network anyway.
"""

import os
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import unicodedata
import unittest
import xml.etree.ElementTree as ET
import zlib

# The Debian set approved before merge (07.17.1.1.1-07, PD-13): bookworm / bookworm-security `main` only.
TOOLKIT_PACKAGES = (
    "poppler-utils",
    "qpdf",
    "tesseract-ocr",
    "tesseract-ocr-eng",
    "tesseract-ocr-spa",
    "libreoffice-writer-nogui",
    "libreoffice-calc-nogui",
    "libreoffice-impress-nogui",
    "imagemagick",
    "7zip",
    "file",
    "libimage-exiftool-perl",
    "catdoc",
    "unrtf",
    "libemail-outlook-message-perl",
    "fonts-dejavu-core",
    "fonts-liberation2",
    "fonts-crosextra-carlito",
    "fonts-crosextra-caladea",
)

# Never in the image (D-05, D-09, PD-11, PD-13): no PostScript interpreter, no Java, no database connectors, no
# GStreamer backend, no GUI toolkit, no pandoc.
ABSENT_PACKAGES = (
    "ghostscript",
    "default-jre-headless",
    "openjdk-17-jre-headless",
    "libreoffice-sdbc-firebird",
    "libreoffice-sdbc-hsqldb",
    "libreoffice-base",
    "libreoffice-gtk3",
    "gstreamer1.0-libav",
    "pandoc",
)

# A version string from backports, trixie or experimental means a package came from outside bookworm.
FOREIGN_VERSION_MARKERS = ("bpo", "deb13", "~exp")

IM_POLICY = "/etc/ImageMagick-6/policy.xml"
LO_DEFAULTS = "/usr/lib/libreoffice/share/registry/ocw.xcd"
SOURCES = "/etc/apt/sources.list.d/debian.sources"
SKIP_WALK = ("/proc", "/sys", "/dev")
POLICY_REFUSAL = "not allowed by the security policy"


def child_env(home):
    """A minimal environment for every child: system paths, UTF-8, a private HOME, one OCR thread."""
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LC_ALL": "C.UTF-8",
        "HOME": home,
        "TMPDIR": home,
        "OMP_THREAD_LIMIT": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }


def run(argv, timeout=60, home=None, stdin=None):
    """Run one argv (never a shell) with a timeout; return (returncode, stdout, stderr) as text."""
    proc = subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        timeout=timeout,
        env=child_env(home or tempfile.gettempdir()),
        check=False,
    )
    return (
        proc.returncode,
        proc.stdout.decode("utf-8", "replace"),
        proc.stderr.decode("utf-8", "replace"),
    )


def fold(text):
    """NFC, casefold, accents stripped: OCR may drop an accent, never a letter."""
    decomposed = unicodedata.normalize("NFD", unicodedata.normalize("NFC", text).casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def tiny_png(path, side=8):
    """A valid grayscale PNG written with the stdlib (ImageMagick's own `xc:` coder is denied by the policy)."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff" * side for _ in range(side))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def dpkg_status(package):
    """(installed, version) from the dpkg database; an unknown package is not installed."""
    code, out, _ = run(["dpkg-query", "-W", "-f", "${Status}\t${Version}", package])
    if code != 0 or "\t" not in out:
        return False, ""
    status, version = out.split("\t", 1)
    return status.endswith(" installed"), version.strip()


class Scratch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ocw-toolkit-", dir="/tmp")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)


class ToolsPresent(Scratch):
    """Every toolkit command starts and reports what it is."""

    # (argv, accepted exit codes, a pattern its combined output must contain)
    CASES = (
        (["pdftotext", "-v"], (0,), r"pdftotext version 22\."),
        (["pdfinfo", "-v"], (0,), r"pdfinfo version 22\."),
        (["pdftoppm", "-v"], (0,), r"pdftoppm version 22\."),
        (["pdfimages", "-v"], (0,), r"pdfimages version 22\."),
        (["qpdf", "--version"], (0,), r"qpdf version 11\."),
        (["convert", "-version"], (0,), r"ImageMagick 6\."),
        (["7zz"], (0,), r"7-Zip"),
        (["file", "--version"], (0,), r"file-5\."),
        (["exiftool", "-ver"], (0,), r"^12\."),
        (["catdoc", "-V"], (0,), r"[Cc]atdoc [Vv]ersion"),
        (["unrtf", "--version"], (0,), r"0\.21\."),
        (["msgconvert", "--help"], (0, 1, 2), r"msgconvert"),
    )

    def test_each_tool_runs(self):
        for argv, codes, pattern in self.CASES:
            with self.subTest(tool=argv[0]):
                self.assertIsNotNone(shutil.which(argv[0]), f"{argv[0]} is not on PATH")
                code, out, err = run(argv, timeout=60, home=self.dir)
                self.assertIn(code, codes, f"{argv[0]} exited {code}: {err.strip()[:300]}")
                self.assertRegex(out + err, re.compile(pattern, re.M), f"{argv[0]} output: {(out + err)[:300]}")

    def test_soffice_is_libreoffice_7_4(self):
        code, out, err = run(["soffice", "--version"], timeout=120, home=self.dir)
        self.assertEqual(code, 0, err[:300])
        self.assertTrue(out.strip().startswith("LibreOffice 7.4"), out[:200])

    def test_tesseract_has_eng_spa_and_osd(self):
        code, out, err = run(["tesseract", "--list-langs"], home=self.dir)
        self.assertEqual(code, 0, err[:300])
        langs = {line.strip() for line in (out + err).splitlines()}
        for lang in ("eng", "spa", "osd"):
            self.assertIn(lang, langs)


class OcrChain(Scratch):
    """A text file goes LibreOffice -> PDF -> poppler -> PNG -> tesseract (spa+eng) -> the same Spanish text (D-07)."""

    def test_text_to_pdf_to_png_to_spanish_text(self):
        src = self.path("politica.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("Política de devoluciones\n\nSeñalización de salidas\n")
        profile = tempfile.mkdtemp(prefix="lo-", dir="/tmp")
        out_dir = self.path("out")
        os.mkdir(out_dir)
        try:
            code, _, err = run(
                [
                    "soffice",
                    "--headless",
                    "--norestore",
                    "--nolockcheck",
                    "--nologo",
                    "--nodefault",
                    f"-env:UserInstallation=file://{profile}",
                    "--infilter=Text (encoded):UTF8",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    out_dir,
                    src,
                ],
                timeout=120,
                home=self.dir,
            )
        finally:
            shutil.rmtree(profile, ignore_errors=True)
        pdf = os.path.join(out_dir, "politica.pdf")
        self.assertEqual(code, 0, err[:500])
        self.assertTrue(os.path.isfile(pdf), f"no PDF written: {err[:500]}")

        code, text, err = run(["pdftotext", "-enc", "UTF-8", pdf, "-"], home=self.dir)
        self.assertEqual(code, 0, err[:300])
        self.assertIn("Política de devoluciones", text)
        self.assertIn("Señalización de salidas", text)

        prefix = self.path("page")
        code, _, err = run(
            ["pdftoppm", "-r", "300", "-scale-to", "3500", "-gray", "-png", "-f", "1", "-l", "1", pdf, prefix],
            home=self.dir,
        )
        self.assertEqual(code, 0, err[:300])
        pngs = sorted(n for n in os.listdir(self.dir) if n.startswith("page") and n.endswith(".png"))
        self.assertEqual(len(pngs), 1, pngs)

        code, ocr, err = run(["tesseract", self.path(pngs[0]), "-", "-l", "spa+eng"], timeout=120, home=self.dir)
        self.assertEqual(code, 0, err[:300])
        self.assertIn("politica de devoluciones", fold(ocr), ocr[:500])
        self.assertIn("devoluciones", ocr)


class ImageMagickPolicy(Scratch):
    """Deny-all coders with an image allow-list (PD-12): images convert, everything else is refused before any I/O."""

    def test_png_converts_to_jpeg(self):
        src, dst = self.path("in.png"), self.path("out.jpg")
        tiny_png(src)
        code, _, err = run(["convert", src, dst], home=self.dir)
        self.assertEqual(code, 0, err[:300])
        with open(dst, "rb") as f:
            self.assertEqual(f.read(3), b"\xff\xd8\xff")

    def test_refuses_every_other_coder_and_at_file_reads(self):
        ps = self.path("x.ps")
        with open(ps, "w", encoding="ascii") as f:
            f.write("%!PS-Adobe-3.0\nshowpage\n")
        pdf = self.path("x.pdf")
        with open(pdf, "w", encoding="ascii") as f:
            f.write("%PDF-1.4\n%%EOF\n")
        eps = self.path("x.eps")
        with open(eps, "w", encoding="ascii") as f:
            f.write("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 8 8\nshowpage\n")
        for name in ("x.msl", "x.txt"):
            with open(self.path(name), "w", encoding="ascii") as f:
                f.write("hi\n")
        cases = {
            "PS": ps,
            "EPS": eps,
            "PDF": pdf,
            "HTTPS": "https://example.invalid/x.png",
            "MSL": f"msl:{self.path('x.msl')}",
            "TEXT": f"text:{self.path('x.txt')}",
            "LABEL": "label:hi",
            "@file": "@/etc/hostname",
        }
        for coder, source in cases.items():
            with self.subTest(coder=coder):
                code, _, err = run(["convert", source, self.path(f"out-{coder.strip('@')}.png")], home=self.dir)
                self.assertNotEqual(code, 0, f"{coder} was converted")
                self.assertIn(POLICY_REFUSAL, err, f"{coder}: {err[:300]}")


class ImageGate(unittest.TestCase):
    """The evidence the Debian set is approved on before merge (07 T3, PD-13), and the image's hardening (D-05, D-09)."""

    def test_toolkit_packages_installed_from_bookworm_only(self):
        lines = []
        for package in TOOLKIT_PACKAGES:
            installed, version = dpkg_status(package)
            lines.append(f"{package} {version or '(missing)'}")
            with self.subTest(package=package):
                self.assertTrue(installed, f"{package} is not installed")
        print("\n=== toolkit packages (dpkg-query -W) ===\n" + "\n".join(lines) + "\n=== end ===", flush=True)

        code, out, err = run(["dpkg-query", "-W", "-f", "${Package} ${Version}\n"])
        self.assertEqual(code, 0, err[:300])
        foreign = [line for line in out.splitlines() if any(m in line.split(" ", 1)[-1] for m in FOREIGN_VERSION_MARKERS)]
        self.assertEqual(foreign, [], "packages from outside bookworm")

        with open("/etc/debian_version", encoding="ascii") as f:
            self.assertTrue(f.read().startswith("12."))

    def test_absent_packages_and_programs(self):
        for package in ABSENT_PACKAGES:
            with self.subTest(package=package):
                installed, version = dpkg_status(package)
                self.assertFalse(installed, f"{package} {version} must not be installed")
        for program in ("gs", "java"):
            with self.subTest(program=program):
                self.assertIsNone(shutil.which(program))

    def test_apt_sources_are_bookworm_main_only(self):
        others = [n for n in os.listdir("/etc/apt/sources.list.d") if n != os.path.basename(SOURCES)]
        self.assertEqual(others, [])
        if os.path.exists("/etc/apt/sources.list"):
            with open("/etc/apt/sources.list", encoding="utf-8") as f:
                live = [ln for ln in f.read().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
            self.assertEqual(live, [])
        with open(SOURCES, encoding="utf-8") as f:
            text = f.read()
        suites, components = [], []
        for line in text.splitlines():
            key, _, value = line.partition(":")
            if key.strip() == "Suites":
                suites.append(value.strip())
            elif key.strip() == "Components":
                components.append(value.strip())
        self.assertEqual(sorted(suites), ["bookworm bookworm-updates", "bookworm-security"])
        self.assertTrue(components)
        self.assertEqual(set(components), {"main"})

    def test_no_setuid_or_setgid_file(self):
        found, unreadable, files = [], 0, 0

        def onerror(_err):
            nonlocal unreadable
            unreadable += 1

        for root, dirs, names in os.walk("/", onerror=onerror):
            if root == "/":
                dirs[:] = [d for d in dirs if f"/{d}" not in SKIP_WALK]
            for name in names:
                full = os.path.join(root, name)
                try:
                    st = os.lstat(full)
                except OSError:
                    unreadable += 1
                    continue
                files += 1
                if stat.S_ISREG(st.st_mode) and st.st_mode & (stat.S_ISUID | stat.S_ISGID):
                    found.append(full)
        print(f"\nsetuid walk: {files} files, {unreadable} unreadable entries (not walked)", flush=True)
        self.assertGreater(files, 10_000)
        self.assertEqual(found, [])

    def test_hardening_files_root_owned_and_read_only(self):
        for path in (IM_POLICY, LO_DEFAULTS):
            with self.subTest(path=path):
                st = os.stat(path)
                self.assertEqual(st.st_uid, 0)
                self.assertEqual(st.st_mode & 0o022, 0)
                self.assertFalse(os.access(path, os.W_OK))

    def test_libreoffice_defaults_are_finalized(self):
        ns = "{http://openoffice.org/2001/registry}"
        root = ET.parse(LO_DEFAULTS).getroot()
        finalized = {
            p.get(f"{ns}name"): p.findtext("value")
            for p in root.iter("prop")
            if p.get(f"{ns}finalized") == "true"
        }
        self.assertEqual(finalized.get("MacroSecurityLevel"), "3")
        self.assertEqual(finalized.get("DisableMacrosExecution"), "true")
        self.assertEqual(finalized.get("BlockUntrustedRefererLinks"), "true")
        links = [p.findtext("value") for p in root.iter("prop") if p.get(f"{ns}name") == "Link"]
        self.assertEqual(links, ["1", "1"])


if __name__ == "__main__":
    unittest.main()
