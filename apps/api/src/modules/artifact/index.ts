import { createHash, randomUUID } from "node:crypto";
import {
  type Attachment,
  INLINE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  sanitizeFilename,
  WORK_PROMPT_MAX_IMAGES,
} from "@ocw/contracts";
import { attachments, type Tx, tenantOf } from "@ocw/db";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiModule, App, Core } from "../../core";
import { conflict } from "../../lib/errors";
// Type-only: the chat module imports this module's helpers (Plan 04-12), so a runtime import would be a cycle.
import type { ConversationAccess } from "../chat/access";
import { type AttachmentScopes, presignPart, registerAttachmentRoutes } from "./attachments";
import { type AttachmentRow, toAttachment } from "./model";
import { SNIFF_BYTES, sniff } from "./sniff";
import { type AttachmentPart, attachmentKey, createObjectStorage, type ObjectStorage } from "./storage";
import { createAttachmentSweeper } from "./sweeper";

export type { AttachmentScope, AttachmentScopes, ScopedKind } from "./attachments";
export { EXTRACT_LIMITS } from "./extract/limits";
export {
  type AgentRead,
  type AgentReadCaps,
  type ExtractRefusal,
  readAttachmentForAgent,
} from "./extract/read";
export {
  type AgentReadKind,
  attachmentKindOf,
  cutChars,
  decodeText,
  labelName,
  TEXT_EXTENSIONS,
  untrustedFileBlock,
} from "./extract/text";
export { type AttachmentRow, toAttachment } from "./model";
export { AttachmentTooLargeError, readAttachmentBytes } from "./read-bytes";
export { fitImageWithin } from "./renditions";
export {
  type AttachmentPart,
  attachmentKey,
  createObjectStorage,
  type ObjectStorage,
  type ObjectStorageEnv,
  ObjectTooLargeError,
  objectStorageConfigured,
  s3Client,
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
    .set({
      workPromptId: input.workPromptId,
      // 06.1-02: request order is persisted (0-based), so the device and every list get the sender's order.
      workPromptPosition: sql`array_position(array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[], ${attachments.id}) - 1`,
    })
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

/** A prompt's images in request order (06.1-02), then upload order for rows linked without a position. */
const workPromptOrder = [
  sql`${attachments.workPromptPosition} asc nulls last`,
  asc(attachments.createdAt),
  asc(attachments.id),
];

/** Ready attachments of the given Work Zone prompts, in request order (06.1). */
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
    .orderBy(...workPromptOrder);
  for (const row of rows) {
    const list = out.get(row.workPromptId!) ?? [];
    list.push(toAttachment(row));
    out.set(row.workPromptId!, list);
  }
  return out;
}

/** Ready attachment rows of one Work Zone prompt, in request order (what its dispatch sends, 06.1-02). */
export async function attachmentRowsForWorkPrompt(tx: Tx, promptId: string): Promise<AttachmentRow[]> {
  return tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.workPromptId, promptId), eq(attachments.status, "ready")))
    .orderBy(...workPromptOrder);
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

/**
 * A file the server itself puts into a conversation for a bot turn (07.8-10: `ocw_sandbox_share`; 07.8-25: browser
 * downloads under a member session). The bytes are written with the storage's server credentials and the row is
 * inserted in the caller's tenant transaction: `pending`, uploaded by the bot, tagged with the turn's `eventId`, its type
 * sniffed from the bytes (nothing declared is trusted, T-04-04-02) and never rendered inline (no renditions). Nobody can
 * read it until the reply posted for that turn links it (`linkTurnAttachments`); a share whose reply never comes stays
 * `pending` and the attachment sweeper removes it after 24 h. A storage failure throws, so the caller's transaction
 * rolls the row back.
 */
export async function storeServerAttachment(
  tx: Tx,
  storage: ObjectStorage,
  input: {
    conversationId: string;
    uploaderAgentId: string;
    eventId: string;
    name: string;
    bytes: Uint8Array;
  },
): Promise<AttachmentRow> {
  const contentType = await sniffedType(input.bytes.subarray(0, SNIFF_BYTES));
  const row = await recordServerAttachment(tx, {
    id: randomUUID(),
    conversationId: input.conversationId,
    uploaderAgentId: input.uploaderAgentId,
    eventId: input.eventId,
    name: input.name,
    sizeBytes: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    contentType,
  });
  await storage.put(
    attachmentKey(row.organizationId, row.conversationId, row.id, "original"),
    input.bytes,
    contentType,
  );
  return row;
}

/** The type stored for server-written bytes: sniffed from their head, never declared (T-04-04-02). */
async function sniffedType(head: Uint8Array): Promise<string> {
  const sniffed = await sniff(head, "application/octet-stream");
  return sniffed.ok ? sniffed.contentType : "application/octet-stream";
}

/**
 * The row half of `storeServerAttachment` (07.17.1.1 PD-17): a `pending` attachment of a bot turn, uploaded by the
 * bot, under an id the caller chose (a transfer pre-allocates it), with the size, sha256 and sniffed type of bytes
 * already in storage under that id. Inserted in the caller's tenant transaction; the name is sanitized here.
 */
export async function recordServerAttachment(
  tx: Tx,
  p: {
    id: string;
    conversationId: string;
    uploaderAgentId: string;
    eventId: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
  },
): Promise<AttachmentRow> {
  const [row] = await tx
    .insert(attachments)
    .values({
      id: p.id,
      organizationId: tenantOf(tx).organizationId,
      conversationId: p.conversationId,
      uploaderId: p.uploaderAgentId,
      filename: sanitizeFilename(p.name),
      declaredType: p.contentType,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      eventId: p.eventId,
    })
    .returning();
  if (!row) throw new Error("attachment insert returned no row");
  return row;
}

/**
 * The storage half of a file a device streams in for a bot turn (07.17.1.1 D-03, D-08, PD-05, PD-17): the body goes
 * to the attachment's `original` key through `putStream` (multipart above one part, never held whole), and every byte
 * is hashed (sha256) and counted on the way; the first `SNIFF_BYTES` pick the stored type (nothing declared is
 * trusted; the bytes are never decoded or rendered). Past `maxBytes` it throws `ObjectTooLargeError` and nothing is
 * stored. The caller compares `sizeBytes` with what it expected, then records the row (`recordServerAttachment`).
 */
export async function streamServerAttachment(
  storage: ObjectStorage,
  p: {
    organizationId: string;
    conversationId: string;
    attachmentId: string;
    body: AsyncIterable<Uint8Array>;
    maxBytes: number;
  },
): Promise<{ sizeBytes: number; sha256: string; contentType: string }> {
  const hash = createHash("sha256");
  const head = new Uint8Array(SNIFF_BYTES);
  let headBytes = 0;
  const { bytes } = await storage.putStream(
    attachmentKey(p.organizationId, p.conversationId, p.attachmentId, "original"),
    p.body,
    {
      contentType: "application/octet-stream",
      maxBytes: p.maxBytes,
      onChunk: (chunk) => {
        hash.update(chunk);
        if (headBytes < SNIFF_BYTES) {
          const take = Math.min(SNIFF_BYTES - headBytes, chunk.length);
          head.set(chunk.subarray(0, take), headBytes);
          headBytes += take;
        }
      },
    },
  );
  return {
    sizeBytes: bytes,
    sha256: hash.digest("hex"),
    contentType: await sniffedType(head.subarray(0, headBytes)),
  };
}

/** How many files a turn has shared that no reply has linked yet (at most `MAX_ATTACHMENTS_PER_MESSAGE`). */
export async function pendingTurnAttachmentCount(tx: Tx, eventId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(attachments)
    .where(
      and(eq(attachments.eventId, eventId), eq(attachments.status, "pending"), isNull(attachments.messageId)),
    );
  return Number(row?.n ?? 0);
}

/**
 * Links the files a bot shared in one turn to the reply posted for it, in the reply's transaction before its
 * `message.created` is appended: only the turn's own `pending` rows of this conversation uploaded by this bot become
 * `ready` attachments of the reply. Returns how many were linked.
 */
export async function linkTurnAttachments(
  tx: Tx,
  input: { eventId: string; conversationId: string; uploaderAgentId: string; messageId: string },
): Promise<number> {
  const linked = await tx
    .update(attachments)
    .set({ messageId: input.messageId, status: "ready", completedAt: new Date().toISOString() })
    .where(
      and(
        eq(attachments.eventId, input.eventId),
        eq(attachments.conversationId, input.conversationId),
        eq(attachments.uploaderId, input.uploaderAgentId),
        eq(attachments.status, "pending"),
        isNull(attachments.messageId),
        isNull(attachments.workPromptId),
        isNull(attachments.purgedAt),
      ),
    )
    .returning({ id: attachments.id });
  return linked.length;
}
