import {
  AI_GRANTS_MAX,
  type AiChatGrant,
  AiChatGrantList,
  AiChatGrant as AiChatGrantSchema,
  CreateAiChatGrantRequest,
  EventTypes,
  IdParams,
} from "@ocw/contracts";
import { aiChatGrants, aiChats, aiGenerations, orgMembers, type Tx } from "@ocw/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { addMember, type ConversationRow, convTopic, createConversationAccess, iso } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService } from "../organization";
import { type AiChatRow, chatSummary, directoryOf, ownerAuthor } from "./dto";
import { createChatGuards } from "./service";

/**
 * Sharing an AI chat in place (D-03, P-03, P-09, MULTI-01): a grant row on the SAME conversation, never a copy. Only
 * the owner (`ai_chat.share`) grants or lists; everyone else, admins included, gets the chat's 404. This plan grants
 * people (`user` subjects); unit and organization subjects answer 400 `grant_subject_unsupported` until 06-04.
 *
 * A person grant also writes that person's participation row (`conversation_members`, role member, P-09): rows are
 * participation only, access comes from the grant (`aiAccessSql`). Every grant is audited with ids only and announced
 * with a durable `ai_chat.access_changed` on `conv:<id>` and `user:<subject>`, plus `ai_chat.updated` on the
 * subject's topic so the chat appears in their sidebar.
 */

const GRANTS_PER_MINUTE = 60;

type GrantRow = typeof aiChatGrants.$inferSelect;

/** Grant DTOs with display labels: the subject's and the granter's names (a former member keeps a neutral one). */
async function grantDtos(tx: Tx, rows: GrantRow[]): Promise<AiChatGrant[]> {
  const userIds = rows.flatMap((r) => [
    r.grantedBy,
    ...(r.subjectKind === "user" && r.subjectId ? [r.subjectId] : []),
  ]);
  const dir = await directoryOf(tx, userIds);
  return rows.map((r) => ({
    id: r.id,
    chatId: r.conversationId,
    subject:
      r.subjectKind === "org" ? { kind: "org" as const } : { kind: r.subjectKind, id: r.subjectId as string },
    label: r.subjectId ? (dir.users.get(r.subjectId)?.displayName ?? "Former member") : "Everyone",
    unitKind: null,
    level: r.level,
    grantedBy: ownerAuthor(dir, r.grantedBy),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  }));
}

async function grantDto(tx: Tx, row: GrantRow): Promise<AiChatGrant> {
  const [dto] = await grantDtos(tx, [row]);
  if (!dto) throw new Error("grant projection missing");
  return dto;
}

export function registerGrantRoutes(app: App, ctx: { core: Core; gateway: ModelGateway }): void {
  const { core, gateway } = ctx;
  const perms = createPermissionService(core);
  const guards = createChatGuards(createConversationAccess(core), perms);
  const chatDeps = { audit: core.audit, realtime: core.realtime };
  const tags = ["ai-chat"];
  const grantLimit = app.rateLimit({
    max: GRANTS_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-grant:${req.auth?.userId ?? req.ip}`,
  });

  /** The chat its owner shares: readable (hidden 404), then `ai_chat.share` (the same 404 for non-owners). */
  async function sharedByOwner(req: FastifyRequest, tx: Tx, chatId: string) {
    const { conv, facts } = await guards.readableChat(req, tx, chatId);
    await guards.assertOn(req, tx, "ai_chat.share", facts);
    const [chat] = await tx.select().from(aiChats).where(eq(aiChats.conversationId, conv.id)).limit(1);
    if (!chat) throw notFound("AI chat not found");
    return { conv, chat };
  }

  /** What the grantee's sidebar shows: the chat as they see it now. */
  async function announce(
    tx: Tx,
    conv: ConversationRow,
    chat: AiChatRow,
    subjectId: string,
    level: "chat" | "view",
  ) {
    const [running] = await tx
      .select({ id: aiGenerations.id })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
      .limit(1);
    const owner = ownerAuthor(await directoryOf(tx, [chat.ownerUserId]), chat.ownerUserId);
    const payload = { conversationId: conv.id, access: level };
    await core.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.aiChatAccessChanged, payload);
    await core.realtime.appendEvent(tx, `user:${subjectId}`, EventTypes.aiChatAccessChanged, payload);
    await core.realtime.appendEvent(tx, `user:${subjectId}`, EventTypes.aiChatUpdated, {
      chat: chatSummary(conv, chat, {
        generating: running !== undefined,
        gateway,
        view: { access: level, owner, shared: true },
      }),
    });
  }

  app.post(
    "/ai-chats/:id/grants",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: grantLimit,
      schema: {
        tags,
        params: IdParams,
        body: CreateAiChatGrantRequest,
        response: { 200: AiChatGrantSchema, 201: AiChatGrantSchema },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { subject, level } = req.body;
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        const { conv, chat } = await sharedByOwner(req, tx, req.params.id);
        if (subject.kind !== "user") {
          throw badRequest(
            "Sharing with a team or the organization is not available yet",
            "grant_subject_unsupported",
          );
        }
        // Under tenant RLS: another organization's user (or nobody) is simply missing (T-06-02-07).
        const [member] = await tx
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(and(eq(orgMembers.userId, subject.id), isNull(orgMembers.deactivatedAt)))
          .limit(1);
        if (!member) throw notFound("Member not found");
        if (subject.id === chat.ownerUserId) throw badRequest("This is your own chat", "grant_to_owner");

        // One grant writer per chat at a time: the cap and the active-grant check below are race-free.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai-grants:${conv.id}`}))`);
        const [active] = await tx
          .select()
          .from(aiChatGrants)
          .where(
            and(
              eq(aiChatGrants.conversationId, conv.id),
              eq(aiChatGrants.subjectKind, "user"),
              eq(aiChatGrants.subjectId, subject.id),
              isNull(aiChatGrants.revokedAt),
            ),
          )
          .limit(1);
        if (active) {
          if (active.level === level) return { status: 200 as const, dto: await grantDto(tx, active) };
          const [updated] = await tx
            .update(aiChatGrants)
            .set({ level, updatedAt: new Date().toISOString() })
            .where(eq(aiChatGrants.id, active.id))
            .returning();
          if (!updated) throw new Error("grant update returned no row");
          await core.audit.record(tx, {
            action: "ai_chat.grant_updated",
            resourceType: "ai_chat",
            resourceId: conv.id,
            metadata: {
              conversationId: conv.id,
              grantId: updated.id,
              subjectKind: "user",
              subjectId: subject.id,
              level,
            },
          });
          await announce(tx, conv, chat, subject.id, level);
          return { status: 200 as const, dto: await grantDto(tx, updated) };
        }
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(aiChatGrants)
          .where(and(eq(aiChatGrants.conversationId, conv.id), isNull(aiChatGrants.revokedAt)));
        if ((count?.n ?? 0) >= AI_GRANTS_MAX) {
          throw new HttpError(
            409,
            "too_many_grants",
            `A chat can be shared with at most ${AI_GRANTS_MAX} people or groups`,
          );
        }
        const [row] = await tx
          .insert(aiChatGrants)
          .values({
            organizationId: conv.organizationId,
            conversationId: conv.id,
            subjectKind: "user",
            subjectId: subject.id,
            level,
            grantedBy: auth.userId,
          })
          .returning();
        if (!row) throw new Error("grant insert returned no row");
        // P-09: the person takes part from now on (roster, unread); the row never decides their access.
        await addMember(
          tx,
          chatDeps,
          conv,
          { kind: "user", id: subject.id },
          { role: "member", reason: "ai_chat_grant" },
        );
        // Ids only (T-06-02-08).
        await core.audit.record(tx, {
          action: "ai_chat.grant_created",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: {
            conversationId: conv.id,
            grantId: row.id,
            subjectKind: "user",
            subjectId: subject.id,
            level,
          },
        });
        await announce(tx, conv, chat, subject.id, level);
        return { status: 201 as const, dto: await grantDto(tx, row) };
      });
      return reply.status(out.status).send(out.dto);
    },
  );

  app.get(
    "/ai-chats/:id/grants",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: AiChatGrantList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await sharedByOwner(req, tx, req.params.id);
        const rows = await tx
          .select()
          .from(aiChatGrants)
          .where(and(eq(aiChatGrants.conversationId, conv.id), isNull(aiChatGrants.revokedAt)))
          .orderBy(asc(aiChatGrants.createdAt), asc(aiChatGrants.id));
        return { grants: await grantDtos(tx, rows) };
      }),
  );
}
