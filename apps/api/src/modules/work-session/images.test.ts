import { WORK_PROMPT_IMAGE_MAX_BYTES } from "@ocw/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/errors";
import { fitImageWithin } from "../artifact";
import { frameFits } from "../device";
import { checkImageBudget, chooseImagePart, DEVICE_IMAGE_MAX_EDGE, PNG_ORIGINAL_MAX_BYTES } from "./images";

const KB = 1024;
const MB = 1024 * 1024;

type Row = Parameters<typeof chooseImagePart>[0];
const row = (over: Partial<Row>): Row => ({
  id: "6f1d2c3b-0000-4000-8000-000000000001",
  filename: "shot.png",
  contentType: "image/png",
  sizeBytes: 800 * KB,
  width: 1600,
  height: 1000,
  largeBytes: 300 * KB,
  ...over,
});

describe("chooseImagePart (P-02): small PNG originals, everything else the EXIF-free rendition", () => {
  it("a PNG of 800 KB at 1600×1000 goes as the original PNG", () => {
    expect(chooseImagePart(row({}))).toEqual({
      part: "original",
      mediaType: "image/png",
      resize: false,
      bytes: 800 * KB,
    });
  });

  it("a PNG over 1 MiB goes as large.webp", () => {
    expect(chooseImagePart(row({ sizeBytes: 1.5 * MB }))).toEqual({
      part: "large.webp",
      mediaType: "image/webp",
      resize: false,
      bytes: 300 * KB,
    });
  });

  it("a PNG of exactly 1 MiB and 2000 px still goes as the original", () => {
    const r = chooseImagePart(row({ sizeBytes: PNG_ORIGINAL_MAX_BYTES, width: 2000, height: 2000 }));
    expect(r.part).toBe("original");
  });

  it("a small PNG of 2400×1200 goes as large.webp, resized", () => {
    expect(chooseImagePart(row({ sizeBytes: 200 * KB, width: 2400, height: 1200 }))).toMatchObject({
      part: "large.webp",
      mediaType: "image/webp",
      resize: true,
    });
  });

  it("a JPEG of 200 KB, a GIF and a WebP go as large.webp (EXIF/GPS and single frame, deviation from D-04)", () => {
    for (const contentType of ["image/jpeg", "image/gif", "image/webp"]) {
      expect(chooseImagePart(row({ contentType, sizeBytes: 200 * KB })), contentType).toEqual({
        part: "large.webp",
        mediaType: "image/webp",
        resize: false,
        bytes: 300 * KB,
      });
    }
  });

  it("resize is true only when the oriented original's long edge exceeds 2000", () => {
    const jpeg = (width: number, height: number) =>
      chooseImagePart(row({ contentType: "image/jpeg", width, height })).resize;
    expect(DEVICE_IMAGE_MAX_EDGE).toBe(2000);
    expect(jpeg(2000, 1500)).toBe(false);
    expect(jpeg(1500, 2000)).toBe(false);
    expect(jpeg(2001, 100)).toBe(true);
    expect(jpeg(100, 2001)).toBe(true);
  });

  it("unknown dimensions never go as an original and are resized to be safe", () => {
    expect(chooseImagePart(row({ width: null, height: null }))).toMatchObject({
      part: "large.webp",
      resize: true,
    });
  });
});

describe("checkImageBudget (P-01, P-03): 2 MiB per image as sent, from recorded sizes only", () => {
  const refusal = (rows: Row[]) => {
    try {
      checkImageBudget(rows);
    } catch (err) {
      return err as HttpError;
    }
    return null;
  };

  it("accepts parts within the budget", () => {
    expect(
      refusal([row({}), row({ contentType: "image/jpeg", largeBytes: WORK_PROMPT_IMAGE_MAX_BYTES })]),
    ).toBeNull();
  });

  it("refuses a rendition over 2 MiB by large_bytes with 400 image_too_large naming the file and the limit", () => {
    const err = refusal([
      row({}),
      row({ filename: "huge.jpg", contentType: "image/jpeg", largeBytes: 3 * MB }),
    ]);
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.statusCode).toBe(400);
    expect(err!.code).toBe("image_too_large");
    expect(err!.message).toBe("huge.jpg is 3.0 MB after resizing; images can be at most 2 MB");
  });

  it("measures an original by size_bytes (the rendition size does not matter)", () => {
    expect(refusal([row({ largeBytes: 9 * MB })])).toBeNull();
  });

  it("refuses a rendition with no recorded large_bytes", () => {
    const err = refusal([row({ filename: "old.jpg", contentType: "image/jpeg", largeBytes: null })]);
    expect(err?.code).toBe("image_too_large");
    expect(err?.message).toContain("old.jpg");
  });
});

describe("fitImageWithin: the dispatch-time resize (no metadata, pixel limit)", () => {
  const webp = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: "#3a7" } })
      .webp()
      .toBuffer();

  it("a 2048×1024 webp comes out at 2000×1000", async () => {
    const out = await fitImageWithin(await webp(2048, 1024), 2000);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 2000, 1000]);
    expect(meta.exif).toBeUndefined();
  });

  it("a 1200×800 webp keeps its size", async () => {
    const meta = await sharp(await fitImageWithin(await webp(1200, 800), 2000)).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 800]);
  });
});

describe("frameFits (P-01): every outbound Device Link frame is measured in UTF-8 bytes", () => {
  it("is true at exactly the limit and false one byte over", () => {
    expect(frameFits("x".repeat(64), 64)).toBe(true);
    expect(frameFits("x".repeat(65), 64)).toBe(false);
  });

  it("measures multi-byte characters in bytes, not string length", () => {
    // "é" is 2 bytes and "😀" 4 bytes (2 UTF-16 units) in UTF-8.
    expect(frameFits("é".repeat(32), 64)).toBe(true);
    expect(frameFits("é".repeat(33), 64)).toBe(false);
    expect(frameFits("😀".repeat(16), 64)).toBe(true);
    expect(frameFits(`${"😀".repeat(16)}x`, 64)).toBe(false);
    expect(frameFits("€".repeat(22), 64)).toBe(false);
  });
});
