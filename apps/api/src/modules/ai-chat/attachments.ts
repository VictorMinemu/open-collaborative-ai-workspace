import { INLINE_IMAGE_TYPES, type ModelCaps } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import {
  type AttachmentRow,
  AttachmentTooLargeError,
  attachmentRowsForMessages,
  type ObjectStorage,
  readAttachmentBytes,
} from "../artifact";
import type { ModelFilePart } from "./build-model-messages";

/**
 * Files in AI chats (05-12, AICHAT-08). Attachments arrive through the Phase 4 pipeline (presign → store → sniff →
 * renditions); at generation time the API reads their bytes from the store and hands them to the model INSIDE the
 * member's own message: no storage URL, presigned or internal, is ever produced here or sent to a provider
 * (ADR-0015, T-05-12-01). File content is untrusted input (T-05-12-06): it never reaches the instructions and is
 * never turned into a tool call by the API.
 */

export type { ModelFilePart } from "./build-model-messages";

/** Originals of images without renditions are sent only up to this size (renditions are ≤ 2048 px webp). */
export const AI_IMAGE_ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);

/** What a model can be given for one attachment. */
export type AiAttachmentKind = "image" | "pdf" | "text" | "other";

/** The kind of a stored attachment, from its sniffed type (images and PDFs). */
export function aiAttachmentKind(row: AttachmentRow): AiAttachmentKind {
  const type = row.contentType ?? row.declaredType;
  if (INLINE.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  return "other";
}

/** A refusal or placeholder may name the file: no control characters, no delimiters, bounded. */
export function labelName(name: string): string {
  return (
    name
      .replace(/[<>"`[\]\r\n\t]/gu, "_")
      .slice(0, 120)
      .trim() || "file"
  );
}

const placeholder = (text: string): ModelFilePart => ({ type: "text", text });

/**
 * The parts one user message carries for the model, in upload order. Images: the `large.webp` rendition (EXIF-free,
 * ≤ 2048 px) when there is one, else the original up to AI_IMAGE_ORIGINAL_MAX_BYTES. Anything the model cannot read
 * (history after a model switch, a missing object) becomes a short placeholder so the conversation stays coherent.
 * `storage: null` (no store, or an estimate only) gives zero-byte file parts of the right type.
 */
export async function modelPartsFor(
  rows: AttachmentRow[],
  storage: ObjectStorage | null,
  caps: ModelCaps,
): Promise<ModelFilePart[]> {
  const out: ModelFilePart[] = [];
  for (const row of rows) {
    const name = labelName(row.filename);
    const kind = aiAttachmentKind(row);
    if (kind === "image") {
      if (!caps.vision) {
        out.push(placeholder(`[Image ${name} was attached; this model can't read images]`));
        continue;
      }
      const mediaType = row.hasRenditions ? "image/webp" : (row.contentType ?? row.declaredType);
      if (!storage) {
        out.push({ type: "file", mediaType, data: new Uint8Array(), filename: name });
        continue;
      }
      try {
        const data = row.hasRenditions
          ? await readAttachmentBytes(storage, row, "large.webp", AI_IMAGE_ORIGINAL_MAX_BYTES)
          : await readAttachmentBytes(storage, row, "original", AI_IMAGE_ORIGINAL_MAX_BYTES);
        out.push({ type: "file", mediaType, data, filename: name });
      } catch (err) {
        out.push(
          placeholder(
            err instanceof AttachmentTooLargeError
              ? `[Image ${name} was attached but is too large to send]`
              : `[Image ${name} was attached but could not be read]`,
          ),
        );
      }
      continue;
    }
    out.push(placeholder(`[File ${name} was attached; this model can't read it]`));
  }
  return out;
}

/**
 * The model parts of every user message in `messageIds` (one query, then the bytes message by message). An empty map
 * when no message has files.
 */
export async function attachmentPartsFor(
  tx: Tx,
  messageIds: string[],
  storage: ObjectStorage | null,
  caps: ModelCaps,
): Promise<Map<string, ModelFilePart[]>> {
  const rows = await attachmentRowsForMessages(tx, messageIds);
  const out = new Map<string, ModelFilePart[]>();
  for (const [messageId, list] of rows) out.set(messageId, await modelPartsFor(list, storage, caps));
  return out;
}
