import { SANDBOX_LIMITS } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { attachmentDisposition, classifyPreview, imageTypeOf, looksText } from "./files";

/**
 * 07.8-11 Task 2 (D-04, T-07.8-11-02): what the bot page may show for a sandbox file, decided on the server. The
 * in-memory sandboxd keeps files as UTF-8 text, so the binary signatures (PNG, JPEG) are proven here.
 */

const bytes = (...b: number[]) => Uint8Array.from(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("imageTypeOf: the four raster signatures", () => {
  it("png, jpeg, gif (87a and 89a) and webp; anything else is not an image", () => {
    expect(imageTypeOf(PNG)).toBe("image/png");
    expect(imageTypeOf(JPEG)).toBe("image/jpeg");
    expect(imageTypeOf(utf8("GIF87a..."))).toBe("image/gif");
    expect(imageTypeOf(utf8("GIF89a..."))).toBe("image/gif");
    expect(imageTypeOf(utf8("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(imageTypeOf(utf8("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBeNull();
    expect(imageTypeOf(utf8("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageTypeOf(bytes())).toBeNull();
  });
});

describe("looksText: valid UTF-8 and no NUL in the first 8 KB", () => {
  it("accepts text, refuses NUL and invalid sequences, tolerates a sequence cut by the sample", () => {
    expect(looksText(utf8("month,revenue\njul,1200\n"))).toBe(true);
    expect(looksText(utf8("abc\u0000def"))).toBe(false);
    expect(looksText(bytes(0x61, 0xc3, 0x28))).toBe(false);
    // "é" (c3 a9) split at the 8 KB boundary of a longer file.
    const long = new Uint8Array(8193 + 10).fill(0x61);
    long[8191] = 0xc3;
    long[8192] = 0xa9;
    expect(looksText(long)).toBe(true);
  });
});

describe("classifyPreview", () => {
  it("text up to 256 KB; past it too_large", () => {
    expect(classifyPreview("q3.csv", utf8("a,b\n"), 4)).toEqual({ kind: "text", text: "a,b\n" });
    const max = SANDBOX_LIMITS.previewTextMaxBytes;
    expect(classifyPreview("big.txt", new Uint8Array(max).fill(0x61), max + 1)).toEqual({
      kind: "too_large",
    });
  });

  it("a raster image up to 5 MB, by its bytes whatever its name; past it too_large", () => {
    expect(classifyPreview("chart.png", PNG, 1000)).toEqual({ kind: "image", mimeType: "image/png" });
    expect(classifyPreview("photo.dat", JPEG, 1000)).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(classifyPreview("huge.png", PNG, SANDBOX_LIMITS.previewImageMaxBytes + 1)).toEqual({
      kind: "too_large",
    });
  });

  it("SVG and HTML are never previewed (by name or by markup); other bytes are binary", () => {
    for (const [name, text] of [
      ["pic.svg", "<svg/>"],
      ["page.htm", "hi"],
      ["page.xhtml", "hi"],
      ["page.txt", "  <!doctype html><p>x</p>"],
      ["notes.md", "<svg onload=alert(1)>"],
      ["data.txt", `${String.fromCharCode(0xfeff)}<?xml version='1.0'?><svg/>`],
    ] as const) {
      expect(classifyPreview(name, utf8(text), utf8(text).length), name).toEqual({ kind: "binary" });
    }
    expect(classifyPreview("blob.bin", bytes(1, 2, 0, 3), 4)).toEqual({ kind: "binary" });
    // Markdown that merely mentions HTML is text, shown as text.
    expect(classifyPreview("notes.md", utf8("Use <b>bold</b>"), 15)).toEqual({
      kind: "text",
      text: "Use <b>bold</b>",
    });
  });
});

describe("attachmentDisposition", () => {
  it("always an attachment; an ASCII fallback without quotes and the exact name in filename*", () => {
    expect(attachmentDisposition("q3.csv")).toBe(`attachment; filename="q3.csv"; filename*=UTF-8''q3.csv`);
    expect(attachmentDisposition('ré"port\u0007.csv')).toBe(
      `attachment; filename="re_port.csv"; filename*=UTF-8''r%C3%A9%22port.csv`,
    );
  });
});
