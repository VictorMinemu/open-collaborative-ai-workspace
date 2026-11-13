"""Text formats (phase 07.17.1.1.1, D-04, D-05): plain text, Markdown, CSV/TSV and JSON of unknown encoding become
UTF-8 (charset-normalizer); HTML loses its scripts and styles (BeautifulSoup on lxml); XML is parsed without entity
expansion, DTD loading or network access (lxml `resolve_entities=False, no_network=True, huge_tree=False`).

The parsing runs in a child interpreter (`text_child`) with a step timeout, never in the `ocw-extract` process.
"""

import os
import sys

from . import bounds

DROP_TAGS = ("script", "style", "noscript", "template", "iframe", "object", "embed", "svg")


def read_capped(path):
    with open(path, "rb") as f:
        data = f.read(bounds.OUTPUT_FILE_MAX_BYTES + 1)
    return data[: bounds.OUTPUT_FILE_MAX_BYTES], len(data) > bounds.OUTPUT_FILE_MAX_BYTES


# Tried first when the bytes are not UTF-8: the owner's files are Spanish and English, and on short Spanish samples
# charset-normalizer's open guess prefers cp1250 ("Ańo" for "Año"). A non-Western text fails these with high chaos
# and falls through to the open detection (Cyrillic, Greek, Polish, Japanese verified).
WESTERN = ["cp1252", "latin_1", "iso8859_15"]


def decode(data):
    """UTF-8 when the bytes are UTF-8, else a Western codepage that decodes cleanly, else charset-normalizer."""
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    from charset_normalizer import from_bytes

    best = from_bytes(data, cp_isolation=WESTERN).best() or from_bytes(data).best()
    if best is not None:
        return str(best)
    return data.decode("utf-8", "replace")


def tidy(text):
    """Stripped lines, runs of blank lines collapsed to one."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip("\n")


def html_to_text(data):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(data, "lxml")
    for tag in soup(list(DROP_TAGS)):
        tag.decompose()
    return tidy(soup.get_text("\n"))


def xml_to_text(data):
    from lxml import etree

    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        huge_tree=False,
        load_dtd=False,
        dtd_validation=False,
        remove_comments=True,
        remove_pis=True,
    )
    root = etree.fromstring(data, parser)
    parts = []
    for node in root.iter():
        if not isinstance(node.tag, str):  # entity references, comments: never expanded or printed
            if node.tail and node.tail.strip():
                parts.append(node.tail.strip())
            continue
        if node.text and node.text.strip():
            parts.append(node.text.strip())
        if node is not root and node.tail and node.tail.strip():
            parts.append(node.tail.strip())
    return "\n".join(parts)


def text_child(args):
    """Child entry: `text_child <path> <kind>` writes the UTF-8 text to stdout. kind: text, html or xml."""
    path, kind = args[0], args[1]
    data, truncated = read_capped(path)
    if kind == "html":
        out = html_to_text(data)
    elif kind == "xml":
        try:
            out = xml_to_text(data)
        except Exception as exc:  # noqa: BLE001 - not well-formed: show the source text, still never expanded
            sys.stderr.write(f"not well-formed XML ({type(exc).__name__}); showing the source\n")
            out = decode(data)
    else:
        out = decode(data)
    sys.stdout.buffer.write(bounds.clean_text(out).encode("utf-8"))
    if truncated:
        sys.stdout.buffer.write(b"\n[the file is larger than 64 MiB: only its start was read]\n")
    return 0


KIND = {"html": "html", "xml": "xml"}


def extract(path, type_name, opts):
    res = opts.steps.python("ocw_extract.text", "text_child", path, KIND.get(type_name, "text"))
    if res.returncode != 0:
        raise bounds.ConversionError(f"could not read {os.path.basename(path)}: {res.err_line() or 'unreadable text'}")
    doc = bounds.Doc(type_name, {"html": "html", "xml": "xml"}.get(type_name, "text"))
    body = res.stdout.decode("utf-8", "replace")
    if type_name in ("csv", "tsv"):
        doc.add(f"### sheet: {os.path.splitext(os.path.basename(path))[0]}")
    doc.add(body)
    return doc
