import { Readable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { GARBAGE_PDF, makeEncryptedPdf, makePdf } from "../../../testing-pdf";
import type { AttachmentRow } from "../model";
import { type AttachmentPart, attachmentKey, type ObjectStorage } from "../storage";
import { EXTRACT_LIMITS } from "./limits";
import { readAttachmentForAgent } from "./read";

/**
 * 07.15-04 (BRA-02, D-05, PD-07): what a bot gets when it reads a stored file. Text from at most the first
 * `EXTRACT_LIMITS.textReadBytes` bytes of the object (a range read, never the whole object), capped in UTF-16 code
 * units; images as the stored rendition or a bounded original; anything else a fixed refusal, never an exception.
 */

const ORG = "00000000-0000-7000-8000-00000000000a";
const CONV = "00000000-0000-7000-8000-00000000000b";
const CAPS = { charsPerFile: 64_000 };

let n = 0;
function row(over: Partial<AttachmentRow>): AttachmentRow {
  n++;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    organizationId: ORG,
    conversationId: CONV,
    messageId: "00000000-0000-7000-8000-00000000000d",
    workPromptId: null,
    workPromptPosition: null,
    uploaderId: "00000000-0000-7000-8000-00000000000c",
    filename: "file.bin",
    declaredType: "application/octet-stream",
    contentType: "application/octet-stream",
    sizeBytes: 10,
    sha256: null,
    status: "ready",
    scanStatus: "not_scanned",
    hasRenditions: false,
    largeBytes: null,
    width: null,
    height: null,
    eventId: null,
    createdAt: "2026-10-06T12:00:00.000Z",
    completedAt: "2026-10-06T12:00:01.000Z",
    purgedAt: null,
    ...over,
  } as AttachmentRow;
}

type Call = { method: "rangeGet" | "stream"; key: string; bytes?: number };

/** A typed in-memory store: objects per part of one row, every call recorded, methods the read never uses throw. */
function memoryStorage(
  target: AttachmentRow,
  parts: Partial<Record<AttachmentPart, Uint8Array>>,
  fail?: { rangeGet?: Error; stream?: Error },
) {
  const calls: Call[] = [];
  const objects = new Map<string, Uint8Array>();
  for (const [part, bytes] of Object.entries(parts) as Array<[AttachmentPart, Uint8Array]>)
    objects.set(attachmentKey(target.organizationId, target.conversationId, target.id, part), bytes);
  const unused = (name: string) => () => {
    throw new Error(`ObjectStorage.${name} is not used by the bot read layer`);
  };
  const storage: ObjectStorage = {
    bucket: "test",
    presignPut: unused("presignPut"),
    presignGet: unused("presignGet"),
    head: unused("head"),
    put: unused("put"),
    putStream: unused("putStream"),
    remove: unused("remove"),
    ensureBucketCors: unused("ensureBucketCors"),
    async rangeGet(key, bytes) {
      calls.push({ method: "rangeGet", key, bytes });
      if (fail?.rangeGet) throw fail.rangeGet;
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return body.slice(0, bytes);
    },
    async stream(key) {
      calls.push({ method: "stream", key });
      if (fail?.stream) throw fail.stream;
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return Readable.from([Buffer.from(body)]);
    },
  };
  return { storage, calls };
}

const enc = (s: string) => new TextEncoder().encode(s);
const keyOf = (r: AttachmentRow, part: AttachmentPart) =>
  attachmentKey(r.organizationId, r.conversationId, r.id, part);

describe("readAttachmentForAgent: text", () => {
  it("returns a Markdown file's text from one range read of the original, never streaming the object", async () => {
    const body = "# Hello\nworld\n";
    const md = row({
      filename: "notes.md",
      declaredType: "text/markdown",
      contentType: "application/octet-stream",
      sizeBytes: enc(body).length,
    });
    const { storage, calls } = memoryStorage(md, { original: enc(body) });
    expect(await readAttachmentForAgent(storage, md, CAPS)).toEqual({
      kind: "text",
      text: body,
      chars: 14,
      truncated: false,
    });
    expect(calls).toEqual([
      { method: "rangeGet", key: keyOf(md, "original"), bytes: EXTRACT_LIMITS.textReadBytes },
    ]);
    expect(EXTRACT_LIMITS.textReadBytes).toBe(262_144);
  });

  it("caps a large file at charsPerFile code units and marks it truncated", async () => {
    const big = row({ filename: "big.txt", declaredType: "text/plain", sizeBytes: 300_000 });
    const { storage, calls } = memoryStorage(big, { original: enc("a".repeat(300_000)) });
    const read = await readAttachmentForAgent(storage, big, CAPS);
    expect(read).toMatchObject({ kind: "text", chars: 64_000, truncated: true });
    expect(read.kind === "text" && read.text.length).toBe(64_000);
    expect(calls.map((c) => c.method)).toEqual(["rangeGet"]);
  });

  it("refuses a .docx as unsupported_type without touching the store", async () => {
    const docx = row({
      filename: "report.docx",
      declaredType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentType: "application/zip",
    });
    const { storage, calls } = memoryStorage(docx, { original: enc("PK") });
    expect(await readAttachmentForAgent(storage, docx, CAPS)).toEqual({
      kind: "refused",
      code: "unsupported_type",
    });
    expect(calls).toEqual([]);
  });

  it("answers unavailable when the store fails", async () => {
    const txt = row({ filename: "a.txt", declaredType: "text/plain" });
    const { storage } = memoryStorage(txt, {}, { rangeGet: new Error("connect ECONNREFUSED secret-text") });
    expect(await readAttachmentForAgent(storage, txt, CAPS)).toEqual({
      kind: "refused",
      code: "unavailable",
    });
  });

  it("reads a file of exactly textReadBytes whole, untruncated", async () => {
    const size = EXTRACT_LIMITS.textReadBytes;
    const exact = row({ filename: "exact.csv", declaredType: "text/csv", sizeBytes: size });
    const { storage } = memoryStorage(exact, { original: enc("a".repeat(size)) });
    expect(await readAttachmentForAgent(storage, exact, { ...CAPS, charsPerFile: size })).toMatchObject({
      kind: "text",
      chars: size,
      truncated: false,
    });
  });

  it("reads a 0-byte text file as empty text", async () => {
    const empty = row({ filename: "empty.txt", declaredType: "text/plain", sizeBytes: 0 });
    const { storage, calls } = memoryStorage(empty, { original: new Uint8Array() });
    expect(await readAttachmentForAgent(storage, empty, CAPS)).toEqual({
      kind: "text",
      text: "",
      chars: 0,
      truncated: false,
    });
    // S3 answers 416 InvalidRange to `bytes=0-…` on an empty object (07.15-08, found on Garage): no read at all.
    expect(calls).toEqual([]);
  });

  it("decodes a UTF-8 file whose last character the range cut split, trimming the partial tail", async () => {
    // 3-byte characters: 262 144 is not a multiple of 3, so the cut lands inside one.
    const body = enc("€".repeat(100_000));
    const euros = row({ filename: "prices.txt", declaredType: "text/plain", sizeBytes: body.length });
    const { storage } = memoryStorage(euros, { original: body });
    const read = await readAttachmentForAgent(storage, euros, CAPS);
    expect(read).toMatchObject({ kind: "text", chars: 64_000, truncated: true });
    expect(read.kind === "text" && read.text).toBe("€".repeat(64_000));
  });

  it("decodes a windows-1252 file", async () => {
    const legacy = row({ filename: "menu.txt", declaredType: "text/plain", sizeBytes: 4 });
    const { storage } = memoryStorage(legacy, { original: new Uint8Array([0x63, 0x61, 0x66, 0xe9]) });
    expect(await readAttachmentForAgent(storage, legacy, CAPS)).toEqual({
      kind: "text",
      text: "café",
      chars: 4,
      truncated: false,
    });
  });

  it("refuses bytes with a NUL in the first 8 KiB as unsupported_type", async () => {
    const bin = row({ filename: "data.txt", declaredType: "text/plain", sizeBytes: 6 });
    const { storage } = memoryStorage(bin, {
      original: new Uint8Array([0x61, 0x00, 0x00, 0x62, 0x63, 0x64]),
    });
    expect(await readAttachmentForAgent(storage, bin, CAPS)).toEqual({
      kind: "refused",
      code: "unsupported_type",
    });
  });

  it("WR-05: a store that answers more than the range is cut at textReadBytes, and the read is marked truncated", async () => {
    const big = row({ filename: "big.txt", declaredType: "text/plain", sizeBytes: 300_000 });
    const { storage } = memoryStorage(big, { original: enc("q".repeat(300_000)) });
    // A store (or proxy) that ignores Range: the whole object, whatever was asked.
    const ignoring: ObjectStorage = {
      ...storage,
      async rangeGet(key) {
        return storage.rangeGet(key, Number.MAX_SAFE_INTEGER);
      },
    };
    const read = await readAttachmentForAgent(ignoring, big, { charsPerFile: 400_000 });
    expect(read).toMatchObject({ kind: "text", chars: EXTRACT_LIMITS.textReadBytes, truncated: true });
  });
});

describe("readAttachmentForAgent: images", () => {
  const MiB = 1024 * 1024;
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

  it("gives the stored large.webp rendition, never the original, with the rendition's dimensions", async () => {
    const png = row({
      filename: "photo.png",
      declaredType: "image/png",
      contentType: "image/png",
      sizeBytes: 3 * MiB,
      hasRenditions: true,
      width: 4000,
      height: 3000,
    });
    const { storage, calls } = memoryStorage(png, { "large.webp": webp, original: new Uint8Array([9, 9]) });
    expect(await readAttachmentForAgent(storage, png, CAPS)).toEqual({
      kind: "image",
      mimeType: "image/webp",
      data: webp,
      width: 2048,
      height: 1536,
    });
    expect(calls).toEqual([{ method: "stream", key: keyOf(png, "large.webp") }]);
  });

  it("keeps a rendition's dimensions when the original was already within 2048 px, and null when unknown", async () => {
    const small = row({
      filename: "s.jpg",
      declaredType: "image/jpeg",
      contentType: "image/jpeg",
      hasRenditions: true,
      width: 800,
      height: 1200,
    });
    const a = memoryStorage(small, { "large.webp": webp });
    expect(await readAttachmentForAgent(a.storage, small, CAPS)).toMatchObject({ width: 800, height: 1200 });
    const unknown = row({ contentType: "image/png", declaredType: "image/png", hasRenditions: true });
    const b = memoryStorage(unknown, { "large.webp": webp });
    expect(await readAttachmentForAgent(b.storage, unknown, CAPS)).toMatchObject({
      width: null,
      height: null,
    });
  });

  it("gives the original of an image without renditions, with its sniffed type and the row's dimensions", async () => {
    const body = new Uint8Array(MiB).fill(7);
    const gif = row({
      filename: "anim.gif",
      declaredType: "image/gif",
      contentType: "image/gif",
      sizeBytes: MiB,
      width: 320,
      height: 240,
    });
    const { storage, calls } = memoryStorage(gif, { original: body });
    const out = await readAttachmentForAgent(storage, gif, CAPS);
    // The 1 MiB body is compared as bytes: a deep `toEqual` walks it element by element and took over 15 s on a loaded
    // CI host (p244).
    const { data, ...rest } = out as { data: Uint8Array };
    expect(rest).toEqual({ kind: "image", mimeType: "image/gif", width: 320, height: 240 });
    expect(Buffer.from(data).equals(Buffer.from(body))).toBe(true);
    expect(calls).toEqual([{ method: "stream", key: keyOf(gif, "original") }]);
  });

  it("refuses an original over 5 MiB without renditions as too_large, before any storage call", async () => {
    const huge = row({
      filename: "scan.png",
      declaredType: "image/png",
      contentType: "image/png",
      sizeBytes: EXTRACT_LIMITS.imageOriginalMaxBytes + 1,
    });
    const { storage, calls } = memoryStorage(huge, { original: new Uint8Array([1]) });
    expect(await readAttachmentForAgent(storage, huge, CAPS)).toEqual({ kind: "refused", code: "too_large" });
    expect(calls).toEqual([]);
  });

  it("answers too_large when the stored object is larger than the cap, whatever the row says", async () => {
    const liar = row({
      filename: "a.webp",
      declaredType: "image/webp",
      contentType: "image/webp",
      sizeBytes: 10,
    });
    const { storage } = memoryStorage(liar, {
      original: new Uint8Array(EXTRACT_LIMITS.imageOriginalMaxBytes + 1),
    });
    expect(await readAttachmentForAgent(storage, liar, CAPS)).toEqual({ kind: "refused", code: "too_large" });
  });

  it("answers unavailable on any other storage error and logs only the error's name", async () => {
    const png = row({ declaredType: "image/png", contentType: "image/png", hasRenditions: true });
    const { storage } = memoryStorage(png, {}, { stream: new Error("socket hang up: secret-content") });
    const logged: unknown[] = [];
    const log = {
      warn: (obj: unknown) => {
        logged.push(obj);
      },
    } as unknown as Pick<FastifyBaseLogger, "warn">;
    expect(await readAttachmentForAgent(storage, png, CAPS, { log })).toEqual({
      kind: "refused",
      code: "unavailable",
    });
    expect(logged).toEqual([{ err: { name: "Error" } }]);
    expect(JSON.stringify(logged)).not.toContain("secret-content");
  });

  it("returns an SVG as its markup, never as an image", async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const svg = row({
      filename: "logo.svg",
      declaredType: "image/svg+xml",
      contentType: "application/octet-stream",
      sizeBytes: enc(markup).length,
    });
    const { storage, calls } = memoryStorage(svg, { original: enc(markup) });
    expect(await readAttachmentForAgent(storage, svg, CAPS)).toEqual({
      kind: "text",
      text: markup,
      chars: markup.length,
      truncated: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["rangeGet"]);
  });

  it.each([
    ["page.html", "text/html", "<html><body onload=x()>hi</body></html>"],
    ["app.js", "text/javascript", "process.exit(1)"],
  ] as const)("returns %s as its text, never evaluated", async (filename, declaredType, body) => {
    const r = row({
      filename,
      declaredType,
      contentType: "application/octet-stream",
      sizeBytes: enc(body).length,
    });
    const { storage } = memoryStorage(r, { original: enc(body) });
    expect(await readAttachmentForAgent(storage, r, CAPS)).toMatchObject({ kind: "text", text: body });
  });
});

describe("readAttachmentForAgent: PDF", () => {
  const pdfRow = (bytes: Uint8Array) =>
    row({
      filename: "invoice.pdf",
      declaredType: "application/pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.length,
    });

  it("returns a stored PDF's text with its page count, streaming the original once", async () => {
    const bytes = makePdf(["Invoice 42 total 1300 EUR", "Second page: paid"]);
    const pdf = pdfRow(bytes);
    const { storage, calls } = memoryStorage(pdf, { original: bytes });
    const read = await readAttachmentForAgent(storage, pdf, CAPS);
    expect(read).toMatchObject({ kind: "text", pages: 2, truncated: false });
    if (read.kind !== "text") throw new Error("expected text");
    expect(read.text).toContain("Invoice 42 total 1300 EUR");
    expect(read.text).toContain("Second page: paid");
    expect(read.chars).toBe(read.text.length);
    expect(calls).toEqual([{ method: "stream", key: keyOf(pdf, "original") }]);
  });

  // WR-06: the PDF bound is a fixed 25 MiB, whatever the deployment's upload limit (here raised to 1 GiB).
  const RAISED = { ...CAPS, maxBytes: 1024 * 1024 * 1024 };

  it("is bounded at a fixed 25 MiB for PDFs", () => {
    expect(EXTRACT_LIMITS.pdfMaxBytes).toBe(25 * 1024 * 1024);
  });

  it("answers too_large before any read for a PDF over 25 MiB, even with a 1 GiB upload limit", async () => {
    const bytes = makePdf(["The row says this PDF is large"]);
    const pdf = row({ ...pdfRow(bytes), sizeBytes: 25 * 1024 * 1024 + 1 });
    const { storage, calls } = memoryStorage(pdf, { original: bytes });
    expect(await readAttachmentForAgent(storage, pdf, RAISED)).toEqual({
      kind: "refused",
      code: "too_large",
    });
    expect(calls).toEqual([]);
  });

  it("answers too_large once the stored object passes 25 MiB, whatever the row says", async () => {
    const head = makePdf(["The row says this PDF is small"]);
    const bytes = new Uint8Array(25 * 1024 * 1024 + 1);
    bytes.set(head);
    const pdf = row({ ...pdfRow(head), sizeBytes: 10 });
    const { storage, calls } = memoryStorage(pdf, { original: bytes });
    expect(await readAttachmentForAgent(storage, pdf, RAISED)).toEqual({
      kind: "refused",
      code: "too_large",
    });
    expect(calls.map((c) => c.method)).toEqual(["stream"]);
  });

  it("answers unavailable when the store fails", async () => {
    const pdf = pdfRow(makePdf(["x"]));
    const { storage } = memoryStorage(pdf, {}, { stream: new Error("socket hang up") });
    expect(await readAttachmentForAgent(storage, pdf, CAPS)).toEqual({
      kind: "refused",
      code: "unavailable",
    });
  });

  it("marks a PDF cut at the page limit as truncated", async () => {
    const bytes = makePdf(Array.from({ length: 105 }, (_, i) => `page${i + 1}`));
    const pdf = pdfRow(bytes);
    const { storage } = memoryStorage(pdf, { original: bytes });
    const read = await readAttachmentForAgent(storage, pdf, CAPS);
    expect(read).toMatchObject({ kind: "text", pages: EXTRACT_LIMITS.pdfPages, truncated: true });
  });

  it.each([
    ["a PDF with no text on any page", () => makePdf(["", ""]), "no_text_layer"],
    ["a password-protected PDF", () => makeEncryptedPdf(), "encrypted"],
    ["random bytes behind a PDF header", () => GARBAGE_PDF, "extraction_failed"],
  ] as const)("refuses %s with a fixed code", async (_label, make, code) => {
    const bytes = make();
    const pdf = pdfRow(bytes);
    const { storage } = memoryStorage(pdf, { original: bytes });
    expect(await readAttachmentForAgent(storage, pdf, CAPS)).toEqual({ kind: "refused", code });
  });
});
