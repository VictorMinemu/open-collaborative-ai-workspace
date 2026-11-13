"""Office containers (07.17.1.1.1 review WR-04): an OOXML (docx, pptx, xlsx and their macro or show variants) or
OpenDocument (odt, odp, ods) file is a zip. Before python-pptx, openpyxl or LibreOffice decompresses a byte of it, a
child reads its central directory and applies the archive caps of PD-09 to its entries: an entry over 10 MiB packed
more than 100 to 1, the whole file packed more than 100 to 1, more than 10 000 entries, a total over
OFFICE_MAX_UNCOMPRESSED_BYTES (the parsers hold parts in memory), an absolute or `..` path, a link. A breach is exit 6,
in single-file mode and as a `failed` row in a batch. A file with an Office extension that is not a zip (an older
binary format renamed) is left to its parser.

The same child refuses an OOXML file any of whose parts declares a DTD or an entity (07.17.1.1.1 review WR-03; OOXML
never needs one). Every part is checked, whatever its name: lxml reads it up to its first element, in whatever encoding
its BOM or XML declaration names (UTF-8, UTF-16, UTF-32, …), with entities, DTD loading and the network off, and a
doctype or internal subset refuses the file. A part lxml cannot read but that starts like XML (a broken prolog, an
encoding lxml refuses) is scanned whole for `<!DOCTYPE` and `<!ENTITY` in UTF-8, UTF-16 and UTF-32 instead; media
and opaque blobs (printer settings embed a plist with a doctype) are never parsed by the readers and are skipped.
"""

import os
import stat
import sys
import zipfile

from . import archives, bounds

OOXML = ("docx", "pptx", "xlsx", "xlsm")
ODF = ("odt", "odp", "ods")
SCAN_CHUNK = 1024 * 1024
_CODECS = ("utf-8", "utf-16-le", "utf-16-be", "utf-32-le", "utf-32-be")
_NEEDLES = tuple(word.encode(codec) for word in ("<!DOCTYPE", "<!ENTITY") for codec in _CODECS)
_OVERLAP = max(len(n) for n in _NEEDLES)


class DtdRefused(Exception):
    pass


def _declares(z, info):
    """True when the part declares a doctype or an internal DTD subset (entities)."""
    from lxml import etree

    with z.open(info) as f:
        try:
            for _event, element in etree.iterparse(
                f,
                events=("start",),
                resolve_entities=False,
                load_dtd=False,
                no_network=True,
                huge_tree=False,
                dtd_validation=False,
            ):
                docinfo = element.getroottree().docinfo
                return bool(docinfo.doctype) or docinfo.internalDTD is not None
            return False
        except etree.LxmlError:
            pass
    with z.open(info) as f:
        if not _starts_like_xml(f.read(512)):
            return False  # media or an opaque blob (printer settings may embed a plist with a doctype): never parsed
    with z.open(info) as f:  # XML lxml cannot read: look for a declaration in every encoding a parser might take
        tail = b""
        while True:
            chunk = f.read(SCAN_CHUNK)
            if not chunk:
                return False
            window = tail + chunk
            if any(n in window for n in _NEEDLES):
                return True
            tail = window[-_OVERLAP:]


def _starts_like_xml(head):
    """True when the part's first character, in some encoding an XML parser detects, is `<` (after a BOM and
    whitespace): a broken or exotic XML part, as opposed to media or a binary blob."""
    for codec in _CODECS:
        text = head.decode(codec, "ignore").lstrip("\ufeff \t\r\n")
        if text.startswith("<"):
            return True
    return False


def refuse_dtd(z):
    """Raise DtdRefused naming the first part of the OOXML zip `z` that declares a DTD or an entity."""
    for info in z.infolist():
        if not info.is_dir() and _declares(z, info):
            raise DtdRefused(f"{info.filename} declares XML entities or a DTD (refused)")


def refuse_dtd_path(path):
    with zipfile.ZipFile(path) as z:
        refuse_dtd(z)


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
    """Child entry: `container_child <path> <type>`: exit 6 with the cap on stderr, 7 when an OOXML part declares a DTD
    or an entity, 0 when it passes (or is not a zip). The caps come first: nothing is decompressed before them."""
    path, type_name = args[0], args[1]
    try:
        if not zipfile.is_zipfile(path):
            return 0
        with zipfile.ZipFile(path) as z:
            problem = check_zip(path, z)
            if problem:
                sys.stderr.write(problem + "\n")
                return bounds.EXIT_CAPS
            if type_name in OOXML:
                refuse_dtd(z)
    except DtdRefused as exc:
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    except (zipfile.BadZipFile, OSError, ValueError, EOFError) as exc:
        sys.stderr.write(f"not a readable Office container: {exc}\n")
        return bounds.EXIT_FAILED
    return 0


def check(path, type_name, steps):
    """Raise CapsError (exit 6) or ConversionError (exit 7) when an OOXML/ODF container fails its checks; a no-op for
    every other type."""
    if type_name not in OOXML + ODF:
        return
    res = steps.python("ocw_extract.containers", "container_child", path, type_name)
    if res.returncode == bounds.EXIT_CAPS:
        raise bounds.CapsError(res.err_line() or "caps: the Office file breaks a cap")
    if res.returncode != 0:
        raise bounds.ConversionError(
            f"could not read {os.path.basename(path)}: {res.err_line() or 'not a readable Office container'}"
        )
