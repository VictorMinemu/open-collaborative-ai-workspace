import { describe, expect, it } from "vitest";
import { contentDisposition, dispositionFor } from "./disposition";

describe("contentDisposition (RFC 6266, T-04-04-06)", () => {
  it("writes an ASCII fallback and an RFC 5987 filename*", () => {
    expect(contentDisposition("résumé ✓.pdf", "attachment")).toBe(
      `attachment; filename="resume _.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%9C%93.pdf`,
    );
    expect(contentDisposition("plain.txt", "attachment")).toBe(
      `attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`,
    );
  });

  it("never lets CR, LF, quotes or backslashes reach the header", () => {
    const header = contentDisposition('evil"\r\nSet-Cookie: x=1\\".html', "attachment");
    expect(header).not.toMatch(/[\r\n]/);
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
    expect(fallback).not.toMatch(/["\\]/);
    expect(header.split("filename*=UTF-8''")[1]).not.toMatch(/["\\\r\n' ()*]/);
    expect(header.startsWith("attachment; ")).toBe(true);
  });

  it("an empty or all-unsafe name still yields a usable header", () => {
    expect(contentDisposition("", "attachment")).toBe(`attachment; filename="file"; filename*=UTF-8''file`);
    expect(contentDisposition("\r\n", "attachment")).toBe(
      `attachment; filename="file"; filename*=UTF-8''file`,
    );
  });
});

describe("dispositionFor", () => {
  it("is inline only for the webp renditions, renamed .webp", () => {
    expect(dispositionFor("original", "dot.png")).toMatch(/^attachment; filename="dot.png"/);
    expect(dispositionFor("thumb.webp", "dot.png")).toBe(
      `inline; filename="dot.webp"; filename*=UTF-8''dot.webp`,
    );
    expect(dispositionFor("large.webp", "photo")).toBe(
      `inline; filename="photo.webp"; filename*=UTF-8''photo.webp`,
    );
  });
});
