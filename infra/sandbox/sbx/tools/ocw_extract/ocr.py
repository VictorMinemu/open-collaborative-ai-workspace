"""OCR with tesseract in Spanish and English (phase 07.17.1.1.1, D-02, D-05, PD-07; Pitfall 6).

A PDF page is rasterized alone (`pdftoppm -r 300 -scale-to 3500 -gray`), OCR'd and its PNG deleted before the next,
so a huge MediaBox or a long scan never fills the memory-backed /tmp or the workspace. Images go to tesseract
directly; AVIF goes through Pillow and HEIC through ImageMagick (allow-listed coders only) to a PNG first (A-05).
"""

import contextlib
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


def to_png(path, type_name, steps, max_side=bounds.RASTER_SCALE_TO):
    """A PNG copy of an image in the scratch directory, its longest side at most `max_side`."""
    png = _scratch_file("image.png")
    if type_name == "heic":
        res = steps("convert", ["convert", f"{path}[0]", "-resize", f"{max_side}x{max_side}>", f"png:{png}"])
    else:
        res = steps.python("ocw_extract.images", "to_png_child", path, png, max_side)
    if res.returncode != 0 or not os.path.isfile(png):
        code = res.returncode if res.returncode in (bounds.EXIT_CAPS,) else bounds.EXIT_FAILED
        raise bounds.ExtractError(
            f"could not decode the {type_name.upper()} image: {res.err_line() or 'unreadable image'}", code
        )
    return png


def ocr_image(path, type_name, lang, steps, width=None, height=None):
    """OCR one image file; images over 3500 px or in a format tesseract cannot read become a bounded PNG first."""
    oversized = width is None or height is None or max(width, height) > bounds.RASTER_SCALE_TO
    if type_name in DIRECT and not oversized:
        return ocr_png(path, lang, steps)
    png = to_png(path, type_name, steps)
    try:
        return ocr_png(png, lang, steps)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(png)
