import {
  AI_GRANTS_MAX,
  AiChatAccessChangedEvent,
  type AiChatGrant,
  AiChatGrantList,
  AiChatGrant as AiChatGrantSchema,
  type AiGrantLevel,
  AiGrantParams,
  type AiGrantSubject,
  CreateAiChatGrantRequest,
  EventTypes,
  IdParams,
  type Mention,
  type UnitKind,
  UpdateAiChatGrantRequest,
} from "@ocw/contracts";
import {
  aiChatGrants,
  aiChats,
  aiGenerations,
  conversationMembers,
  messages,
  orgMembers,
  orgUnits,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import {
  addMember,
  aiAccessOf,
  type ConversationRow,
  convTopic,
  createConversationAccess,
  iso,
  lockNextSeq,
  type MessageRow,
  removeMember,
} from "../chat";
import type { ModelGateway } from "../model-gateway";
import { notifyUsers } from "../notification";
import { createPermissionService } from "../organization";
import {
  type AiChatRow,
  aiMessage,
  chatSummary,
  directoryOf,
  EMPTY_DIRECTORY,
  ownerAuthor,
  readUpTo,
} from "./dto";
import { createChatGuards } from "./service";

/**
 * Sharing an AI chat in place (D-03, P-03, P-09, MULTI-01): a grant row on the SAME conversation, never a copy. Only
 * the owner (`ai_chat.share`) grants, lists, changes a level or revokes; everyone else, admins included, gets the
 * chat's 404. Subjects: one person, one unit (and so its subtree: `aiGrantMatchSql` over membership paths) or the
 * whole organization.
 *
 * A person grant also writes that person's participation row (`conversation_members`, role member, P-09); unit and
 * organization grants write none and notify nobody individually (no flood): rows are participation only, access
 * comes from the grant (`aiAccessSql`). A level change or a revoke re-decides every non-owner human participant
 * through the readable set and removes the ones who lost the chat. Every change is a server-written notice line in
 * the chat (`postNotice`), audited with ids and levels only, and announced with a durable `ai_chat.access_changed`
 * on `conv:<id>` (whose invalidator re-decides every live subscriber, ADR-0009), on `user:<subject>` for a person
 * (their new access) and on `org:<id>` for a unit or the organization (ids only).
 */

const GRANTS_PER_MINUTE = 60;
const GRANT_NOT_FOUND = "Grant not found";

type GrantRow = typeof aiChatGrants.$inferSelect;
type NoticeAction = "granted" | "level_changed" | "revoked";

const LEVEL_LABEL: Record<AiGrantLevel, string> = { chat: "Can chat", view: "Can view" };

/** Names inside a notice stay on one line. */
const oneLine = (s: string) => s.replace(/\s+/gu, " ").trim();

/**
 * The notice line of an access change, e.g. "Víctor Ruiz shared this chat with Backend · Can chat",
 * "Víctor Ruiz changed Backend to Can view", "Víctor Ruiz removed access for Backend".
 */
export function noticeOf(
  action: NoticeAction,
  actorName: string,
  subjectLabel: string,
  level: AiGrantLevel | null,
): string {
  const actor = oneLine(actorName);
  const subject = oneLine(subjectLabel);
  switch (action) {
    case "granted":
      return `${actor} shared this chat with ${subject} · ${LEVEL_LABEL[level ?? "chat"]}`;
    case "level_changed":
      return `${actor} changed ${subject} to ${LEVEL_LABEL[level ?? "chat"]}`;
    case "revoked":
      return `${actor} removed access for ${subject}`;
  }
}

/**
 * A notice row in an AI chat: author_kind `system` (no author id), `n.body`, `n.mentions` (a person subject only), the
 * next seq of `conv:<id>` and its own `message.created` with the AI chat message DTO. Never part of a prompt
 * (`loadTurn` skips system rows) and never answered. 06-10 reuses it for agents.
 */
export async function postNotice(
  core: Core,
  tx: Tx,
  conv: ConversationRow,
  n: { body: string; mentions: Mention[] },
): Promise<MessageRow> {
  const topic = convTopic(conv.id);
  const seq = await lockNextSeq(tx, topic);
  const [row] = await tx
    .insert(messages)
    .values({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      seq,
      authorKind: "system",
      authorId: null,
      body: n.body,
      mentions: n.mentions,
      clientKind: "system",
    })
    .returning();
  if (!row) throw new Error("notice insert returned no row");
  const appended = await core.realtime.appendEvent(tx, topic, EventTypes.messageCreated, {
    message: aiMessage(row, EMPTY_DIRECTORY),
  });
  if (appended !== seq) throw new Error(`stream seq drift on ${topic}: expected ${seq}, got ${appended}`);
  return row;
}

interface SubjectInfo {
  label: string;
  unitKind: UnitKind | null;
}

/** Display labels of grant subjects: a person's name, a unit's name and kind, "Everyone at <org>". */
async function subjectLabeller(
  core: Core,
  tx: Tx,
  rows: Array<Pick<GrantRow, "subjectKind" | "subjectId">>,
): Promise<(r: Pick<GrantRow, "subjectKind" | "subjectId">) => SubjectInfo> {
  const userIds = rows
    .filter((r) => r.subjectKind === "user" && r.subjectId)
    .map((r) => r.subjectId as string);
  const unitIds = rows
    .filter((r) => r.subjectKind === "unit" && r.subjectId)
    .map((r) => r.subjectId as string);
  const dir = await directoryOf(tx, userIds);
  const units = unitIds.length
    ? await tx
        .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind })
        .from(orgUnits)
        .where(inArray(orgUnits.id, [...new Set(unitIds)]))
    : [];
  const byUnit = new Map(units.map((u) => [u.id, u]));
  const orgName = rows.some((r) => r.subjectKind === "org")
    ? ((await core.identity.organizationName(tenantOf(tx).organizationId)) ?? "your organization")
    : "";
  return (r) => {
    if (r.subjectKind === "org") return { label: `Everyone at ${orgName}`, unitKind: null };
    if (r.subjectKind === "unit") {
      const u = r.subjectId ? byUnit.get(r.subjectId) : undefined;
      return u ? { label: u.name, unitKind: u.kind } : { label: "Deleted group", unitKind: null };
    }
    return {
      label: (r.subjectId ? dir.users.get(r.subjectId)?.displayName : undefined) ?? "Former member",
      unitKind: null,
    };
  };
}

/** Grant DTOs with display labels: the subject's and the granter's names (a former member keeps a neutral one). */
async function grantDtos(core: Core, tx: Tx, rows: GrantRow[]): Promise<AiChatGrant[]> {
  const labelOf = await subjectLabeller(core, tx, rows);
  const granters = await directoryOf(
    tx,
    rows.map((r) => r.grantedBy),
  );
  return rows.map((r) => {
    const info = labelOf(r);
    return {
      id: r.id,
      chatId: r.conversationId,
      subject: subjectOf(r),
      label: info.label,
      unitKind: info.unitKind,
      level: r.level,
      grantedBy: ownerAuthor(granters, r.grantedBy),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  });
}

async function grantDto(core: Core, tx: Tx, row: GrantRow): Promise<AiChatGrant> {
  const [dto] = await grantDtos(core, tx, [row]);
  if (!dto) throw new Error("grant projection missing");
  return dto;
}

function subjectOf(r: Pick<GrantRow, "subjectKind" | "subjectId">): AiGrantSubject {
  return r.subjectKind === "org" ? { kind: "org" } : { kind: r.subjectKind, id: r.subjectId as string };
}

/** Ids and levels only (T-06-02-08, T-06-04-05). */
const auditIds = (r: GrantRow) => ({
  conversationId: r.conversationId,
  grantId: r.id,
  subjectKind: r.subjectKind,
  subjectId: r.subjectId,
});

export function registerGrantRoutes(app: App, ctx: { core: Core; gateway: ModelGateway }): void {
  const { core, gateway } = ctx;
  const perms = createPermissionService(core);
  const access = createConversationAccess(core);
  const guards = createChatGuards(access, perms);
  const chatDeps = { audit: core.audit, realtime: core.realtime };
  const notifyDeps = { core, access };
  const tags = ["ai-chat"];
  const grantLimit = app.rateLimit({
    max: GRANTS_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-grant:${req.auth?.userId ?? req.ip}`,
  });

  // ADR-0009 D-05: an access change of an AI chat re-decides every live subscription to its stream through the `conv`
  // topic authorizer (the readable set), so a revoked grantee's stream closes without waiting for the backstop. The
  // `user:` and `org:` copies change no `conv:` decision by themselves.
  core.realtime.registerSubscriptionInvalidator(EventTypes.aiChatAccessChanged, (topic, payload) =>
    topic.startsWith("conv:") && AiChatAccessChangedEvent.safeParse(payload).success
      ? { topics: [topic] }
      : null,
  );

  /** The chat its owner shares: readable (hidden 404), then `ai_chat.share` (the same 404 for non-owners). */
  async function sharedByOwner(req: FastifyRequest, tx: Tx, chatId: string, opts: { write?: boolean } = {}) {
    const { conv, facts } = await guards.readableChat(req, tx, chatId);
    await guards.assertOn(req, tx, "ai_chat.share", facts);
    const [chat] = await tx.select().from(aiChats).where(eq(aiChats.conversationId, conv.id)).limit(1);
    if (!chat) throw notFound("AI chat not found");
    // One grant writer per chat at a time: caps, active-grant checks and level changes are race-free.
    if (opts.write) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai-grants:${conv.id}`}))`);
    return { conv, chat };
  }

  /** The active grant `grantId` of this chat, or 404 (unknown, another chat's, or revoked). */
  async function activeGrant(tx: Tx, conv: ConversationRow, grantId: string): Promise<GrantRow> {
    const [row] = await tx
      .select()
      .from(aiChatGrants)
      .where(
        and(
          eq(aiChatGrants.id, grantId),
          eq(aiChatGrants.conversationId, conv.id),
          isNull(aiChatGrants.revokedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound(GRANT_NOT_FOUND);
    return row;
  }

  /** P-09 after a revoke or a level change: participants who can no longer read the chat lose their row. */
  async function redecideParticipants(tx: Tx, conv: ConversationRow, chat: AiChatRow): Promise<void> {
    const rows = await tx
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conv.id),
          eq(conversationMembers.memberKind, "user"),
          ne(conversationMembers.memberId, chat.ownerUserId),
        ),
      );
    for (const r of rows) {
      if (await access.isReadable(tx, r.id, conv.id, { kinds: ["ai_chat"] })) continue;
      await removeMember(tx, chatDeps, conv, { kind: "user", id: r.id });
    }
  }

  /**
   * After a grant changed: participation re-decided (level change, revoke), the notice line, then the events. A
   * person hears their new access (and, while they keep one, their sidebar view); a unit or the organization gets one
   * ids-only event on the org topic.
   */
  async function afterChange(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow,
    chat: AiChatRow,
    row: GrantRow,
    action: NoticeAction,
  ): Promise<MessageRow> {
    if (action !== "granted") await redecideParticipants(tx, conv, chat);
    const actorId = authOf(req).userId;
    const actor = (await directoryOf(tx, [actorId])).users.get(actorId)?.displayName ?? "Former member";
    const { label } = (await subjectLabeller(core, tx, [row]))(row);
    const notice = await postNotice(core, tx, conv, {
      body: noticeOf(action, actor, label, action === "revoked" ? null : row.level),
      mentions: row.subjectKind === "user" && row.subjectId ? [{ kind: "user", id: row.subjectId }] : [],
    });
    // 06-08: the owner is acting in the chat, so everything up to this change is read for them (their shared chat's
    // badge starts from here, not from the solo history they never had to mark read).
    await readUpTo(tx, conv.id, chat.ownerUserId, notice.seq);

    if (row.subjectKind === "user" && row.subjectId) {
      const subjectId = row.subjectId;
      const now = await aiAccessOf(tx, subjectId, conv.id);
      const payload = { conversationId: conv.id, access: now };
      await core.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.aiChatAccessChanged, payload);
      await core.realtime.appendEvent(tx, `user:${subjectId}`, EventTypes.aiChatAccessChanged, payload);
      if (now !== null) {
        const [running] = await tx
          .select({ id: aiGenerations.id })
          .from(aiGenerations)
          .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
          .limit(1);
        const owner = ownerAuthor(await directoryOf(tx, [chat.ownerUserId]), chat.ownerUserId);
        await core.realtime.appendEvent(tx, `user:${subjectId}`, EventTypes.aiChatUpdated, {
          chat: chatSummary(conv, chat, {
            generating: running !== undefined,
            gateway,
            view: { access: now, owner, shared: true },
          }),
        });
      }
      return notice;
    }
    const payload = { conversationId: conv.id, access: null };
    await core.realtime.appendEvent(tx, convTopic(conv.id), EventTypes.aiChatAccessChanged, payload);
    await core.realtime.appendEvent(
      tx,
      `org:${conv.organizationId}`,
      EventTypes.aiChatAccessChanged,
      payload,
    );
    return notice;
  }

  /** A level change of an active grant: updated in place, audited `{from, to}`, then `afterChange`. */
  async function changeLevel(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow,
    chat: AiChatRow,
    active: GrantRow,
    level: AiGrantLevel,
  ): Promise<GrantRow> {
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
      metadata: { ...auditIds(updated), from: active.level, to: level },
    });
    await afterChange(req, tx, conv, chat, updated, "level_changed");
    return updated;
  }

  /** The subject must exist in this organization (tenant RLS: another organization's id is simply missing). */
  async function assertSubject(tx: Tx, chat: AiChatRow, subject: AiGrantSubject): Promise<void> {
    if (subject.kind === "user") {
      const [member] = await tx
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.userId, subject.id), isNull(orgMembers.deactivatedAt)))
        .limit(1);
      if (!member) throw notFound("Member not found");
      if (subject.id === chat.ownerUserId) throw badRequest("This is your own chat", "grant_to_owner");
    } else if (subject.kind === "unit") {
      // T-06-04-02: under tenant RLS another organization's unit (or none) is missing.
      const [u] = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(eq(orgUnits.id, subject.id))
        .limit(1);
      if (!u) throw notFound("Unit not found");
    }
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
        const { conv, chat } = await sharedByOwner(req, tx, req.params.id, { write: true });
        await assertSubject(tx, chat, subject);
        const subjectId = subject.kind === "org" ? null : subject.id;
        const [active] = await tx
          .select()
          .from(aiChatGrants)
          .where(
            and(
              eq(aiChatGrants.conversationId, conv.id),
              eq(aiChatGrants.subjectKind, subject.kind),
              subjectId === null ? isNull(aiChatGrants.subjectId) : eq(aiChatGrants.subjectId, subjectId),
              isNull(aiChatGrants.revokedAt),
            ),
          )
          .limit(1);
        if (active) {
          const row = active.level === level ? active : await changeLevel(req, tx, conv, chat, active, level);
          return { status: 200 as const, dto: await grantDto(core, tx, row) };
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
            subjectKind: subject.kind,
            subjectId,
            level,
            grantedBy: auth.userId,
          })
          .returning();
        if (!row) throw new Error("grant insert returned no row");
        // P-09: a person takes part from now on (roster, unread); the row never decides their access. Units and the
        // organization get no rows (no flood, research pitfall 6): their members join when they write.
        const joined =
          subject.kind === "user" &&
          (await addMember(
            tx,
            chatDeps,
            conv,
            { kind: "user", id: subject.id },
            { role: "member", reason: "ai_chat_grant" },
          ));
        await core.audit.record(tx, {
          action: "ai_chat.grant_created",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: { ...auditIds(row), level },
        });
        const notice = await afterChange(req, tx, conv, chat, row, "granted");
        if (subject.kind === "user") {
          // 06-08 (MULTI-01): a new participant's unread starts after the notice (the history is not "new" to them);
          // the share itself reaches them as one `ai_chat_shared` notification on that notice. Units and the
          // organization never fan out per member (research pitfall 6), and a level change notifies nobody.
          if (joined) await readUpTo(tx, conv.id, subject.id, notice.seq);
          await notifyUsers(tx, notifyDeps, {
            kind: "ai_chat_shared",
            conversationId: conv.id,
            messageId: notice.id,
            actor: { kind: "user", id: auth.userId },
            userIds: [subject.id],
          });
        }
        return { status: 201 as const, dto: await grantDto(core, tx, row) };
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
        return { grants: await grantDtos(core, tx, rows) };
      }),
  );

  app.patch(
    "/ai-chats/:id/grants/:grantId",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: grantLimit,
      schema: {
        tags,
        params: AiGrantParams,
        body: UpdateAiChatGrantRequest,
        response: { 200: AiChatGrantSchema },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { conv, chat } = await sharedByOwner(req, tx, req.params.id, { write: true });
        const active = await activeGrant(tx, conv, req.params.grantId);
        const row =
          active.level === req.body.level
            ? active
            : await changeLevel(req, tx, conv, chat, active, req.body.level);
        return grantDto(core, tx, row);
      }),
  );

  app.delete(
    "/ai-chats/:id/grants/:grantId",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: grantLimit,
      schema: { tags, params: AiGrantParams },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), async (tx) => {
        const { conv, chat } = await sharedByOwner(req, tx, req.params.id, { write: true });
        const active = await activeGrant(tx, conv, req.params.grantId);
        const at = new Date().toISOString();
        const [revoked] = await tx
          .update(aiChatGrants)
          .set({ revokedAt: at, revokedBy: auth.userId, updatedAt: at })
          .where(eq(aiChatGrants.id, active.id))
          .returning();
        if (!revoked) throw new Error("grant revoke returned no row");
        await core.audit.record(tx, {
          action: "ai_chat.grant_revoked",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: { ...auditIds(revoked), level: revoked.level },
        });
        await afterChange(req, tx, conv, chat, revoked, "revoked");
      });
      return reply.status(204).send();
    },
  );
}
