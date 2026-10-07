import {
  type AiAddressing,
  type AiChatAccess,
  type AiChatDetail,
  type AiChatSettings,
  type AiChatSummary,
  type AiGeneration,
  type AiSkipReason,
  type AiToolState,
  type AiUsage,
  type Attachment,
  EventTypes,
  type Message,
  type MessageAuthor,
  ModelRef,
  type Permission,
} from "@ocw/contracts";
import {
  agents,
  aiChatGrants,
  type aiChats,
  aiGenerations,
  aiMessageContext,
  aiUsageRecords,
  conversationMembers,
  orgMembers,
  type Tx,
} from "@ocw/db";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Core } from "../../core";
import {
  aiAccessOf,
  aiGrantMatchSql,
  type ConversationRow,
  type Directory,
  iso,
  type MessageRow,
  toMessage,
  unreadCountsFor,
} from "../chat";
import type { ModelGateway } from "../model-gateway";

/** DTOs of the AI chat module (P-13): assistant turns are `agent` messages with no author id and a generation. */

export type AiChatRow = typeof aiChats.$inferSelect;
export type GenerationRow = typeof aiGenerations.$inferSelect;
export type UsageRow = typeof aiUsageRecords.$inferSelect;

export const DEFAULT_CHAT_TITLE = "New chat";

/** Assistant turns resolve their author from the generation, never the directory. */
export const EMPTY_DIRECTORY: Directory = { users: new Map(), agents: new Map(), byHandle: new Map() };

/** A directory of just these members (the human authors of one AI chat's messages). */
export async function directoryOf(tx: Tx, userIds: string[], agentIds: string[] = []): Promise<Directory> {
  const dir: Directory = { users: new Map(), agents: new Map(), byHandle: new Map() };
  if (agentIds.length > 0) {
    const bots = await tx
      .select({ id: agents.id, name: agents.name, username: agents.username, avatarUrl: agents.avatarUrl })
      .from(agents)
      .where(inArray(agents.id, [...new Set(agentIds)]));
    for (const b of bots) {
      dir.agents.set(b.id, {
        kind: "agent",
        id: b.id,
        displayName: b.name,
        handle: b.username,
        avatarUrl: b.avatarUrl,
      });
    }
  }
  if (userIds.length === 0) return dir;
  const rows = await tx
    .select({
      userId: orgMembers.userId,
      displayName: orgMembers.displayName,
      avatarUrl: orgMembers.avatarUrl,
    })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, [...new Set(userIds)]));
  for (const r of rows) {
    dir.users.set(r.userId, {
      kind: "user",
      id: r.userId,
      displayName: r.displayName,
      handle: "",
      avatarUrl: r.avatarUrl,
    });
  }
  return dir;
}

/**
 * P-05 `shared` as SQL: any active grant or more than one human member. Personal instructions are never used in a
 * shared chat (D-06), from the moment it is shared.
 */
export function sharedSql(conversationIdCol: SQL | AnyPgColumn): SQL {
  return sql`(exists (select 1 from app.ai_chat_grants sg
                      where sg.conversation_id = ${conversationIdCol} and sg.revoked_at is null)
           or (select count(*) from app.conversation_members sm
                where sm.conversation_id = ${conversationIdCol} and sm.member_kind = 'user') > 1)`;
}

/**
 * Moves `userId`'s read cursor of a chat forward to `seq`, never back (06-08). Without a participation row nothing
 * happens. Joining participants start here, so a chat's history is not "unread" to someone who just arrived.
 */
export async function readUpTo(tx: Tx, conversationId: string, userId: string, seq: number): Promise<void> {
  await tx
    .update(conversationMembers)
    .set({ lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${seq})` })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.memberKind, "user"),
        eq(conversationMembers.memberId, userId),
      ),
    );
}

/** P-05 for one chat. */
export async function isShared(tx: Tx, conversationId: string): Promise<boolean> {
  const [grant] = await tx
    .select({ id: aiChatGrants.id })
    .from(aiChatGrants)
    .where(and(eq(aiChatGrants.conversationId, conversationId), isNull(aiChatGrants.revokedAt)))
    .limit(1);
  if (grant) return true;
  const humans = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberKind, "user")),
    );
  return humans.length > 1;
}

/**
 * The active grant through which `userId` reaches a chat, or null: the same match as `aiAccessSql`
 * (`aiGrantMatchSql`: person, unit subtree or organization). `chat` beats `view`; among equals the most specific
 * subject (person, then unit, then organization), then the oldest.
 */
export async function matchingGrant(
  tx: Tx,
  conversationId: string,
  userId: string,
): Promise<{ id: string; level: "chat" | "view" } | null> {
  const res = await tx.execute(sql`
    select ag.id, ag.level from app.ai_chat_grants ag
    where ag.conversation_id = ${conversationId}::uuid and ag.revoked_at is null
      and ${aiGrantMatchSql(sql`${userId}::uuid`)}
    order by (ag.level = 'chat') desc,
             case ag.subject_kind when 'user' then 0 when 'unit' then 1 else 2 end,
             ag.created_at, ag.id
    limit 1`);
  return (res.rows[0] as { id: string; level: "chat" | "view" } | undefined) ?? null;
}

/** How one viewer sees a chat (Phase 6 summary fields): their access, the owner and whether it is shared. */
export interface ChatView {
  access: AiChatAccess;
  owner: MessageAuthor;
  shared: boolean;
}

/** The owner as a message author (a former member keeps a neutral name). */
export function ownerAuthor(dir: Directory, ownerUserId: string): MessageAuthor {
  const e = dir.users.get(ownerUserId);
  return {
    kind: "user",
    id: ownerUserId,
    displayName: e?.displayName ?? "Former member",
    avatarUrl: e?.avatarUrl ?? null,
  };
}

/** The `ChatView` of `viewerId` (null access = the viewer cannot read it; callers only ask for readable chats). */
export async function viewOf(tx: Tx, chat: AiChatRow, viewerId: string): Promise<ChatView | null> {
  const access = await aiAccessOf(tx, viewerId, chat.conversationId);
  if (access === null) return null;
  const dir = await directoryOf(tx, [chat.ownerUserId]);
  return {
    access,
    owner: ownerAuthor(dir, chat.ownerUserId),
    shared: await isShared(tx, chat.conversationId),
  };
}

export function parseModelRef(v: unknown): ModelRef | null {
  const parsed = ModelRef.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function chatSummary(
  conv: ConversationRow,
  chat: AiChatRow,
  opts: { generating: boolean; gateway: ModelGateway; view?: ChatView | null },
): AiChatSummary {
  const lastModel = parseModelRef(chat.lastModel);
  return {
    ...(opts.view ? { access: opts.view.access, owner: opts.view.owner, shared: opts.view.shared } : {}),
    id: conv.id,
    title: conv.name ?? DEFAULT_CHAT_TITLE,
    titleSource: chat.titleSource,
    lastModel,
    lastModelLabel: lastModel ? opts.gateway.labelOf(lastModel) : null,
    archived: conv.archivedAt !== null,
    generating: opts.generating,
    createdAt: iso(chat.createdAt),
    lastActivityAt: iso(chat.lastActivityAt),
  };
}

/**
 * `ai_chat.updated` for everyone whose sidebar shows the chat (06-08, P-09): a solo chat tells its owner exactly as in
 * Phase 5; a shared chat tells the owner (access `owner`) and every human participant and active person grantee with
 * their own access, `shared`, the owner and their own unread count. People who lost the chat (no access now) and
 * unit or organization grantees who never joined hear nothing. Summaries never carry settings (owner-only, T-06-08-02).
 * Returns the summary each recipient got.
 */
export async function emitChatUpdated(
  core: Core,
  tx: Tx,
  conv: ConversationRow,
  chat: AiChatRow,
  opts: { generating: boolean; gateway: ModelGateway },
): Promise<Map<string, AiChatSummary>> {
  const out = new Map<string, AiChatSummary>();
  const owner = chat.ownerUserId;
  if (!(await isShared(tx, conv.id))) {
    const summary = chatSummary(conv, chat, opts);
    await core.realtime.appendEvent(tx, `user:${owner}`, EventTypes.aiChatUpdated, { chat: summary });
    out.set(owner, summary);
    return out;
  }
  const res = await tx.execute(sql`
    select cm.member_id as id from app.conversation_members cm
    where cm.conversation_id = ${conv.id}::uuid and cm.member_kind = 'user'
    union
    select g.subject_id from app.ai_chat_grants g
    where g.conversation_id = ${conv.id}::uuid and g.subject_kind = 'user' and g.revoked_at is null`);
  const ids = [owner, ...(res.rows as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== owner)];
  const ownerView = ownerAuthor(await directoryOf(tx, [owner]), owner);
  // One summary per distinct access; only the unread count differs per person.
  const byAccess = new Map<AiChatAccess, AiChatSummary>();
  for (const id of ids) {
    const access = id === owner ? "owner" : await aiAccessOf(tx, id, conv.id);
    if (access === null) continue;
    let base = byAccess.get(access);
    if (!base) {
      base = chatSummary(conv, chat, { ...opts, view: { access, owner: ownerView, shared: true } });
      byAccess.set(access, base);
    }
    const counts = (await unreadCountsFor(tx, id, [conv.id])).get(conv.id);
    const summary = counts ? { ...base, unreadCount: counts.unreadCount } : base;
    await core.realtime.appendEvent(tx, `user:${id}`, EventTypes.aiChatUpdated, { chat: summary });
    out.set(id, summary);
  }
  return out;
}

export function chatSettings(chat: AiChatRow): AiChatSettings {
  return {
    instructions: chat.instructions,
    usePersonalInstructions: chat.usePersonalInstructions,
    tools: { web: chat.tools?.web === true },
  };
}

/** `tools` comes from `toolStates` (tools-state.ts, 05-11): availability depends on policy, permission and model. */
export function chatDetail(
  summary: AiChatSummary,
  chat: AiChatRow,
  tools: AiToolState[],
  viewerCan: Permission[],
): AiChatDetail {
  return { ...summary, settings: chatSettings(chat), tools, viewerCan };
}

export function usageDto(u: UsageRow): AiUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens,
    reasoningTokens: u.reasoningTokens,
    estimated: u.estimated,
    costMicrosUsd: u.costMicrosUsd,
    priceRef: u.priceRef,
  };
}

export function generationDto(
  g: GenerationRow,
  usage: UsageRow | AiUsage | null,
  gateway: ModelGateway,
): AiGeneration {
  const ref = { backend: g.backend, provider: g.provider, modelId: g.modelId } as ModelRef;
  return {
    id: g.id,
    status: g.status,
    backend: g.backend,
    provider: ref.provider,
    modelId: g.modelId,
    modelLabel: gateway.labelOf(ref),
    metered: g.backend === "org_key",
    attempt: g.attempt,
    // Who asked, and so who pays (D-01, P-07).
    requesterUserId: g.requesterUserId,
    errorCode: (g.errorCode as AiGeneration["errorCode"]) ?? null,
    errorParam: g.errorParam,
    usage: usage ? ("generationId" in usage ? usageDto(usage) : usage) : null,
    webUsed: g.webUsed,
    sourceDomains: g.sourceDomains.slice(0, 20),
    startedAt: iso(g.startedAt),
    finishedAt: g.finishedAt ? iso(g.finishedAt) : null,
  };
}

/**
 * A message of an AI chat: user turns as in chat, with their files (05-12, `attachmentsForMessages`); assistant turns
 * carry the model as author and the generation, never files.
 */
export function aiMessage(
  row: MessageRow,
  dir: Directory,
  generation?: AiGeneration,
  attachments: Attachment[] = [],
): Message {
  const base = toMessage(row, dir, []);
  if (row.authorKind !== "agent") return { ...base, attachments };
  if (!generation) return { ...base, attachments: [] };
  return {
    ...base,
    author: { kind: "agent", id: null, displayName: generation.modelLabel, avatarUrl: null },
    attachments: [],
    generation,
  };
}

/** The latest generation (highest attempt) of each assistant message, with its chat usage record. */
export async function generationsFor(
  tx: Tx,
  assistantMessageIds: string[],
  gateway: ModelGateway,
): Promise<Map<string, AiGeneration>> {
  const out = new Map<string, AiGeneration>();
  if (assistantMessageIds.length === 0) return out;
  const gens = await tx
    .select()
    .from(aiGenerations)
    .where(inArray(aiGenerations.assistantMessageId, assistantMessageIds))
    .orderBy(desc(aiGenerations.attempt), desc(aiGenerations.startedAt));
  const latest = new Map<string, GenerationRow>();
  for (const g of gens) if (!latest.has(g.assistantMessageId)) latest.set(g.assistantMessageId, g);
  const ids = [...latest.values()].map((g) => g.id);
  const usage = ids.length
    ? await tx
        .select()
        .from(aiUsageRecords)
        .where(and(inArray(aiUsageRecords.generationId, ids), eq(aiUsageRecords.kind, "chat")))
    : [];
  const byGen = new Map(usage.map((u) => [u.generationId, u]));
  for (const [messageId, g] of latest) out.set(messageId, generationDto(g, byGen.get(g.id) ?? null, gateway));
  return out;
}

/**
 * Where each human message of a multiplayer chat stands (06-06, D-05): not addressed, queued, answering (its
 * generation runs), answered, or skipped with the reason. Messages without a context row (before Phase 6) are absent.
 */
export async function addressingFor(tx: Tx, messageIds: string[]): Promise<Map<string, AiAddressing>> {
  const out = new Map<string, AiAddressing>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select({
      messageId: aiMessageContext.messageId,
      addressed: aiMessageContext.addressed,
      skipReason: aiMessageContext.skipReason,
      generationId: aiMessageContext.answeredByGenerationId,
      status: aiGenerations.status,
    })
    .from(aiMessageContext)
    .leftJoin(aiGenerations, eq(aiGenerations.id, aiMessageContext.answeredByGenerationId))
    .where(inArray(aiMessageContext.messageId, messageIds));
  for (const r of rows) {
    const status: AiAddressing["status"] = !r.addressed
      ? "not_addressed"
      : r.skipReason !== null
        ? "skipped"
        : r.generationId === null
          ? "queued"
          : r.status === "running"
            ? "answering"
            : "answered";
    out.set(r.messageId, {
      addressed: r.addressed,
      status,
      skipReason: (r.skipReason as AiSkipReason | null) ?? null,
      generationId: r.generationId,
    });
  }
  return out;
}
