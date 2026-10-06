import { type Attachment, MAX_ATTACHMENTS_PER_MESSAGE } from "@ocw/contracts";
import { attachments, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ApiModule, App, Core } from "../../core";
import { conflict } from "../../lib/errors";
// Type-only: the chat module imports this module's helpers (Plan 04-12), so a runtime import would be a cycle.
import type { ConversationAccess } from "../chat/access";
import { registerAttachmentRoutes } from "./attachments";
import { toAttachment } from "./model";
import { createObjectStorage, type ObjectStorage } from "./storage";

export { type AttachmentRow, toAttachment } from "./model";
export { attachmentKey, createObjectStorage, type ObjectStorage } from "./storage";

/**
 * Artifact module (PRD Artifact service): chat attachments on S3-compatible storage (ADR-0015, D-03). Bytes go
 * browser → store on presigned URLs; the API verifies them and authorizes every download through the
 * conversation's read decision (P-03). Storage is optional: unconfigured = attachments disabled.
 */
export function createArtifactModule(
  core: Core,
  deps: { access: ConversationAccess },
): ApiModule & { storage: ObjectStorage | null } {
  const storage = createObjectStorage(core.env, core.secretStore);
  return {
    name: "artifact",
    storage,
    register(app: App) {
      registerAttachmentRoutes(app, {
        core,
        access: deps.access,
        storage,
        storageStatus: async () => "ok",
      });
    },
  };
}

const notLinkable = () =>
  conflict("One or more attachments cannot be added to this message", "attachment_not_linkable");

/**
 * Links uploaded files to a new message in the message's transaction. Every id must be the uploader's, in the
 * same conversation, `ready` and not linked yet, at most MAX_ATTACHMENTS_PER_MESSAGE; anything else is 409
 * `attachment_not_linkable` (and the caller's transaction rolls back).
 */
export async function linkAttachments(
  tx: Tx,
  input: { conversationId: string; messageId: string; uploaderId: string; ids: string[] },
): Promise<void> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return;
  if (input.ids.length > MAX_ATTACHMENTS_PER_MESSAGE || ids.length !== input.ids.length) throw notLinkable();
  const linked = await tx
    .update(attachments)
    .set({ messageId: input.messageId })
    .where(
      and(
        inArray(attachments.id, ids),
        eq(attachments.conversationId, input.conversationId),
        eq(attachments.uploaderId, input.uploaderId),
        eq(attachments.status, "ready"),
        isNull(attachments.messageId),
      ),
    )
    .returning({ id: attachments.id });
  if (linked.length !== ids.length) throw notLinkable();
}

/** Ready attachments of the given messages, in upload order (deleted and pending ones never appear). */
export async function attachmentsForMessages(
  tx: Tx,
  messageIds: string[],
): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(inArray(attachments.messageId, messageIds), eq(attachments.status, "ready")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  for (const row of rows) {
    const list = out.get(row.messageId!) ?? [];
    list.push(toAttachment(row));
    out.set(row.messageId!, list);
  }
  return out;
}
