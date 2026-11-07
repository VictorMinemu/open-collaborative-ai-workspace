import { randomBytes } from "node:crypto";
import { constants, createDeflate } from "node:zlib";

/**
 * PDF fixtures for the bot read layer (07.15-05): built byte by byte, so no test downloads or stores a binary file.
 *
 * - `makePdf(pages)`: a minimal valid PDF (catalog, page tree, one Helvetica text object per page, a correct xref).
 *   An empty string gives a page with no text at all (a scanned-like page).
 * - `makeEncryptedPdf()`: the same with a Standard security handler (V 1, R 2) whose O and U entries are random, so
 *   the empty user password fails and PDF.js raises `PasswordException`.
 * - `GARBAGE_PDF`: random-looking bytes behind a `%PDF-1.4` header (deterministic, so a run never flakes).
 * - `makeFlateBombPdf(inflatedBytes)`: a one-page PDF whose content stream is `FlateDecode` of `inflatedBytes` spaces
 *   (about 1 MB for 1 GiB): a decompression bomb (CR-01, 07.15 review).
 */

/** A PDF literal string body: backslash and both parentheses escaped; the text is Latin-1 (Helvetica's encoding). */
function literal(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Glyphs per line at 2 pt: at most 500 pt wide even for Helvetica's widest glyph, so all of it is on the page. */
const LINE = 250;

/**
 * One text object; long text is wrapped into lines that stay on the page (PDF.js drops glyphs outside the page box,
 * so a single 30 000-character line would come back as its first few dozen characters).
 */
function contentStream(text: string): string {
  if (text === "") return "";
  if (text.length <= 40) return `BT /F1 12 Tf 72 720 Td (${literal(text)}) Tj ET`;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += LINE) lines.push(`(${literal(text.slice(i, i + LINE))}) Tj T*`);
  return `BT /F1 2 Tf 2.4 TL 36 780 Td ${lines.join(" ")} ET`;
}

/** Objects numbered from 1, joined with a correct cross-reference table and trailer. */
function assemble(objects: string[], trailerExtra = ""): Uint8Array {
  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
}

/** Objects: 1 catalog, 2 page tree, 3 font, then a page and its content stream per page. */
function pdfObjects(pages: string[]): string[] {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const stream = contentStream(text);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  return objects;
}

export function makePdf(pages: string[]): Uint8Array {
  return assemble(pdfObjects(pages));
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function makeEncryptedPdf(): Uint8Array {
  const objects = pdfObjects(["This text is behind a password"]);
  objects.push(
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(randomBytes(32))}> /U <${hex(randomBytes(32))}> /P -4 >>`,
  );
  const encrypt = objects.length;
  const id = hex(randomBytes(16));
  return assemble(objects, ` /Encrypt ${encrypt} 0 R /ID [<${id}> <${id}>]`);
}

function garbage(): Uint8Array {
  const header = new TextEncoder().encode("%PDF-1.4\n");
  const out = new Uint8Array(header.length + 4096);
  out.set(header);
  let x = 0x2545_4446; // a fixed seed (xorshift32): the same bytes on every run
  for (let i = header.length; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export const GARBAGE_PDF: Uint8Array = garbage();

/**
 * A decompression bomb (CR-01): one page whose content stream inflates to `inflatedBytes` spaces. Deflated as a stream
 * from one reused 1 MiB chunk, so building it never holds more than about a megabyte (the tests measure this
 * process's memory).
 */
export async function makeFlateBombPdf(inflatedBytes: number): Promise<Uint8Array> {
  const deflate = createDeflate({ level: 9, strategy: constants.Z_RLE });
  const out: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.once("end", resolve);
    deflate.once("error", reject);
  });
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  for (let left = inflatedBytes; left > 0; left -= chunk.length) {
    const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  const stream = Buffer.concat(out);
  const latin1 = (text: string) => Buffer.from(text, "latin1");
  const parts: Buffer[] = [latin1("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = parts[0]?.length ?? 0;
  const object = (body: Buffer) => {
    offsets.push(at);
    const bytes = Buffer.concat([latin1(`${offsets.length} 0 obj\n`), body, latin1("\nendobj\n")]);
    parts.push(bytes);
    at += bytes.length;
  };
  object(latin1("<< /Type /Catalog /Pages 2 0 R >>"));
  object(latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  object(latin1("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"));
  object(
    Buffer.concat([
      latin1(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
      stream,
      latin1("\nendstream"),
    ]),
  );
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(latin1(xref));
  return new Uint8Array(Buffer.concat(parts));
}
