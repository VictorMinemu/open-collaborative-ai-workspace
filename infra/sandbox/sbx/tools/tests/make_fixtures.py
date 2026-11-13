"""Test fixtures for `ocw-extract`, generated at test time inside the `sbx` image (phase 07.17.1.1.1, PD-03, D-07).

No network and no committed blobs: every file is written here with the stdlib, the toolkit venv (python-docx,
openpyxl, python-pptx, Pillow) and the image's own tools (soffice, qpdf, convert, 7zz). DejaVu Sans renders every
text. Importable (`make_all(out)`) and runnable:

    python3 make_fixtures.py <outdir> [--only name,name]     # prints the name → path map as JSON

`--only` builds just those fixtures and what they derive from (05's smoke uses it for the macro control). It runs
under the venv's interpreter and under the system `python3` with the toolkit PYTHONPATH (05 runs it in a bot's shell).
A fixture whose file already exists is not built again, so several test files share one set.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_NAME = "DejaVu Sans"
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TEXT_PAGE_1 = "Informe de facturación 2026"
TEXT_PAGE_2 = "Segunda página: Señalización"
SCAN_PAGE_1 = "Política de devoluciones"
SCAN_PAGE_2 = "Señalización de salidas"
SIGN_TEXT = "Señalización de emergencia"

_REGISTRY = {}


def fixture(name, *deps):
    """Register a builder `fn(out, paths) -> path` for `name`, built after `deps`."""

    def register(fn):
        _REGISTRY[name] = (deps, fn)
        return fn

    return register


def env(home):
    return {
        "PATH": SYSTEM_PATH,
        "LC_ALL": "C.UTF-8",
        "HOME": home,
        "TMPDIR": home,
        "OMP_THREAD_LIMIT": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }


def run(argv, timeout=180, cwd=None):
    """One argv, never a shell; raises with the tail of stderr when it fails."""
    home = tempfile.mkdtemp(prefix="fx-home-")
    try:
        proc = subprocess.run(
            argv, capture_output=True, timeout=timeout, cwd=cwd or home, env=env(home), check=False
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-600:]
        raise RuntimeError(f"{argv[0]} exited {proc.returncode}: {tail}")
    return proc


def soffice(src, fmt, outdir):
    """Convert with LibreOffice and a throwaway profile; returns the output path."""
    profile = tempfile.mkdtemp(prefix="fx-lo-", dir="/tmp")
    try:
        run(
            [
                "soffice",
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--nologo",
                "--nodefault",
                f"-env:UserInstallation=file://{profile}",
                "--convert-to",
                fmt,
                "--outdir",
                outdir,
                src,
            ]
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    ext = fmt.split(":", 1)[0]
    out = os.path.join(outdir, os.path.splitext(os.path.basename(src))[0] + "." + ext)
    if not os.path.isfile(out):
        raise RuntimeError(f"soffice did not write {os.path.basename(out)}")
    return out


def build_dir(out):
    path = os.path.join(out, "_build")
    os.makedirs(path, exist_ok=True)
    return path


def docx_with(paragraphs, path, page_breaks_after=()):
    import docx
    from docx.enum.text import WD_BREAK

    doc = docx.Document()
    doc.styles["Normal"].font.name = FONT_NAME
    for i, text in enumerate(paragraphs):
        par = doc.add_paragraph(text)
        if i in page_breaks_after:
            par.add_run().add_break(WD_BREAK.PAGE)
    doc.save(path)
    return path


def move(src, dest):
    shutil.move(src, dest)
    return dest


@fixture("text.pdf")
def _text_pdf(out, _paths):
    build = build_dir(out)
    docx_with([TEXT_PAGE_1, TEXT_PAGE_2], os.path.join(build, "text.docx"), page_breaks_after=(0,))
    return move(soffice(os.path.join(build, "text.docx"), "pdf", build), os.path.join(out, "text.pdf"))


LONG_LINE = "Línea {i:04d}: texto de prueba para el límite de salida del extractor de documentos."


@fixture("long.pdf")
def _long_pdf(out, _paths):
    build = build_dir(out)
    lines = [LONG_LINE.format(i=i) for i in range(480)]
    docx_with(lines, os.path.join(build, "long.docx"))
    return move(soffice(os.path.join(build, "long.docx"), "pdf", build), os.path.join(out, "long.pdf"))


def text_image(lines, size, font_px, path=None, fmt=None, **save):
    """A white grayscale page with black DejaVu text, one line per entry."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("L", size, 255)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, font_px)
    y = font_px
    for line in lines:
        draw.text((font_px, y), line, font=font, fill=0)
        y += int(font_px * 1.8)
    if path:
        img.save(path, fmt, **save)
    return img


A4_300DPI = (2480, 3508)


def image_pdf(pages, path, resolution=300.0):
    """An image-only PDF (no text layer): every page is a Pillow image."""
    pages[0].save(path, "PDF", resolution=resolution, save_all=True, append_images=pages[1:])
    return path


@fixture("scan.pdf")
def _scan_pdf(out, _paths):
    pages = [text_image([line], A4_300DPI, 64) for line in (SCAN_PAGE_1, SCAN_PAGE_2)]
    return image_pdf(pages, os.path.join(out, "scan.pdf"))


@fixture("mixed.pdf", "text.pdf", "scan.pdf")
def _mixed_pdf(out, paths):
    target = os.path.join(out, "mixed.pdf")
    run(["qpdf", "--empty", "--pages", paths["text.pdf"], "1", paths["scan.pdf"], "1", "--", target])
    return target


@fixture("huge.pdf")
def _huge_pdf(out, _paths):
    from PIL import Image, ImageDraw

    img = Image.new("L", (200, 200), 255)
    ImageDraw.Draw(img).rectangle((40, 40, 160, 160), fill=0)
    # 200 px at 1 dpi: a 14 400 pt MediaBox, 60 000 px wide at 300 dpi without -scale-to (Pitfall 6).
    return image_pdf([img], os.path.join(out, "huge.pdf"), resolution=1.0)


@fixture("encrypted.pdf", "text.pdf")
def _encrypted_pdf(out, paths):
    target = os.path.join(out, "encrypted.pdf")
    # A user password generated at run time and never written anywhere: nobody, ocw-extract included, can open it.
    run(["qpdf", "--encrypt", random_password(), random_password(), "256", "--", paths["text.pdf"], target])
    return target


OCR55_PAGES = 55


@fixture("ocr55.pdf")
def _ocr55_pdf(out, _paths):
    pages = [text_image([f"Página {n}"], (1200, 300), 64) for n in range(1, OCR55_PAGES + 1)]
    return image_pdf(pages, os.path.join(out, "ocr55.pdf"))


SIGN_SIZE = (1400, 240)


@fixture("sign.png")
def _sign_png(out, _paths):
    path = os.path.join(out, "sign.png")
    text_image([SIGN_TEXT], SIGN_SIZE, 48, path, "PNG")
    return path


@fixture("sign.webp")
def _sign_webp(out, _paths):
    path = os.path.join(out, "sign.webp")
    text_image([SIGN_TEXT], SIGN_SIZE, 48, path, "WEBP", lossless=True)
    return path


@fixture("sign.tiff")
def _sign_tiff(out, _paths):
    path = os.path.join(out, "sign.tiff")
    text_image([SIGN_TEXT], SIGN_SIZE, 48, path, "TIFF", compression="tiff_deflate")
    return path


@fixture("sign.avif")
def _sign_avif(out, _paths):
    """Written by Pillow (A-05): the format is claimed only if this fixture is written and read back."""
    path = os.path.join(out, "sign.avif")
    text_image([SIGN_TEXT], SIGN_SIZE, 48).convert("RGB").save(path, "AVIF", quality=90)
    return path


@fixture("sign.heic", "sign.png")
def _sign_heic(out, paths):
    """Written by ImageMagick (A-05), whose policy allows HEIC."""
    path = os.path.join(out, "sign.heic")
    run(["convert", paths["sign.png"], path])
    return path


@fixture("tiny.png")
def _tiny_png(out, _paths):
    path = os.path.join(out, "tiny.png")
    text_image(["x"], (40, 40), 20, path, "PNG")
    return path


@fixture("plan.docx")
def _plan_docx(out, _paths):
    import docx

    doc = docx.Document()
    doc.styles["Normal"].font.name = FONT_NAME
    doc.add_heading("Plan anual 2026", level=1)
    doc.add_paragraph("Objetivos de crecimiento por región.")
    table = doc.add_table(rows=2, cols=2)
    for (r, c), value in {(0, 0): "Región Norte", (0, 1): "1200", (1, 0): "Región Sur", (1, 1): "950"}.items():
        table.cell(r, c).text = value
    path = os.path.join(out, "plan.docx")
    doc.save(path)
    return path


def converted(out, src, fmt, name):
    return move(soffice(src, fmt, build_dir(out)), os.path.join(out, name))


@fixture("plan.odt", "plan.docx")
def _plan_odt(out, paths):
    return converted(out, paths["plan.docx"], "odt", "plan.odt")


@fixture("plan.doc", "plan.docx")
def _plan_doc(out, paths):
    return converted(out, paths["plan.docx"], "doc", "plan.doc")


@fixture("plan.rtf", "plan.docx")
def _plan_rtf(out, paths):
    return converted(out, paths["plan.docx"], "rtf", "plan.rtf")


SLIDES = ("Plan de acción", "Próximos pasos")


@fixture("slides.pptx")
def _slides_pptx(out, _paths):
    import pptx
    from pptx.util import Inches, Pt

    prs = pptx.Presentation()
    for title in SLIDES:
        slide = prs.slides.add_slide(prs.slide_layouts[5])  # title only
        slide.shapes.title.text = title
        box = slide.shapes.add_textbox(Inches(1), Inches(3), Inches(8), Inches(1))
        box.text_frame.text = f"Detalle: {title.lower()}"
        box.text_frame.paragraphs[0].runs[0].font.size = Pt(24)
    path = os.path.join(out, "slides.pptx")
    prs.save(path)
    return path


@fixture("slides.odp", "slides.pptx")
def _slides_odp(out, paths):
    return converted(out, paths["slides.pptx"], "odp", "slides.odp")


@fixture("slides.ppt", "slides.pptx")
def _slides_ppt(out, paths):
    return converted(out, paths["slides.pptx"], "ppt", "slides.ppt")


@fixture("ventas.xlsx")
def _ventas_xlsx(out, _paths):
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Ventas"
    for row in (("Región", "Importe"), ("Norte", 1200), ("Sur", 950)):
        ws.append(row)
    wb.create_sheet("Notas").append(("Revisado por el equipo de ventas",))
    path = os.path.join(out, "ventas.xlsx")
    wb.save(path)
    return path


@fixture("ventas.xls", "ventas.xlsx")
def _ventas_xls(out, paths):
    return converted(out, paths["ventas.xlsx"], "xls", "ventas.xls")


@fixture("ventas.ods", "ventas.xlsx")
def _ventas_ods(out, paths):
    return converted(out, paths["ventas.xlsx"], "ods", "ventas.ods")


LATIN1_CSV = (
    "Región;Importe;Año\n"
    "Norte;1200;2026\n"
    "Sur;950;2026\n"
    "Señalización;300;2025\n"
    "Comunicación y diseño;480;2025\n"
    "Logística, almacén y distribución;1500;2024\n"
)


@fixture("latin1.csv")
def _latin1_csv(out, _paths):
    path = os.path.join(out, "latin1.csv")
    with open(path, "wb") as f:
        f.write(LATIN1_CSV.encode("latin-1"))
    return path


@fixture("data.json")
def _data_json(out, _paths):
    path = os.path.join(out, "data.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cliente": "Señora Pérez", "importe": 1200, "líneas": ["uno", "dos"]}, f, ensure_ascii=False)
    return path


HTML_SCRIPT_TEXT = "codigo-del-script-que-no-debe-salir"
HTML_STYLE_TEXT = "estilo-que-no-debe-salir"


@fixture("page.html")
def _page_html(out, _paths):
    path = os.path.join(out, "page.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            "<!doctype html><html><head><meta charset='utf-8'><title>Página</title>"
            f"<style>.{HTML_STYLE_TEXT} {{ color: red }}</style>"
            f"<script>var x = '{HTML_SCRIPT_TEXT}';</script></head>"
            f"<body><h1>Texto visible</h1><p>Información pública</p><noscript>{HTML_SCRIPT_TEXT}</noscript>"
            "</body></html>"
        )
    return path


def entity_bomb(levels=3, fanout=10):
    """A billion-laughs DTD: `&lol<levels>;` would expand to 3 * fanout ** levels characters."""
    defs = ['<!ENTITY lol "lol">']
    prev = "lol"
    for level in range(1, levels + 1):
        name = f"lol{level}"
        defs.append(f'<!ENTITY {name} "{("&" + prev + ";") * fanout}">')
        prev = name
    return defs, prev


@fixture("lol.xml")
def _lol_xml(out, _paths):
    defs, top = entity_bomb()
    path = os.path.join(out, "lol.xml")
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f"<!DOCTYPE lolz [{''.join(defs)}]>\n"
            f"<lolz><title>Texto XML</title><payload>&{top};</payload></lolz>\n"
        )
    return path


@fixture("lol.xlsx", "ventas.xlsx")
def _lol_xlsx(out, paths):
    import zipfile

    defs, top = entity_bomb()
    sheet = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f"<!DOCTYPE worksheet [{''.join(defs)}]>\n"
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        f'<row r="1"><c r="A1" t="inlineStr"><is><t>&{top};</t></is></c></row>'
        "</sheetData></worksheet>"
    )
    path = os.path.join(out, "lol.xlsx")
    with zipfile.ZipFile(paths["ventas.xlsx"]) as src, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = sheet.encode("utf-8") if item.filename == "xl/worksheets/sheet1.xml" else src.read(item)
            dst.writestr(item.filename, data)
    return path


MACRO_MARKER = "MACRO-RAN"
MACRO_TEXT = "Documento con macro de prueba"


@fixture("macro.fodt")
def _macro_fodt(out, _paths):
    """A flat ODF text document with an embedded Basic module bound to its load event; the module writes
    <out>/MACRO-RAN. ocw-extract (and a plain soffice conversion) must never run it (D-08, PD-11)."""
    marker = os.path.join(out, MACRO_MARKER)
    path = os.path.join(out, "macro.fodt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"
 xmlns:ooo="http://openoffice.org/2004/office"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 xmlns:dom="http://www.w3.org/2001/xml-events"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:scripts>
  <office:script script:language="ooo:Basic">
   <ooo:libraries>
    <ooo:library-embedded ooo:name="Standard">
     <ooo:module ooo:name="Module1">
      <ooo:source-code>Sub Main
  Dim n As Integer
  n = FreeFile
  Open "{marker}" For Output As #n
  Print #n, "ran"
  Close #n
End Sub
</ooo:source-code>
     </ooo:module>
    </ooo:library-embedded>
   </ooo:libraries>
  </office:script>
  <office:event-listeners>
   <script:event-listener script:language="ooo:script" script:event-name="dom:load"
    xlink:type="simple"
    xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document"/>
  </office:event-listeners>
 </office:scripts>
 <office:body><office:text><text:p>{MACRO_TEXT}</text:p></office:text></office:body>
</office:document>
"""
        )
    return path


@fixture("blob.bin")
def _blob_bin(out, _paths):
    import random

    path = os.path.join(out, "blob.bin")
    with open(path, "wb") as f:
        f.write(b"\x00\x01OCW-BLOB\x02" + random.Random(7).randbytes(4096))
    return path


@fixture("pedido.eml", "text.pdf")
def _pedido_eml(out, paths):
    from email.message import EmailMessage
    from email.utils import format_datetime
    import datetime

    msg = EmailMessage()
    msg["From"] = "Ana Gómez <ana@example.invalid>"
    msg["To"] = "Equipo de ventas <ventas@example.invalid>"
    msg["Subject"] = "Pedido 42"
    msg["Date"] = format_datetime(datetime.datetime(2026, 11, 12, 10, 30, tzinfo=datetime.timezone.utc))
    msg.set_content("Hola equipo,\nadjunto la factura del pedido 42.\n")
    with open(paths["text.pdf"], "rb") as f:
        msg.add_attachment(f.read(), maintype="application", subtype="pdf", filename="factura.pdf")
    path = os.path.join(out, "pedido.eml")
    with open(path, "wb") as f:
        f.write(bytes(msg))
    return path


@fixture("fake.msg")
def _fake_msg(out, _paths):
    path = os.path.join(out, "fake.msg")
    with open(path, "wb") as f:
        f.write(b"This is not an Outlook message.\n" * 32)
    return path


ZIP_TEXT = "contenido del zip"


def pack_members(out, paths):
    """The files every pack archive holds: a.txt, informe.pdf (= text.pdf) and inner.zip (one b.txt)."""
    import zipfile

    folder = os.path.join(build_dir(out), "pack-members")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "a.txt"), "w", encoding="utf-8") as f:
        f.write(ZIP_TEXT + "\n")
    shutil.copyfile(paths["text.pdf"], os.path.join(folder, "informe.pdf"))
    with zipfile.ZipFile(os.path.join(folder, "inner.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("b.txt", "dentro del zip interior\n")
    return folder, ("a.txt", "informe.pdf", "inner.zip")


@fixture("pack.zip", "text.pdf")
def _pack_zip(out, paths):
    import zipfile

    folder, names = pack_members(out, paths)
    path = os.path.join(out, "pack.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:
            z.write(os.path.join(folder, name), name)
    return path


@fixture("pack.7z", "text.pdf")
def _pack_7z(out, paths):
    folder, names = pack_members(out, paths)
    path = os.path.join(out, "pack.7z")
    run(["7zz", "a", "-bd", path, *names], cwd=folder)
    return path


@fixture("pack.tar.gz", "text.pdf")
def _pack_tgz(out, paths):
    import tarfile

    folder, names = pack_members(out, paths)
    path = os.path.join(out, "pack.tar.gz")
    with tarfile.open(path, "w:gz") as t:
        for name in names:
            t.add(os.path.join(folder, name), name)
    return path


MIB = 1024 * 1024


def zeros_zip(path, name, mib):
    import zipfile

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z, z.open(name, "w") as f:
        for _ in range(mib):
            f.write(b"\0" * MIB)
    return path


@fixture("bomb.zip")
def _bomb_zip(out, _paths):
    return zeros_zip(os.path.join(out, "bomb.zip"), "zeros.bin", 60)


@fixture("big.zip")
def _big_zip(out, _paths):
    # Honest listing (5 MiB, under the 10 MiB ratio threshold): only a lowered cap catches it, through the watcher.
    return zeros_zip(os.path.join(out, "big.zip"), "big.bin", 5)


@fixture("traversal.zip")
def _traversal_zip(out, _paths):
    import zipfile

    path = os.path.join(out, "traversal.zip")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("ok.txt", "fine\n")
        z.writestr("../evil.txt", "escaped\n")
    return path


@fixture("link.zip")
def _link_zip(out, _paths):
    import zipfile

    path = os.path.join(out, "link.zip")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("ok.txt", "fine\n")
        info = zipfile.ZipInfo("passwd-link")
        info.external_attr = 0o120777 << 16  # a symbolic link entry
        z.writestr(info, "/etc/passwd")
    return path


PACK_LAYOUT = {
    "sub": ("text.pdf", "scan.pdf", "plan.docx", "ventas.xlsx"),
    "docs": ("slides.pptx", "sign.png", "latin1.csv", "page.html", "blob.bin", "pedido.eml"),
}


@fixture("pack", "pack.zip", *sorted({n for names in PACK_LAYOUT.values() for n in names}))
def _pack_folder(out, paths):
    """A folder like a knowledge pack: two sub-folders of fixtures, an archive and a link pointing outside."""
    root = os.path.join(out, "pack")
    staging = root + ".building"
    shutil.rmtree(staging, ignore_errors=True)
    for folder, names in PACK_LAYOUT.items():
        os.makedirs(os.path.join(staging, folder))
        for name in names:
            shutil.copyfile(paths[name], os.path.join(staging, folder, name))
    shutil.copyfile(paths["pack.zip"], os.path.join(staging, "pack.zip"))
    os.symlink("/etc/hostname", os.path.join(staging, "outside-link"))
    os.rename(staging, root)
    return root


@fixture("badpack", "bomb.zip", "traversal.zip", "link.zip")
def _badpack_folder(out, paths):
    """Hostile archives inside a folder walk: each is a failed row, the walk goes on."""
    root = os.path.join(out, "badpack")
    staging = root + ".building"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    for name in ("bomb.zip", "traversal.zip", "link.zip"):
        shutil.copyfile(paths[name], os.path.join(staging, name))
    with open(os.path.join(staging, "nota.txt"), "w", encoding="utf-8") as f:
        f.write("una nota legible\n")
    os.rename(staging, root)
    return root


def make_all(out, only=None):
    """Build the fixtures (all, or `only` and their dependencies) into `out`; returns name → path."""
    os.makedirs(out, exist_ok=True)
    wanted = list(_REGISTRY) if not only else []
    if only:

        def add(name):
            if name not in _REGISTRY:
                raise KeyError(f"unknown fixture {name}")
            for dep in _REGISTRY[name][0]:
                add(dep)
            if name not in wanted:
                wanted.append(name)

        for name in only:
            add(name)
    paths = {}
    for name in _REGISTRY:
        if name not in wanted:
            continue
        target = os.path.join(out, name)
        if os.path.lexists(target):
            paths[name] = target
            continue
        paths[name] = _REGISTRY[name][1](out, paths)
    return paths


def random_password():
    return secrets.token_hex(12)


def main(argv):
    args = list(argv)
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = [n for n in args[i + 1].split(",") if n]
        del args[i : i + 2]
    if len(args) != 1:
        print("usage: python3 make_fixtures.py <outdir> [--only name,name]", file=sys.stderr)
        return 2
    print(json.dumps(make_all(args[0], only), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
