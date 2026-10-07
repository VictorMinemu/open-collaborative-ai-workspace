import {
  AddAiChatAgentRequest,
  AiAgentParams,
  AiChatParticipants,
  type AiParticipant,
  AiParticipant as AiParticipantSchema,
  IdParams,
} from "@ocw/contracts";
import { aiChatGrants, aiChats, aiGenerations, conversationMembers, conversations, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import {
  addMember,
  agentFactsOf,
  aiAccessOf,
  aiAccessSql,
  type ConversationRow,
  createConversationAccess,
  type DirectoryEntry,
  getMembership,
  loadDirectory,
  removeMember,
} from "../chat";
import type { ModelGateway } from "../model-gateway";
import { agentResource, createPermissionService } from "../organization";
import { directoryOf, emitChatUpdated } from "./dto";
import { postNotice } from "./grants";
import { createChatGuards, refuseArchived } from "./service";

/**
 * Agents in AI chats (06-10, D-07, P-10). The owner adds a team persona as a member of the chat (`ai_chat.manage`; a
 * non-personal, live bot the owner may `bot.read`); participants then @mention it and it answers through the Agent Channel
 * API and the OpenClaw cell like in a channel, never through the chat's model. Adding and removing write a notice line
 * and an audit row (ids only). Anyone who can read the chat lists its participants.
 *
 * `participantsOf` is the roster a persona sees; `audienceOf` is who reads what a persona says (the scoped-tool check of
 * `turnPolicy`, D-06).
 */

const AGENT_CHANGES_PER_MINUTE = 60;

const oneLine = (s: string) => s.replace(/\s+/gu, " ").trim();

/** The humans of a chat (owner, participation rows, active person grantees) who can read it now. */
async function readingHumans(tx: Tx, conversationId: string, ownerUserId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberKind, "user")),
    );
  const grantees = await tx
    .select({ id: aiChatGrants.subjectId })
    .from(aiChatGrants)
    .where(
      and(
        eq(aiChatGrants.conversationId, conversationId),
        eq(aiChatGrants.subjectKind, "user"),
        isNull(aiChatGrants.revokedAt),
      ),
    );
  const candidates = [
    ...new Set([...rows.map((r) => r.id), ...grantees.map((g) => g.id).filter((id): id is string => !!id)]),
  ].filter((id) => id !== ownerUserId);
  const out = [ownerUserId];
  // A participation row outlives a lost unit membership (06-04): only people who can read the chat now count.
  for (const id of candidates) if ((await aiAccessOf(tx, id, conversationId)) !== null) out.push(id);
  return out;
}

async function ownerOf(tx: Tx, conversationId: string): Promise<string> {
  const [chat] = await tx
    .select({ owner: aiChats.ownerUserId })
    .from(aiChats)
    .where(eq(aiChats.conversationId, conversationId))
    .limit(1);
  if (!chat) throw notFound("AI chat not found");
  return chat.owner;
}

function agentParticipant(a: DirectoryEntry): AiParticipant {
  return {
    kind: "agent",
    id: a.id,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    access: "agent",
    orgRole: null,
    handle: a.handle,
  };
}

/**
 * Everyone who takes part in an AI chat (P-09, P-10): the owner, the humans with a participation row who can still read
 * it (with their access), then the member agents. Owner first, then people and agents by name.
 */
export async function participantsOf(tx: Tx, conversationId: string): Promise<AiParticipant[]> {
  const owner = await ownerOf(tx, conversationId);
  const rows = await tx
    .select({ kind: conversationMembers.memberKind, id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  const dir = await loadDirectory(tx);
  const humans: AiParticipant[] = [];
  const bots: AiParticipant[] = [];
  const userIds = [owner, ...rows.filter((r) => r.kind === "user" && r.id !== owner).map((r) => r.id)];
  for (const id of [...new Set(userIds)]) {
    const access = id === owner ? "owner" : await aiAccessOf(tx, id, conversationId);
    if (access === null) continue;
    const u = dir.users.get(id);
    humans.push({
      kind: "user",
      id,
      displayName: u?.displayName ?? "Former member",
      avatarUrl: u?.avatarUrl ?? null,
      access,
      orgRole: u?.role ?? null,
      handle: null,
    });
  }
  for (const r of rows) {
    if (r.kind !== "agent") continue;
    const a = dir.agents.get(r.id);
    if (a && !a.deleted) bots.push(agentParticipant(a));
  }
  const [first, ...rest] = humans;
  rest.sort((a, b) => a.displayName.localeCompare(b.displayName));
  bots.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [...(first ? [first] : []), ...rest, ...bots];
}

/**
 * Who reads what a persona says in this chat (D-06, P-10): the owner, the participants and the active person grantees who
 * can read it now; `unbounded` when a unit or the organization holds an active grant (then the readers are not a list).
 */
export async function audienceOf(
  tx: Tx,
  conversationId: string,
): Promise<{ userIds: string[]; unbounded: boolean }> {
  const owner = await ownerOf(tx, conversationId);
  const [group] = await tx
    .select({ id: aiChatGrants.id })
    .from(aiChatGrants)
    .where(
      and(
        eq(aiChatGrants.conversationId, conversationId),
        inArray(aiChatGrants.subjectKind, ["unit", "org"]),
        isNull(aiChatGrants.revokedAt),
      ),
    )
    .limit(1);
  return { userIds: (await readingHumans(tx, conversationId, owner)).sort(), unbounded: group !== undefined };
}

/** `listed` unless a unit (`units`) or the organization (`organization`) holds an active grant. */
async function audienceKind(tx: Tx, conversationId: string): Promise<AiChatParticipants["audience"]> {
  const rows = await tx
    .select({ kind: aiChatGrants.subjectKind })
    .from(aiChatGrants)
    .where(and(eq(aiChatGrants.conversationId, conversationId), isNull(aiChatGrants.revokedAt)));
  if (rows.some((r) => r.kind === "org")) return "organization";
  if (rows.some((r) => r.kind === "unit")) return "units";
  return "listed";
}

/**
 * A persona's message in an AI chat (posted by the chat module for the Agent Channel API) is activity: the chat moves up
 * and every participant's sidebar hears `ai_chat.updated` with their own access and unread count (06-08), in the
 * message's transaction. Human sends and the model's answers already do this themselves.
 */
export function registerPersonaActivity(core: Core, gateway: ModelGateway): void {
  core.chatEvents.onMessagePosted(async (tx, input) => {
    if (input.conv.kind !== "ai_chat" || input.author.kind !== "agent") return;
    const at = new Date().toISOString();
    const [chat] = await tx
      .update(aiChats)
      .set({ lastActivityAt: at, updatedAt: at })
      .where(eq(aiChats.conversationId, input.conv.id))
      .returning();
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, input.conv.id)).limit(1);
    if (!chat || !conv) return;
    const [running] = await tx
      .select({ id: aiGenerations.id })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
      .limit(1);
    await emitChatUpdated(core, tx, conv, chat, { generating: running !== undefined, gateway });
  });
}

/** At most this many readers who never joined are listed beside the participants (an organization can be large). */
const UNJOINED_READERS_MAX = 200;

/**
 * Who is in an AI chat as its readers see it (`GET /participants`, 06-12): the participants of `participantsOf`, plus,
 * when a unit or the organization holds a grant, the active members it covers who never opened or wrote in the chat
 * (they have no participation row yet, P-09). They can read it, so they are people of the chat: the participants list
 * and the @ suggestions name them. The persona roster (`participantsOf`) stays the joined people only.
 */
async function chatPeopleOf(tx: Tx, conversationId: string): Promise<AiChatParticipants> {
  const participants = await participantsOf(tx, conversationId);
  const audience = await audienceKind(tx, conversationId);
  if (audience === "listed") return { participants, audience };
  const humans = participants.filter((p) => p.kind === "user");
  const known = new Set(humans.map((p) => p.id));
  const access = aiAccessSql(sql`om.user_id`, sql`${conversationId}::uuid`);
  const res = await tx.execute(sql`
    select om.user_id as id, om.display_name as name, om.avatar_url as avatar, om.role as role, ${access} as access
      from app.org_members om
     where om.deactivated_at is null and ${access} is not null
     order by om.display_name, om.user_id
     limit ${UNJOINED_READERS_MAX + known.size}`);
  type Row = {
    id: string;
    name: string;
    avatar: string | null;
    role: AiParticipant["orgRole"];
    access: string;
  };
  const readers: AiParticipant[] = (res.rows as Row[])
    .filter((r) => !known.has(r.id) && (r.access === "chat" || r.access === "view"))
    .slice(0, UNJOINED_READERS_MAX)
    .map((r) => ({
      kind: "user",
      id: r.id,
      displayName: r.name,
      avatarUrl: r.avatar,
      access: r.access as "chat" | "view",
      orgRole: r.role,
      handle: null,
    }));
  const [owner, ...others] = humans;
  const people = [...others, ...readers].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
  );
  const agents = participants.filter((p) => p.kind === "agent");
  return { participants: [...(owner ? [owner] : []), ...people, ...agents], audience };
}

export function registerMemberRoutes(app: App, ctx: { core: Core }): void {
  const { core } = ctx;
  const perms = createPermissionService(core);
  const guards = createChatGuards(createConversationAccess(core), perms);
  const chatDeps = { audit: core.audit, realtime: core.realtime };
  const tags = ["ai-chat"];
  const changeLimit = app.rateLimit({
    max: AGENT_CHANGES_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-agents:${req.auth?.userId ?? req.ip}`,
  });

  async function actorName(tx: Tx, userId: string): Promise<string> {
    return oneLine((await directoryOf(tx, [userId])).users.get(userId)?.displayName ?? "Former member");
  }

  /** Ids only (T-06-10-04). */
  async function audit(
    tx: Tx,
    action: "ai_chat.agent_added" | "ai_chat.agent_removed",
    conv: ConversationRow,
    agentId: string,
  ): Promise<void> {
    await core.audit.record(tx, {
      action,
      resourceType: "ai_chat",
      resourceId: conv.id,
      agentId,
      metadata: { conversationId: conv.id, agentId },
    });
  }

  app.get(
    "/ai-chats/:id/participants",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: AiChatParticipants } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.readableChat(req, tx, req.params.id);
        return chatPeopleOf(tx, conv.id);
      }),
  );

  app.post(
    "/ai-chats/:id/agents",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: changeLimit,
      schema: {
        tags,
        params: IdParams,
        body: AddAiChatAgentRequest,
        response: { 200: AiParticipantSchema, 201: AiParticipantSchema },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.managedChat(req, tx, req.params.id);
        refuseArchived(conv);
        const dir = await loadDirectory(tx);
        const bot = dir.agents.get(req.body.agentId);
        if (!bot || bot.deleted) throw notFound("Bot not found", "agent_not_found");
        // The owner must be able to see and use it (a unit persona outside their reach reads as missing, AGENT-01).
        await perms.assertCan(req, tx, "bot.read", agentResource(agentFactsOf(bot), auth.userId), {
          hideAs404: true,
        });
        // A personal bot only ever lives in its owner's private chat with it (Phase 3.1 D-01).
        if (bot.scope === "personal") {
          throw badRequest("Personal bots cannot join an AI chat", "personal_bot_not_allowed");
        }
        if (bot.status === "disabled") throw badRequest("This bot is disabled", "agent_disabled");
        const added = await addMember(
          tx,
          chatDeps,
          conv,
          { kind: "agent", id: bot.id },
          { role: "member", reason: "ai_chat_agent" },
        );
        if (!added) return { status: 200 as const, participant: agentParticipant(bot) };
        await postNotice(core, tx, conv, {
          body: `${await actorName(tx, auth.userId)} added @${bot.handle} to this chat`,
          mentions: [{ kind: "agent", id: bot.id }],
        });
        await audit(tx, "ai_chat.agent_added", conv, bot.id);
        return { status: 201 as const, participant: agentParticipant(bot) };
      });
      return reply.status(out.status).send(out.participant);
    },
  );

  app.delete(
    "/ai-chats/:id/agents/:agentId",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: changeLimit,
      schema: { tags, params: AiAgentParams },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.managedChat(req, tx, req.params.id);
        const agentId = req.params.agentId;
        if (!(await getMembership(tx, conv.id, "agent", agentId))) {
          throw notFound("This bot is not in the chat", "agent_not_found");
        }
        await removeMember(tx, chatDeps, conv, { kind: "agent", id: agentId });
        const handle = (await directoryOf(tx, [], [agentId])).agents.get(agentId)?.handle ?? "bot";
        await postNotice(core, tx, conv, {
          body: `${await actorName(tx, auth.userId)} removed @${handle} from this chat`,
          mentions: [{ kind: "agent", id: agentId }],
        });
        await audit(tx, "ai_chat.agent_removed", conv, agentId);
      });
      return reply.status(204).send();
    },
  );
}
