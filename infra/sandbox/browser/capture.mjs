// Screencast and masked screenshots of the bot browser agent (07.8-07, D-06, D-07, D-11).
//
// - startScreencast: CDP `Page.startScreencast` JPEG frames, acked so Chromium keeps flowing, forwarded at most `fps`
//   per second (the rest are acked and dropped, never queued). Frame bytes are never persisted or logged.
// - maskedScreenshot: a PNG capture with solid boxes painted over every sensitive or human-typed field. The boxes are
//   drawn on the decoded pixels in the agent, not overlaid in the page, so a page script can neither hide nor move
//   them; the mask exists only in the returned image.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG, jpegjs } = require("playwright-core/lib/utilsBundle");

/** The mask colour (opaque black): a pixel-level test asserts every masked pixel equals it. */
export const MASK_RGB = [0, 0, 0];
/** CSS pixels added around each field box, so its border, padding and caret are covered too. */
export const MASK_PAD = 2;

/**
 * Start the screencast of `cdp`'s page. `onFrame(jpegBuffer, { width, height })` is called at most `fps` times per
 * second. Returns `stop()`.
 */
export async function startScreencast(cdp, { maxWidth, maxHeight, quality, fps }, onFrame) {
  const minGap = 1000 / Math.max(1, fps);
  let last = 0;
  let stopped = false;
  // The newest frame inside the throttle window: delivered when the window ends, so the final state of a page that
  // then stops changing is never lost (Chromium sends no new frame for a still page). Older ones are dropped.
  let pending = null;
  let timer = null;
  const deliver = (data) => {
    last = Date.now();
    const jpeg = Buffer.from(data, "base64");
    onFrame(jpeg, jpegSize(jpeg) ?? { width: maxWidth, height: maxHeight });
  };
  const flush = () => {
    timer = null;
    if (stopped || pending === null) return;
    const data = pending;
    pending = null;
    deliver(data);
  };
  const handler = (f) => {
    // Ack first and always, so Chromium keeps producing frames.
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (stopped) return;
    const wait = minGap - (Date.now() - last);
    if (wait <= 0 && timer === null) {
      deliver(f.data);
      return;
    }
    pending = f.data;
    timer ??= setTimeout(flush, Math.max(0, wait));
  };
  cdp.on("Page.screencastFrame", handler);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
  return async () => {
    stopped = true;
    pending = null;
    if (timer) clearTimeout(timer);
    cdp.off("Page.screencastFrame", handler);
    await cdp.send("Page.stopScreencast").catch(() => {});
  };
}

/** Width and height from a JPEG's SOF marker, or null. */
export function jpegSize(buf) {
  let i = 2;
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * A screenshot of the viewport with `rects` (CSS pixels, viewport-relative) painted over. `format` is "png" or
 * "jpeg". Returns `{ mimeType, data (base64), width, height, masked, maskRects }`.
 */
export async function maskedScreenshot(cdp, rects, { format = "jpeg", quality = 80 } = {}) {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const cssWidth = metrics.cssVisualViewport?.clientWidth ?? metrics.layoutViewport.clientWidth;
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const png = PNG.sync.read(Buffer.from(shot.data, "base64"));
  const scale = cssWidth > 0 ? png.width / cssWidth : 1;
  const painted = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - MASK_PAD) * scale));
    const y0 = Math.max(0, Math.floor((r.y - MASK_PAD) * scale));
    const x1 = Math.min(png.width, Math.ceil((r.x + r.width + MASK_PAD) * scale));
    const y1 = Math.min(png.height, Math.ceil((r.y + r.height + MASK_PAD) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const o = (y * png.width + x) * 4;
        png.data[o] = MASK_RGB[0];
        png.data[o + 1] = MASK_RGB[1];
        png.data[o + 2] = MASK_RGB[2];
        png.data[o + 3] = 255;
      }
    }
    painted.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  let data;
  let mimeType;
  if (format === "png") {
    data = PNG.sync.write(png);
    mimeType = "image/png";
  } else {
    data = jpegjs.encode({ data: png.data, width: png.width, height: png.height }, quality).data;
    mimeType = "image/jpeg";
  }
  return {
    mimeType,
    data: Buffer.from(data).toString("base64"),
    width: png.width,
    height: png.height,
    masked: painted.length,
    maskRects: painted,
  };
}
