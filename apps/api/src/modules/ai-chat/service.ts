import {
  AI_SNAPSHOT_MESSAGES,
  type AiChatDetail,
  type AiChatList,
  type AiChatListQuery,
  type AiChatSnapshot,
  type AiChatSummary,
  type Attachment,
  type CreateAiChatRequest,
  EventTypes,
  type MessagePage,
  type ModelRef,
  type Permission,
  type SendAiMessageRequest,
  type SendAiMessageResponse,
  type UpdateAiChatRequest,
} from "@ocw/contracts";
import { aiChats, aiGenerations, conversationMembers, conversations, messages, type Tx } from "@ocw/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
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
  type ConversationAccess,
  type ConversationRow,
  convTopic,
  lockNextSeq,
  type MessageRow,
} from "../chat";
import {
  loadAiChatPolicy,
  type ModelGateway,
  ModelUnavailableError,
  PlanTokenUnavailableError,
  type ResolvedModel,
} from "../model-gateway";
import { channelResource, orgResource, type PermissionService } from "../organization";
import {
  type AiChatRow,
  aiMessage,
  chatDetail,
  chatSettings,
  chatSummary,
  directoryOf,
  EMPTY_DIRECTORY,
  type GenerationRow,
  generationDto,
  generationsFor,
  parseModelRef,
} from "./dto";
import { consumeGeneration, refuseOverLimit } from "./limits";
import { loadPreferences } from "./prefs";
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

export interface AiChatDeps {
  core: Core;
  gateway: ModelGateway;
  runLoop: RunLoop;
  access: ConversationAccess;
  perms: PermissionService;
}

const VIEWER_CAN: readonly Permission[] = ["ai_chat.use", "ai_chat.web", "ai_chat.share"];
const NOT_FOUND = "AI chat not found";

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
      userId: chat.ownerUserId,
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
    return {
      chat: chatSummary(conv, chat, { generating: await isGenerating(tx, conv.id), gateway }),
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
    files: AttachmentRow[] = [],
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
    const generation = generationDto(genRow, null, gateway);
    const assistantMessage = aiMessage(assistantRow, EMPTY_DIRECTORY, generation);
    const s2 = await core.realtime.appendEvent(tx, topic, EventTypes.messageCreated, {
      message: assistantMessage,
    });
    if (s2 !== userSeq + 1)
      throw new Error(`stream seq drift on ${topic}: expected ${userSeq + 1}, got ${s2}`);
    return { turn: { userMessage, assistantMessage, generation }, generation: genRow };
  }

  async function touchChat(
    tx: Tx,
    conv: ConversationRow,
    ref: ModelRef,
    tools: { web: boolean } | undefined,
  ): Promise<AiChatSummary> {
    const at = new Date().toISOString();
    const [chat] = await tx
      .update(aiChats)
      .set({ lastModel: ref, lastActivityAt: at, updatedAt: at, ...(tools ? { tools } : {}) })
      .where(eq(aiChats.conversationId, conv.id))
      .returning();
    if (!chat) throw notFound(NOT_FOUND);
    const summary = chatSummary(conv, chat, { generating: true, gateway });
    await core.realtime.appendEvent(tx, `user:${chat.ownerUserId}`, EventTypes.aiChatUpdated, {
      chat: summary,
    });
    return summary;
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

  /** The chat if the caller owns it (hidden = 404 for everyone else, admins included). */
  async function ownedChat(req: FastifyRequest, tx: Tx, chatId: string) {
    const { conv, facts } = await access.readable(req, tx, chatId, {
      kinds: ["ai_chat"],
      notFoundMessage: NOT_FOUND,
    });
    await perms.assertCan(req, tx, "ai_chat.use", channelResource(facts), { hideAs404: true });
    return { conv, facts };
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
        await tx.insert(aiChats).values({
          conversationId: conv.id,
          organizationId: auth.organizationId,
          ownerUserId: auth.userId,
          titleSource: "heuristic",
          instructions: body.settings?.instructions ?? "",
          usePersonalInstructions: body.settings?.usePersonalInstructions ?? true,
          // The member's "Web on by default" applies when the first send says nothing (05-11).
          tools: body.tools ??
            body.settings?.tools ?? { web: (await loadPreferences(tx, auth.userId)).webDefault },
          lastModel: body.model,
        });
        const turn = await insertTurn(req, tx, conv, body, resolved);
        const chat = await touchChat(tx, conv, body.model, undefined);
        await auditSend(tx, "ai_chat.created", conv, turn.generation);
        return { response: { ...turn.turn, chat }, start: turn.generation };
      });
      // The refusal's audit row is committed; nothing else was written.
      if ("refused" in out) throw out.refused;
      if (out.start) runLoop.start({ organizationId: out.start.organizationId, generationId: out.start.id });
      return out.response;
    },

    async sendMessage(
      req: FastifyRequest,
      chatId: string,
      body: SendAiMessageRequest,
    ): Promise<SendAiMessageResponse> {
      const auth = authOf(req);
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        let { conv } = await ownedChat(req, tx, chatId);
        // Serializes sends on this chat, which also makes the retry check below race-free.
        await lockNextSeq(tx, convTopic(conv.id));
        const retried = await ownSend(tx, auth.userId, body.clientMessageId);
        if (retried) {
          if (retried.conversationId !== conv.id) {
            throw conflict("clientMessageId already used", "client_message_id_reused");
          }
          return { response: await responseFor(tx, retried), start: null };
        }
        refuseArchived(conv);
        const resolved = await resolveOr409(tx, body.model, auth.userId);
        // Only the sender's own ready, unlinked uploads of this chat (409 otherwise, before anything else).
        const files = await linkableAttachments(tx, {
          conversationId: conv.id,
          uploaderId: auth.userId,
          ids: body.attachmentIds ?? [],
        });
        if (await isGenerating(tx, conv.id)) {
          throw conflict("An answer is still being generated in this chat", "generation_in_progress");
        }
        const policy = await loadAiChatPolicy(tx);
        await capOr429(tx, auth.userId, policy.concurrentGenerationsPerUser);
        const limit = { userId: auth.userId, backendClass: backendClassOf(resolved.ref.backend) };
        const counted = await consumeGeneration(tx, { ...limit, policy });
        if (!counted.ok) return { refused: await refuseOverLimit(core, tx, counted, limit) };
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
        const turn = await insertTurn(req, tx, conv, body, resolved, files);
        const chat = await touchChat(tx, conv, body.model, body.tools);
        await auditSend(tx, "ai_chat.message.sent", conv, turn.generation);
        return { response: { ...turn.turn, chat }, start: turn.generation };
      });
      // The refusal's audit row is committed; nothing else was written.
      if ("refused" in out) throw out.refused;
      if (out.start) runLoop.start({ organizationId: out.start.organizationId, generationId: out.start.id });
      return out.response;
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
        if (!(await perms.can(req, tx, "ai_chat.use"))) return { chats: [], nextCursor: null };
        const readable = await access.readableIds(tx, auth.userId, {
          kinds: ["ai_chat"],
          includeArchived: true,
        });
        if (readable.length === 0) return { chats: [], nextCursor: null };
        const rows = await tx
          .select({ conv: conversations, chat: aiChats, at: sql<string>`${aiChats.lastActivityAt}::text` })
          .from(aiChats)
          .innerJoin(conversations, eq(conversations.id, aiChats.conversationId))
          .where(
            and(
              inArray(aiChats.conversationId, readable),
              eq(aiChats.ownerUserId, auth.userId),
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
        const last = page.at(-1);
        return {
          chats: page.map((r) =>
            chatSummary(r.conv, r.chat, { generating: generating.has(r.conv.id), gateway }),
          ),
          nextCursor:
            rows.length > q.limit && last ? encodeListCursor({ t: last.at, i: last.conv.id }) : null,
        };
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
        const { conv, facts } = await ownedChat(req, tx, chatId);
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
        });
        if (audits.length > 0) {
          await core.realtime.appendEvent(tx, `user:${fresh.chat.ownerUserId}`, EventTypes.aiChatUpdated, {
            chat: summary,
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
        const { conv } = await ownedChat(req, tx, chatId);
        await tx.update(aiChats).set({ lastActivityAt }).where(eq(aiChats.conversationId, conv.id));
      });
    },

    async snapshot(req: FastifyRequest, chatId: string): Promise<AiChatSnapshot> {
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await ownedChat(req, tx, chatId);
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
        const list = await toDtos(tx, page, chat);
        const [running] = await tx
          .select()
          .from(aiGenerations)
          .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
          .limit(1);
        const summary = chatSummary(conv, chat, { generating: running !== undefined, gateway });
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
        };
      });
    },

    async page(
      req: FastifyRequest,
      chatId: string,
      q: { before?: number; limit: number },
    ): Promise<MessagePage> {
      return core.db.withTenant(tenant(req), async (tx) => {
        const { conv } = await ownedChat(req, tx, chatId);
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
          messages: await toDtos(tx, page, chat),
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

  async function toDtos(tx: Tx, rows: MessageRow[], chat: AiChatRow) {
    const gens = await generationsFor(
      tx,
      rows.filter((r) => r.authorKind === "agent").map((r) => r.id),
      gateway,
    );
    const dir = await directoryOf(tx, [chat.ownerUserId]);
    const files = await attachmentsForMessages(
      tx,
      rows.filter((r) => r.authorKind === "user").map((r) => r.id),
    );
    return rows.map((r) =>
      r.authorKind === "agent"
        ? aiMessage(r, EMPTY_DIRECTORY, gens.get(r.id))
        : aiMessage(r, dir, undefined, files.get(r.id) ?? []),
    );
  }
}

export type AiChatService = ReturnType<typeof createAiChatService>;
