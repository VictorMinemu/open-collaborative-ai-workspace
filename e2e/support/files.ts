import { crc32, deflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import { shot } from "../tests/env";

/**
 * File helpers shared by the attachment specs (Phase 4 chat, AI chat, Work Zone images 06.1): a PNG generator, a
 * screenshot-like mockup, a drop on a pane and a paste into a composer the way the browser does them, and the
 * light/dark screenshot pair.
 */

export interface FileSpec {
  name: string;
  type: string;
  bytes: Buffer;
}

export async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** An RGB PNG drawn by `pixel` (no image library needed). */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A soft gradient "mockup" with a card in the middle, so previews and the lightbox look like real screenshots. */
export function mockup(width = 960, height = 600, hue: [number, number, number] = [99, 102, 241]): Buffer {
  return png(width, height, (x, y) => {
    const inCard = x > width * 0.2 && x < width * 0.8 && y > height * 0.25 && y < height * 0.75;
    if (inCard) {
      const bar = y > height * 0.32 && y < height * 0.36 && x < width * 0.55;
      return bar ? [hue[0], hue[1], hue[2]] : [250, 250, 252];
    }
    const t = (x / width + y / height) / 2;
    return [
      Math.round(hue[0] + (255 - hue[0]) * t * 0.6),
      Math.round(hue[1] + (255 - hue[1]) * t * 0.6),
      Math.round(hue[2] + (255 - hue[2]) * t * 0.3),
    ];
  });
}

/** Drops files on the conversation pane the way a browser does (a DataTransfer built in the page). */
export async function dropFiles(page: Page, files: FileSpec[]) {
  const dt = await page.evaluateHandle(
    (list) => {
      const dataTransfer = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        dataTransfer.items.add(new File([bytes], f.name, { type: f.type }));
      }
      return dataTransfer;
    },
    files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") })),
  );
  const zone = page.getByTestId("drop-zone").first();
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.getByTestId("drop-zone-overlay")).toBeHidden();
}

/** Pastes files into a composer the way the browser does (a ClipboardEvent carrying the files). */
export async function pasteFiles(target: Locator, files: FileSpec[]) {
  await target.click();
  await target.evaluate(
    (el, list) => {
      const dataTransfer = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        dataTransfer.items.add(new File([bytes], f.name, { type: f.type }));
      }
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
      );
    },
    files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") })),
  );
}
