import type { Readable } from "node:stream";
import type { AttachmentRow } from "./model";
import { type AttachmentPart, attachmentKey, type ObjectStorage } from "./storage";

/** The object is larger than the caller's cap: it is never buffered past it. */
export class AttachmentTooLargeError extends Error {}

/**
 * The bytes of one stored part of an attachment, read server-side from the store (never a URL: the bytes travel
 * inside the caller's request, ADR-0015), at most `maxBytes` (larger → `AttachmentTooLargeError`, the stream is
 * destroyed at once).
 */
export async function readAttachmentBytes(
  storage: ObjectStorage,
  row: AttachmentRow,
  part: AttachmentPart,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream: Readable = await storage.stream(
    attachmentKey(row.organizationId, row.conversationId, row.id, part),
  );
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) throw new AttachmentTooLargeError("attachment larger than the cap");
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  // One copy into a buffer of its own (never a Buffer-pool view), not a concatenation copied again (WR-06).
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
