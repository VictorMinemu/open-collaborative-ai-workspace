import {
  AiChatShare,
  AiChatShareList,
  type AiShareAttachment,
  type AiShareMessage,
  AiShareView,
  IdParams,
} from "@ocw/contracts";
import { aiChatShares, conversations, messages, orgMembers, type Tx } from "@ocw/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import {
  type AttachmentPart,
  attachmentRowsByIds,
  attachmentRowsForMessages,
  type ObjectStorage,
  presignAttachmentPart,
  toAttachment,
} from "../artifact";
import { createConversationAccess, iso } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { AuthzDeniedError, channelResource, createPermissionService, orgResource } from "../organization";
import { DEFAULT_CHAT_TITLE, generationsFor } from "./dto";

/**
 * Read-only snapshot share links of an AI chat (05-13, AICHAT-09, Pattern 8). The owner freezes the visible
 * conversation ONCE into `ai_chat_shares.snapshot` (bodies copied, never referenced), with the allow-list of the
 * files it shows in `attachment_ids`. A colleague signed in to the same organization with `ai_chat.share.read` reads
 * it at `GET /ai-shares/<id>`; the web route is `/share/ai/<id>` inside the signed-in app.
 *
 * Never public: every route needs a session (`requireUser`, 401 otherwise), the share row is read under tenant RLS
 * (another organization's id is simply missing) and no URL carries a token: the id alone grants nothing. Missing,
 * revoked, other-org and denied all answer the same 404. Created, revoked and viewed are audited with ids only.
 */

const SHARE_NOT_FOUND = "This link isn't available";
const CHAT_NOT_FOUND = "AI chat not found";
/** Share links per member per minute: each one copies the whole visible chat. */
const SHARES_PER_MINUTE = 30;

/** One file of a snapshot as stored (metadata only; URLs are share-scoped and built when it is read). */
const StoredAttachment = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  isImage: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
type StoredAttachment = z.infer<typeof StoredAttachment>;

const StoredMessage = z.object({
  role: z.enum(["user", "assistant"]),
  body: z.string(),
  modelLabel: z.string().nullable(),
  createdAt: z.string(),
  attachments: z.array(StoredAttachment),
});
type StoredMessage = z.infer<typeof StoredMessage>;

const ShareParams = z.object({ shareId: z.uuid() });

/** `ai_chat_shares.snapshot`: written once at creation, never updated. */
const StoredSnapshot = z.object({ v: z.literal(1), messages: z.array(StoredMessage) });

/** Answers kept in a snapshot: finished ones, and ones cut short that kept their text. */
const KEPT_ANSWERS = new Set(["completed", "stopped", "interrupted"]);

export interface Snapshot {
  title: string;
  messages: StoredMessage[];
  attachmentIds: string[];
}

/**
 * The visible conversation right now: non-deleted top-level messages in seq order. User turns are copied with
 * their ready files; assistant turns only when their latest generation completed (or was stopped/interrupted) with
 * text, labelled with that generation's model. Running, failed and empty answers are left out.
 */
export async function snapshotOf(tx: Tx, chatId: string, gateway: ModelGateway): Promise<Snapshot> {
  const [conv] = await tx
    .select({ name: conversations.name })
    .from(conversations)
    .where(eq(conversations.id, chatId))
    .limit(1);
  if (!conv) throw notFound(CHAT_NOT_FOUND);
  const rows = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, chatId), isNull(messages.threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.seq));
  const gens = await generationsFor(
    tx,
    rows.filter((r) => r.authorKind === "agent").map((r) => r.id),
    gateway,
  );
  const files = await attachmentRowsForMessages(
    tx,
    rows.filter((r) => r.authorKind === "user").map((r) => r.id),
  );
  const out: StoredMessage[] = [];
  const attachmentIds: string[] = [];
  for (const r of rows) {
    if (r.authorKind === "agent") {
      const g = gens.get(r.id);
      if (!g || !KEPT_ANSWERS.has(g.status) || r.status === "streaming" || r.body.trim() === "") continue;
      out.push({
        role: "assistant",
        body: r.body,
        modelLabel: g.modelLabel,
        createdAt: iso(r.createdAt),
        attachments: [],
      });
      continue;
    }
    if (r.authorKind !== "user") continue;
    const attached = (files.get(r.id) ?? []).map((row): StoredAttachment => {
      const a = toAttachment(row);
      attachmentIds.push(a.id);
      return {
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        isImage: a.isImage,
        width: a.width,
        height: a.height,
      };
    });
    out.push({
      role: "user",
      body: r.body,
      modelLabel: null,
      createdAt: iso(r.createdAt),
      attachments: attached,
    });
  }
  return { title: conv.name ?? DEFAULT_CHAT_TITLE, messages: out, attachmentIds };
}

type ShareRow = typeof aiChatShares.$inferSelect;

function messageCountOf(row: ShareRow): number {
  const parsed = StoredSnapshot.safeParse(row.snapshot);
  return parsed.success ? parsed.data.messages.length : 0;
}

export function shareDto(row: ShareRow): AiChatShare {
  return {
    id: row.id,
    chatId: row.conversationId,
    path: `/share/ai/${row.id}`,
    title: row.title,
    messageCount: messageCountOf(row),
    createdAt: iso(row.createdAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
  };
}

/** Share-scoped file URLs (API-relative): they re-check the share on every request. */
export function shareAttachmentDto(shareId: string, a: StoredAttachment): AiShareAttachment {
  const base = `/api/v1/ai-shares/${shareId}/attachments/${a.id}`;
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    isImage: a.isImage,
    width: a.isImage ? a.width : null,
    height: a.isImage ? a.height : null,
    previewUrl: a.isImage ? `${base}/preview` : null,
    largeUrl: a.isImage ? `${base}/large` : null,
    downloadUrl: `${base}/download`,
  };
}

export interface ShareRoutesDeps {
  core: Core;
  gateway: ModelGateway;
  /** Where the snapshot's files live (ADR-0015); null = attachments are not configured. */
  storage: ObjectStorage | null;
}

/** What every share route answers for a share the caller may not see (missing, revoked, other org, denied). */
export const shareHidden = () => notFound(SHARE_NOT_FOUND);
/** A file that is not part of the snapshot (or no longer ready). */
const fileHidden = () => notFound("Attachment not found");

/**
 * The live share the caller may read, or the one 404: a session of the share's organization (RLS), the reader's
 * `ai_chat.share.read` on the organization, and not revoked.
 */
export async function readableShare(
  req: FastifyRequest,
  tx: Tx,
  perms: ReturnType<typeof createPermissionService>,
  shareId: string,
): Promise<ShareRow> {
  try {
    await perms.assertCan(req, tx, "ai_chat.share.read", orgResource(), { hideAs404: true });
  } catch (err) {
    // A denial must read exactly like a missing link (same status, code and message).
    if (err instanceof AuthzDeniedError && err.hidden) {
      throw new AuthzDeniedError(err.denial, { hideAs404: true, message: SHARE_NOT_FOUND });
    }
    throw err;
  }
  const [row] = await tx.select().from(aiChatShares).where(eq(aiChatShares.id, shareId)).limit(1);
  if (!row || row.revokedAt !== null) throw shareHidden();
  return row;
}

export function registerShareRoutes(app: App, deps: ShareRoutesDeps): void {
  const { core, gateway, storage } = deps;
  const access = createConversationAccess(core);
  const perms = createPermissionService(core);
  const tags = ["ai-chat"];
  const createLimit = app.rateLimit({
    max: SHARES_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-share:${req.auth?.userId ?? req.ip}`,
  });

  /** The caller's own AI chat (readable set with `ai_chat` is owner-only; everyone else, admins included, 404). */
  const ownedChat = (req: FastifyRequest, tx: Tx, chatId: string) =>
    access.readable(req, tx, chatId, { kinds: ["ai_chat"], notFoundMessage: CHAT_NOT_FOUND });

  app.post(
    "/ai-chats/:id/shares",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: createLimit,
      schema: { tags, params: IdParams, response: { 201: AiChatShare } },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const dto = await core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await ownedChat(req, tx, req.params.id);
        await perms.assertCan(req, tx, "ai_chat.share", channelResource(facts), { hideAs404: true });
        const snap = await snapshotOf(tx, conv.id, gateway);
        if (snap.messages.length === 0)
          throw conflict("There is nothing to share in this chat yet", "share_empty");
        const [row] = await tx
          .insert(aiChatShares)
          .values({
            organizationId: conv.organizationId,
            conversationId: conv.id,
            createdBy: auth.userId,
            title: snap.title,
            snapshot: { v: 1, messages: snap.messages },
            attachmentIds: snap.attachmentIds,
          })
          .returning();
        if (!row) throw new Error("share insert returned no row");
        // Ids and the count only: the title and the bodies are the member's own text.
        await core.audit.record(tx, {
          action: "ai_chat.share_created",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: { conversationId: conv.id, shareId: row.id, messageCount: snap.messages.length },
        });
        return shareDto(row);
      });
      return reply.status(201).send(dto);
    },
  );

  app.get(
    "/ai-chats/:id/shares",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: AiChatShareList } },
    },
    async (req) => {
      const auth = authOf(req);
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await ownedChat(req, tx, req.params.id);
        const rows = await tx
          .select()
          .from(aiChatShares)
          .where(and(eq(aiChatShares.conversationId, conv.id), eq(aiChatShares.createdBy, auth.userId)))
          .orderBy(desc(aiChatShares.createdAt), desc(aiChatShares.id));
        return { shares: rows.map(shareDto) };
      });
    },
  );

  // Revoke (creator only; anyone else, admins included, 404). Takes effect at once: every read checks `revoked_at`.
  // Idempotent: a second call answers the same share and audits nothing.
  app.delete(
    "/ai-shares/:shareId",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: ShareParams, response: { 200: AiChatShare } },
    },
    async (req) => {
      const auth = authOf(req);
      return core.db.withTenant(tenant(req), async (tx) => {
        const [row] = await tx
          .select()
          .from(aiChatShares)
          .where(and(eq(aiChatShares.id, req.params.shareId), eq(aiChatShares.createdBy, auth.userId)))
          .limit(1);
        if (!row) throw shareHidden();
        // The creator's own chat (the resolver decides on it, owner only); revoking needs no share permission, so
        // a member whose `ai_chat.share` was taken away can still withdraw what they shared.
        await access.readable(req, tx, row.conversationId, {
          kinds: ["ai_chat"],
          notFoundMessage: SHARE_NOT_FOUND,
        });
        if (row.revokedAt !== null) return shareDto(row);
        const [revoked] = await tx
          .update(aiChatShares)
          .set({ revokedAt: new Date().toISOString() })
          .where(and(eq(aiChatShares.id, row.id), isNull(aiChatShares.revokedAt)))
          .returning();
        // A concurrent revoke won: answer its row, audit once.
        if (!revoked) {
          const [current] = await tx.select().from(aiChatShares).where(eq(aiChatShares.id, row.id)).limit(1);
          return shareDto(current ?? row);
        }
        await core.audit.record(tx, {
          action: "ai_chat.share_revoked",
          resourceType: "ai_chat",
          resourceId: row.conversationId,
          metadata: { conversationId: row.conversationId, shareId: row.id },
        });
        return shareDto(revoked);
      });
    },
  );

  app.get(
    "/ai-shares/:shareId",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: ShareParams, response: { 200: AiShareView } },
    },
    async (req): Promise<AiShareView> =>
      core.db.withTenant(tenant(req), async (tx) => {
        const row = await readableShare(req, tx, perms, req.params.shareId);
        const snap = StoredSnapshot.parse(row.snapshot);
        const [author] = await tx
          .select({ displayName: orgMembers.displayName, avatarUrl: orgMembers.avatarUrl })
          .from(orgMembers)
          .where(eq(orgMembers.userId, row.createdBy))
          .limit(1);
        await core.audit.record(tx, {
          action: "ai_chat.share_viewed",
          resourceType: "ai_chat",
          resourceId: row.conversationId,
          metadata: { shareId: row.id, conversationId: row.conversationId },
        });
        return {
          id: row.id,
          title: row.title,
          createdAt: iso(row.createdAt),
          createdBy: {
            kind: "user",
            id: row.createdBy,
            displayName: author?.displayName ?? "Former member",
            avatarUrl: author?.avatarUrl ?? null,
          },
          messages: snap.messages.map(
            (m): AiShareMessage => ({
              role: m.role,
              body: m.body,
              modelLabel: m.modelLabel,
              createdAt: m.createdAt,
              attachments: m.attachments.map((a) => shareAttachmentDto(row.id, a)),
            }),
          ),
        };
      }),
  );

  // The snapshot's files, through the share only (ADR-0015): the share must be readable (the same rules and the same
  // 404 as the view), the id must be in its `attachment_ids` allow-list and the file still `ready` in that chat. The
  // AI chat's own attachment routes stay owner-only. Renditions are not audited (one per image per view, as in
  // Phase 4); the original is, with the share id.
  const ShareAttachmentParams = z.object({ shareId: z.uuid(), attachmentId: z.uuid() });
  for (const [path, part] of [
    ["preview", "thumb.webp"],
    ["large", "large.webp"],
    ["download", "original"],
  ] as const satisfies ReadonlyArray<readonly [string, AttachmentPart]>) {
    app.get(
      `/ai-shares/:shareId/attachments/:attachmentId/${path}`,
      {
        config: { authz: "user" },
        onRequest: core.identity.requireUser,
        schema: { tags, params: ShareAttachmentParams },
      },
      async (req, reply) => {
        if (!storage) throw new HttpError(503, "attachments_disabled", "File attachments are not configured");
        const url = await core.db.withTenant(tenant(req), async (tx) => {
          const share = await readableShare(req, tx, perms, req.params.shareId);
          const { attachmentId } = req.params;
          if (!share.attachmentIds.includes(attachmentId)) throw fileHidden();
          const [row] = await attachmentRowsByIds(tx, [attachmentId]);
          if (row?.status !== "ready" || row.conversationId !== share.conversationId) throw fileHidden();
          if (part !== "original" && !toAttachment(row).isImage) throw fileHidden();
          if (part === "original") {
            await core.audit.record(tx, {
              action: "attachment.downloaded",
              resourceType: "attachment",
              resourceId: row.id,
              metadata: { attachmentId: row.id, conversationId: row.conversationId, shareId: share.id },
            });
          }
          return presignAttachmentPart(storage, row, part);
        });
        // Same headers as the chat's routes: the redirect is never cached, and the web app embeds renditions as
        // <img> from its own origin (see artifact/attachments.ts on the CORP header).
        if (part !== "original") reply.header("cross-origin-resource-policy", "cross-origin");
        return reply.header("cache-control", "private, no-store").redirect(url, 302);
      },
    );
  }
}
