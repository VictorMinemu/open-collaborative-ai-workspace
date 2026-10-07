import { AI_MAX_STEPS, type AiChatPolicy, type AiGenerationStatus, type ModelCaps } from "@ocw/contracts";
import {
  agents,
  aiChatGrants,
  aiChats,
  aiGenerations,
  aiMessageContext,
  aiUserPreferences,
  conversationMembers,
  messages,
  orgMembers,
  type Tx,
} from "@ocw/db";
import { type ModelMessage, type StopCondition, stepCountIs, type ToolSet } from "ai";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { ObjectStorage } from "../artifact";
import { aiAccessSql } from "../chat";
import type { ResolvedModel } from "../model-gateway";
import type { PermissionService } from "../organization";
import { attachmentPartsFor } from "./attachments";
import {
  type BuildInput,
  buildModelMessages,
  type PersistedTurn,
  type PromptParticipant,
} from "./build-model-messages";
import type { GenerationRow } from "./dto";
import { webUnavailableReason } from "./tools-state";
import { searxngWebSearchTool } from "./web-tools";

/**
 * The seam between persisted state and the model call: persisted rows (seq order, before the answer being
 * generated), chat settings, the requester's preferences, the viewer and the user messages' files →
 * `buildModelMessages`; nothing else assembles a prompt (P-05).
 *
 * Files (05-12): the bytes of each user message's attachments are read from the store here, for the resolved
 * model's caps (`attachmentPartsFor`), and travel as file/text parts of that message only. Without `files` (an
 * estimate for a turn that never reached a model) they count as zero-byte parts.
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

/** Where the turn reads attachment bytes and what the model can read (05-12). */
export interface TurnFiles {
  storage: ObjectStorage | null;
  caps: ModelCaps;
}

/** Estimates only: every attachment counts as a part, no byte is read. */
const ESTIMATE_FILES: TurnFiles = {
  storage: null,
  caps: { vision: true, pdf: true, webSearch: "none" },
};

/** What the turn needs to attach tools: the requester's resolved model and the resolver (absent = no tools). */
export interface TurnTools {
  resolved: ResolvedModel;
  perms: PermissionService;
  /** `OCW_AI_SEARXNG_URL` (operator configuration); null = organization and mock models cannot search. */
  searxngUrl: string | null;
  /** The result domains of each SearXNG search this answer ran. */
  onSearch(domains: string[]): void;
}

/**
 * The tools of this turn (null when Web is off, not allowed or not supported here) and, when the chat has Web on but
 * this requester and model may not use it, the reason (`webUnavailableReason`: policy → permission → model support).
 * Tools are decided for the requester only, never borrowed from the owner (D-06, T-06-05-02).
 */
async function webTools(
  tx: Tx,
  generation: GenerationRow,
  web: boolean,
  policy: AiChatPolicy,
  t: TurnTools | undefined,
): Promise<{ tools: ToolSet | null; withheldReason: string | null }> {
  if (!web || !t) return { tools: null, withheldReason: null };
  const { resolved, perms } = t;
  const reason = await webUnavailableReason(tx, {
    userId: generation.requesterUserId,
    policy,
    perms,
    caps: resolved.caps,
    backend: resolved.ref.backend,
  });
  if (reason !== null) return { tools: null, withheldReason: reason };
  if (resolved.ref.backend === "chatgpt_plan") {
    const hosted = resolved.hostedTools.web_search;
    return { tools: hosted ? { web_search: hosted } : null, withheldReason: null };
  }
  // Organization keys and the mock: the self-hosted SearXNG only, never a provider-hosted (metered) search (D-04).
  if (!t.searxngUrl) return { tools: null, withheldReason: null };
  return {
    tools: { web_search: searxngWebSearchTool({ baseUrl: t.searxngUrl, onSearch: t.onSearch }) },
    withheldReason: null,
  };
}

type Row = { id: string; authorKind: string; authorId: string | null };

type AgentInfo = { name: string; handle: string };

/**
 * P-05 and P-06 for one generation: `undefined` for a solo chat (no active grant, the owner is the only member, and
 * nobody else ever wrote: the Phase 5 prompt, byte for byte); otherwise the roster (requester-independent), whom this
 * turn answers and whether the chat is shared, plus every author's name (people) and name and handle (personas).
 */
async function participantsOf(
  tx: Tx,
  generation: GenerationRow,
  ownerUserId: string,
  rows: Row[],
): Promise<{
  participants: BuildInput["participants"];
  names: Map<string, string>;
  agentsById: Map<string, AgentInfo>;
}> {
  const conversationId = generation.conversationId;
  const [grant] = await tx
    .select({ id: aiChatGrants.id })
    .from(aiChatGrants)
    .where(and(eq(aiChatGrants.conversationId, conversationId), isNull(aiChatGrants.revokedAt)))
    .limit(1);
  const members = await tx
    .select({
      kind: conversationMembers.memberKind,
      id: conversationMembers.memberId,
      access: aiAccessSql(conversationMembers.memberId, conversationMembers.conversationId),
    })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  const othersWrote = rows.some((r) => r.authorId !== null && r.authorId !== ownerUserId);
  const multiplayer =
    grant !== undefined || members.some((m) => !(m.kind === "user" && m.id === ownerUserId)) || othersWrote;
  const names = new Map<string, string>();
  const agentsById = new Map<string, AgentInfo>();
  if (!multiplayer) return { participants: undefined, names, agentsById };

  const humanIds = [
    ...new Set([
      ownerUserId,
      generation.requesterUserId,
      ...members.filter((m) => m.kind === "user").map((m) => m.id),
      ...rows.filter((r) => r.authorKind === "user" && r.authorId).map((r) => r.authorId as string),
    ]),
  ];
  const people = await tx
    .select({ id: orgMembers.userId, name: orgMembers.displayName, role: orgMembers.role })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, humanIds));
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const p of people) names.set(p.id, p.name);
  const memberAgentIds = members.filter((m) => m.kind === "agent").map((m) => m.id);
  // Persona authors (agent rows with an author id) are looked up even when they are no longer members.
  const agentIds = [
    ...new Set([
      ...memberAgentIds,
      ...rows.filter((r) => r.authorKind === "agent" && r.authorId).map((r) => r.authorId as string),
    ]),
  ];
  const directory = agentIds.length
    ? await tx
        .select({ id: agents.id, name: agents.name, handle: agents.username })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  for (const a of directory) agentsById.set(a.id, { name: a.name, handle: a.handle });
  const bots = directory.filter((a) => memberAgentIds.includes(a.id));

  const access = new Map(
    members.filter((m) => m.kind === "user").map((m) => [m.id, m.access as PromptParticipant["access"]]),
  );
  const human = (id: string): PromptParticipant => ({
    kind: "user",
    id,
    name: byId.get(id)?.name ?? "Former member",
    role: byId.get(id)?.role ?? null,
    access: id === ownerUserId ? "owner" : (access.get(id) ?? null),
  });
  // Owner first, then the other humans by name, then agents by handle: the same list whoever asks.
  // Only people who can read the chat now: a participation row outlives a lost unit membership (06-04), and someone
  // removed from the granted team must leave the roster at once (06-12). Their messages stay attributed.
  const others = members
    .filter((m) => m.kind === "user" && m.id !== ownerUserId && m.access !== null)
    .map((m) => human(m.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const roster: PromptParticipant[] = [
    human(ownerUserId),
    ...others,
    ...bots
      .map((b): PromptParticipant => ({ kind: "agent", id: b.id, name: b.name, handle: b.handle }))
      .sort((a, b) => (a.handle ?? "").localeCompare(b.handle ?? "")),
  ];

  // Whom this turn answers: the authors of the messages answered by any attempt of this answer (P-07); the
  // requester when nothing is recorded (an answer from before Phase 6).
  const answered = await tx
    .select({ authorId: messages.authorId })
    .from(aiMessageContext)
    .innerJoin(messages, eq(messages.id, aiMessageContext.messageId))
    .innerJoin(aiGenerations, eq(aiGenerations.id, aiMessageContext.answeredByGenerationId))
    .where(
      and(
        eq(aiGenerations.assistantMessageId, generation.assistantMessageId),
        eq(aiMessageContext.authorKind, "user"),
      ),
    )
    .orderBy(asc(messages.seq));
  const respondingIds = [
    ...new Set(answered.map((a) => a.authorId).filter((id): id is string => id !== null)),
  ];
  const respondingTo = (respondingIds.length ? respondingIds : [generation.requesterUserId]).map(human);

  const humanMembers = members.filter((m) => m.kind === "user").length;
  // D-06 (06-12): a persona reads the whole chat, so an agent member counts as sharing (no personal instructions).
  const shared = grant !== undefined || humanMembers > 1 || memberAgentIds.length > 0;
  return {
    participants: { roster, respondingTo, shared },
    names,
    agentsById,
  };
}

export async function loadTurn(
  tx: Tx,
  generation: GenerationRow,
  ctx: { orgName: string; now: Date; policy: AiChatPolicy; tools?: TurnTools; files?: TurnFiles },
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
      authorId: messages.authorId,
      createdAt: messages.createdAt,
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
  const [chat] = await tx
    .select()
    .from(aiChats)
    .where(eq(aiChats.conversationId, generation.conversationId))
    .limit(1);
  if (!chat) throw new Error("ai chat missing");
  const { participants, names, agentsById } = await participantsOf(tx, generation, chat.ownerUserId, rows);

  // Rows by author (P-06, research pitfall 3): only the chat's own model (agent, no author id) answers as the
  // assistant; an agent with an id is a persona whose words are a user-side block; system rows are notices.
  const turns: PersistedTurn[] = rows.map((r): PersistedTurn => {
    const model = r.authorKind === "agent" && r.authorId === null;
    const base: PersistedTurn = {
      id: r.id,
      role: model ? "assistant" : "user",
      body: r.body,
      status: r.status,
      generationStatus: model ? (statuses.get(r.id) ?? null) : null,
      deleted: r.deletedAt !== null,
    };
    if (r.authorKind === "system") return { ...base, kind: "notice" };
    // Read by the multiplayer format only (P-06): the solo prompt ignores author and time.
    if (!participants || !r.authorId) return base;
    const at = new Date(r.createdAt).toISOString();
    if (r.authorKind === "agent") {
      const a = agentsById.get(r.authorId);
      return {
        ...base,
        author: { kind: "agent", id: r.authorId, name: a?.name ?? "Former agent", handle: a?.handle ?? null },
        at,
      };
    }
    return {
      ...base,
      author: { kind: "user", id: r.authorId, name: names.get(r.authorId) ?? "Former member" },
      at,
    };
  });
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

  const { tools, withheldReason } = await webTools(
    tx,
    generation,
    chat.tools?.web === true,
    ctx.policy,
    ctx.tools,
  );
  const files = ctx.files ?? ESTIMATE_FILES;
  const attachments = await attachmentPartsFor(
    tx,
    turns.filter((t) => t.role === "user" && t.kind !== "notice" && !t.deleted).map((t) => t.id),
    files.storage,
    files.caps,
  );
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
    attachments,
    maxContextTokens: ctx.policy.maxContextTokens,
    // Only for a multiplayer chat (P-05): its absence keeps a solo prompt byte-identical to Phase 5. D-06: Web on for
    // the chat but not for this requester → no tools and a withheld line the model can explain.
    ...(participants
      ? {
          participants: withheldReason
            ? { ...participants, withheld: [{ tool: "web", reason: withheldReason }] }
            : participants,
        }
      : {}),
  });
  return tools
    ? { ...built, tools, stopWhen: stepCountIs(AI_MAX_STEPS) }
    : { ...built, tools: undefined, stopWhen: undefined };
}
