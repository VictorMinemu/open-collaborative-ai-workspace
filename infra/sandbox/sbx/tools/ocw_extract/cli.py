"""The `ocw-extract` command line (phase 07.17.1.1.1, D-04, D-11; the hub's CLI contract).

Exit codes: 0 ok · 2 usage · 3 unsupported type · 4 not found or outside /workspace · 5 encrypted (password needed) ·
6 too large or a cap hit · 7 conversion failed or timed out · 75 batch budget reached, more to do. Every non-zero exit
prints one line to stderr starting `ocw-extract: `.
"""

import argparse
import os
import sys

from . import bounds, detect, pdf, runner

DESCRIPTION = """\
Print the text of a file in your workspace as UTF-8: PDFs, scanned PDFs and images (OCR in Spanish and English),
Word, Excel, PowerPoint and OpenDocument files, CSV/JSON/XML/HTML, e-mails and archives (listing).
Output on stdout is capped (--max-chars, at most 15000 characters); use -o FILE for the whole text, or --pages.
--batch reads a whole folder or archive into a .txt mirror under /workspace/extracted/<name> with an index
(_index.tsv), in chunks: exit 75 means more to do, so run the same command again until it exits 0."""

EPILOG = """\
exit codes: 0 ok, 2 usage, 3 unsupported type, 4 not found or outside /workspace, 5 encrypted (password needed),
6 too large or a cap hit, 7 conversion failed or timed out, 75 batch budget reached (run it again)."""


class Options:
    """What every extractor reads: the OCR mode and language, the page range and the step runner."""

    def __init__(self, steps, ocr="auto", lang=bounds.DEFAULT_LANG, pages=None, batch=False):
        self.steps = steps
        self.ocr = ocr
        self.lang = lang
        self.pages = pages
        self.batch = batch


def handlers():
    """Family → extractor `fn(path, type_name, opts) -> Doc`."""
    return {"pdf": pdf.extract}


def supported_types():
    available = handlers()
    return [t for t in detect.TYPES if detect.family(t) in available]


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise bounds.UsageError(f"{message} (see ocw-extract --help)")


def parser():
    p = Parser(
        prog="ocw-extract",
        description=DESCRIPTION,
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("file", nargs="?", help="the file to read (under /workspace)")
    p.add_argument("--batch", metavar="DIR|ARCHIVE", help="read a whole folder or archive into a .txt mirror tree")
    p.add_argument("--out", metavar="DIR", help="--batch output folder (default /workspace/extracted/<name>)")
    p.add_argument(
        "--budget",
        metavar="SECONDS",
        help=f"--batch time budget per run (default {bounds.BATCH_DEFAULT_BUDGET_S}, at most {bounds.BATCH_MAX_BUDGET_S})",
    )
    p.add_argument(
        "--ocr",
        choices=("auto", "always", "never"),
        default="auto",
        help="auto: OCR pages and images without a text layer (default)",
    )
    p.add_argument("--pages", metavar="A-B", help="only these pages (PDFs, presentations)")
    p.add_argument(
        "--max-chars",
        metavar="N",
        default=str(bounds.DEFAULT_MAX_CHARS),
        help=f"characters on stdout (default {bounds.DEFAULT_MAX_CHARS}, at most {bounds.STDOUT_MAX_CHARS})",
    )
    p.add_argument("-o", metavar="FILE", dest="output", help="write the whole text to FILE (under /workspace)")
    p.add_argument(
        "--lang", default=bounds.DEFAULT_LANG, help="OCR language: spa, eng, spa+eng (default) or eng+spa"
    )
    p.add_argument("--types", action="store_true", help="list the supported file types, one per line")
    return p


def check_usage(args):
    modes = [bool(args.file), bool(args.batch), bool(args.types)]
    if sum(modes) != 1:
        raise bounds.UsageError("give one file, --batch <folder|archive> or --types (see ocw-extract --help)")
    if args.lang not in bounds.OCR_LANGS:
        raise bounds.UsageError(f"--lang must be one of {', '.join(bounds.OCR_LANGS)} (got {args.lang})")
    if args.file or args.types:
        for flag, value in (("--out", args.out), ("--budget", args.budget)):
            if value is not None:
                raise bounds.UsageError(f"{flag} works only with --batch")
    if args.batch or args.types:
        for flag, value in (("-o", args.output), ("--pages", args.pages)):
            if value is not None:
                raise bounds.UsageError(f"{flag} works only with a single file")


def write_stdout(data):
    stream = getattr(sys.stdout, "buffer", None)
    if stream is not None:
        sys.stdout.flush()
        stream.write(data)
        stream.flush()
    else:
        sys.stdout.write(data.decode("utf-8"))


def write_file(path, data):
    """Atomically: a temporary file in the same folder, then os.replace."""
    tmp = f"{path}.ocw-extract-{os.getpid()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def extract_file(path, opts):
    """Detect and extract one file (the caller holds a scratch directory)."""
    type_name, _mime = detect.detect(path, opts.steps)
    handler = handlers().get(detect.family(type_name))
    if handler is None:
        raise bounds.UnsupportedError(f"{os.path.basename(path)} ({type_name}) is not supported yet; see --types")
    return handler(path, type_name, opts)


def single(args):
    max_chars = bounds.parse_max_chars(args.max_chars)
    src = runner.confine(args.file)
    out = runner.confine(args.output, for_output=True) if args.output else None
    if out and out == src:
        raise bounds.UsageError("-o must not be the input file")
    opts = Options(runner.Steps(), ocr=args.ocr, lang=args.lang, pages=args.pages)
    with runner.scratch():
        doc = extract_file(src, opts)
    name = os.path.basename(src)
    if out:
        data = doc.full_text(name).encode("utf-8")
        if len(data) > bounds.OUTPUT_FILE_MAX_BYTES:
            raise bounds.CapsError(
                f"the text is larger than {bounds.OUTPUT_FILE_MAX_BYTES // (1024 * 1024)} MiB: use --pages for a part"
            )
        write_file(out, data)
        write_stdout(f"wrote {out} · {doc.summary(len(doc.body()))}\n".encode("utf-8"))
        return bounds.EXIT_OK
    write_stdout(bounds.bounded_stdout(doc.header(name), doc.body(), doc.notes, max_chars))
    return bounds.EXIT_OK


def batch(args):
    raise bounds.UsageError("--batch is not available in this build")


def run(argv):
    args = parser().parse_args(argv)
    check_usage(args)
    if args.types:
        write_stdout(("\n".join(supported_types()) + "\n").encode("utf-8"))
        return bounds.EXIT_OK
    if args.batch:
        return batch(args)
    return single(args)


def main(argv=None):
    if argv is None:
        runner.install_signal_handlers()
        argv = sys.argv[1:]
    try:
        return run(argv)
    except SystemExit as exc:  # --help, and the signal handlers
        return exc.code if isinstance(exc.code, int) else 0
    except bounds.ExtractError as exc:
        print(f"ocw-extract: {exc.reason}", file=sys.stderr)
        return exc.code
    except BrokenPipeError:
        return bounds.EXIT_FAILED
    except Exception as exc:  # noqa: BLE001 - one plain line, never a traceback
        print(f"ocw-extract: conversion failed ({type(exc).__name__}: {exc})", file=sys.stderr)
        return bounds.EXIT_FAILED
