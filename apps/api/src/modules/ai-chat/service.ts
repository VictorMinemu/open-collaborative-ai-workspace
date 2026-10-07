import {
  AI_QUEUE_MAX,
  AI_SNAPSHOT_MESSAGES,
  type AiAddressing,
  type AiChatDetail,
  type AiChatList,
  type AiChatListQuery,
  type AiChatSnapshot,
  type AiChatSummary,
  type AiPostedMessageResponse,
  type Attachment,
  type ConversationReadEvent,
  type CreateAiChatRequest,
  EventTypes,
  type MessagePage,
  type ModelRef,
  type Permission,
  type SendAiMessageRequest,
  type SendAiMessageResponse,
  type UpdateAiChatRequest,
} from "@ocw/contracts";
import {
  aiChats,
  aiGenerations,
  aiMessageContext,
  conversationMembers,
  conversations,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import {
  type AttachmentRow,
  attachmentsForMessages,
  linkAttachments,
  linkableAttachments,
  notLinkable,
} from "../artifact";
import {
  addMember,
  agentFactsOf,
  aiAccessSql,
  type ConversationAccess,
  type ConversationRow,
  convTopic,
  type Directory,
  getMembership,
  loadDirectory,
  lockNextSeq,
  type MessageRow,
  resolveMentions,
  unreadCountsFor,
} from "../chat";
import {
  loadAiChatPolicy,
  type ModelGateway,
  ModelUnavailableError,
  PlanTokenUnavailableError,
  type ResolvedModel,
} from "../model-gateway";
import {
  AuthzDeniedError,
  agentResource,
  type ChannelFacts,
  channelResource,
  orgResource,
  type PermissionService,
} from "../organization";
import { assertReadableBy } from "./attachments";
import {
  type AiChatRow,
  addressingFor,
  aiMessage,
  type ChatView,
  chatDetail,
  chatSettings,
  chatSummary,
  directoryOf,
  EMPTY_DIRECTORY,
  emitChatUpdated,
  type GenerationRow,
  generationDto,
  generationsFor,
  isShared,
  matchingGrant,
  ownerAuthor,
  parseModelRef,
  readUpTo,
  sharedSql,
  viewOf,
} from "./dto";
import { consumeGeneration, refuseOverLimit } from "./limits";
import { loadPreferences } from "./prefs";
import { addressedOf, isMultiplayer, pendingCount, publishQueue, queueState, startNext } from "./queue";
import type { RunLoop } from "./run-loop";
import { heuristicTitle } from "./titles";
import { toolStates } from "./tools-state";
import { backendClassOf } from "./usage";

/**
 * AI chat sends (D-01, D-05, P-03, P-07): one tenant transaction decides `ai_chat.use`, resolves the model for the
 * REQUESTER (refusal → 409 `model_unavailable`), takes the per-user advisory lock and concurrency cap (429), inserts
 * the user message and the streaming assistant placeholder (each with the seq of its `message.created`) and a
 * `running` generation (one per conversation → 409). The run loop starts after commit. Before anything is inserted,
 * the answer is counted against the member's daily cap (05-08, `consumeGeneration`): at the cap the send is 429
 * `daily_limit_reached` with the reset time, only its audit row commits and no model is ever called.
 */

/** A send answers 201 when an answer started for it now; a multiplayer chat answers 202 otherwise (06-06). */
export type SendOutcome =
  | { status: 201; body: SendAiMessageResponse }
  | { status: 202; body: AiPostedMessageResponse };

export interface AiChatDeps {
  core: Core;
  gateway: ModelGateway;
  runLoop: RunLoop;
  access: ConversationAccess;
  perms: PermissionService;
}

const VIEWER_CAN: readonly Permission[] = ["ai_chat.use", "ai_chat.web", "ai_chat.manage", "ai_chat.share"];
const NOT_FOUND = "AI chat not found";

/** A hidden denial reads exactly like a missing chat (same status, code and message). */
function asMissing(err: unknown): unknown {
  return err instanceof AuthzDeniedError && err.hidden
    ? new AuthzDeniedError(err.denial, { hideAs404: true, message: NOT_FOUND })
    : err;
}

/**
 * The three ways a route reaches one AI chat (P-04, P-07). Anyone who cannot read it, admins included, gets the same
 * 404 as a missing chat.
 * - `readableChat`: `channel.read` (owner or any grant): snapshot, page, grants and links are decided after it.
 * - `writableChat`: `ai_chat.use` (owner or a `chat` grant): sends. A `view` grantee is told 403 `ai_chat_view_only`;
 *   every other denial stays a 404, as in Phase 5.
 * - `managedChat`: `ai_chat.manage` (the owner): rename, archive, settings.
 */
export function createChatGuards(access: ConversationAccess, perms: PermissionService) {
  const readableChat = (req: FastifyRequest, tx: Tx, chatId: string) =>
    access.readable(req, tx, chatId, { kinds: ["ai_chat"], notFoundMessage: NOT_FOUND });

  async function assertOn(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    facts: ChannelFacts,
    visible: (reason: string) => boolean = () => false,
  ): Promise<void> {
    try {
      await perms.assertCan(req, tx, permission, channelResource(facts));
    } catch (err) {
      if (err instanceof AuthzDeniedError && !visible(err.denial.reason)) {
        throw new AuthzDeniedError(err.denial, { hideAs404: true, message: NOT_FOUND });
      }
      throw asMissing(err);
    }
  }

  return {
    readableChat,
    /** Decides `permission` on a chat the caller can read: hidden as the chat's 404 unless `visible(reason)`. */
    assertOn,
    async writableChat(req: FastifyRequest, tx: Tx, chatId: string) {
      const out = await readableChat(req, tx, chatId);
      await assertOn(req, tx, "ai_chat.use", out.facts, (reason) => reason === "ai_chat_view_only");
      return out;
    },
    async managedChat(req: FastifyRequest, tx: Tx, chatId: string) {
      const out = await readableChat(req, tx, chatId);
      await assertOn(req, tx, "ai_chat.manage", out.facts);
      return out;
    },
  };
}

/** How the sender reached the chat (MULTI-02): the owner, or a grant (its id and level). */
interface SendContext {
  access: { access: "owner" | "grant"; grantId: string | null; level: "owner" | "chat" };
  /** The chat's effective tools for this message. */
  tools: { web: boolean };
  shared: boolean;
}

/** 410 on anything that would write a turn into an archived chat (05-10): it opens read-only until unarchived. */
export function refuseArchived(conv: ConversationRow): void {
  if (conv.archivedAt !== null) {
    throw new HttpError(410, "chat_archived", "This chat is archived. Unarchive it to continue.");
  }
}

/** Opaque keyset cursor of the chat list: (last activity with microseconds, conversation id), newest first. */
const ListCursor = z.object({ t: z.string().min(1).max(64), i: z.uuid() });
const encodeListCursor = (c: z.infer<typeof ListCursor>) =>
  Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
function decodeListCursor(raw: string): z.infer<typeof ListCursor> {
  try {
    const parsed = ListCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (Number.isNaN(Date.parse(parsed.t))) throw new Error("bad time");
    return parsed;
  } catch {
    throw badRequest("Invalid cursor", "invalid_cursor");
  }
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The requester's model, or 409 `model_unavailable` (reason) / 503 `usage_unavailable` (sends, regenerate). */
export async function resolveModelOr409(
  gateway: ModelGateway,
  tx: Tx,
  ref: ModelRef,
  userId: string,
): Promise<ResolvedModel> {
  try {
    return await gateway.resolve(tx, ref, userId);
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      throw new HttpError(409, "model_unavailable", "This model is not available to you right now", {
        reason: err.reason,
      });
    }
    // The member's plan tokens could not be refreshed right now (05-05): nothing was cleared, try again later.
    if (err instanceof PlanTokenUnavailableError) {
      throw new HttpError(503, "usage_unavailable", "ChatGPT is temporarily unavailable. Try again shortly.");
    }
    throw err;
  }
}

/** P-07: per-user advisory lock, then the running-generation cap across every chat of the member (429). */
export async function capOr429(tx: Tx, userId: string, cap: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai:${userId}`}))`);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aiGenerations)
    .where(and(eq(aiGenerations.requesterUserId, userId), eq(aiGenerations.status, "running")));
  if ((row?.n ?? 0) >= cap) {
    throw new HttpError(429, "concurrent_generations", `At most ${cap} answers can run at the same time`);
  }
}

export function createAiChatService(deps: AiChatDeps) {
  const { core, gateway, runLoop, access, perms } = deps;
  const guards = createChatGuards(access, perms);
  const chatDeps = { audit: core.audit, realtime: core.realtime };

  const resolveOr409 = (tx: Tx, ref: ModelRef, userId: string) => resolveModelOr409(gateway, tx, ref, userId);

  /** The chat detail its owner sees: settings, the tool toggles for the chat's last model (05-11), viewerCan. */
  async function detailOf(
    req: FastifyRequest,
    tx: Tx,
    summary: AiChatSummary,
    chat: AiChatRow,
    facts: Parameters<typeof channelResource>[0],
  ): Promise<AiChatDetail> {
    const tools = await toolStates(tx, {
      // The viewer's own tool availability (P-07: whoever sends uses their own permissions and model).
      userId: authOf(req).userId,
      policy: await loadAiChatPolicy(tx),
      perms,
      gateway,
      chat: chatSettings(chat),
      model: parseModelRef(chat.lastModel),
    });
    const viewerCan = await perms.viewerCan(req, tx, channelResource(facts), VIEWER_CAN);
    return chatDetail(summary, chat, tools, viewerCan);
  }

  async function isGenerating(tx: Tx, conversationId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: aiGenerations.id })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.conversationId, conversationId), eq(aiGenerations.status, "running")))
      .limit(1);
    return row !== undefined;
  }

  async function loadChat(
    tx: Tx,
    conversationId: string,
  ): Promise<{ conv: ConversationRow; chat: AiChatRow }> {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const [chat] = await tx.select().from(aiChats).where(eq(aiChats.conversationId, conversationId)).limit(1);
    if (!conv || !chat) throw notFound(NOT_FOUND);
    return { conv, chat };
  }

  /** The send response for a user message (fresh or retried) and its latest generation. */
  async function responseFor(tx: Tx, userRow: MessageRow): Promise<SendAiMessageResponse> {
    const [gen] = await tx
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.userMessageId, userRow.id))
      .orderBy(desc(aiGenerations.attempt))
      .limit(1);
    if (!gen) throw conflict("This message has no answer", "client_message_id_reused");
    const [assistant] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, gen.assistantMessageId))
      .limit(1);
    if (!assistant) throw new Error("assistant message missing");
    const generation = (await generationsFor(tx, [assistant.id], gateway)).get(assistant.id);
    if (!generation) throw new Error("generation projection missing");
    const { conv, chat } = await loadChat(tx, userRow.conversationId);
    const dir = await directoryOf(tx, [userRow.authorId ?? ""]);
    const files = await attachmentsForMessages(tx, [userRow.id]);
    const view = userRow.authorId ? await viewOf(tx, chat, userRow.authorId) : null;
    return {
      chat: chatSummary(conv, chat, { generating: await isGenerating(tx, conv.id), gateway, view }),
      userMessage: aiMessage(userRow, dir, undefined, files.get(userRow.id) ?? []),
      assistantMessage: aiMessage(assistant, EMPTY_DIRECTORY, generation),
      generation,
    };
  }

  /** A retried send (same author + clientMessageId): the existing message, or null. */
  async function ownSend(tx: Tx, userId: string, clientMessageId: string): Promise<MessageRow | null> {
    const [row] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.authorKind, "user"),
          eq(messages.authorId, userId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Inserts the user message, the assistant placeholder and the running generation; emits both message.created. */
  async function insertTurn(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow,
    body: SendAiMessageRequest,
    resolved: ResolvedModel,
    files: AttachmentRow[],
    context: SendContext,
  ): Promise<{ turn: Omit<SendAiMessageResponse, "chat">; generation: GenerationRow }> {
    const auth = authOf(req);
    const topic = convTopic(conv.id);
    const userSeq = await lockNextSeq(tx, topic);
    // Under the stream lock: one running generation per conversation (the partial unique index is the backstop).
    if (await isGenerating(tx, conv.id)) {
      throw conflict("An answer is still being generated in this chat", "generation_in_progress");
    }
    const [userRow] = await tx
      .insert(messages)
      .values({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        seq: userSeq,
        authorKind: "user",
        authorId: auth.userId,
        body: body.body,
        clientKind: auth.clientKind,
        sessionId: auth.sessionId,
        clientMessageId: body.clientMessageId,
      })
      .returning();
    if (!userRow) throw new Error("user message insert returned no row");
    // The files join the message in this transaction, before its message.created (05-12): a refusal rolls it back.
    let attached: Attachment[] = [];
    if (files.length > 0) {
      await linkAttachments(tx, {
        conversationId: conv.id,
        messageId: userRow.id,
        uploaderId: auth.userId,
        ids: files.map((f) => f.id),
      });
      attached = (await attachmentsForMessages(tx, [userRow.id])).get(userRow.id) ?? [];
    }
    const dir = await directoryOf(tx, [auth.userId]);
    const userMessage = aiMessage(userRow, dir, undefined, attached);
    const s1 = await core.realtime.appendEvent(tx, topic, EventTypes.messageCreated, {
      message: userMessage,
    });
    if (s1 !== userSeq) throw new Error(`stream seq drift on ${topic}: expected ${userSeq}, got ${s1}`);

    const [assistantRow] = await tx
      .insert(messages)
      .values({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        seq: userSeq + 1,
        authorKind: "agent",
        authorId: null,
        body: "",
        status: "streaming",
      })
      .returning();
    if (!assistantRow) throw new Error("assistant message insert returned no row");
    let genRow: GenerationRow | undefined;
    try {
      [genRow] = await tx
        .insert(aiGenerations)
        .values({
          organizationId: conv.organizationId,
          conversationId: conv.id,
          userMessageId: userRow.id,
          assistantMessageId: assistantRow.id,
          requesterUserId: auth.userId,
          backend: resolved.ref.backend,
          provider: resolved.ref.provider,
          modelId: resolved.ref.modelId,
          attempt: 1,
          status: "running",
          instanceId: runLoop.instanceId,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("An answer is still being generated in this chat", "generation_in_progress");
      }
      throw err;
    }
    if (!genRow) throw new Error("generation insert returned no row");
    // MULTI-02: who sent it, through which access, with which model and tools, and which generation answers it.
    // Client kind and session are on the message row itself.
    await tx.insert(aiMessageContext).values({
      messageId: userRow.id,
      organizationId: conv.organizationId,
      conversationId: conv.id,
      authorKind: "user",
      access: context.access.access,
      grantId: context.access.grantId,
      level: context.access.level,
      addressed: true,
      answeredByGenerationId: genRow.id,
      model: body.model,
      tools: context.tools,
      shared: context.shared,
    });
    const generation = generationDto(genRow, null, gateway);
    const assistantMessage = aiMessage(assistantRow, EMPTY_DIRECTORY, generation);
    const s2 = await core.realtime.appendEvent(tx, topic, EventTypes.messageCreated, {
      message: assistantMessage,
    });
    if (s2 !== userSeq + 1)
      throw new Error(`stream seq drift on ${topic}: expected ${userSeq + 1}, got ${s2}`);
    return { turn: { userMessage, assistantMessage, generation }, generation: genRow };
  }

  /**
   * Bumps the chat after a send and tells every sidebar that shows it (`emitChatUpdated`, 06-08): the owner's view, and
   * in a shared chat every participant's own view. Returns the sender's view.
   */
  async function touchChat(
    tx: Tx,
    conv: ConversationRow,
    ref: ModelRef | undefined,
    tools: { web: boolean } | undefined,
    sender: { userId: string; access: "owner" | "chat" | "view"; shared: boolean },
    generating = true,
  ): Promise<AiChatSummary> {
    const at = new Date().toISOString();
    const [chat] = await tx
      .update(aiChats)
      .set({
        ...(ref ? { lastModel: ref } : {}),
        lastActivityAt: at,
        updatedAt: at,
        ...(tools ? { tools } : {}),
      })
      .where(eq(aiChats.conversationId, conv.id))
      .returning();
    if (!chat) throw notFound(NOT_FOUND);
    const heard = await emitChatUpdated(core, tx, conv, chat, { generating, gateway });
    const mine = heard.get(sender.userId);
    // A shared chat's summary already has the sender's view; a solo chat's send answers with the owner's view.
    if (mine?.access !== undefined) return mine;
    const owner = ownerAuthor(await directoryOf(tx, [chat.ownerUserId]), chat.ownerUserId);
    return chatSummary(conv, chat, {
      generating,
      gateway,
      view: { access: sender.access, owner, shared: sender.shared },
    });
  }

  /** The newest message seq of a chat (0 when empty). */
  async function latestSeq(tx: Tx, conversationId: string): Promise<number> {
    const [row] = await tx
      .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)`.mapWith(Number) })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.threadId)));
    return row?.seq ?? 0;
  }

  /** P-09: a participation row for a reader who has none yet, its cursor at the chat's newest message (06-08). */
  async function join(tx: Tx, conv: ConversationRow, userId: string, reason: string): Promise<boolean> {
    const added = await addMember(
      tx,
      chatDeps,
      conv,
      { kind: "user", id: userId },
      { role: "member", reason },
    );
    if (added) await readUpTo(tx, conv.id, userId, await latestSeq(tx, conv.id));
    return added;
  }

  async function auditSend(
    tx: Tx,
    action: "ai_chat.created" | "ai_chat.message.sent",
    conv: ConversationRow,
    g: GenerationRow,
  ): Promise<void> {
    // Ids, backend, provider and model only: never a body (T-05-02-02).
    await core.audit.record(tx, {
      action,
      resourceType: "ai_chat",
      resourceId: conv.id,
      metadata: {
        conversationId: conv.id,
        generationId: g.id,
        backend: g.backend,
        provider: g.provider,
        modelId: g.modelId,
        attempt: g.attempt,
      },
    });
  }

  const OWNER_CONTEXT: SendContext["access"] = { access: "owner", grantId: null, level: "owner" };

  /**
   * What every send of a non-retried message settles before inserting it: a draft's name, the sticky Web state (owner
   * only), how the sender reached the chat and their participation row, and whether the chat is shared.
   */
  async function prepareSend(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow,
    facts: ChannelFacts,
    body: SendAiMessageRequest,
    files: AttachmentRow[],
  ) {
    const auth = authOf(req);
    // A draft's first message names it, as a new chat's would (the auto title replaces this later).
    if (conv.name === null) {
      const name = heuristicTitle(body.body || (files[0]?.filename ?? ""));
      const [named] = await tx
        .update(conversations)
        .set({ name })
        .where(and(eq(conversations.id, conv.id), isNull(conversations.name)))
        .returning();
      if (named) conv = named;
    }
    const { chat: current } = await loadChat(tx, conv.id);
    // The sticky Web state is a chat setting: only its manager (the owner) changes it by sending (P-04).
    const manages = await perms.can(req, tx, "ai_chat.manage", channelResource(facts));
    const sticky = manages ? body.tools : undefined;
    const viewerAccess = facts.aiAccess ?? (current.ownerUserId === auth.userId ? "owner" : null);
    let sendAccess = OWNER_CONTEXT;
    if (viewerAccess !== "owner") {
      const g = await matchingGrant(tx, conv.id, auth.userId);
      sendAccess = { access: "grant", grantId: g?.id ?? null, level: "chat" };
    }
    // P-09: whoever writes takes part (roster, unread); a person grantee already has the row from the grant. A unit
    // or organization grantee joining by writing has read what was there (06-08: their unread starts now).
    if (!(await getMembership(tx, conv.id, "user", auth.userId))) {
      await join(tx, conv, auth.userId, "ai_chat_post");
    }
    const shared = await isShared(tx, conv.id);
    return { conv, current, sticky, viewerAccess, sendAccess, shared };
  }

  /** The sender's own model for an addressed message, or null when it is refused (the queue then skips it). */
  async function senderModel(tx: Tx, ref: ModelRef, userId: string): Promise<ResolvedModel | null> {
    try {
      return await gateway.resolve(tx, ref, userId);
    } catch (err) {
      if (err instanceof ModelUnavailableError || err instanceof PlanTokenUnavailableError) return null;
      throw err;
    }
  }

  /** A human message of a multiplayer chat as everyone sees it: its files and where its request stands. */
  async function sharedUserMessage(tx: Tx, row: MessageRow) {
    const dir = await directoryOf(tx, [row.authorId ?? ""]);
    const files = (await attachmentsForMessages(tx, [row.id])).get(row.id) ?? [];
    const aiAddressing = (await addressingFor(tx, [row.id])).get(row.id);
    return { ...aiMessage(row, dir, undefined, files), ...(aiAddressing ? { aiAddressing } : {}) };
  }

  /**
   * 201 when `gen` started now and answers this message (it is one of the messages its turn answers), else 202 with
   * the message's addressing (queued, not addressed, skipped with the reason, or already answering for a retry).
   */
  async function sharedOutcome(
    tx: Tx,
    row: MessageRow,
    chat: AiChatSummary,
    gen: GenerationRow | null,
  ): Promise<SendOutcome> {
    const userMessage = await sharedUserMessage(tx, row);
    const addressing: AiAddressing = userMessage.aiAddressing ?? {
      addressed: false,
      status: "not_addressed",
      skipReason: null,
      generationId: null,
    };
    if (gen && addressing.generationId === gen.id) {
      const [assistant] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, gen.assistantMessageId))
        .limit(1);
      if (!assistant) throw new Error("assistant message missing");
      const generation = generationDto(gen, null, gateway);
      return {
        status: 201,
        body: {
          chat,
          userMessage,
          assistantMessage: aiMessage(assistant, EMPTY_DIRECTORY, generation),
          generation,
        },
      };
    }
    return { status: 202, body: { chat, userMessage, addressing } };
  }

  /** A retried send in a multiplayer chat: the answer it started (201), or where it stands now (202). */
  async function retriedShared(tx: Tx, row: MessageRow): Promise<SendOutcome> {
    const [own] = await tx
      .select({ id: aiGenerations.id })
      .from(aiGenerations)
      .where(eq(aiGenerations.userMessageId, row.id))
      .limit(1);
    if (own) {
      const response = await responseFor(tx, row);
      return { status: 201, body: { ...response, userMessage: await sharedUserMessage(tx, row) } };
    }
    const { conv, chat } = await loadChat(tx, row.conversationId);
    const summary = chatSummary(conv, chat, {
      generating: await isGenerating(tx, conv.id),
      gateway,
      view: row.authorId ? await viewOf(tx, chat, row.authorId) : null,
    });
    return sharedOutcome(tx, row, summary, null);
  }

  /**
   * Agents in AI chats (06-10, D-07, P-10): every @mentioned persona that is a member of the chat, live, not personal and
   * visible to the author (`bot.read`) gets ONE flat delivery through the Agent Channel API (`delivery: "dm"`: the whole
   * chat as history, a top-level reply), inside the send transaction, so it is delivered iff the message commits. The
   * chat model never answers through OpenClaw and a persona never answers through the chat model.
   */
  async function dispatchPersonas(
    tx: Tx,
    conv: ConversationRow,
    row: MessageRow,
    createdAt: string,
    dir: Directory,
    authorId: string,
  ): Promise<void> {
    const agentIds: string[] = [];
    for (const m of row.mentions) {
      if (m.kind !== "agent" || agentIds.includes(m.id)) continue;
      const bot = dir.agents.get(m.id);
      if (!bot || bot.deleted || bot.status === "disabled" || bot.scope === "personal") continue;
      if (!(await getMembership(tx, conv.id, "agent", bot.id))) continue;
      const reads = await perms.decide(
        tx,
        { kind: "user", userId: authorId },
        "bot.read",
        agentResource({ ...agentFactsOf(bot), disabled: false }, authorId),
      );
      if (reads.allowed) agentIds.push(bot.id);
    }
    if (agentIds.length === 0) return;
    await core.chatAgent.emitAgentMention(
      tx,
      {
        organizationId: conv.organizationId,
        conversationId: conv.id,
        threadRootId: row.id,
        messageId: row.id,
        agentIds,
        author: { kind: "user", id: authorId, displayName: dir.users.get(authorId)?.displayName ?? "Member" },
        body: row.body,
        createdAt,
        delivery: "dm",
      },
      tenantOf(tx).afterCommit,
    );
  }

  /**
   * A send in a multiplayer chat (06-06, D-05, P-07, P-08): never 409. The message is persisted and broadcast with its
   * server-resolved mentions; it is addressed when `askAi` says so or, absent, when it mentions nobody. An addressed
   * message joins the queue (429 `ai_queue_full` at `AI_QUEUE_MAX` waiting, nothing written) and `startNext` answers
   * it now when nothing runs, on the first waiting author's own model; otherwise it waits, visible to everyone.
   */
  async function sendShared(
    req: FastifyRequest,
    tx: Tx,
    conv: ConversationRow,
    facts: ChannelFacts,
    body: SendAiMessageRequest,
  ): Promise<SendOutcome> {
    const auth = authOf(req);
    // Only the sender's own ready, unlinked uploads of this chat (409 otherwise, before anything else).
    const files = await linkableAttachments(tx, {
      conversationId: conv.id,
      uploaderId: auth.userId,
      ids: body.attachmentIds ?? [],
    });
    // Server-derived, exactly like a channel post: the request's own `mentions` never decide anything.
    const dir = await loadDirectory(tx);
    const mentions = resolveMentions(body.body, dir);
    const addressed = addressedOf(body.askAi, mentions);
    if (addressed) {
      // Files the sender's model cannot read are refused as in Phase 5; a refused model is skipped by the queue.
      const resolved = await senderModel(tx, body.model, auth.userId);
      if (resolved) assertReadableBy(files, resolved.caps, resolved.label);
      if ((await pendingCount(tx, conv.id)) >= AI_QUEUE_MAX) {
        throw new HttpError(429, "ai_queue_full", `At most ${AI_QUEUE_MAX} messages can wait for an answer`);
      }
    }
    const prepared = await prepareSend(req, tx, conv, facts, body, files);
    const { current, sticky, viewerAccess, sendAccess, shared } = prepared;
    const topic = convTopic(prepared.conv.id);
    const seq = await lockNextSeq(tx, topic);
    const [row] = await tx
      .insert(messages)
      .values({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        seq,
        authorKind: "user",
        authorId: auth.userId,
        body: body.body,
        mentions,
        clientKind: auth.clientKind,
        sessionId: auth.sessionId,
        clientMessageId: body.clientMessageId,
      })
      .returning();
    if (!row) throw new Error("user message insert returned no row");
    if (files.length > 0) {
      await linkAttachments(tx, {
        conversationId: conv.id,
        messageId: row.id,
        uploaderId: auth.userId,
        ids: files.map((f) => f.id),
      });
    }
    await tx.insert(aiMessageContext).values({
      messageId: row.id,
      organizationId: conv.organizationId,
      conversationId: conv.id,
      authorKind: "user",
      access: sendAccess.access,
      grantId: sendAccess.grantId,
      level: sendAccess.level,
      addressed,
      answeredByGenerationId: null,
      model: body.model,
      tools: { web: (sticky ?? chatSettings(current).tools).web === true },
      shared,
    });
    const posted = await sharedUserMessage(tx, row);
    const s = await core.realtime.appendEvent(tx, topic, EventTypes.messageCreated, { message: posted });
    if (s !== seq) throw new Error(`stream seq drift on ${topic}: expected ${seq}, got ${s}`);
    // 06-08: the mentioned humans who can read the chat are notified (`mention`), in this transaction, through the
    // chat-events seam (the notification module decides readers; never `@channel`/DM rules here).
    await core.chatEvents.messagePosted(tx, {
      conv: { id: conv.id, kind: "ai_chat", organizationId: conv.organizationId },
      message: posted,
      author: { kind: "user", id: auth.userId },
      mentions,
      mentionAll: null,
      threadRootId: null,
    });
    // 06-10: the personas it mentions answer through OpenClaw, independently of the model's queue.
    await dispatchPersonas(tx, conv, row, posted.createdAt, dir, auth.userId);

    let started: GenerationRow | null = null;
    if (addressed) {
      started = await startNext({ core, gateway, runLoop }, tx, conv.id, { publish: false });
      await publishQueue(core, tx, conv.id);
    }
    const chat = await touchChat(
      tx,
      prepared.conv,
      addressed ? body.model : undefined,
      sticky,
      { userId: auth.userId, access: viewerAccess === "owner" ? "owner" : "chat", shared },
      await isGenerating(tx, conv.id),
    );
    const outcome = await sharedOutcome(tx, row, chat, started);
    // Ids only (T-05-02-02): the message, whether it asked the model and the answer it started, if any.
    await core.audit.record(tx, {
      action: "ai_chat.message.sent",
      resourceType: "ai_chat",
      resourceId: conv.id,
      metadata: {
        conversationId: conv.id,
        messageId: row.id,
        addressed,
        generationId: outcome.status === 201 ? outcome.body.generation.id : null,
      },
    });
    return outcome;
  }

  return {
    async createChat(req: FastifyRequest, body: CreateAiChatRequest): Promise<SendAiMessageResponse> {
      const auth = authOf(req);
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        // Files are uploaded into an existing chat (a draft, `POST /ai-chats/drafts`): none can belong to this one.
        if (body.attachmentIds?.length) throw notLinkable();
        const retried = await ownSend(tx, auth.userId, body.clientMessageId);
        if (retried) {
          const [conv] = await tx
            .select({ kind: conversations.kind })
            .from(conversations)
            .where(eq(conversations.id, retried.conversationId))
            .limit(1);
          if (conv?.kind !== "ai_chat")
            throw conflict("clientMessageId already used", "client_message_id_reused");
          return { response: await responseFor(tx, retried), start: null };
        }
        const resolved = await resolveOr409(tx, body.model, auth.userId);
        const policy = await loadAiChatPolicy(tx);
        await capOr429(tx, auth.userId, policy.concurrentGenerationsPerUser);
        const limit = { userId: auth.userId, backendClass: backendClassOf(resolved.ref.backend) };
        const counted = await consumeGeneration(tx, { ...limit, policy });
        if (!counted.ok) return { refused: await refuseOverLimit(core, tx, counted, limit) };

        const [conv] = await tx
          .insert(conversations)
          .values({
            organizationId: auth.organizationId,
            kind: "ai_chat",
            visibility: "private",
            name: heuristicTitle(body.body),
            createdBy: auth.userId,
          })
          .returning();
        if (!conv) throw new Error("conversation insert returned no row");
        await tx.insert(conversationMembers).values({
          conversationId: conv.id,
          organizationId: auth.organizationId,
          memberKind: "user",
          memberId: auth.userId,
          role: "owner",
        });
        // The member's "Web on by default" applies when the first send says nothing (05-11).
        const tools = body.tools ??
          body.settings?.tools ?? { web: (await loadPreferences(tx, auth.userId)).webDefault };
        await tx.insert(aiChats).values({
          conversationId: conv.id,
          organizationId: auth.organizationId,
          ownerUserId: auth.userId,
          titleSource: "heuristic",
          instructions: body.settings?.instructions ?? "",
          usePersonalInstructions: body.settings?.usePersonalInstructions ?? true,
          tools,
          lastModel: body.model,
        });
        const turn = await insertTurn(req, tx, conv, body, resolved, [], {
          access: OWNER_CONTEXT,
          tools: { web: tools.web === true },
          shared: false,
        });
        const chat = await touchChat(tx, conv, body.model, undefined, {
          userId: auth.userId,
          access: "owner",
          shared: false,
        });
        await auditSend(tx, "ai_chat.created", conv, turn.generation);
        return { response: { ...turn.turn, chat }, start: turn.generation };
      });
      // The refusal's audit row is committed; nothing else was written.
      if ("refused" in out) throw out.refused;
      if (out.start) runLoop.start({ organizationId: out.start.organizationId, generationId: out.start.id });
      return out.response;
    },

    async sendMessage(req: FastifyRequest, chatId: string, body: SendAiMessageRequest): Promise<SendOutcome> {
      const auth = authOf(req);
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        let { conv, facts } = await guards.writableChat(req, tx, chatId);
        // Serializes sends on this chat, which also makes the retry check below race-free.
        await lockNextSeq(tx, convTopic(conv.id));
        const multiplayer = await isMultiplayer(tx, conv.id);
        const retried = await ownSend(tx, auth.userId, body.clientMessageId);
        if (retried) {
          if (retried.conversationId !== conv.id) {
            throw conflict("clientMessageId already used", "client_message_id_reused");
          }
          if (multiplayer) return { outcome: await retriedShared(tx, retried), start: null };
          return { response: await responseFor(tx, retried), start: null };
        }
        refuseArchived(conv);
        // A shared chat (06-06): the message is always posted; the queue decides whether and when it is answered.
        if (multiplayer) return { outcome: await sendShared(req, tx, conv, facts, body), start: null };
        const resolved = await resolveOr409(tx, body.model, auth.userId);
        // Only the sender's own ready, unlinked uploads of this chat (409 otherwise, before anything else).
        const files = await linkableAttachments(tx, {
          conversationId: conv.id,
          uploaderId: auth.userId,
          ids: body.attachmentIds ?? [],
        });
        // Nothing the selected model cannot read is ever sent (400 attachment_not_supported, nothing written).
        assertReadableBy(files, resolved.caps, resolved.label);
        if (await isGenerating(tx, conv.id)) {
          throw conflict("An answer is still being generated in this chat", "generation_in_progress");
        }
        const policy = await loadAiChatPolicy(tx);
        await capOr429(tx, auth.userId, policy.concurrentGenerationsPerUser);
        const limit = { userId: auth.userId, backendClass: backendClassOf(resolved.ref.backend) };
        const counted = await consumeGeneration(tx, { ...limit, policy });
        if (!counted.ok) return { refused: await refuseOverLimit(core, tx, counted, limit) };
        const prepared = await prepareSend(req, tx, conv, facts, body, files);
        conv = prepared.conv;
        const { current, sticky, viewerAccess, sendAccess, shared } = prepared;
        const turn = await insertTurn(req, tx, conv, body, resolved, files, {
          access: sendAccess,
          tools: { web: (sticky ?? chatSettings(current).tools).web === true },
          shared,
        });
        const chat = await touchChat(tx, conv, body.model, sticky, {
          userId: auth.userId,
          access: viewerAccess === "owner" ? "owner" : "chat",
          shared,
        });
        await auditSend(tx, "ai_chat.message.sent", conv, turn.generation);
        return { response: { ...turn.turn, chat }, start: turn.generation };
      });
      // The refusal's audit row is committed; nothing else was written.
      if ("refused" in out) throw out.refused;
      if ("outcome" in out && out.outcome) return out.outcome;
      if (out.start) runLoop.start({ organizationId: out.start.organizationId, generationId: out.start.id });
      return { status: 201, body: out.response };
    },

    /**
     * An empty AI chat to upload files into before the first message (05-12): owner-only like any AI chat, titled
     * "New chat", audited `ai_chat.created {draft: true}`. It stays out of `GET /ai-chats` (and so out of every list)
     * until its first message; an abandoned draft is never shown, and its unsent uploads are swept with every other
     * unlinked upload.
     */
    async createDraft(req: FastifyRequest): Promise<AiChatSummary> {
      const auth = authOf(req);
      return core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const [conv] = await tx
          .insert(conversations)
          .values({
            organizationId: auth.organizationId,
            kind: "ai_chat",
            visibility: "private",
            name: null,
            createdBy: auth.userId,
          })
          .returning();
        if (!conv) throw new Error("conversation insert returned no row");
        await tx.insert(conversationMembers).values({
          conversationId: conv.id,
          organizationId: auth.organizationId,
          memberKind: "user",
          memberId: auth.userId,
          role: "owner",
        });
        const [chat] = await tx
          .insert(aiChats)
          .values({
            conversationId: conv.id,
            organizationId: auth.organizationId,
            ownerUserId: auth.userId,
            titleSource: "heuristic",
            instructions: "",
            usePersonalInstructions: true,
            tools: { web: (await loadPreferences(tx, auth.userId)).webDefault },
            lastModel: null,
          })
          .returning();
        if (!chat) throw new Error("ai chat insert returned no row");
        await core.audit.record(tx, {
          action: "ai_chat.created",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: { conversationId: conv.id, draft: true },
        });
        return chatSummary(conv, chat, { generating: false, gateway });
      });
    },

    /**
     * The caller's own AI chats (05-10, AICHAT-04, P-03): the resolver's readable set with kind `ai_chat` (owner
     * only, admins included), narrowed to `owner_user_id = caller`, newest activity first, keyset-paged; archived
     * ones only with `archived=true`. A member without `ai_chat.use` simply has none to list.
     */
    async list(req: FastifyRequest, q: AiChatListQuery): Promise<AiChatList> {
      const auth = authOf(req);
      return core.db.withTenant(tenant(req), async (tx) => {
        const cursor = q.cursor ? decodeListCursor(q.cursor) : null;
        // `mine` is the Phase 5 list: a member without `ai_chat.use` has none. Chats shared with the caller are read
        // through their grant (`channel.read`), decided per chat by the readable set below.
        const mayUse = await perms.can(req, tx, "ai_chat.use");
        if (q.scope === "mine" && !mayUse) return { chats: [], nextCursor: null };
        const readable = await access.readableIds(tx, auth.userId, {
          kinds: ["ai_chat"],
          includeArchived: true,
        });
        if (readable.length === 0) return { chats: [], nextCursor: null };
        const rows = await tx
          .select({
            conv: conversations,
            chat: aiChats,
            at: sql<string>`${aiChats.lastActivityAt}::text`,
            access: aiAccessSql(auth.userId, aiChats.conversationId).mapWith(String),
            shared: sharedSql(aiChats.conversationId).mapWith(Boolean),
          })
          .from(aiChats)
          .innerJoin(conversations, eq(conversations.id, aiChats.conversationId))
          .where(
            and(
              inArray(aiChats.conversationId, readable),
              q.scope === "mine"
                ? eq(aiChats.ownerUserId, auth.userId)
                : q.scope === "shared"
                  ? ne(aiChats.ownerUserId, auth.userId)
                  : undefined,
              q.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
              // A draft (05-12) is listed from its first message on.
              sql`exists (select 1 from ${messages} where ${messages.conversationId} = ${aiChats.conversationId})`,
              cursor
                ? or(
                    sql`${aiChats.lastActivityAt} < ${cursor.t}::timestamptz`,
                    and(
                      sql`${aiChats.lastActivityAt} = ${cursor.t}::timestamptz`,
                      sql`${aiChats.conversationId} < ${cursor.i}::uuid`,
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(aiChats.lastActivityAt), desc(aiChats.conversationId))
          .limit(q.limit + 1);
        const page = rows.slice(0, q.limit);
        const ids = page.map((r) => r.conv.id);
        const live = ids.length
          ? await tx
              .select({ id: aiGenerations.conversationId })
              .from(aiGenerations)
              .where(and(inArray(aiGenerations.conversationId, ids), eq(aiGenerations.status, "running")))
          : [];
        const generating = new Set(live.map((g) => g.id));
        // 06-08: shared chats the caller takes part in carry their unread count; solo chats keep the Phase 5 shape.
        const unread = await unreadCountsFor(
          tx,
          auth.userId,
          page.filter((r) => r.shared).map((r) => r.conv.id),
        );
        const owners = await directoryOf(
          tx,
          page.map((r) => r.chat.ownerUserId),
        );
        const last = page.at(-1);
        return {
          chats: page.map((r) => {
            const summary = chatSummary(r.conv, r.chat, {
              generating: generating.has(r.conv.id),
              gateway,
              view: {
                access: (r.access as ChatView["access"] | null) ?? "view",
                owner: ownerAuthor(owners, r.chat.ownerUserId),
                shared: r.shared,
              },
            });
            const counts = unread.get(r.conv.id);
            return counts ? { ...summary, unreadCount: counts.unreadCount } : summary;
          }),
          nextCursor:
            rows.length > q.limit && last ? encodeListCursor({ t: last.at, i: last.conv.id }) : null,
        };
      });
    },

    /**
     * The caller read the chat up to `seq` (06-08, P-09, CHAT-09 semantics): `channel.read` first (hidden 404, so it never
     * joins a chat the caller cannot read), then the caller's participation row (a unit or organization grantee joins
     * here), the cursor moved forward only (clamped to the newest message), the notifications it covers read, and a
     * durable `conversation.read` with the new counts on `user:<caller>` for their other tabs and devices.
     */
    async markRead(req: FastifyRequest, chatId: string, seq: number): Promise<void> {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.readableChat(req, tx, chatId);
        const joined = await join(tx, conv, auth.userId, "ai_chat_read");
        const mine = and(
          eq(conversationMembers.conversationId, conv.id),
          eq(conversationMembers.memberKind, "user"),
          eq(conversationMembers.memberId, auth.userId),
        );
        // Lock order (cursor row → notifications → user stream) as the channel read route.
        const [row] = await tx
          .select({ lastReadSeq: conversationMembers.lastReadSeq })
          .from(conversationMembers)
          .where(mine)
          .for("update");
        if (!row) return;
        const latest = await latestSeq(tx, conv.id);
        const prev = Number(row.lastReadSeq);
        const next = Math.max(prev, Math.min(seq, latest));
        if (next !== prev) await tx.update(conversationMembers).set({ lastReadSeq: next }).where(mine);
        await core.chatEvents.conversationRead(tx, {
          userId: auth.userId,
          conversationId: conv.id,
          lastReadSeq: next,
        });
        if (next === prev && !joined) return;
        await lockNextSeq(tx, `user:${auth.userId}`);
        const counts = (await unreadCountsFor(tx, auth.userId, [conv.id])).get(conv.id) ?? {
          unreadCount: 0,
          mentionCount: 0,
        };
        const ev: ConversationReadEvent = {
          conversationId: conv.id,
          lastReadSeq: next,
          ...counts,
          latestMessageSeq: latest,
        };
        await core.realtime.appendEvent(tx, `user:${auth.userId}`, EventTypes.conversationRead, ev);
      });
    },

    /**
     * Rename and archive/unarchive (05-10, owner only, hidden = 404). A typed title becomes `title_source = 'user'`
     * and is never replaced by a generated one; archive is the conversation's `archived_at`. Each real change is
     * audited (`ai_chat.renamed` carries the id only, never the title) and announced as `ai_chat.updated`.
     * Settings (05-11): instructions (≤ AI_INSTRUCTIONS_MAX, by the schema), "Also use my personal instructions" and the
     * chat's tools; `ai_chat.settings_updated` lists the changed keys only.
     */
    async update(req: FastifyRequest, chatId: string, body: UpdateAiChatRequest): Promise<AiChatDetail> {
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await guards.managedChat(req, tx, chatId);
        const { chat } = await loadChat(tx, conv.id);
        const at = new Date().toISOString();
        const audits: Array<"ai_chat.renamed" | "ai_chat.archived" | "ai_chat.unarchived"> = [];
        if (body.title !== undefined && (body.title !== conv.name || chat.titleSource !== "user")) {
          await tx.update(conversations).set({ name: body.title }).where(eq(conversations.id, conv.id));
          await tx
            .update(aiChats)
            .set({ titleSource: "user", updatedAt: at })
            .where(eq(aiChats.conversationId, conv.id));
          audits.push("ai_chat.renamed");
        }
        if (body.archived !== undefined && body.archived !== (conv.archivedAt !== null)) {
          await tx
            .update(conversations)
            .set({ archivedAt: body.archived ? at : null })
            .where(eq(conversations.id, conv.id));
          await tx.update(aiChats).set({ updatedAt: at }).where(eq(aiChats.conversationId, conv.id));
          audits.push(body.archived ? "ai_chat.archived" : "ai_chat.unarchived");
        }
        for (const action of audits) {
          // The id only: a title is the member's own text (T-05-10-04).
          await core.audit.record(tx, {
            action,
            resourceType: "ai_chat",
            resourceId: conv.id,
            metadata: { conversationId: conv.id },
          });
        }
        if (body.settings !== undefined) {
          const changed = await updateSettings(tx, chat, body.settings, at);
          if (changed.length > 0) {
            // Changed keys only: instructions are the member's own text (T-05-11-05).
            await core.audit.record(tx, {
              action: "ai_chat.settings_updated",
              resourceType: "ai_chat",
              resourceId: conv.id,
              metadata: { conversationId: conv.id, changed },
            });
          }
        }
        const fresh = await loadChat(tx, conv.id);
        const summary = chatSummary(fresh.conv, fresh.chat, {
          generating: await isGenerating(tx, conv.id),
          gateway,
          view: await viewOf(tx, fresh.chat, fresh.chat.ownerUserId),
        });
        // A rename or an archive reaches every participant's sidebar, each with their own view (06-08).
        if (audits.length > 0) {
          await emitChatUpdated(core, tx, fresh.conv, fresh.chat, {
            generating: summary.generating,
            gateway,
          });
        }
        return detailOf(req, tx, summary, fresh.chat, facts);
      });
    },

    /**
     * TEST-ONLY (05-10 e2e): moves a chat's last activity back so the list's date groups can be exercised. Owner
     * only, like every route here; mounted only where the ChatGPT test seed is (never in production).
     */
    async setActivityForTest(req: FastifyRequest, chatId: string, lastActivityAt: string): Promise<void> {
      await core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.managedChat(req, tx, chatId);
        await tx.update(aiChats).set({ lastActivityAt }).where(eq(aiChats.conversationId, conv.id));
      });
    },

    async snapshot(req: FastifyRequest, chatId: string): Promise<AiChatSnapshot> {
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await guards.readableChat(req, tx, chatId);
        // The cursor is read FIRST: every later statement of this (READ COMMITTED) transaction sees at least the
        // state of `lastSeq`, so replaying the events after it only moves the client forward. Read last, a
        // generation finalized between the reads came back `streaming` under a cursor that already covered its
        // final `message.updated`, and the answer stayed "writing" in the browser (05-03).
        const lastSeq = await core.realtime.lastSeq(tx, convTopic(conv.id));
        const { chat } = await loadChat(tx, conv.id);
        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conv.id), isNull(messages.threadId)))
          .orderBy(desc(messages.seq))
          .limit(AI_SNAPSHOT_MESSAGES + 1);
        const hasMore = rows.length > AI_SNAPSHOT_MESSAGES;
        const page = rows.slice(0, AI_SNAPSHOT_MESSAGES).reverse();
        const multiplayer = await isMultiplayer(tx, conv.id);
        const list = await toDtos(tx, page, chat, multiplayer);
        const [running] = await tx
          .select()
          .from(aiGenerations)
          .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
          .limit(1);
        const summary = chatSummary(conv, chat, {
          generating: running !== undefined,
          gateway,
          view: await viewOf(tx, chat, authOf(req).userId),
        });
        return {
          chat: await detailOf(req, tx, summary, chat, facts),
          messages: list,
          hasMore,
          running: running
            ? {
                generationId: running.id,
                messageId: running.assistantMessageId,
                partialText: runLoop.textOf(running.id) ?? running.partialText,
              }
            : null,
          lastSeq,
          // The one-generation queue of a shared chat (P-08); solo snapshots keep the Phase 5 shape.
          ...(multiplayer ? { queue: await queueState(tx, conv.id) } : {}),
        };
      });
    },

    async page(
      req: FastifyRequest,
      chatId: string,
      q: { before?: number; limit: number },
    ): Promise<MessagePage> {
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await guards.readableChat(req, tx, chatId);
        const { chat } = await loadChat(tx, conv.id);
        const rows = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conv.id),
              isNull(messages.threadId),
              q.before ? lt(messages.seq, q.before) : undefined,
            ),
          )
          .orderBy(desc(messages.seq))
          .limit(q.limit + 1);
        const hasMore = rows.length > q.limit;
        const page = rows.slice(0, q.limit).reverse();
        return {
          messages: await toDtos(tx, page, chat, await isMultiplayer(tx, conv.id)),
          nextBefore: hasMore ? (page[0]?.seq ?? null) : null,
          lastSeq: await core.realtime.lastSeq(tx, convTopic(conv.id)),
        };
      });
    },
  };

  /** Applies a settings patch (05-11); returns the keys that actually changed, sorted. */
  async function updateSettings(
    tx: Tx,
    chat: AiChatRow,
    patch: NonNullable<UpdateAiChatRequest["settings"]>,
    at: string,
  ): Promise<string[]> {
    const before = chatSettings(chat);
    const next = {
      instructions: patch.instructions ?? before.instructions,
      usePersonalInstructions: patch.usePersonalInstructions ?? before.usePersonalInstructions,
      tools: patch.tools ?? before.tools,
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
      .sort();
    if (changed.length > 0) {
      await tx
        .update(aiChats)
        .set({ ...next, updatedAt: at })
        .where(eq(aiChats.conversationId, chat.conversationId));
    }
    return changed;
  }

  async function toDtos(tx: Tx, rows: MessageRow[], chat: AiChatRow, multiplayer: boolean) {
    const gens = await generationsFor(
      tx,
      rows.filter((r) => r.authorKind === "agent").map((r) => r.id),
      gateway,
    );
    // Every human author (a shared chat has several) and every persona author (06-05), plus the owner.
    const dir = await directoryOf(
      tx,
      [
        chat.ownerUserId,
        ...rows.filter((r) => r.authorKind === "user" && r.authorId).map((r) => r.authorId as string),
      ],
      rows.filter((r) => r.authorKind === "agent" && r.authorId).map((r) => r.authorId as string),
    );
    const files = await attachmentsForMessages(
      tx,
      rows.filter((r) => r.authorKind === "user").map((r) => r.id),
    );
    // Where each human request stands (06-06): shared chats only, so solo pages keep the Phase 5 shape.
    const addressing = multiplayer
      ? await addressingFor(
          tx,
          rows.filter((r) => r.authorKind === "user").map((r) => r.id),
        )
      : new Map<string, AiAddressing>();
    return rows.map((r) => {
      // The chat model's answers carry their generation; a persona's message (06-10) its directory entry.
      if (r.authorKind === "agent") return aiMessage(r, r.authorId ? dir : EMPTY_DIRECTORY, gens.get(r.id));
      const aiAddressing = addressing.get(r.id);
      return {
        ...aiMessage(r, dir, undefined, files.get(r.id) ?? []),
        ...(aiAddressing ? { aiAddressing } : {}),
      };
    });
  }
}

export type AiChatService = ReturnType<typeof createAiChatService>;
