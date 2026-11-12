"""PDFs (phase 07.17.1.1.1, D-04, PD-07): `pdfinfo` for the page count and encryption, then one `pdftotext -layout`
per page, so a huge document never sits in memory or on stdout at once."""

import os
import re

from . import bounds


def info(path, steps):
    """The page count; a PDF that needs a password raises EncryptedError (exit 5)."""
    res = steps("pdfinfo", ["pdfinfo", path])
    reason = res.err_line()
    if res.returncode != 0:
        if re.search(r"password|encrypt", reason, re.IGNORECASE):
            raise bounds.EncryptedError(
                f"{os.path.basename(path)} is encrypted and needs a password; ocw-extract cannot open it"
            )
        raise bounds.ConversionError(f"pdfinfo could not read {os.path.basename(path)}: {reason or 'damaged PDF'}")
    m = re.search(r"^Pages:\s+(\d+)", res.stdout.decode("utf-8", "replace"), re.MULTILINE)
    if not m:
        raise bounds.ConversionError(f"pdfinfo found no page count in {os.path.basename(path)}")
    return int(m.group(1))


def page_text(path, n, steps):
    """The text layer of page `n` (UTF-8, layout kept)."""
    res = steps("pdftotext", ["pdftotext", "-layout", "-enc", "UTF-8", "-f", str(n), "-l", str(n), path, "-"])
    if res.returncode != 0:
        raise bounds.ConversionError(f"pdftotext failed on page {n}: {res.err_line() or 'damaged PDF'}")
    return bounds.clean_text(res.stdout.decode("utf-8", "replace")).strip("\n")


def block(n, text, ocr):
    mark = f"--- page {n} (ocr) ---" if ocr else f"--- page {n} ---"
    return f"{mark}\n{text}" if text.strip() else mark


def extract(path, type_name, opts):
    steps = opts.steps
    total = info(path, steps)
    doc = bounds.Doc(type_name, "pdftotext")
    doc.unit = "pages"
    doc.total = total
    if total == 0:
        doc.notes.append("[the PDF has no pages]")
        return doc
    first, last = bounds.parse_pages(opts.pages, total) if opts.pages else (1, total)
    doc.first = first
    doc.last = first - 1
    for n in range(first, last + 1):
        text = page_text(path, n, steps)
        doc.add(block(n, text, False))
        doc.text_pages += 1
        doc.last = n
    return doc
