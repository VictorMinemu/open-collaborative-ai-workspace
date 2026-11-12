"""Office and OpenDocument files through LibreOffice (phase 07.17.1.1.1, D-04, D-05, D-08, PD-06, PD-11).

One `soffice` call per conversion, headless, with a throwaway profile under /tmp (removed after) and the finalized
system defaults of `ocw.xcd` (macros never run, links never update); a conversion never requests macro execution, the
child has no proxy variable and the sandbox no other route out. Writer documents → LibreOffice's UTF-8 text filter
(BOM stripped), presentations → python-pptx text frames (pptx) or PDF → text per slide; never the print-to-stdout
mode, which emits Latin-1 (Pitfall 4). `.doc` falls back to catdoc and `.rtf` to unrtf when LibreOffice fails.
"""

import glob
import os
import re
import sys
import tempfile

from . import bounds, ocr, pdf, runner

TEXT_FILTER = "txt:Text (encoded):UTF8"
WRITER_FALLBACK = {
    "doc": ("catdoc", lambda path: ["catdoc", "-d", "utf-8", "-w", path]),
    "rtf": ("unrtf", lambda path: ["unrtf", "--text", path]),
}


def soffice_argv(profile_url, target, outdir, src):
    return [
        "soffice",
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        "--nodefault",
        f"-env:UserInstallation={profile_url}",
        "--convert-to",
        target,
        "--outdir",
        outdir,
        src,
    ]


def convert(path, target, steps, expect_one=True):
    """Convert `path` with LibreOffice into a fresh folder of the scratch directory; returns the one output file
    (or the folder when `expect_one` is False). Failures raise ConversionError, timeouts StepTimeout (exit 7)."""
    outdir = tempfile.mkdtemp(prefix="lo-out-", dir=runner.current_scratch())
    with runner.lo_profile() as profile:
        res = steps("soffice", soffice_argv(profile, target, outdir, path))
    produced = sorted(glob.glob(os.path.join(glob.escape(outdir), "*")))
    if not produced:
        reason = res.err_line() or "no output"
        raise bounds.ConversionError(f"LibreOffice could not convert {os.path.basename(path)}: {reason}")
    if not expect_one:
        return outdir
    return produced[0]


def read_utf8(path):
    with open(path, "rb") as f:
        data = f.read(bounds.OUTPUT_FILE_MAX_BYTES + 1)
    if len(data) > bounds.OUTPUT_FILE_MAX_BYTES:
        raise bounds.CapsError("the document's text is larger than 64 MiB")
    return bounds.clean_text(data.decode("utf-8", "replace"))


def writer_fallback(path, type_name, steps):
    kind, argv = WRITER_FALLBACK[type_name]
    res = steps(kind, argv(path))
    if res.returncode != 0:
        raise bounds.ConversionError(f"{kind} could not read {os.path.basename(path)}: {res.err_line()}")
    text = res.stdout.decode("utf-8", "replace")
    if kind == "unrtf":  # its banner lines start with ### and a dashed rule
        text = "\n".join(
            line for line in text.splitlines() if not line.startswith("###") and not re.fullmatch(r"-{5,}", line)
        )
    return bounds.clean_text(text)


def via_pdf(path, type_name, opts, unit):
    """Convert to PDF, then text (or OCR) per page; slides are `### slide N` blocks."""
    converted = convert(path, "pdf", opts.steps)
    total = pdf.info(converted, opts.steps)
    doc = bounds.Doc(type_name, "soffice+pdftotext")
    doc.unit = unit
    doc.total = total
    first, last = bounds.parse_pages(opts.pages, total) if opts.pages else (1, total)
    doc.first, doc.last = first, last
    mode = "always" if opts.ocr == "always" else "never"
    page_opts = Options(opts.steps, mode, opts.lang)
    for n in range(first, last + 1):
        text, used_ocr = pdf.page(converted, n, page_opts)
        if unit == "slides":
            doc.add(f"### slide {n}" + (" (ocr)" if used_ocr else "") + (f"\n{text}" if text.strip() else ""))
        else:
            doc.add(pdf.block(n, text, used_ocr))
        if used_ocr:
            doc.ocr_pages += 1
        else:
            doc.text_pages += 1
    if doc.ocr_pages:
        doc.method = "soffice+ocr"
    return doc


class Options:
    def __init__(self, steps, ocr_mode, lang, pages=None):
        self.steps = steps
        self.ocr = ocr_mode
        self.lang = lang
        self.pages = pages


def extract_writer(path, type_name, opts):
    if opts.ocr == "always":
        ocr.check_lang(opts.lang)
        return via_pdf(path, type_name, opts, "pages")
    doc = bounds.Doc(type_name, "soffice")
    try:
        doc.add(read_utf8(convert(path, TEXT_FILTER, opts.steps)))
    except bounds.ConversionError:
        if type_name not in WRITER_FALLBACK:
            raise
        doc.add(writer_fallback(path, type_name, opts.steps))
        doc.method = WRITER_FALLBACK[type_name][0]
    return doc


def shape_texts(shapes):
    for shape in shapes:
        if hasattr(shape, "shapes"):  # a group: its members, in order
            yield from shape_texts(shape.shapes)
            continue
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            text = shape.text_frame.text.strip()
            if text:
                yield text
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                cells = [c.text.strip() for c in row.cells]
                if any(cells):
                    yield " | ".join(cells)


def pptx_child(args):
    """Child entry: `pptx_child <path> <first|0> <last|0>`: first line `slides <n>`, then `### slide N` blocks."""
    path, first, last = args[0], int(args[1]), int(args[2])
    try:
        from . import sheets

        sheets.refuse_dtd(path)
        import pptx

        prs = pptx.Presentation(path)
        slides = list(prs.slides)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    total = len(slides)
    first = first or 1
    last = min(last or total, total)
    out = [f"slides {total}"]
    for n in range(first, last + 1):
        texts = list(shape_texts(slides[n - 1].shapes))
        out.append(f"### slide {n}" + ("\n" + "\n".join(texts) if texts else ""))
    sys.stdout.buffer.write(bounds.clean_text("\n".join(out)).encode("utf-8"))
    return 0


def extract_pptx(path, type_name, opts):
    """python-pptx text frames in slide order; the page range is checked against the slide count."""
    res = opts.steps.python("ocw_extract.office", "pptx_child", path, 0, 0)
    if res.returncode != 0:
        return None
    lines = res.stdout.decode("utf-8", "replace").split("\n", 1)
    m = re.fullmatch(r"slides (\d+)", lines[0])
    if not m:
        return None
    total = int(m.group(1))
    first, last = bounds.parse_pages(opts.pages, total) if opts.pages else (1, total)
    body = lines[1] if len(lines) > 1 else ""
    blocks = re.split(r"(?m)^(?=### slide \d+$)", body)
    doc = bounds.Doc(type_name, "python-pptx")
    doc.unit = "slides"
    doc.total = total
    doc.first, doc.last = (first, last) if total else (0, 0)
    for blk in blocks:
        m = re.match(r"### slide (\d+)", blk)
        if m and first <= int(m.group(1)) <= last:
            doc.add(blk)
    return doc


def extract_slides(path, type_name, opts):
    if type_name == "pptx" and opts.ocr != "always":
        doc = extract_pptx(path, type_name, opts)
        if doc is not None:
            return doc
    if opts.ocr == "always":
        ocr.check_lang(opts.lang)
    return via_pdf(path, type_name, opts, "slides")
