import type { Readable } from "node:stream";
import {
  type Attachment,
  INLINE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  WORK_PROMPT_MAX_IMAGES,
} from "@ocw/contracts";
import { attachments, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ApiModule, App, Core } from "../../core";
import { conflict } from "../../lib/errors";
// Type-only: the chat module imports this module's helpers (Plan 04-12), so a runtime import would be a cycle.
import type { ConversationAccess } from "../chat/access";
import { type AttachmentScopes, presignPart, registerAttachmentRoutes } from "./attachments";
import { type AttachmentRow, toAttachment } from "./model";
import { type AttachmentPart, attachmentKey, createObjectStorage, type ObjectStorage } from "./storage";
import { createAttachmentSweeper } from "./sweeper";

export type { AttachmentScope, AttachmentScopes, ScopedKind } from "./attachments";
export { type AttachmentRow, toAttachment } from "./model";
export {
  type AttachmentPart,
  attachmentKey,
  createObjectStorage,
  type ObjectStorage,
  objectStorageConfigured,
} from "./storage";
export { type AttachmentSweeper, createAttachmentSweeper } from "./sweeper";

const CORS_RETRY_MAX_MS = 60_000;
/** How long `GET /attachments/config` waits for an in-flight storage check before answering `unavailable`. */
const STATUS_WAIT_MS = 3_000;

/**
 * Artifact module (PRD Artifact service): chat attachments on S3-compatible storage (ADR-0015, D-03). Bytes go
 * browser → store on presigned URLs; the API verifies them and authorizes every download through the
 * conversation's read decision (P-03). Storage is optional: unconfigured = attachments disabled.
 */
export function createArtifactModule(
  core: Core,
  deps: { access: ConversationAccess; scopes?: AttachmentScopes },
): ApiModule & { storage: ObjectStorage | null } {
  const storage = createObjectStorage(core.env, core.secretStore);
  const sweeper = storage ? createAttachmentSweeper(core, storage) : null;
  const origins = [core.env.OCW_PUBLIC_WEB_URL, ...core.env.OCW_TRUSTED_ORIGINS];

  // Bucket CORS is configured by the API itself (no init container): in the background, retried with backoff, so
  // an unreachable store never blocks or fails the API start (T-04-04-09). Until it succeeds, attachments
  // report `enabled: false, reason: "unavailable"`.
  let ready = false;
  let closed = false;
  let inFlight: Promise<void> | null = null;
  let retry: NodeJS.Timeout | null = null;

  function configure(delayMs = 1_000): Promise<void> {
    if (!storage || closed) return Promise.resolve();
    inFlight ??= storage.ensureBucketCors(origins).then(
      () => {
        ready = true;
        inFlight = null;
      },
      (err: Error) => {
        inFlight = null;
        core.log.warn({ err: { name: err?.name } }, "object storage not reachable yet; retrying bucket CORS");
        if (closed) return;
        retry = setTimeout(() => void configure(Math.min(delayMs * 2, CORS_RETRY_MAX_MS)), delayMs);
        retry.unref();
      },
    );
    return inFlight;
  }

  async function storageStatus(): Promise<"ok" | "unavailable"> {
    if (ready) return "ok";
    const pending = inFlight ?? configure();
    await Promise.race([pending, new Promise((r) => setTimeout(r, STATUS_WAIT_MS).unref())]);
    return ready ? "ok" : "unavailable";
  }

  return {
    name: "artifact",
    storage,
    register(app: App) {
      registerAttachmentRoutes(app, {
        core,
        access: deps.access,
        storage,
        storageStatus,
        ...(deps.scopes ? { scopes: deps.scopes } : {}),
      });
      void configure();
      sweeper?.start();
    },
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      sweeper?.stop();
    },
  };
}

/** 409 `attachment_not_linkable`: the one refusal for any file that cannot join a message (never says why). */
export const notLinkable = (target: "message" | "prompt" = "message") =>
  conflict(`One or more attachments cannot be added to this ${target}`, "attachment_not_linkable");

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
        isNull(attachments.workPromptId),
      ),
    )
    .returning({ id: attachments.id });
  if (linked.length !== ids.length) throw notLinkable();
}

/**
 * Links images to a new Work Zone prompt in the prompt's transaction (06.1, P-05): the Phase 4 rule (every id the
 * uploader's, in the session's conversation, `ready`, not linked to a message or a prompt yet, no duplicates) plus a
 * sniffed inline image with renditions, at most WORK_PROMPT_MAX_IMAGES. Anything else, including another tenant's id
 * (invisible under RLS), is the one 409 `attachment_not_linkable` and the caller's transaction rolls back. Returns
 * the rows in request order.
 */
export async function linkWorkPromptAttachments(
  tx: Tx,
  input: { conversationId: string; workPromptId: string; uploaderId: string; ids: string[] },
): Promise<AttachmentRow[]> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return [];
  if (input.ids.length > WORK_PROMPT_MAX_IMAGES || ids.length !== input.ids.length)
    throw notLinkable("prompt");
  const linked = await tx
    .update(attachments)
    .set({ workPromptId: input.workPromptId })
    .where(
      and(
        inArray(attachments.id, ids),
        eq(attachments.conversationId, input.conversationId),
        eq(attachments.uploaderId, input.uploaderId),
        eq(attachments.status, "ready"),
        isNull(attachments.messageId),
        isNull(attachments.workPromptId),
        eq(attachments.hasRenditions, true),
        inArray(attachments.contentType, [...INLINE_IMAGE_TYPES]),
      ),
    )
    .returning();
  if (linked.length !== ids.length) throw notLinkable("prompt");
  const order = new Map(input.ids.map((id, i) => [id, i]));
  return linked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Ready attachments of the given Work Zone prompts, in upload order (06.1). */
export async function attachmentsForWorkPrompts(
  tx: Tx,
  promptIds: string[],
): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>();
  if (promptIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(inArray(attachments.workPromptId, promptIds), eq(attachments.status, "ready")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  for (const row of rows) {
    const list = out.get(row.workPromptId!) ?? [];
    list.push(toAttachment(row));
    out.set(row.workPromptId!, list);
  }
  return out;
}

/** Ready attachment rows of one Work Zone prompt, in upload order (what its dispatch sends, 06.1-02). */
export async function attachmentRowsForWorkPrompt(tx: Tx, promptId: string): Promise<AttachmentRow[]> {
  return tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.workPromptId, promptId), eq(attachments.status, "ready")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
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

/**
 * The rows `linkAttachments` would accept for this message (05-12): the uploader's own `ready`, unlinked files of
 * this conversation. Anything else among `ids` is 409 `attachment_not_linkable`, before the caller looks at a single
 * row, so a refused id never reveals what kind of file it is.
 */
export async function linkableAttachments(
  tx: Tx,
  input: { conversationId: string; uploaderId: string; ids: string[] },
): Promise<AttachmentRow[]> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return [];
  if (input.ids.length > MAX_ATTACHMENTS_PER_MESSAGE || ids.length !== input.ids.length) throw notLinkable();
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, ids),
        eq(attachments.conversationId, input.conversationId),
        eq(attachments.uploaderId, input.uploaderId),
        eq(attachments.status, "ready"),
        isNull(attachments.messageId),
        isNull(attachments.workPromptId),
      ),
    );
  if (rows.length !== ids.length) throw notLinkable();
  const order = new Map(input.ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Ready attachment rows of the given messages, in upload order (what a model turn reads, 05-12). */
export async function attachmentRowsForMessages(
  tx: Tx,
  messageIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
  const out = new Map<string, AttachmentRow[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(inArray(attachments.messageId, messageIds), eq(attachments.status, "ready")))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  for (const row of rows) {
    const list = out.get(row.messageId!) ?? [];
    list.push(row);
    out.set(row.messageId!, list);
  }
  return out;
}

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
  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * A presigned GET for one part of an attachment the caller was already authorized for (05-13: the AI chat share
 * routes). Same TTL, type and disposition as the Phase 4 routes; never log the URL (a bearer credential).
 */
export async function presignAttachmentPart(
  storage: ObjectStorage,
  row: AttachmentRow,
  part: AttachmentPart,
): Promise<string> {
  return presignPart(storage, row, part);
}

/** Attachment rows by id under the caller's tenant (RLS); missing ids are simply absent. */
export async function attachmentRowsByIds(tx: Tx, ids: string[]): Promise<AttachmentRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return tx.select().from(attachments).where(inArray(attachments.id, unique));
}
