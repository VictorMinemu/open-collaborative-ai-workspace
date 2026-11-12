"""Test fixtures for `ocw-extract`, generated at test time inside the `sbx` image (phase 07.17.1.1.1, PD-03, D-07).

No network and no committed blobs: every file is written here with the stdlib, the toolkit venv (python-docx,
openpyxl, python-pptx, Pillow) and the image's own tools (soffice, qpdf, convert, 7zz). DejaVu Sans renders every
text. Importable (`make_all(out)`) and runnable:

    python3 make_fixtures.py <outdir> [--only name,name]     # prints the name → path map as JSON

`--only` builds just those fixtures and what they derive from (05's smoke uses it for the macro control). It runs
under the venv's interpreter and under the system `python3` with the toolkit PYTHONPATH (05 runs it in a bot's shell).
A fixture whose file already exists is not built again, so several test files share one set.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_NAME = "DejaVu Sans"
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TEXT_PAGE_1 = "Informe de facturación 2026"
TEXT_PAGE_2 = "Segunda página: Señalización"
SCAN_PAGE_1 = "Política de devoluciones"
SCAN_PAGE_2 = "Señalización de salidas"
SIGN_TEXT = "Señalización de emergencia"

_REGISTRY = {}


def fixture(name, *deps):
    """Register a builder `fn(out, paths) -> path` for `name`, built after `deps`."""

    def register(fn):
        _REGISTRY[name] = (deps, fn)
        return fn

    return register


def env(home):
    return {
        "PATH": SYSTEM_PATH,
        "LC_ALL": "C.UTF-8",
        "HOME": home,
        "TMPDIR": home,
        "OMP_THREAD_LIMIT": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }


def run(argv, timeout=180, cwd=None):
    """One argv, never a shell; raises with the tail of stderr when it fails."""
    home = tempfile.mkdtemp(prefix="fx-home-")
    try:
        proc = subprocess.run(
            argv, capture_output=True, timeout=timeout, cwd=cwd or home, env=env(home), check=False
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-600:]
        raise RuntimeError(f"{argv[0]} exited {proc.returncode}: {tail}")
    return proc


def soffice(src, fmt, outdir):
    """Convert with LibreOffice and a throwaway profile; returns the output path."""
    profile = tempfile.mkdtemp(prefix="fx-lo-", dir="/tmp")
    try:
        run(
            [
                "soffice",
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--nologo",
                "--nodefault",
                f"-env:UserInstallation=file://{profile}",
                "--convert-to",
                fmt,
                "--outdir",
                outdir,
                src,
            ]
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    ext = fmt.split(":", 1)[0]
    out = os.path.join(outdir, os.path.splitext(os.path.basename(src))[0] + "." + ext)
    if not os.path.isfile(out):
        raise RuntimeError(f"soffice did not write {os.path.basename(out)}")
    return out


def build_dir(out):
    path = os.path.join(out, "_build")
    os.makedirs(path, exist_ok=True)
    return path


def docx_with(paragraphs, path, page_breaks_after=()):
    import docx
    from docx.enum.text import WD_BREAK

    doc = docx.Document()
    doc.styles["Normal"].font.name = FONT_NAME
    for i, text in enumerate(paragraphs):
        par = doc.add_paragraph(text)
        if i in page_breaks_after:
            par.add_run().add_break(WD_BREAK.PAGE)
    doc.save(path)
    return path


def move(src, dest):
    shutil.move(src, dest)
    return dest


@fixture("text.pdf")
def _text_pdf(out, _paths):
    build = build_dir(out)
    docx_with([TEXT_PAGE_1, TEXT_PAGE_2], os.path.join(build, "text.docx"), page_breaks_after=(0,))
    return move(soffice(os.path.join(build, "text.docx"), "pdf", build), os.path.join(out, "text.pdf"))


LONG_LINE = "Línea {i:04d}: texto de prueba para el límite de salida del extractor de documentos."


@fixture("long.pdf")
def _long_pdf(out, _paths):
    build = build_dir(out)
    lines = [LONG_LINE.format(i=i) for i in range(480)]
    docx_with(lines, os.path.join(build, "long.docx"))
    return move(soffice(os.path.join(build, "long.docx"), "pdf", build), os.path.join(out, "long.pdf"))


def make_all(out, only=None):
    """Build the fixtures (all, or `only` and their dependencies) into `out`; returns name → path."""
    os.makedirs(out, exist_ok=True)
    wanted = list(_REGISTRY) if not only else []
    if only:

        def add(name):
            if name not in _REGISTRY:
                raise KeyError(f"unknown fixture {name}")
            for dep in _REGISTRY[name][0]:
                add(dep)
            if name not in wanted:
                wanted.append(name)

        for name in only:
            add(name)
    paths = {}
    for name in _REGISTRY:
        if name not in wanted:
            continue
        target = os.path.join(out, name)
        if os.path.lexists(target):
            paths[name] = target
            continue
        paths[name] = _REGISTRY[name][1](out, paths)
    return paths


def random_password():
    return secrets.token_hex(12)


def main(argv):
    args = list(argv)
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = [n for n in args[i + 1].split(",") if n]
        del args[i : i + 2]
    if len(args) != 1:
        print("usage: python3 make_fixtures.py <outdir> [--only name,name]", file=sys.stderr)
        return 2
    print(json.dumps(make_all(args[0], only), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
