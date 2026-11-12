"""Images (phase 07.17.1.1.1, D-04, D-05; A-05): one metadata line from exiftool, then OCR in auto mode when the
short side is at least IMAGE_OCR_MIN_SIDE pixels (always / never override it).

Decoding for OCR happens in children only: tesseract reads PNG, JPEG, TIFF, WEBP and BMP itself; AVIF, GIF and
oversized images become a bounded PNG through Pillow (`to_png_child`, at most IMAGE_MAX_PIXELS), HEIC through
ImageMagick under its allow-list policy.
"""

import json
import os
import re
import sys

from . import bounds, ocr

TAGS = ("-FileType", "-ImageSize", "-CreateDate", "-Title", "-Description")


def metadata(path, steps):
    res = steps("exiftool", ["exiftool", "-j", "-n", *TAGS, path])
    if res.returncode != 0:
        return {}
    try:
        rows = json.loads(res.stdout.decode("utf-8", "replace"))
    except ValueError:
        return {}
    return rows[0] if rows and isinstance(rows[0], dict) else {}


def size_of(meta):
    m = re.fullmatch(r"\s*(\d+)\s*[x ]\s*(\d+)\s*", str(meta.get("ImageSize", "")))
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def meta_line(meta, type_name, width, height):
    parts = [f"image: {meta.get('FileType') or type_name.upper()}"]
    if width and height:
        parts.append(f"{width}x{height}")
    for key, label in (("CreateDate", "created"), ("Title", "title"), ("Description", "description")):
        value = str(meta.get(key) or "").strip()
        if value:
            parts.append(f"{label} {value[:200]}")
    return " · ".join(parts)


def extract(path, type_name, opts):
    steps = opts.steps
    ocr.check_lang(opts.lang)
    meta = metadata(path, steps)
    width, height = size_of(meta)
    doc = bounds.Doc(type_name, "exiftool")
    doc.add(meta_line(meta, type_name, width, height))
    short = min(width, height) if width and height else None
    if opts.ocr == "never":
        return doc
    if opts.ocr == "auto" and short is not None and short < bounds.IMAGE_OCR_MIN_SIDE:
        doc.notes.append(
            f"[image too small to OCR (short side {short} px < {bounds.IMAGE_OCR_MIN_SIDE}); use --ocr always]"
        )
        return doc
    text = ocr.ocr_image(path, type_name, opts.lang, steps, width, height)
    doc.method = "exiftool+ocr"
    doc.add("--- ocr ---" + (f"\n{text}" if text else ""))
    if not text:
        doc.notes.append("[OCR found no text in the image]")
    return doc


def to_png_child(args):
    """Child entry: `to_png_child <in> <out> <max_side>`: the first frame as a PNG, its longest side bounded."""
    src, dest, max_side = args[0], args[1], int(args[2])
    try:
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = bounds.IMAGE_MAX_PIXELS
        with Image.open(src) as img:
            img.seek(0)
            frame = img.convert("L") if img.mode not in ("L", "RGB") else img.copy()
        frame.thumbnail((max_side, max_side))
        frame.save(dest, "PNG")
    except Exception as exc:  # noqa: BLE001
        if type(exc).__name__ == "DecompressionBombError":
            sys.stderr.write(f"the image has more than {bounds.IMAGE_MAX_PIXELS} pixels\n")
            return bounds.EXIT_CAPS
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    return 0 if os.path.isfile(dest) else bounds.EXIT_FAILED
