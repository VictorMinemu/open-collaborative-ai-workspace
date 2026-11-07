import { getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { GARBAGE_PDF, makeEncryptedPdf, makePdf } from "../../../testing-pdf";
import { EXTRACT_LIMITS } from "./limits";
import { pdfText, pdfWorkersInFlight } from "./pdf";

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

/**
 * Hostile workers (E12): a worker stuck in a synchronous loop, one that exhausts its heap, and one that posts a forged
 * message. `pdfText` resolves only after its worker is terminated, so the in-flight count returning to 0 proves the
 * thread is gone and the slot was given back.
 */
describe("pdfText under hostile workers", () => {
  const HANG = new URL("./fixtures/hang-worker.mjs", import.meta.url);
  const OOM = new URL("./fixtures/oom-worker.mjs", import.meta.url);
  const enc = (s: string) => new TextEncoder().encode(s);

  it("terminates a worker that never answers at the deadline: timeout", async () => {
    const started = Date.now();
    const out = await pdfText(enc("spin"), { ...CAPS, ms: 300 }, { workerUrl: HANG });
    expect(out).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers extraction_failed when the worker exhausts its heap", async () => {
    const started = Date.now();
    const out = await pdfText(enc("grow"), { ...CAPS, heapMb: 16 }, { workerUrl: OOM });
    expect(out).toEqual({ ok: false, code: "extraction_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers busy at once while two reads are in flight, and starts workers again once they end", async () => {
    expect(EXTRACT_LIMITS.pdfConcurrency).toBe(2);
    const first = pdfText(enc("spin"), { ...CAPS, ms: 1_000 }, { workerUrl: HANG });
    const second = pdfText(enc("spin"), { ...CAPS, ms: 1_000 }, { workerUrl: HANG });
    expect(pdfWorkersInFlight()).toBe(2);
    const started = Date.now();
    expect(await pdfText(makePdf(["Third"]), CAPS)).toEqual({ ok: false, code: "busy" });
    expect(Date.now() - started).toBeLessThan(50);
    expect(await first).toEqual({ ok: false, code: "timeout" });
    expect(await second).toEqual({ ok: false, code: "timeout" });
    expect(pdfWorkersInFlight()).toBe(0);
    expect(await pdfText(makePdf(["Fourth"]), CAPS)).toMatchObject({ ok: true, pages: 1 });
  });

  it("answers extraction_failed for a malformed worker message", async () => {
    const out = await pdfText(enc("malformed"), CAPS, { workerUrl: HANG });
    expect(out).toEqual({ ok: false, code: "extraction_failed" });
    expect(pdfWorkersInFlight()).toBe(0);
  });

  it("answers extraction_failed when the worker script cannot start, and gives the slot back", async () => {
    const missing = new URL("./fixtures/no-such-worker.mjs", import.meta.url);
    expect(await pdfText(enc("x"), CAPS, { workerUrl: missing })).toEqual({
      ok: false,
      code: "extraction_failed",
    });
    expect(pdfWorkersInFlight()).toBe(0);
  });
});
