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
import { attachments, messages, type Tx, tenantOf } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, gone, HttpError, notFound } from "../../lib/errors";
import type { ConversationAccess } from "../chat/access";
import { channelResource, createPermissionService } from "../organization";
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

export interface AttachmentRoutesDeps {
  core: Core;
  access: ConversationAccess;
  storage: ObjectStorage | null;
  /** Storage reachability for `GET /attachments/config` (Garage may still be starting). */
  storageStatus(): Promise<"ok" | "unavailable">;
}

const disabled = () => new HttpError(503, "attachments_disabled", "File attachments are not configured");
const unavailable = () => new HttpError(503, "storage_unavailable", "File storage is unavailable, try again");
const hidden = () => notFound("Attachment not found");
const NO_STORE = "private, no-store";

async function loadRow(tx: Tx, id: string): Promise<AttachmentRow | null> {
  const [row] = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row ?? null;
}

const keyOf = (row: AttachmentRow, part: AttachmentPart) =>
  attachmentKey(row.organizationId, row.conversationId, row.id, part);

export function registerAttachmentRoutes(app: App, deps: AttachmentRoutesDeps): void {
  const { core, access, storage } = deps;
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
      const row = await core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await access.readable(req, tx, req.params.id);
        if (conv.archivedAt) throw gone("This conversation is archived", "channel_archived");
        await perms.assertCan(req, tx, "channel.post", channelResource(facts));
        await perms.assertCan(req, tx, "attachment.upload", channelResource(facts));
        if (req.body.size > maxBytes) {
          throw new HttpError(400, "too_large", `Files can be at most ${maxBytes} bytes`, { maxBytes });
        }
        const [inserted] = await tx
          .insert(attachments)
          .values({
            organizationId: tenantOf(tx).organizationId,
            conversationId: conv.id,
            uploaderId: auth.userId,
            filename: sanitizeFilename(req.body.filename),
            declaredType: req.body.contentType,
            sizeBytes: req.body.size,
          })
          .returning();
        return inserted!;
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
        await access.readable(req, tx, r.conversationId, { notFoundMessage: "Attachment not found" });
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
   * The attachment when the caller may see it: readable conversation (hidden = 404), `ready`, and either linked
   * to a live message or still the caller's own unlinked upload.
   */
  async function visible(req: FastifyRequest, tx: Tx, id: string): Promise<AttachmentRow> {
    const row = await loadRow(tx, id);
    if (row?.status !== "ready") throw hidden();
    await access.readable(req, tx, row.conversationId, { notFoundMessage: "Attachment not found" });
    if (row.messageId) {
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
        return storage.presignGet(keyOf(row, "original"), {
          ttlSeconds: GET_TTL_SECONDS,
          contentType: row.contentType ?? "application/octet-stream",
          disposition: dispositionFor("original", row.filename),
        });
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
          return storage.presignGet(keyOf(row, part), {
            ttlSeconds: GET_TTL_SECONDS,
            contentType: "image/webp",
            disposition: dispositionFor(part, row.filename),
          });
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
