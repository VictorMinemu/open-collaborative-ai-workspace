"""OCR with tesseract in Spanish and English (phase 07.17.1.1.1, D-02, D-05, PD-07; Pitfall 6).

A PDF page is rasterized alone (`pdftoppm -r 300 -scale-to 3500 -gray`), OCR'd and its PNG deleted before the next,
so a huge MediaBox or a long scan never fills the memory-backed /tmp or the workspace. Images are probed for their
frames and pixel count first; a single small frame goes to tesseract directly, anything else (AVIF through Pillow,
HEIC through ImageMagick with allow-listed coders only) to a bounded PNG per frame first (A-05, review WR-02).
"""

import contextlib
import json
import os

from . import bounds, runner

DIRECT = ("png", "jpeg", "tiff", "webp", "bmp")


def check_lang(lang):
    if lang not in bounds.OCR_LANGS:
        raise bounds.UsageError(f"--lang must be one of {', '.join(bounds.OCR_LANGS)} (got {lang})")
    return lang


def _scratch_file(name):
    where = runner.current_scratch()
    if not where:
        raise RuntimeError("OCR needs a scratch directory")
    return os.path.join(where, name)


def ocr_png(png, lang, steps):
    res = steps("tesseract", ["tesseract", png, "-", "-l", check_lang(lang)])
    if res.returncode != 0:
        raise bounds.ConversionError(f"tesseract failed: {res.err_line() or 'unreadable image'}")
    return bounds.clean_text(res.stdout.decode("utf-8", "replace")).strip()


def ocr_page(pdf, n, lang, steps):
    """Rasterize page `n` of `pdf` (bounded to 3500 px), OCR it, delete the PNG."""
    root = _scratch_file(f"page-{n}")
    png = root + ".png"
    try:
        res = steps(
            "pdftoppm",
            [
                "pdftoppm",
                "-r",
                str(bounds.RASTER_DPI),
                "-scale-to",
                str(bounds.RASTER_SCALE_TO),
                "-gray",
                "-png",
                "-singlefile",
                "-f",
                str(n),
                "-l",
                str(n),
                pdf,
                root,
            ],
        )
        if res.returncode != 0 or not os.path.isfile(png):
            raise bounds.ConversionError(f"pdftoppm could not rasterize page {n}: {res.err_line() or 'damaged page'}")
        return ocr_png(png, lang, steps)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(png)


def to_png(path, type_name, steps, max_side=bounds.RASTER_SCALE_TO, frame=0):
    """A PNG copy of one frame of an image in the scratch directory, its longest side at most `max_side`."""
    png = _scratch_file("image.png")
    if type_name == "heic":
        res = steps("convert", ["convert", f"{path}[0]", "-resize", f"{max_side}x{max_side}>", f"png:{png}"])
    else:
        res = steps.python("ocw_extract.images", "to_png_child", path, png, max_side, frame)
    if res.returncode != 0 or not os.path.isfile(png):
        code = res.returncode if res.returncode in (bounds.EXIT_CAPS,) else bounds.EXIT_FAILED
        raise bounds.ExtractError(
            f"could not decode the {type_name.upper()} image: {res.err_line() or 'unreadable image'}", code
        )
    return png


def probe(path, steps):
    """The image's frame count and the sizes of its first IMAGE_MAX_FRAMES frames, from its headers (a child); a
    frame over IMAGE_MAX_PIXELS raises CapsError (exit 6) before anything decodes it (07.17.1.1.1 review WR-02)."""
    res = steps.python("ocw_extract.images", "probe_child", path)
    if res.returncode == bounds.EXIT_CAPS:
        raise bounds.CapsError(res.err_line() or f"the image has more than {bounds.IMAGE_MAX_PIXELS} pixels")
    if res.returncode != 0:
        raise bounds.ConversionError(f"could not read the image: {res.err_line() or 'unreadable image'}")
    info = json.loads(res.stdout.decode("utf-8", "replace"))
    return int(info["frames"]), [tuple(s) for s in info["sizes"]]


def _ocr_frame(path, type_name, lang, steps, frame):
    png = to_png(path, type_name, steps, frame=frame)
    try:
        return ocr_png(png, lang, steps)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(png)


def ocr_image(path, type_name, lang, steps, width=None, height=None):
    """OCR one image file. PNG, JPEG, TIFF, WEBP and BMP are probed first; tesseract reads the file itself only when it
    has one frame within 3500 px. Other files, larger ones and every frame of a multi-frame file (up to
    IMAGE_MAX_FRAMES, `--- frame N ---` blocks) become a bounded PNG first."""
    if type_name not in DIRECT:
        return _ocr_frame(path, type_name, lang, steps, 0)
    frames, sizes = probe(path, steps)
    if frames == 1 and sizes and max(sizes[0]) <= bounds.RASTER_SCALE_TO:
        return ocr_png(path, lang, steps)
    if frames == 1:
        return _ocr_frame(path, type_name, lang, steps, 0)
    parts = []
    for i in range(len(sizes)):
        found = _ocr_frame(path, type_name, lang, steps, i)
        parts.append(f"--- frame {i + 1} ---" + (f"\n{found}" if found else ""))
    if frames > len(sizes):
        parts.append(f"[ocr stopped at frame {len(sizes)} of {frames} ({bounds.IMAGE_MAX_FRAMES} frames per call)]")
    return "\n".join(parts)
