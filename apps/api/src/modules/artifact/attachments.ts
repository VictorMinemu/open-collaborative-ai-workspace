import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  Attachment,
  type Attachment as AttachmentDto,
  AttachmentsConfig,
  IdParams,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PresignUploadRequest,
  PresignUploadResponse,
  sanitizeFilename,
} from "@ocw/contracts";
import { attachments, conversations, messages, type Tx, tenantOf } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, gone, HttpError, notFound } from "../../lib/errors";
import type { ConversationAccess, ReadableKind } from "../chat/access";
import { AuthzDeniedError, channelResource, createPermissionService } from "../organization";
import { dispositionFor } from "./disposition";
import { type AttachmentRow, toAttachment } from "./model";
import { ImageTooLargeError, type Renditions, renderRenditions } from "./renditions";
import { SNIFF_BYTES, sniff } from "./sniff";
import { type AttachmentPart, attachmentKey, type ObjectStorage } from "./storage";

/** Presigned PUT lifetime (the browser starts the upload right away). */
export const PUT_TTL_SECONDS = 300;
/** Presigned GET lifetime: issued after the read decision, followed immediately by the browser. */
export const GET_TTL_SECONDS = 60;
/** P-11: presigns per user per minute. */
export const PRESIGN_PER_MINUTE = 60;

/** Conversation kinds whose attachment access another module decides (06.1, P-04). */
export type ScopedKind = "work_session";

/**
 * Who may upload into and read the attachments of one conversation kind, decided by the module that owns it (06.1,
 * P-04: a Work Zone session's conversation is the session's, not a channel). Everything else in the routes (size and
 * rate limits, sniffing, renditions, audit, redirects) stays the Phase 4 pipeline.
 */
export interface AttachmentScope {
  /**
   * The caller may upload into this conversation: throws 404 (hidden reads exactly like missing, with
   * `notFoundMessage`), 403 or 409. Returns the declared types it accepts and the refusal text for any other type.
   */
  assertUpload(
    req: FastifyRequest,
    tx: Tx,
    conversationId: string,
    notFoundMessage: string,
  ): Promise<{ allowedTypes: readonly string[]; typeMessage: string }>;
  /** The caller may read this conversation's attachments: throws 404 (with `notFoundMessage`) otherwise. */
  assertRead(req: FastifyRequest, tx: Tx, conversationId: string, notFoundMessage: string): Promise<void>;
}

export type AttachmentScopes = Partial<Record<ScopedKind, AttachmentScope>>;

export interface AttachmentRoutesDeps {
  core: Core;
  access: ConversationAccess;
  /** 06.1: per conversation kind, the module that decides upload and read (wired in app.ts). */
  scopes?: AttachmentScopes;
  storage: ObjectStorage | null;
  /** Storage reachability for `GET /attachments/config` (Garage may still be starting). */
  storageStatus(): Promise<"ok" | "unavailable">;
}

const disabled = () => new HttpError(503, "attachments_disabled", "File attachments are not configured");
const unavailable = () => new HttpError(503, "storage_unavailable", "File storage is unavailable, try again");
const hidden = () => notFound("Attachment not found");
const NO_STORE = "private, no-store";

/**
 * Attachments live in channels, DMs, groups and (05-12) the owner's AI chats. `ai_chat` is never a default readable
 * kind (P-03): asking for it here keeps an AI chat's files exactly as private as the chat (its owner only, admins
 * included in the hidden-as-404 rule).
 */
const KINDS: readonly ReadableKind[] = ["channel", "dm", "group", "ai_chat"];

async function loadRow(tx: Tx, id: string): Promise<AttachmentRow | null> {
  const [row] = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row ?? null;
}

const keyOf = (row: AttachmentRow, part: AttachmentPart) =>
  attachmentKey(row.organizationId, row.conversationId, row.id, part);

/**
 * A short-lived presigned GET for one stored part, issued only after the caller's read decision: the original as a
 * download with its sniffed type, the renditions inline as webp (T-04-04-06). Shared with the AI chat share routes
 * (05-13) through `presignAttachmentPart`, so both serve files the same way.
 */
export function presignPart(
  storage: ObjectStorage,
  row: AttachmentRow,
  part: AttachmentPart,
): Promise<string> {
  return storage.presignGet(keyOf(row, part), {
    ttlSeconds: GET_TTL_SECONDS,
    contentType: part === "original" ? (row.contentType ?? "application/octet-stream") : "image/webp",
    disposition: dispositionFor(part, row.filename),
  });
}

export function registerAttachmentRoutes(app: App, deps: AttachmentRoutesDeps): void {
  const { core, access, storage } = deps;
  const scopes = deps.scopes ?? {};
  const scoped = Object.keys(scopes).length > 0;

  /** The scope deciding this conversation (looked up under RLS: another tenant's conversation has none). */
  async function scopeOf(tx: Tx, conversationId: string): Promise<AttachmentScope | null> {
    if (!scoped) return null;
    const [conv] = await tx
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return conv ? (scopes[conv.kind as ScopedKind] ?? null) : null;
  }

  /** The caller may read the conversation's attachments: its scope decides, else the readable set (hidden = 404). */
  async function assertReadable(req: FastifyRequest, tx: Tx, conversationId: string): Promise<void> {
    const scope = await scopeOf(tx, conversationId);
    if (scope) return scope.assertRead(req, tx, conversationId, "Attachment not found");
    await access.readable(req, tx, conversationId, { kinds: KINDS, notFoundMessage: "Attachment not found" });
  }
  const perms = createPermissionService(core);
  const requireUser = core.identity.requireUser;
  const tags = ["attachments"];
  const maxBytes = core.env.OCW_ATTACHMENT_MAX_BYTES;

  /** Storage errors become 503; only the error name is logged (never a URL or a signed query string). */
  async function storageCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      core.log.warn({ op, err: { name: (err as Error)?.name } }, "object storage call failed");
      throw unavailable();
    }
  }

  app.get(
    "/attachments/config",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, response: { 200: AttachmentsConfig } },
    },
    async (req) => {
      const allowed = await core.db.withTenant(tenant(req), (tx) => perms.can(req, tx, "attachment.upload"));
      const base = { maxBytes, maxPerMessage: MAX_ATTACHMENTS_PER_MESSAGE };
      if (!storage) return { ...base, enabled: false, reason: "not_configured" as const };
      if ((await deps.storageStatus()) !== "ok")
        return { ...base, enabled: false, reason: "unavailable" as const };
      return { ...base, enabled: allowed, reason: null };
    },
  );

  app.post(
    "/conversations/:id/attachments",
    {
      config: {
        authz: "user",
        // After requireUser, so the bucket is the user (P-11), not the IP.
        rateLimit: {
          max: PRESIGN_PER_MINUTE,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: FastifyRequest) => `presign:${req.auth?.userId ?? req.ip}`,
        },
      },
      preHandler: requireUser,
      schema: {
        tags,
        params: IdParams,
        body: PresignUploadRequest,
        response: { 200: PresignUploadResponse },
      },
    },
    async (req) => {
      if (!storage) throw disabled();
      const auth = authOf(req);
      /** The `pending` row, after the size limit (the same for every kind). */
      async function insertPending(tx: Tx, conversationId: string): Promise<AttachmentRow> {
        if (req.body.size > maxBytes) {
          throw new HttpError(400, "too_large", `Files can be at most ${maxBytes} bytes`, { maxBytes });
        }
        const [inserted] = await tx
          .insert(attachments)
          .values({
            organizationId: tenantOf(tx).organizationId,
            conversationId,
            uploaderId: auth.userId,
            filename: sanitizeFilename(req.body.filename),
            declaredType: req.body.contentType,
            sizeBytes: req.body.size,
          })
          .returning();
        return inserted!;
      }
      const row = await core.db.withTenant(tenant(req), async (tx) => {
        const scope = await scopeOf(tx, req.params.id);
        if (scope) {
          const { allowedTypes, typeMessage } = await scope.assertUpload(
            req,
            tx,
            req.params.id,
            "Conversation not found",
          );
          if (!allowedTypes.includes(req.body.contentType)) {
            throw new HttpError(400, "images_only", typeMessage, { allowedTypes });
          }
          return insertPending(tx, req.params.id);
        }
        const { conv, facts } = await access.readable(req, tx, req.params.id, { kinds: KINDS });
        if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
        // Nobody posts into an AI chat through the channel permissions (`ai_chat_private`): its owner and `chat`
        // grantees write there under `ai_chat.use`, decided on the chat itself. As on the chat's own send route, a
        // `view` grantee (who can read the chat) is told 403 `ai_chat_view_only`; every other denial is a 404.
        if (conv.kind === "ai_chat") {
          try {
            await perms.assertCan(req, tx, "ai_chat.use", channelResource(facts));
          } catch (err) {
            if (err instanceof AuthzDeniedError && err.denial.reason !== "ai_chat_view_only") {
              throw new AuthzDeniedError(err.denial, { hideAs404: true });
            }
            throw err;
          }
        } else {
          await perms.assertCan(req, tx, "channel.post", channelResource(facts));
        }
        await perms.assertCan(req, tx, "attachment.upload", channelResource(facts));
        return insertPending(tx, conv.id);
      });
      const upload = await storage.presignPut(
        keyOf(row, "original"),
        row.declaredType,
        row.sizeBytes,
        PUT_TTL_SECONDS,
      );
      return { attachment: toAttachment(row), upload: { ...upload, method: "PUT" as const } };
    },
  );

  app.post(
    "/attachments/:id/complete",
    {
      config: { authz: "user" },
      preHandler: requireUser,
      schema: { tags, params: IdParams, response: { 200: Attachment } },
    },
    async (req): Promise<AttachmentDto> => {
      if (!storage) throw disabled();
      const auth = authOf(req);
      const ctx = tenant(req);
      // 1. Authorize in a short transaction: only the uploader completes, and only while they can read.
      const row = await core.db.withTenant(ctx, async (tx) => {
        const r = await loadRow(tx, req.params.id);
        if (!r || r.uploaderId !== auth.userId) throw hidden();
        await assertReadable(req, tx, r.conversationId);
        return r;
      });
      if (row.status === "ready") return toAttachment(row); // idempotent retry
      if (row.status !== "pending") throw conflict("This upload can no longer be completed", "not_pending");

      // 2. Verify the bytes outside any transaction (storage calls can take a while): size, type by magic bytes,
      //    SHA-256, then EXIF-stripped renditions for raster images.
      const original = keyOf(row, "original");
      const head = await storageCall("head", () => storage.head(original));
      if (!head) throw conflict("The file has not been uploaded yet", "upload_missing");
      if (head.size !== row.sizeBytes) {
        await reject();
        throw conflict("The uploaded file does not match the declared size", "size_mismatch");
      }
      const first = await storageCall("range", () => storage.rangeGet(original, SNIFF_BYTES));
      const sniffed = await sniff(first, row.declaredType);
      if (!sniffed.ok) {
        await reject();
        throw conflict("The file content does not match its type", "type_mismatch");
      }
      const sha256 = await storageCall("hash", async () => {
        const hash = createHash("sha256");
        await pipeline(await storage.stream(original), hash);
        return hash.digest("hex");
      });
      let renditions: Renditions | null = null;
      if (sniffed.raster) {
        try {
          renditions = await renderRenditions(await storageCall("stream", () => storage.stream(original)));
        } catch (err) {
          if (err instanceof ImageTooLargeError) {
            await reject();
            throw conflict("The image is too large to process", "image_too_large");
          }
          if (err instanceof HttpError) throw err;
          // A file sharp cannot decode stays a plain download (no preview).
          core.log.warn({ attachmentId: row.id, err: { name: (err as Error)?.name } }, "rendition failed");
        }
        for (const { part, body } of renditions?.parts ?? []) {
          await storageCall("put", () => storage.put(keyOf(row, part), body, "image/webp"));
        }
      }

      // 3. Mark ready (only from pending: a concurrent complete or delete wins) and audit, in one transaction.
      return core.db.withTenant(ctx, async (tx) => {
        const [ready] = await tx
          .update(attachments)
          .set({
            status: "ready",
            contentType: sniffed.contentType,
            sha256,
            hasRenditions: renditions !== null,
            // 06.1: the size of the rendition a Work Zone prompt may send, so its budget needs no storage call.
            largeBytes: renditions?.parts.find((p) => p.part === "large.webp")?.body.length ?? null,
            width: renditions?.width ?? null,
            height: renditions?.height ?? null,
            completedAt: new Date().toISOString(),
          })
          .where(and(eq(attachments.id, row.id), eq(attachments.status, "pending")))
          .returning();
        if (!ready) throw conflict("This upload can no longer be completed", "not_pending");
        await core.audit.record(tx, {
          action: "attachment.uploaded",
          resourceType: "attachment",
          resourceId: ready.id,
          metadata: {
            attachmentId: ready.id,
            conversationId: ready.conversationId,
            size: ready.sizeBytes,
            contentType: sniffed.contentType,
            sha256,
          },
        });
        return toAttachment(ready);
      });

      async function reject() {
        await core.db.withTenant(ctx, (tx) =>
          tx
            .update(attachments)
            .set({ status: "rejected" })
            .where(and(eq(attachments.id, row.id), eq(attachments.status, "pending"))),
        );
        // Best effort; the sweeper removes whatever is left after 24 h.
        await storage?.remove([original]).catch(() => undefined);
      }
    },
  );

  /**
   * The attachment when the caller may see it: readable conversation (hidden = 404; its scope decides for a scoped
   * kind), `ready`, and either linked to a live message, linked to a Work Zone prompt (every reader of the session,
   * 06.1) or still the caller's own unlinked upload.
   */
  async function visible(req: FastifyRequest, tx: Tx, id: string): Promise<AttachmentRow> {
    const row = await loadRow(tx, id);
    if (row?.status !== "ready") throw hidden();
    await assertReadable(req, tx, row.conversationId);
    if (row.workPromptId) {
      // Sent with a prompt: the session's readers see it (the scope above decided).
    } else if (row.messageId) {
      const [msg] = await tx
        .select({ deletedAt: messages.deletedAt })
        .from(messages)
        .where(eq(messages.id, row.messageId))
        .limit(1);
      if (!msg || msg.deletedAt) throw hidden();
    } else if (row.uploaderId !== authOf(req).userId) {
      throw hidden();
    }
    return row;
  }

  /** 302 to a short-lived presigned GET; the redirect itself is never cached (T-04-04-03). */
  const redirect = (reply: FastifyReply, url: string) =>
    reply.header("cache-control", NO_STORE).redirect(url, 302);

  app.get(
    "/attachments/:id/download",
    { config: { authz: "user" }, preHandler: requireUser, schema: { tags, params: IdParams } },
    async (req, reply) => {
      if (!storage) throw disabled();
      const url = await core.db.withTenant(tenant(req), async (tx) => {
        const row = await visible(req, tx, req.params.id);
        await core.audit.record(tx, {
          action: "attachment.downloaded",
          resourceType: "attachment",
          resourceId: row.id,
          metadata: { attachmentId: row.id, conversationId: row.conversationId },
        });
        return presignPart(storage, row, "original");
      });
      return redirect(reply, url);
    },
  );

  // Inline webp renditions of sniffed raster images. Not audited: a message list loads one per image, and the
  // original (with its EXIF) is only reachable through the audited download (ADR-0015).
  for (const [path, part] of [
    ["preview", "thumb.webp"],
    ["large", "large.webp"],
  ] as const) {
    app.get(
      `/attachments/:id/${path}`,
      { config: { authz: "user" }, preHandler: requireUser, schema: { tags, params: IdParams } },
      async (req, reply) => {
        if (!storage) throw disabled();
        const url = await core.db.withTenant(tenant(req), async (tx) => {
          const row = await visible(req, tx, req.params.id);
          if (!toAttachment(row).isImage) throw hidden();
          return presignPart(storage, row, part);
        });
        // The web app embeds these as <img> from its own origin. Helmet's `same-site` CORP blocks that wherever
        // the web and the API are not same-site, e.g. a self-hosted install on an IP address with two ports
        // (Chromium treats each IP:port as its own site). The 302 carries no body, the session cookie is
        // SameSite=Lax (a cross-site page gets a 404 here), and the access check above runs on every request.
        reply.header("cross-origin-resource-policy", "cross-origin");
        return redirect(reply, url);
      },
    );
  }
}
