import {
  ATTACHMENT_READ_LIMITS,
  TURN_ATTACHMENT_NOTES,
  type TurnAttachment,
  type TurnAttachmentAccess,
} from "@ocw/contracts";
import { type AttachmentRow, attachmentKindOf, cutChars, EXTRACT_LIMITS } from "../artifact";

/** What `buildTurnAttachments` needs to know about this bot on this turn (07.15 PD-04). */
export interface TurnAttachmentContext {
  /** The bot's model reads images (`modelAcceptsImages`; false for ChatGPT-plan bots by design, D-13). */
  imageModel: boolean;
  /** The turn offers `ocw_sandbox_import`. */
  importOffered: boolean;
  /**
   * The conversation's audience covers the bot's workspace (D-09, F-8: the import route's `audienceCovers` decision).
   * Asked lazily: at most once per build, and only when a file the bot cannot read could be imported instead.
   */
  importCovered: () => Promise<boolean>;
}

const NAME_MAX = 255;
const MEDIA_TYPE_MAX = 127;

/** An image the read route can return: its `large.webp` rendition, or an original within the inline cap. */
const imageReadable = (row: AttachmentRow) =>
  row.hasRenditions || row.sizeBytes <= EXTRACT_LIMITS.imageOriginalMaxBytes;

/**
 * The attachments a turn lists (07.15 D-02, D-04, D-09, D-13, PD-04): `rows` in listing order (the caller applies it),
 * at most `ATTACHMENT_READ_LIMITS.listPerTurn`, the rest counted in `more`. Each entry is metadata only (never content,
 * a URL or a storage key) with how THIS bot can read the file:
 * - text → `read`; a PDF → `read` up to `EXTRACT_LIMITS.pdfMaxBytes`, else `tooLarge` and `import` or `none`, as the
 *   read route refuses it `too_large` (07.15 IN-02);
 * - an image → `read` for an image model when it has a rendition or an original within the inline cap; otherwise
 *   `modelNoImages` (no image model) or `tooLarge`, and `import` when the sandbox copy is possible, else `none`;
 * - anything else → `import` with `cannotReadImport` when the turn offers `ocw_sandbox_import` and the conversation's
 *   audience covers the workspace, `none` with `cannotReadNarrower` when it does not, `none` with `cannotReadNoSandbox`
 *   without the import.
 * The note is the fixed sentence the plugin shows the bot (`TURN_ATTACHMENT_NOTES`), never provider text. This list
 * never grants anything: the read and import routes re-decide every file at call time (the one row rule, the asker,
 * the model, the budget, the audience).
 */
export async function buildTurnAttachments(
  rows: readonly AttachmentRow[],
  ctx: TurnAttachmentContext,
): Promise<{ attachments: TurnAttachment[]; more: number }> {
  let covered: Promise<boolean> | null = null;
  const importable = async () => {
    if (!ctx.importOffered) return false;
    covered ??= ctx.importCovered();
    return covered;
  };
  const listed = rows.slice(0, ATTACHMENT_READ_LIMITS.listPerTurn);
  const attachments: TurnAttachment[] = [];
  for (const row of listed) {
    const kind = attachmentKindOf(row);
    let access: TurnAttachmentAccess = "read";
    let note: string | undefined;
    if (kind === "image" && !(ctx.imageModel && imageReadable(row))) {
      note = ctx.imageModel ? TURN_ATTACHMENT_NOTES.tooLarge : TURN_ATTACHMENT_NOTES.modelNoImages;
      access = (await importable()) ? "import" : "none";
    } else if (kind === "pdf" && row.sizeBytes > EXTRACT_LIMITS.pdfMaxBytes) {
      note = TURN_ATTACHMENT_NOTES.tooLarge;
      access = (await importable()) ? "import" : "none";
    } else if (kind === "other") {
      if (!ctx.importOffered) {
        access = "none";
        note = TURN_ATTACHMENT_NOTES.cannotReadNoSandbox;
      } else if (await importable()) {
        access = "import";
        note = TURN_ATTACHMENT_NOTES.cannotReadImport;
      } else {
        access = "none";
        note = TURN_ATTACHMENT_NOTES.cannotReadNarrower;
      }
    }
    attachments.push({
      id: row.id,
      messageId: row.messageId as string,
      name: cutChars(row.filename, NAME_MAX).text,
      mediaType: cutChars(row.contentType ?? row.declaredType, MEDIA_TYPE_MAX).text,
      size: row.sizeBytes,
      kind,
      access,
      ...(note ? { note } : {}),
    });
  }
  return { attachments, more: rows.length - listed.length };
}
