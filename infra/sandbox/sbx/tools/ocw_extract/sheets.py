"""Spreadsheets (phase 07.17.1.1.1, D-04, PD-11): one `### sheet: <name>` block of CSV (stdlib `csv`) per sheet.

xlsx/xlsm are read with openpyxl (`read_only=True, data_only=True`; defusedxml installed) in a child interpreter.
Legacy .xls and OpenDocument sheets go through LibreOffice to .xlsx first, which keeps the sheet order and names
(xlrd was dropped for its license); LibreOffice's UTF-8 CSV export of every sheet is the fallback. An OOXML part
that declares a DTD or an entity is refused before any parser sees it (OOXML never needs one).
"""

import csv
import datetime
import glob
import io
import os
import sys
import zipfile

from . import bounds, office

# LibreOffice's CSV filter: comma, double quote, UTF-8 (76), from line 1, …, every sheet (-1) (PD-11, Pitfall 4).
CSV_FILTER = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1"
XLSX_FILTER = "xlsx:Calc MS Excel 2007 XML"
DTD_SCAN_BYTES = 64 * 1024


def refuse_dtd(path):
    """Raise when any XML part of an OOXML zip declares a DTD or an entity (billion laughs, XXE)."""
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if not info.filename.endswith((".xml", ".rels", ".vml")):
                continue
            with z.open(info) as f:
                start = f.read(DTD_SCAN_BYTES)
            if b"<!DOCTYPE" in start or b"<!ENTITY" in start:
                raise ValueError(f"{info.filename} declares XML entities or a DTD (refused)")


def cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    return str(value)


def xlsx_child(args):
    """Child entry: `xlsx_child <path>` writes every sheet as `### sheet: <name>` + CSV to stdout."""
    path = args[0]
    try:
        refuse_dtd(path)
        import openpyxl

        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - one plain line for the parent
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    out = sys.stdout.buffer
    written = 0
    try:
        for ws in wb.worksheets:
            buf = io.StringIO()
            buf.write(f"### sheet: {ws.title}\n")
            writer = csv.writer(buf, lineterminator="\n")
            for row in ws.iter_rows(values_only=True):
                values = [cell(v) for v in row]
                while values and values[-1] == "":
                    values.pop()
                writer.writerow(values)
                if buf.tell() > 1024 * 1024:
                    written += out.write(buf.getvalue().encode("utf-8"))
                    buf = io.StringIO()
                    writer = csv.writer(buf, lineterminator="\n")
                if written > bounds.OUTPUT_FILE_MAX_BYTES:
                    sys.stderr.write("the workbook's text is larger than 64 MiB\n")
                    return bounds.EXIT_CAPS
            written += out.write(buf.getvalue().encode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{exc}\n")
        return bounds.EXIT_FAILED
    finally:
        wb.close()
    return 0


def read_xlsx(path, steps):
    res = steps.python("ocw_extract.sheets", "xlsx_child", path)
    if res.returncode != 0:
        code = bounds.EXIT_CAPS if res.returncode == bounds.EXIT_CAPS else bounds.EXIT_FAILED
        raise bounds.ExtractError(
            f"could not read the workbook {os.path.basename(path)}: {res.err_line() or 'damaged file'}", code
        )
    return res.stdout.decode("utf-8", "replace")


def via_csv(path, steps):
    """LibreOffice's CSV export of every sheet (`<stem>-<sheet>.csv`), in file-name order."""
    outdir = office.convert(path, CSV_FILTER, steps, expect_one=False)
    stem = os.path.splitext(os.path.basename(path))[0]
    parts = []
    for csv_path in sorted(glob.glob(os.path.join(glob.escape(outdir), "*.csv"))):
        name = os.path.splitext(os.path.basename(csv_path))[0]
        sheet = name[len(stem) + 1 :] if name.startswith(stem + "-") else name
        with open(csv_path, "rb") as f:
            parts.append(f"### sheet: {sheet}\n" + f.read().decode("utf-8", "replace").replace("﻿", ""))
    if not parts:
        raise bounds.ConversionError(f"LibreOffice exported no sheet from {os.path.basename(path)}")
    return "\n".join(parts)


def extract(path, type_name, opts):
    steps = opts.steps
    doc = bounds.Doc(type_name, "openpyxl")
    if type_name in ("xlsx", "xlsm"):
        doc.add(read_xlsx(path, steps))
        return doc
    try:
        converted = office.convert(path, XLSX_FILTER, steps)
        doc.add(read_xlsx(converted, steps))
        doc.method = "soffice+openpyxl"
    except bounds.StepTimeout:
        raise
    except bounds.ExtractError:
        doc.add(via_csv(path, steps))
        doc.method = "soffice-csv"
    return doc
