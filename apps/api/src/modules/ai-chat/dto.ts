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
import { aiAccessOf, type ConversationRow, type Directory, iso, type MessageRow, toMessage } from "../chat";
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
 * The active person grant of `userId` on a chat (`chat` beats `view`), or null. 06-04 extends the match to unit and
 * organization subjects, in step with `aiAccessSql`.
 */
export async function matchingGrant(
  tx: Tx,
  conversationId: string,
  userId: string,
): Promise<{ id: string; level: "chat" | "view" } | null> {
  const rows = await tx
    .select({ id: aiChatGrants.id, level: aiChatGrants.level })
    .from(aiChatGrants)
    .where(
      and(
        eq(aiChatGrants.conversationId, conversationId),
        isNull(aiChatGrants.revokedAt),
        eq(aiChatGrants.subjectKind, "user"),
        eq(aiChatGrants.subjectId, userId),
      ),
    );
  return rows.find((r) => r.level === "chat") ?? rows[0] ?? null;
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
