// Types of capture.mjs (07.13 D-04, PD-02): screencast frames and masked screenshots over a CDP session.

/** The CDP session capture needs: Playwright's CDPSession, or a fake in tests. */
export interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: { sessionId: number; data: string }) => void): unknown;
  off(event: string, handler: (params: { sessionId: number; data: string }) => void): unknown;
}

export interface ScreencastOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  fps: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** A field box in CSS pixels, relative to the viewport. */
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
}

export interface MaskedScreenshot {
  mimeType: "image/png" | "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
  /** How many boxes were painted. */
  masked: number;
  /** The painted boxes, in image pixels. */
  maskRects: MaskRect[];
}

export const MASK_RGB: readonly [number, number, number];
export const MASK_PAD: number;

/** Starts the page's screencast; resolves with `stop()`. */
export function startScreencast(
  cdp: CdpSession,
  options: ScreencastOptions,
  onFrame: (jpeg: Buffer, size: FrameSize) => void,
): Promise<() => Promise<void>>;
export function jpegSize(buf: Buffer): FrameSize | null;
export function maskedScreenshot(
  cdp: CdpSession,
  rects: readonly MaskRect[],
  options?: ScreenshotOptions,
): Promise<MaskedScreenshot>;
