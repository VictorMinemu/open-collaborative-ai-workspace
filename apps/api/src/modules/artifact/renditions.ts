import type { Readable } from "node:stream";
import sharp from "sharp";

/** libvips' default pixel limit (~16384²): larger declared dimensions are a decompression bomb (T-04-04-04). */
export const MAX_INPUT_PIXELS = 268_402_689;

export const RENDITIONS = [
  { part: "thumb.webp", size: 720 },
  { part: "large.webp", size: 2048 },
] as const;

export interface Renditions {
  width: number;
  height: number;
  parts: Array<{ part: (typeof RENDITIONS)[number]["part"]; body: Buffer }>;
}

/** The image is larger than MAX_INPUT_PIXELS (or claims to be). */
export class ImageTooLargeError extends Error {}

const isPixelLimit = (err: unknown) => /pixel limit/i.test(String((err as Error)?.message ?? err));

/**
 * EXIF-stripped webp renditions of a raster image streamed from storage: orientation applied first
 * (`rotate()`), fit inside 720 and 2048 px, never enlarged, no metadata copied (sharp drops EXIF, GPS, XMP and
 * ICC unless asked to keep them). Width and height are the oriented dimensions of the original.
 */
export async function renderRenditions(source: Readable): Promise<Renditions> {
  const input = sharp({ limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  const meta = input.clone().metadata();
  const outputs = RENDITIONS.map(({ part, size }) =>
    input
      .clone()
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
      .then((body) => ({ part, body })),
  );
  source.on("error", (err) => input.destroy(err));
  source.pipe(input);
  try {
    const [m, ...parts] = await Promise.all([meta, ...outputs]);
    const width = m.autoOrient?.width ?? m.width;
    const height = m.autoOrient?.height ?? m.height;
    if (width * height > MAX_INPUT_PIXELS) throw new ImageTooLargeError("image exceeds the pixel limit");
    return { width, height, parts };
  } catch (err) {
    source.destroy();
    if (err instanceof ImageTooLargeError || isPixelLimit(err))
      throw new ImageTooLargeError("image exceeds the pixel limit");
    throw err;
  }
}
