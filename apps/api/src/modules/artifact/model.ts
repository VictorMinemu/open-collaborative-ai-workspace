import { type Attachment, INLINE_IMAGE_TYPES } from "@ocw/contracts";
import type { attachments } from "@ocw/db";

export type AttachmentRow = typeof attachments.$inferSelect;

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);
const iso = (v: string) => new Date(v).toISOString();

/**
 * The public DTO. Every URL is an API-relative path that re-checks access before redirecting to a short-lived
 * presigned GET; previews exist only for sniffed raster images with renditions (never SVG or HTML).
 */
export function toAttachment(row: AttachmentRow): Attachment {
  const contentType = row.contentType ?? row.declaredType;
  const isImage = row.hasRenditions && INLINE.has(contentType);
  const base = `/api/v1/attachments/${row.id}`;
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    filename: row.filename,
    contentType,
    size: row.sizeBytes,
    status: row.status,
    isImage,
    width: isImage ? row.width : null,
    height: isImage ? row.height : null,
    previewUrl: isImage ? `${base}/preview` : null,
    largeUrl: isImage ? `${base}/large` : null,
    downloadUrl: `${base}/download`,
    createdAt: iso(row.createdAt),
  };
}
