import { ATTACHMENT_READ_LIMITS, type TurnAttachment } from "@ocw/contracts";
import { type AttachmentRow, attachmentKindOf, EXTRACT_LIMITS } from "../artifact";

/** What `buildTurnAttachments` needs to know about this bot on this turn (07.15 PD-04). */
export interface TurnAttachmentContext {
  /** The bot's model reads images (`modelAcceptsImages`). */
  imageModel: boolean;
  /** The turn offers `ocw_sandbox_import`. */
  importOffered: boolean;
  /** The conversation's audience covers the bot's workspace (F-8, `audienceCovers`); asked lazily, at most once. */
  importCovered: () => Promise<boolean>;
}

const NAME_MAX = 255;
const MEDIA_TYPE_MAX = 127;

/** Cuts to `max` UTF-16 code units without leaving a lone high surrogate at the end. */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An image the read route can return: its `large.webp` rendition, or an original within the inline cap. */
const imageReadable = (row: AttachmentRow) =>
  row.hasRenditions || row.sizeBytes <= EXTRACT_LIMITS.imageOriginalMaxBytes;

/**
 * The attachments a turn lists (07.15 D-02, D-04, PD-04): `rows` in listing order (the caller applies it), at most
 * `ATTACHMENT_READ_LIMITS.listPerTurn`, the rest counted in `more`. Each entry is metadata only (never content, a URL or
 * a storage key) with how THIS bot can read the file. This list never grants anything: the read and import routes
 * re-decide every file at call time (the one row rule, the asker, the model, the budget).
 */
export async function buildTurnAttachments(
  rows: readonly AttachmentRow[],
  ctx: TurnAttachmentContext,
): Promise<{ attachments: TurnAttachment[]; more: number }> {
  const listed = rows.slice(0, ATTACHMENT_READ_LIMITS.listPerTurn);
  const attachments: TurnAttachment[] = [];
  for (const row of listed) {
    const kind = attachmentKindOf(row);
    const readable =
      kind === "text" || kind === "pdf" || (kind === "image" && ctx.imageModel && imageReadable(row));
    attachments.push({
      id: row.id,
      messageId: row.messageId as string,
      name: bounded(row.filename, NAME_MAX),
      mediaType: bounded(row.contentType ?? row.declaredType, MEDIA_TYPE_MAX),
      size: row.sizeBytes,
      kind,
      access: readable ? "read" : "none",
    });
  }
  return { attachments, more: rows.length - listed.length };
}
