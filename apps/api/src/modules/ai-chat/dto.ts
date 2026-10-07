import {
  type AiChatDetail,
  type AiChatSettings,
  type AiChatSummary,
  type AiGeneration,
  type AiToolState,
  type AiUsage,
  type Attachment,
  type Message,
  ModelRef,
  type Permission,
} from "@ocw/contracts";
import { type aiChats, aiGenerations, aiUsageRecords, orgMembers, type Tx } from "@ocw/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type ConversationRow, type Directory, iso, type MessageRow, toMessage } from "../chat";
import type { ModelGateway } from "../model-gateway";

/** DTOs of the AI chat module (P-13): assistant turns are `agent` messages with no author id and a generation. */

export type AiChatRow = typeof aiChats.$inferSelect;
export type GenerationRow = typeof aiGenerations.$inferSelect;
export type UsageRow = typeof aiUsageRecords.$inferSelect;

export const DEFAULT_CHAT_TITLE = "New chat";

/** Assistant turns resolve their author from the generation, never the directory. */
export const EMPTY_DIRECTORY: Directory = { users: new Map(), agents: new Map(), byHandle: new Map() };

/** A directory of just these members (user turns of one AI chat: its owner). */
export async function directoryOf(tx: Tx, userIds: string[]): Promise<Directory> {
  const dir: Directory = { users: new Map(), agents: new Map(), byHandle: new Map() };
  if (userIds.length === 0) return dir;
  const rows = await tx
    .select({
      userId: orgMembers.userId,
      displayName: orgMembers.displayName,
      avatarUrl: orgMembers.avatarUrl,
    })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, userIds));
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

export function parseModelRef(v: unknown): ModelRef | null {
  const parsed = ModelRef.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function chatSummary(
  conv: ConversationRow,
  chat: AiChatRow,
  opts: { generating: boolean; gateway: ModelGateway },
): AiChatSummary {
  const lastModel = parseModelRef(chat.lastModel);
  return {
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
