"""File type detection for `ocw-extract` (phase 07.17.1.1.1, D-04): `file -b --mime-type` plus an extension map.

The MIME type wins when it names a specific type; the extension decides when `file` only knows the container
(zip, OLE, plain text, XML, gzip). Anything else is unsupported (exit 3).
"""

import os

from . import bounds

# Every supported type, in the order `--types` prints them: name → (extensions, MIME types).
TYPES = {
    "pdf": ((".pdf",), ("application/pdf",)),
    "docx": (
        (".docx", ".docm"),
        (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-word.document.macroenabled.12",
        ),
    ),
    "doc": ((".doc",), ("application/msword",)),
    "odt": ((".odt",), ("application/vnd.oasis.opendocument.text",)),
    "fodt": ((".fodt",), ("application/vnd.oasis.opendocument.text-flat-xml",)),
    "rtf": ((".rtf",), ("text/rtf", "application/rtf")),
    "pptx": (
        (".pptx", ".pptm", ".ppsx"),
        (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
            "application/vnd.ms-powerpoint.presentation.macroenabled.12",
        ),
    ),
    "ppt": ((".ppt", ".pps"), ("application/vnd.ms-powerpoint",)),
    "odp": ((".odp",), ("application/vnd.oasis.opendocument.presentation",)),
    "fodp": ((".fodp",), ("application/vnd.oasis.opendocument.presentation-flat-xml",)),
    "xlsx": ((".xlsx",), ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",)),
    "xlsm": ((".xlsm",), ("application/vnd.ms-excel.sheet.macroenabled.12",)),
    "xls": ((".xls",), ("application/vnd.ms-excel",)),
    "ods": ((".ods",), ("application/vnd.oasis.opendocument.spreadsheet",)),
    "fods": ((".fods",), ("application/vnd.oasis.opendocument.spreadsheet-flat-xml",)),
    "csv": ((".csv",), ("text/csv",)),
    "tsv": ((".tsv", ".tab"), ("text/tab-separated-values",)),
    "txt": ((".txt", ".text", ".log"), ("text/plain",)),
    "md": ((".md", ".markdown"), ("text/markdown",)),
    "json": ((".json",), ("application/json",)),
    "xml": ((".xml",), ("text/xml", "application/xml")),
    "html": ((".html", ".htm", ".xhtml"), ("text/html", "application/xhtml+xml")),
    "eml": ((".eml",), ("message/rfc822",)),
    "msg": ((".msg",), ("application/vnd.ms-outlook",)),
    "zip": ((".zip",), ("application/zip",)),
    "7z": ((".7z",), ("application/x-7z-compressed",)),
    "tar": ((".tar",), ("application/x-tar",)),
    "tgz": ((".tar.gz", ".tgz"), ()),
    "png": ((".png",), ("image/png",)),
    "jpeg": ((".jpg", ".jpeg"), ("image/jpeg",)),
    "gif": ((".gif",), ("image/gif",)),
    "webp": ((".webp",), ("image/webp",)),
    "tiff": ((".tif", ".tiff"), ("image/tiff",)),
    "bmp": ((".bmp",), ("image/bmp", "image/x-ms-bmp")),
    "avif": ((".avif",), ("image/avif",)),
    "heic": ((".heic", ".heif"), ("image/heic", "image/heif")),
}

FAMILIES = {
    "pdf": ("pdf",),
    "writer": ("docx", "doc", "odt", "fodt", "rtf"),
    "slides": ("pptx", "ppt", "odp", "fodp"),
    "sheets": ("xlsx", "xlsm", "xls", "ods", "fods"),
    "text": ("csv", "tsv", "txt", "md", "json", "xml", "html"),
    "mail": ("eml", "msg"),
    "archive": ("zip", "7z", "tar", "tgz"),
    "image": ("png", "jpeg", "gif", "webp", "tiff", "bmp", "avif", "heic"),
}
FAMILY_OF = {t: fam for fam, types in FAMILIES.items() for t in types}

# `file` names only the container for these: the extension decides.
GENERIC_MIMES = {
    "application/octet-stream",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-ole-storage",
    "application/cdfv2",
    "application/vnd.ms-office",
    "application/xml",
    "text/xml",
    "text/plain",
    "application/gzip",
    "application/x-gzip",
    "inode/x-empty",
    "application/x-empty",
}

_BY_MIME = {m: name for name, (_, mimes) in TYPES.items() for m in mimes}


def by_extension(name):
    lower = name.lower()
    for type_name, (exts, _) in TYPES.items():
        for ext in exts:
            if lower.endswith(ext) and len(lower) > len(ext):
                if ext == ".gz" and not lower.endswith(".tar.gz"):
                    continue
                return type_name
    return None


def mime_type(path, steps):
    res = steps("file", ["file", "-b", "--mime-type", path])
    if res.returncode != 0:
        raise bounds.ConversionError(f"file could not read {os.path.basename(path)}")
    return res.stdout.decode("utf-8", "replace").strip().lower()


def decide(mime, name):
    """The type name for a MIME type and a file name, or None."""
    ext = by_extension(name)
    if ext == "tgz" and mime in ("application/gzip", "application/x-gzip", "application/x-tar"):
        return "tgz"
    by_mime = _BY_MIME.get(mime)
    if by_mime and mime not in GENERIC_MIMES:
        return by_mime
    if ext:
        return ext
    if by_mime:
        return by_mime
    if mime.startswith("text/") or mime in ("inode/x-empty", "application/x-empty"):
        return "txt"
    return None


def detect(path, steps):
    """(type name, MIME type) of `path`; unsupported types and password-protected Office files raise."""
    mime = mime_type(path, steps)
    if mime == "application/encrypted":
        raise bounds.EncryptedError(
            f"{os.path.basename(path)} is password-protected: open it with its password and save an unprotected copy"
        )
    found = decide(mime, os.path.basename(path))
    if not found:
        raise bounds.UnsupportedError(
            f"{os.path.basename(path)} is {mime}, which ocw-extract does not read; ocw-extract --types lists what it reads"
        )
    return found, mime


def family(type_name):
    return FAMILY_OF[type_name]
