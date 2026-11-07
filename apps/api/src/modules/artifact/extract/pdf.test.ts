import { getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { GARBAGE_PDF, makeEncryptedPdf, makePdf } from "../../../testing-pdf";
import { pdfText } from "./pdf";

/**
 * 07.15-05 (BRA-02, D-05, D-12, PD-07): a PDF's text for a bot, parsed only inside a bounded Worker (unpdf 1.9.1,
 * PDF.js without eval), never on the API's event loop. Every failure is a fixed code.
 */

const CAPS = { pages: 100, chars: 64_000, ms: 10_000, heapMb: 256 };

/** `a.b.c` ≥ `x.y.z`, numerically. */
function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("pdfText", () => {
  it("returns both pages' text in page order through the worker", async () => {
    const bytes = makePdf(["Invoice 42 total 1300 EUR", "Second page: paid"]);
    const out = await pdfText(bytes, CAPS);
    expect(out).toMatchObject({ ok: true, pages: 2, totalPages: 2, truncated: false });
    if (!out.ok) throw new Error("expected text");
    const first = out.text.indexOf("Invoice 42 total 1300 EUR");
    const second = out.text.indexOf("Second page: paid");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it("bundles a PDF.js at least 4.2.67 (CVE-2024-4367 fixed)", async () => {
    const pdfjs = await getResolvedPDFJS();
    expect(atLeast(pdfjs.version, "4.2.67")).toBe(true);
  });

  it("leaves the caller's bytes usable: the worker got a fresh copy", async () => {
    const bytes = makePdf(["Kept"]);
    const before = bytes.byteLength;
    await pdfText(bytes, CAPS);
    expect(bytes.byteLength).toBe(before);
    expect(bytes.buffer.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("%PDF-1.4");
  });
});

describe("pdfText bounds and failures", () => {
  it("reads only the first 100 pages and reports the total", async () => {
    const bytes = makePdf(Array.from({ length: 105 }, (_, i) => `page${i + 1}`));
    const out = await pdfText(bytes, CAPS);
    expect(out).toMatchObject({ ok: true, pages: 100, totalPages: 105, truncated: true });
    if (!out.ok) throw new Error("expected text");
    expect(out.text).toContain("page100");
    expect(out.text).not.toContain("page101");
  });

  it("returns at most chars code units and marks the text truncated", async () => {
    const pages = ["a", "b", "c"].map((c) => c.repeat(30_000));
    const out = await pdfText(makePdf(pages), { ...CAPS, chars: 64_000 });
    expect(out).toMatchObject({ ok: true, truncated: true });
    if (!out.ok) throw new Error("expected text");
    expect(out.text.length).toBe(64_000);
  });

  it("answers no_text_layer for a PDF whose pages have no text", async () => {
    expect(await pdfText(makePdf(["", ""]), CAPS)).toEqual({ ok: false, code: "no_text_layer" });
  });

  it("answers encrypted for a password-protected PDF", async () => {
    expect(await pdfText(makeEncryptedPdf(), CAPS)).toEqual({ ok: false, code: "encrypted" });
  });

  it("answers extraction_failed for random bytes behind a PDF header", async () => {
    expect(await pdfText(GARBAGE_PDF, CAPS)).toEqual({ ok: false, code: "extraction_failed" });
  });
});
