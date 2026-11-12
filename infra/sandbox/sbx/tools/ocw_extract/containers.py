"""Office containers (07.17.1.1.1 review WR-04): an OOXML (docx, pptx, xlsx and their macro or show variants) or
OpenDocument (odt, odp, ods) file is a zip. Before python-pptx, openpyxl or LibreOffice decompresses a byte of it, a
child reads its central directory and applies the archive caps of PD-09 to its entries: an entry over 10 MiB packed
more than 100 to 1, the whole file packed more than 100 to 1, more than 10 000 entries, a total over
OFFICE_MAX_UNCOMPRESSED_BYTES (the parsers hold parts in memory), an absolute or `..` path, a link. A breach is exit 6,
in single-file mode and as a `failed` row in a batch. A file with an Office extension that is not a zip (an older
binary format renamed) is left to its parser.
"""

import os
import stat
import sys
import zipfile

from . import archives, bounds

OOXML = ("docx", "pptx", "xlsx", "xlsm")
ODF = ("odt", "odp", "ods")


def entries(z):
    out = []
    for info in z.infolist():
        mode = (info.external_attr >> 16) & 0o170000
        out.append(
            archives.Entry(
                info.filename,
                info.file_size,
                info.compress_size,
                is_dir=info.is_dir(),
                link=mode == stat.S_IFLNK,
                special=mode not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK),
            )
        )
    return out


def check_zip(path, z):
    """The first cap the container breaks, as `caps: …`, or None."""
    return archives.check_caps(entries(z), bounds.OFFICE_MAX_UNCOMPRESSED_BYTES, os.path.getsize(path))


def container_child(args):
    """Child entry: `container_child <path>`: exit 6 with the cap on stderr, 0 when it fits (or is not a zip)."""
    path = args[0]
    try:
        if not zipfile.is_zipfile(path):
            return 0
        with zipfile.ZipFile(path) as z:
            problem = check_zip(path, z)
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        sys.stderr.write(f"not a readable Office container: {exc}\n")
        return bounds.EXIT_FAILED
    if problem:
        sys.stderr.write(problem + "\n")
        return bounds.EXIT_CAPS
    return 0


def check(path, type_name, steps):
    """Raise CapsError (exit 6) or ConversionError (exit 7) when an OOXML/ODF container fails its checks; a no-op for
    every other type."""
    if type_name not in OOXML + ODF:
        return
    res = steps.python("ocw_extract.containers", "container_child", path)
    if res.returncode == bounds.EXIT_CAPS:
        raise bounds.CapsError(res.err_line() or "caps: the Office file breaks a cap")
    if res.returncode != 0:
        raise bounds.ConversionError(
            f"could not read {os.path.basename(path)}: {res.err_line() or 'not a readable Office container'}"
        )
