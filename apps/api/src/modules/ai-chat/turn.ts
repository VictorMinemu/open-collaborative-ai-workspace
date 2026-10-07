import { type AiChatPolicy, type AiGenerationStatus, AI_MAX_STEPS } from "@ocw/contracts";
import {
  aiChats,
  aiGenerations,
  aiUserPreferences,
  conversationMembers,
  messages,
  orgMembers,
  type Tx,
} from "@ocw/db";
import { type ModelMessage, type StopCondition, stepCountIs, type ToolSet } from "ai";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { ResolvedModel } from "../model-gateway";
import type { PermissionService } from "../organization";
import { buildModelMessages, type ModelFilePart, type PersistedTurn } from "./build-model-messages";
import type { GenerationRow } from "./dto";
import { webAllowed } from "./tools-state";

/**
 * The seam between persisted state and the model call: persisted rows (seq order, before the answer being
 * generated), chat settings, the requester's preferences and the viewer → `buildModelMessages`. 05-12 adds
 * attachments here; nothing else assembles a prompt (P-05).
 *
 * Tools (05-11, D-04): when the chat has Web on and `webAllowed` holds for the requester and the resolved model
 * (policy, `ai_chat.web`, the model's search support), the plan backend gets its hosted `web_search` and organization
 * keys and the mock get the SearXNG function tool; never a provider-hosted search on an organization key. Tools come
 * with `stopWhen: stepCountIs(AI_MAX_STEPS)` and the prompt's web note; without them the turn has no tools at all.
 */
export interface Turn {
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet | undefined;
  /** Set together with `tools`: at most `AI_MAX_STEPS` model steps per answer. */
  stopWhen: StopCondition<ToolSet> | undefined;
  truncated: boolean;
}

/** What the turn needs to attach tools: the requester's resolved model and the resolver (absent = no tools). */
export interface TurnTools {
  resolved: ResolvedModel;
  perms: PermissionService;
}

/** The tools of this turn, or null when Web is off, not allowed or not supported here. */
async function webTools(
  tx: Tx,
  generation: GenerationRow,
  web: boolean,
  policy: AiChatPolicy,
  t: TurnTools | undefined,
): Promise<ToolSet | null> {
  if (!web || !t) return null;
  const { resolved, perms } = t;
  const allowed = await webAllowed(tx, {
    userId: generation.requesterUserId,
    policy,
    perms,
    caps: resolved.caps,
    backend: resolved.ref.backend,
  });
  if (!allowed) return null;
  if (resolved.ref.backend === "chatgpt_plan") {
    return resolved.hostedTools.web_search ? { web_search: resolved.hostedTools.web_search } : null;
  }
  return null;
}

export async function loadTurn(
  tx: Tx,
  generation: GenerationRow,
  ctx: { orgName: string; now: Date; policy: AiChatPolicy; tools?: TurnTools },
): Promise<Turn> {
  const [assistant] = await tx
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, generation.assistantMessageId))
    .limit(1);
  if (!assistant) throw new Error("assistant message missing");
  const rows = await tx
    .select({
      id: messages.id,
      authorKind: messages.authorKind,
      body: messages.body,
      status: messages.status,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, generation.conversationId),
        isNull(messages.threadId),
        lt(messages.seq, assistant.seq),
      ),
    )
    .orderBy(asc(messages.seq));

  const assistantIds = rows.filter((r) => r.authorKind === "agent").map((r) => r.id);
  const statuses = new Map<string, AiGenerationStatus>();
  if (assistantIds.length) {
    const gens = await tx
      .select({ messageId: aiGenerations.assistantMessageId, status: aiGenerations.status })
      .from(aiGenerations)
      .where(inArray(aiGenerations.assistantMessageId, assistantIds))
      .orderBy(desc(aiGenerations.attempt), desc(aiGenerations.startedAt));
    for (const g of gens) if (!statuses.has(g.messageId)) statuses.set(g.messageId, g.status);
  }
  const turns: PersistedTurn[] = rows
    .filter((r) => r.authorKind !== "system")
    .map((r) => ({
      id: r.id,
      role: r.authorKind === "agent" ? "assistant" : "user",
      body: r.body,
      status: r.status,
      generationStatus: r.authorKind === "agent" ? (statuses.get(r.id) ?? null) : null,
      deleted: r.deletedAt !== null,
    }));

  const [chat] = await tx
    .select()
    .from(aiChats)
    .where(eq(aiChats.conversationId, generation.conversationId))
    .limit(1);
  if (!chat) throw new Error("ai chat missing");
  const [prefs] = await tx
    .select({ instructions: aiUserPreferences.instructions })
    .from(aiUserPreferences)
    .where(eq(aiUserPreferences.userId, generation.requesterUserId))
    .limit(1);
  const [viewer] = await tx
    .select({ displayName: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, generation.requesterUserId))
    .limit(1);
  const humans = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, generation.conversationId),
        eq(conversationMembers.memberKind, "user"),
      ),
    );

  const tools = await webTools(tx, generation, chat.tools?.web === true, ctx.policy, ctx.tools);
  const built = buildModelMessages({
    purpose: "chat",
    webSearch: tools !== null,
    rows: turns,
    viewer: { displayName: viewer?.displayName ?? "a member", orgName: ctx.orgName, now: ctx.now },
    chat: {
      instructions: chat.instructions,
      usePersonalInstructions: chat.usePersonalInstructions,
      humanMembers: humans.length,
    },
    personalInstructions: prefs?.instructions ?? "",
    attachments: new Map<string, ModelFilePart[]>(),
    maxContextTokens: ctx.policy.maxContextTokens,
  });
  return tools
    ? { ...built, tools, stopWhen: stepCountIs(AI_MAX_STEPS) }
    : { ...built, tools: undefined, stopWhen: undefined };
}
