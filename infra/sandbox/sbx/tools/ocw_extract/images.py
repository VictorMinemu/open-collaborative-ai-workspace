"""Images (phase 07.17.1.1.1, D-04, D-05; A-05): one metadata line from exiftool, then OCR in auto mode when the
short side is at least IMAGE_OCR_MIN_SIDE pixels (always / never override it).

Decoding for OCR happens in children only. Every PNG, JPEG, TIFF, WEBP and BMP is probed first (`probe_child`: its
frames and their sizes, from the headers): a frame over IMAGE_MAX_PIXELS is refused (exit 6) before anything decodes
it, and tesseract reads the file itself only when it has one frame within 3500 px. Multi-frame files (a fax TIFF) are
OCR'd frame by frame, up to IMAGE_MAX_FRAMES. AVIF, GIF and oversized images become a bounded PNG through Pillow
(`to_png_child`), HEIC through ImageMagick under its allow-list policy. Pillow's DecompressionBombWarning is an error
(07.17.1.1.1 review WR-02): its own error fires only above twice MAX_IMAGE_PIXELS.
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


def _pillow():
    """Pillow capped at exactly IMAGE_MAX_PIXELS: its warning band (1x to 2x the limit) is an error too."""
    import warnings

    from PIL import Image

    Image.MAX_IMAGE_PIXELS = bounds.IMAGE_MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    return Image


def _too_many_pixels(exc):
    return type(exc).__name__ in ("DecompressionBombError", "DecompressionBombWarning")


def _over(frame, width, height):
    return f"frame {frame} of the image is {width}x{height}: more than {bounds.IMAGE_MAX_PIXELS} pixels"


def probe_child(args):
    """Child entry: `probe_child <in>`: JSON `{"sizes": [[w, h], ...]}` of the first IMAGE_MAX_FRAMES frames and
    `"frames"`, read from the headers (nothing is decoded); exit 6 when a frame is over IMAGE_MAX_PIXELS."""
    import json

    src = args[0]
    try:
        Image = _pillow()
        with Image.open(src) as img:
            frames = getattr(img, "n_frames", 1)
            sizes = []
            for i in range(min(frames, bounds.IMAGE_MAX_FRAMES)):
                img.seek(i)
                width, height = img.size
                if width * height > bounds.IMAGE_MAX_PIXELS:
                    sys.stderr.write(_over(i + 1, width, height) + "\n")
                    return bounds.EXIT_CAPS
                sizes.append([width, height])
    except Exception as exc:  # noqa: BLE001
        if _too_many_pixels(exc):
            sys.stderr.write(f"the image has more than {bounds.IMAGE_MAX_PIXELS} pixels\n")
            return bounds.EXIT_CAPS
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    sys.stdout.write(json.dumps({"frames": frames, "sizes": sizes}))
    return 0


def to_png_child(args):
    """Child entry: `to_png_child <in> <out> <max_side> [frame]`: one frame (the first by default) as a PNG, its
    longest side bounded. Decoded once, reduced in place (no full-size copy), converted only once it is small."""
    src, dest, max_side = args[0], args[1], int(args[2])
    frame = int(args[3]) if len(args) > 3 else 0
    try:
        Image = _pillow()
        with Image.open(src) as img:
            img.seek(frame)
            width, height = img.size
            if width * height > bounds.IMAGE_MAX_PIXELS:
                sys.stderr.write(_over(frame + 1, width, height) + "\n")
                return bounds.EXIT_CAPS
            img.draft("L", (max_side, max_side))  # JPEG: decode at a reduced scale
            img.thumbnail((max_side, max_side))  # reduce first, then resize: never a second full-size image
            out = img if img.mode in ("L", "RGB") else img.convert("L")
            out.save(dest, "PNG")
    except Exception as exc:  # noqa: BLE001
        if _too_many_pixels(exc):
            sys.stderr.write(f"the image has more than {bounds.IMAGE_MAX_PIXELS} pixels\n")
            return bounds.EXIT_CAPS
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    return 0 if os.path.isfile(dest) else bounds.EXIT_FAILED
