import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  contentTypeOf,
  fileKind,
  formatBytes,
  imageBox,
  middleEllipsis,
  screenFiles,
  uploadErrorText,
} from "./files";

const MB = 1024 * 1024;
const config = { maxBytes: 25 * MB, maxPerMessage: 10 };
const f = (name: string, size: number) => ({ name, size });

describe("formatBytes", () => {
  it("uses B, KB and MB with at most one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(3.25 * MB)).toBe("3.3 MB");
    expect(formatBytes(25 * MB)).toBe("25 MB");
    expect(formatBytes(2 * 1024 * MB)).toBe("2 GB");
  });
});

describe("middleEllipsis", () => {
  it("keeps short names and the extension of long ones", () => {
    expect(middleEllipsis("report.pdf", 20)).toBe("report.pdf");
    const out = middleEllipsis("quarterly-financial-report-final-v2.pdf", 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).toContain("…");
    expect(out.startsWith("quarterly")).toBe(true);
  });
  it("handles names without an extension", () => {
    const out = middleEllipsis("a".repeat(60), 20);
    expect(out.length).toBe(20);
    expect(out).toContain("…");
  });
});

describe("screenFiles", () => {
  it("accepts files within the limits", () => {
    const r = screenFiles([f("a.png", 10), f("b.pdf", 20)], config, 0);
    expect(r.accepted.map((x) => x.error)).toEqual([null, null]);
    expect(r.dropped).toBe(0);
  });
  it("flags a file over the size limit before any upload", () => {
    const r = screenFiles([f("huge.mov", 26 * MB)], config, 0);
    expect(r.accepted[0]?.error).toBe("Larger than the 25 MB limit");
  });
  it("flags an empty file", () => {
    expect(screenFiles([f("empty.txt", 0)], config, 0).accepted[0]?.error).toBe("This file is empty");
  });
  it("drops files beyond the per-message count, counting what is already queued", () => {
    const r = screenFiles([f("1", 1), f("2", 1), f("3", 1)], config, 8);
    expect(r.accepted).toHaveLength(2);
    expect(r.dropped).toBe(1);
  });
});

describe("uploadErrorText", () => {
  it("maps server codes to readable text", () => {
    expect(uploadErrorText(new ApiRequestError(409, "type_mismatch", "x"))).toMatch(/don't match its type/);
    expect(uploadErrorText(new ApiRequestError(400, "too_large", "x"), 25 * MB)).toBe(
      "Larger than the 25 MB limit",
    );
    expect(uploadErrorText(new ApiRequestError(409, "size_mismatch", "x"))).toMatch(/incomplete/);
    expect(uploadErrorText(new ApiRequestError(409, "image_too_large", "x"))).toMatch(/too large/);
    expect(uploadErrorText(new ApiRequestError(429, "rate_limited", "x"))).toMatch(/Too many/);
    expect(uploadErrorText(new ApiRequestError(503, "storage_unavailable", "x"))).toMatch(/unreachable/);
    expect(uploadErrorText(new ApiRequestError(0, "network_error", "x"))).toMatch(/connection/);
  });
  it("falls back to the error message", () => {
    expect(uploadErrorText(new ApiRequestError(400, "something_new", "Nope"))).toBe("Nope");
    expect(uploadErrorText(new Error("Boom"))).toBe("Boom");
  });
});

describe("fileKind / contentTypeOf", () => {
  it("groups types into icon families", () => {
    expect(fileKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(fileKind("image/png", "a.png")).toBe("image");
    expect(fileKind("application/zip", "a.zip")).toBe("archive");
    expect(fileKind("text/csv", "a.csv")).toBe("sheet");
    expect(fileKind("application/octet-stream", "notes.md")).toBe("text");
    expect(fileKind("video/mp4", "a.mp4")).toBe("video");
    expect(fileKind("audio/mpeg", "a.mp3")).toBe("audio");
    expect(fileKind("application/octet-stream", "blob")).toBe("other");
  });
  it("never sends an empty content type", () => {
    expect(contentTypeOf({ type: "" })).toBe("application/octet-stream");
    expect(contentTypeOf({ type: "Image/PNG" })).toBe("image/png");
  });
});

describe("imageBox", () => {
  it("fits inside the box keeping the aspect ratio and never enlarges", () => {
    expect(imageBox(4000, 3000, 480, 360)).toEqual({ width: 480, height: 360 });
    expect(imageBox(1000, 4000, 480, 360)).toEqual({ width: 90, height: 360 });
    expect(imageBox(100, 50, 480, 360)).toEqual({ width: 100, height: 50 });
  });
  it("uses a default box when the size is unknown", () => {
    expect(imageBox(null, null, 480, 360)).toEqual({ width: 360, height: 240 });
  });
});
