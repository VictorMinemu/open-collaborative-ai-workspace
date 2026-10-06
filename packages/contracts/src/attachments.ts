import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * Chat attachments (CHAT-12, D-03): browser uploads go straight to the S3-compatible store through a presigned
 * PUT with a signed Content-Type; the API verifies, sniffs and renders thumbnails before a file is `ready`.
 * Object keys are tenant-scoped (`org/<orgId>/conv/<convId>/att/<attId>/…`) and the bucket is private, so every
 * URL in these contracts is an API-relative path (`/api/v1/attachments/<id>/…`) that re-checks access.
 */

/** Default per-file limit; `OCW_ATTACHMENT_MAX_BYTES` overrides it (Plan 04-04). */
export const ATTACHMENT_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Shown inline with a thumbnail; anything else is a download card. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const AttachmentStatus = z.enum(["pending", "ready", "rejected", "deleted"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

const FILENAME_MAX = 255;
// C0 and C1 controls, plus the Unicode bidi embeddings, overrides and isolates (a "fdp.exe" spoof).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * A display- and header-safe file name: NFC; control and bidi characters removed; `/` and `\` become `_`;
 * leading dots and spaces trimmed; whitespace collapsed; at most 255 characters keeping the extension; `""`
 * becomes `"file"`. Never used to build a storage key (keys are ids only).
 */
export function sanitizeFilename(name: string): string {
  let out = name
    .normalize("NFC")
    .replace(UNSAFE_CHARS, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  if (out.length > FILENAME_MAX) {
    const dot = out.lastIndexOf(".");
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : "";
    out = `${out.slice(0, FILENAME_MAX - ext.length).trimEnd()}${ext}`;
  }
  return out || "file";
}

/** The client's file name (sanitized server-side with `sanitizeFilename` before it is stored). */
export const AttachmentFilename = z.string().trim().min(1).max(FILENAME_MAX);

export const MimeType = z
  .string()
  .trim()
  .toLowerCase()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, "a MIME type such as image/png");

export const PresignUploadRequest = z.object({
  filename: AttachmentFilename,
  contentType: MimeType,
  size: z.number().int().positive(),
});
export type PresignUploadRequest = z.infer<typeof PresignUploadRequest>;

export const Attachment = z.object({
  id: Id,
  conversationId: Id,
  messageId: Id.nullable(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  status: AttachmentStatus,
  isImage: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** API-relative path of the small rendition (images only). */
  previewUrl: z.string().nullable(),
  /** API-relative path of the large rendition (images only). */
  largeUrl: z.string().nullable(),
  /** API-relative path that redirects to a short-lived presigned GET. */
  downloadUrl: z.string(),
  createdAt: IsoDateTime,
});
export type Attachment = z.infer<typeof Attachment>;

export const PresignUploadResponse = z.object({
  attachment: Attachment,
  upload: z.object({
    url: z.url(),
    method: z.literal("PUT"),
    /** Headers the browser must send exactly (the Content-Type is signed). */
    headers: z.record(z.string(), z.string()),
    expiresAt: IsoDateTime,
  }),
});
export type PresignUploadResponse = z.infer<typeof PresignUploadResponse>;

/** `GET /api/v1/attachments/config`: unconfigured storage hides the paperclip. */
export const AttachmentsConfig = z.object({
  enabled: z.boolean(),
  maxBytes: z.number().int().positive(),
  maxPerMessage: z.number().int().positive(),
  reason: z.enum(["not_configured", "unavailable"]).nullable(),
});
export type AttachmentsConfig = z.infer<typeof AttachmentsConfig>;
