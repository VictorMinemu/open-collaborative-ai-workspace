import { INLINE_IMAGE_TYPES } from "@ocw/contracts";
import { fileTypeFromBuffer } from "file-type";

/** Bytes `file-type` needs to recognise every format it supports. */
export const SNIFF_BYTES = 4100;

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);
/** Types a browser could execute or render as a document; served as opaque bytes even as a download. */
const ACTIVE = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
]);

export type SniffResult =
  | { ok: true; contentType: string; raster: boolean }
  | { ok: false; reason: "type_mismatch"; sniffed: string | null };

/**
 * The browser's declared type is never trusted (T-04-04-02). A declared inline image must be exactly that image
 * by its magic bytes; anything else keeps the sniffed type when one is recognised, otherwise
 * `application/octet-stream`. SVG, HTML and XML are never images and never keep an active type.
 */
export async function sniff(head: Uint8Array, declared: string): Promise<SniffResult> {
  const detected = (await fileTypeFromBuffer(head))?.mime ?? null;
  if (INLINE.has(declared)) {
    if (detected !== declared) return { ok: false, reason: "type_mismatch", sniffed: detected };
    return { ok: true, contentType: declared, raster: true };
  }
  if (!detected || ACTIVE.has(detected))
    return { ok: true, contentType: "application/octet-stream", raster: false };
  return { ok: true, contentType: detected, raster: INLINE.has(detected) };
}
