"""PDFs (phase 07.17.1.1.1, D-04, PD-07): `pdfinfo` for the page count and encryption, then one `pdftotext -layout`
per page, so a huge document never sits in memory or on stdout at once."""

import os
import re

from . import bounds, ocr


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


def needs_ocr(text, mode):
    if mode == "always":
        return True
    if mode == "never":
        return False
    return bounds.nonspace_chars(text) < bounds.OCR_MIN_PAGE_CHARS


def page(path, n, opts, text=None):
    """One page: (text, ocr used). In auto mode a page with fewer than OCR_MIN_PAGE_CHARS non-space characters is
    OCR'd; a non-empty text layer is kept unless OCR found at least OCR_GAIN_MIN_CHARS more (a short title page
    stays text, a scan with a stamped page number becomes OCR)."""
    if opts.ocr != "always" and text is None:
        text = page_text(path, n, opts.steps)
    if not needs_ocr(text or "", opts.ocr):
        return text, False
    ocr_text = ocr.ocr_page(path, n, opts.lang, opts.steps)
    if opts.ocr == "auto":
        have = bounds.nonspace_chars(text or "")
        if have and bounds.nonspace_chars(ocr_text) < have + bounds.OCR_GAIN_MIN_CHARS:
            return text, False
    return ocr_text, True


def ranges(numbers):
    """[1, 2, 3, 7] → '1-3, 7'."""
    out = []
    for n in numbers:
        if out and out[-1][1] == n - 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ", ".join(f"{a}-{b}" if a != b else f"{a}" for a, b in out)


def extract(path, type_name, opts):
    steps = opts.steps
    ocr.check_lang(opts.lang)
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
    no_layer = []
    for n in range(first, last + 1):
        text = None if opts.ocr == "always" else page_text(path, n, steps)
        if needs_ocr(text or "", opts.ocr) and doc.ocr_pages >= bounds.OCR_PAGES_PER_CALL:
            doc.notes.append(
                f"[ocr stopped at page {n - 1} ({bounds.OCR_PAGES_PER_CALL} pages per call): "
                f"use --pages {n}-{last} or --batch]"
            )
            break
        result, used_ocr = page(path, n, opts, text)
        if opts.ocr == "never" and needs_ocr(result, "auto"):
            no_layer.append(n)
        doc.add(block(n, result, used_ocr))
        if used_ocr:
            doc.ocr_pages += 1
        else:
            doc.text_pages += 1
        doc.last = n
    if doc.ocr_pages:
        doc.method = "pdftotext+ocr" if doc.text_pages else "ocr"
    if no_layer:
        doc.notes.append(f"[pages with no text layer: {ranges(no_layer)}; use --ocr auto to OCR them]")
    return doc
