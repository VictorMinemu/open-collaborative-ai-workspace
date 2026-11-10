import {
  AI_QUEUE_MAX,
  type AiQueueState,
  type AiSkipReason,
  EventTypes,
  type MessageMention,
  type ModelRef,
} from "@ocw/contracts";
import {
  aiChatGrants,
  aiChats,
  aiGenerations,
  aiMessageContext,
  conversationMembers,
  conversations,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { attachmentsForMessages } from "../artifact";
import { convTopic, lockNextSeq } from "../chat";
import {
  loadAiChatPolicy,
  type ModelGateway,
  ModelUnavailableError,
  PlanTokenUnavailableError,
  type ResolvedModel,
} from "../model-gateway";
import {
  addressingFor,
  aiMessage,
  directoryOf,
  EMPTY_DIRECTORY,
  emitChatUpdated,
  type GenerationRow,
  generationDto,
  parseModelRef,
} from "./dto";
import { consumeGeneration, refuseOverLimit } from "./limits";
import type { RunLoop } from "./run-loop";
import { backendClassOf } from "./usage";

/**
 * One generation per conversation in shared AI chats (06-06, D-01, D-05, P-07, P-08). The queue is derived, never
 * stored: the context rows of a chat that are addressed, unanswered and not skipped, in message order. `startNext`
 * is the single place that turns them into a generation: under the conversation's stream lock, when nothing runs, it
 * takes the FIRST waiting author, resolves that author's own model (the one they sent with their earliest pending
 * message), checks their concurrency and daily caps, and starts one coalesced turn that answers every pending
 * message (D-01: billed to that first author). An author whose model is refused or who is at the daily cap is
 * skipped with the reason; nobody else's plan or key is ever tried. No model call decides whether to answer and
 * nothing is debounced (P-08). Callers: the multiplayer send, the finalize hook (`registerQueue`) and the sweeper.
 */

export interface QueueDeps {
  core: Core;
  gateway: ModelGateway;
  runLoop: RunLoop;
}

export interface StartNextOptions {
  /** Append `ai.queue.updated` when something started or was skipped (default true). */
  publish?: boolean;
  /**
   * Only try the requester's advisory lock (`ai:<user>`). The finalize hook runs after finalize has appended to
   * `user:<owner>`; waiting there for a lock a send of the same person may hold while it waits on that same stream
   * row could deadlock, so the hook gives up instead and retries in a fresh transaction after commit.
   */
  tryLock?: boolean;
}

/** P-08: an explicit `askAi` wins; otherwise a message asks the model only when it mentions nobody. */
export function addressedOf(askAi: boolean | undefined, mentions: MessageMention[]): boolean {
  return askAi ?? mentions.length === 0;
}

/** A chat with an active grant, or any member besides its owner (people or agents), runs the queue. */
export async function isMultiplayer(tx: Tx, conversationId: string): Promise<boolean> {
  const [grant] = await tx
    .select({ id: aiChatGrants.id })
    .from(aiChatGrants)
    .where(and(eq(aiChatGrants.conversationId, conversationId), isNull(aiChatGrants.revokedAt)))
    .limit(1);
  if (grant) return true;
  const [other] = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .innerJoin(aiChats, eq(aiChats.conversationId, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        or(ne(conversationMembers.memberKind, "user"), ne(conversationMembers.memberId, aiChats.ownerUserId)),
      ),
    )
    .limit(1);
  return other !== undefined;
}

interface PendingRow {
  messageId: string;
  authorId: string;
  model: unknown;
}

/** Addressed, unanswered, not skipped human messages of the chat, oldest first. */
async function pendingRows(tx: Tx, conversationId: string, limit = AI_QUEUE_MAX): Promise<PendingRow[]> {
  const rows = await tx
    .select({
      messageId: aiMessageContext.messageId,
      authorId: messages.authorId,
      model: aiMessageContext.model,
    })
    .from(aiMessageContext)
    .innerJoin(messages, eq(messages.id, aiMessageContext.messageId))
    .where(
      and(
        eq(aiMessageContext.conversationId, conversationId),
        eq(aiMessageContext.authorKind, "user"),
        eq(aiMessageContext.addressed, true),
        isNull(aiMessageContext.answeredByGenerationId),
        isNull(aiMessageContext.skipReason),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit);
  return rows.flatMap((r) => (r.authorId === null ? [] : [{ ...r, authorId: r.authorId }]));
}

/** How many addressed messages wait (the `AI_QUEUE_MAX` check of a send). */
export async function pendingCount(tx: Tx, conversationId: string): Promise<number> {
  return (await pendingRows(tx, conversationId, AI_QUEUE_MAX + 1)).length;
}

async function runningOf(tx: Tx, conversationId: string): Promise<GenerationRow | null> {
  const [row] = await tx
    .select()
    .from(aiGenerations)
    .where(and(eq(aiGenerations.conversationId, conversationId), eq(aiGenerations.status, "running")))
    .limit(1);
  return row ?? null;
}

/** The running answer (whom it answers, across its attempts) and what waits after it. */
export async function queueState(tx: Tx, conversationId: string): Promise<AiQueueState> {
  const running = await runningOf(tx, conversationId);
  let runningState: AiQueueState["running"] = null;
  if (running) {
    const answered = await tx
      .select({ authorId: messages.authorId })
      .from(aiMessageContext)
      .innerJoin(messages, eq(messages.id, aiMessageContext.messageId))
      .innerJoin(aiGenerations, eq(aiGenerations.id, aiMessageContext.answeredByGenerationId))
      .where(
        and(
          eq(aiGenerations.assistantMessageId, running.assistantMessageId),
          eq(aiMessageContext.authorKind, "user"),
        ),
      )
      .orderBy(asc(messages.seq));
    const authors = [...new Set(answered.map((a) => a.authorId).filter((id): id is string => id !== null))];
    runningState = {
      generationId: running.id,
      requesterUserId: running.requesterUserId,
      respondingTo: (authors.length ? authors : [running.requesterUserId]).slice(0, AI_QUEUE_MAX + 1),
    };
  }
  const pending = await pendingRows(tx, conversationId);
  return {
    running: runningState,
    pending: pending.map((p) => ({ messageId: p.messageId, authorId: p.authorId })),
  };
}

/** Durable `ai.queue.updated` on `conv:<id>`: every participant sees who is answered now and who waits. */
export async function publishQueue(core: Core, tx: Tx, conversationId: string): Promise<void> {
  const state = await queueState(tx, conversationId);
  await core.realtime.appendEvent(tx, convTopic(conversationId), EventTypes.aiQueueUpdated, {
    conversationId,
    ...state,
  });
}

/** Marks every pending message of `authorId` skipped and tells everyone (`message.updated` with the reason). */
async function skipAuthor(
  core: Core,
  tx: Tx,
  conversationId: string,
  authorId: string,
  reason: AiSkipReason,
): Promise<void> {
  const ids = (await pendingRows(tx, conversationId, AI_QUEUE_MAX + 1))
    .filter((p) => p.authorId === authorId)
    .map((p) => p.messageId);
  if (ids.length === 0) return;
  await tx
    .update(aiMessageContext)
    .set({ skipReason: reason })
    .where(inArray(aiMessageContext.messageId, ids));
  const rows = await tx.select().from(messages).where(inArray(messages.id, ids)).orderBy(asc(messages.seq));
  const dir = await directoryOf(tx, [authorId]);
  const files = await attachmentsForMessages(tx, ids);
  const addressing = await addressingFor(tx, ids);
  for (const row of rows) {
    await core.realtime.appendEvent(tx, convTopic(conversationId), EventTypes.messageUpdated, {
      message: {
        ...aiMessage(row, dir, undefined, files.get(row.id) ?? []),
        aiAddressing: addressing.get(row.id),
      },
    });
  }
}

type Resolution =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; reason: AiSkipReason }
  | { ok: "error" };

async function resolveFor(gateway: ModelGateway, tx: Tx, model: unknown, userId: string, core: Core) {
  const ref: ModelRef | null = parseModelRef(model);
  if (!ref) return { ok: false, reason: "not_allowed" } satisfies Resolution;
  try {
    return { ok: true, resolved: await gateway.resolve(tx, ref, userId) } satisfies Resolution;
  } catch (err) {
    if (err instanceof ModelUnavailableError) return { ok: false, reason: err.reason } satisfies Resolution;
    if (err instanceof PlanTokenUnavailableError) {
      return { ok: false, reason: "usage_unavailable" } satisfies Resolution;
    }
    // Anything else (e.g. the secret store is down) is not the author's fault: leave the queue for the sweeper.
    core.log.warn({ name: (err as Error)?.name ?? "unknown" }, "ai queue: model resolve failed");
    return { ok: "error" } satisfies Resolution;
  }
}

/** The outcome of one `startNext` pass. */
interface StartOutcome {
  generation: GenerationRow | null;
  /** Something was started or skipped (the queue changed). */
  changed: boolean;
  /** The requester's advisory lock was busy (`tryLock` only): retry in a fresh transaction. */
  busy: boolean;
}

async function startNextIn(
  deps: QueueDeps,
  tx: Tx,
  conversationId: string,
  opts: StartNextOptions,
): Promise<StartOutcome> {
  const { core, gateway, runLoop } = deps;
  const topic = convTopic(conversationId);
  // The stream lock serialises this with sends, regenerates and other starters (one running generation).
  await lockNextSeq(tx, topic);
  const idle: StartOutcome = { generation: null, changed: false, busy: false };
  if (await runningOf(tx, conversationId)) return idle;
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  // An archived chat opens read-only (05-10): its queue waits until it is unarchived.
  if (!conv || conv.archivedAt !== null) return idle;
  const policy = await loadAiChatPolicy(tx);
  let changed = false;
  for (;;) {
    const pending = await pendingRows(tx, conversationId);
    const first = pending[0];
    if (!first) return { generation: null, changed, busy: false };
    const requester = first.authorId;

    const resolution = await resolveFor(gateway, tx, first.model, requester, core);
    if (resolution.ok === "error") return { generation: null, changed, busy: false };
    if (resolution.ok === false) {
      await skipAuthor(core, tx, conversationId, requester, resolution.reason);
      changed = true;
      continue;
    }
    const resolved = resolution.resolved;

    // Per-user concurrency (capOr429 without the throw): at the cap the queue keeps its order and the sweeper retries.
    const key = `ai:${requester}`;
    if (opts.tryLock) {
      const res = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`);
      if (!(res.rows[0] as { ok: boolean } | undefined)?.ok) return { generation: null, changed, busy: true };
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    }
    const [live] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.requesterUserId, requester), eq(aiGenerations.status, "running")));
    if ((live?.n ?? 0) >= policy.concurrentGenerationsPerUser)
      return { generation: null, changed, busy: false };

    // The daily cap of the requester (05-08): refused → skipped, audited like a refused send.
    const limit = { userId: requester, backendClass: backendClassOf(resolved.ref.backend) };
    const counted = await consumeGeneration(tx, { ...limit, policy });
    if (!counted.ok) {
      await refuseOverLimit(core, tx, counted, limit, { userId: requester });
      await skipAuthor(core, tx, conversationId, requester, "daily_limit_reached");
      changed = true;
      continue;
    }

    const seq = await lockNextSeq(tx, topic);
    const [assistantRow] = await tx
      .insert(messages)
      .values({
        organizationId: conv.organizationId,
        conversationId,
        seq,
        authorKind: "agent",
        authorId: null,
        body: "",
        status: "streaming",
      })
      .returning();
    if (!assistantRow) throw new Error("assistant message insert returned no row");
    const [gen] = await tx
      .insert(aiGenerations)
      .values({
        organizationId: conv.organizationId,
        conversationId,
        userMessageId: first.messageId,
        assistantMessageId: assistantRow.id,
        requesterUserId: requester,
        backend: resolved.ref.backend,
        provider: resolved.ref.provider,
        modelId: resolved.ref.modelId,
        attempt: 1,
        status: "running",
        instanceId: runLoop.instanceId,
      })
      .returning();
    if (!gen) throw new Error("generation insert returned no row");
    // Coalescing (D-01): this one turn answers every message that waited, whoever wrote it.
    const messageIds = pending.map((p) => p.messageId);
    await tx
      .update(aiMessageContext)
      .set({ answeredByGenerationId: gen.id })
      .where(inArray(aiMessageContext.messageId, messageIds));
    const s = await core.realtime.appendEvent(
      tx,
      topic,
      EventTypes.messageCreated,
      { message: aiMessage(assistantRow, EMPTY_DIRECTORY, generationDto(gen, null, gateway)) },
      { actorUserId: requester },
    );
    if (s !== seq) throw new Error(`stream seq drift on ${topic}: expected ${seq}, got ${s}`);
    // Ids only (T-06-06-06): who pays for the turn and which messages it answers.
    await core.audit.record(tx, {
      action: "ai_generation.queued_started",
      resourceType: "ai_chat",
      resourceId: conversationId,
      actorKind: "system",
      userId: requester,
      sessionId: null,
      clientKind: null,
      metadata: { conversationId, generationId: gen.id, requesterUserId: requester, messageIds },
    });
    const job = { organizationId: conv.organizationId, generationId: gen.id };
    tenantOf(tx).afterCommit(() => runLoop.start(job));
    return { generation: gen, changed: true, busy: false };
  }
}

/**
 * Starts the conversation's next coalesced turn, or returns null when an answer runs, nothing is pending, the chat is
 * archived or the first waiting author is at the concurrency cap (the sweeper retries). The run loop starts after
 * commit.
 */
export async function startNext(
  deps: QueueDeps,
  tx: Tx,
  conversationId: string,
  opts: StartNextOptions = {},
): Promise<GenerationRow | null> {
  const out = await startNextIn(deps, tx, conversationId, opts);
  if (out.changed && opts.publish !== false) await publishQueue(deps.core, tx, conversationId);
  // A send announces its own turn (touchChat); the sweeper's start tells every sidebar here.
  if (out.generation && opts.publish !== false) await announceStarted(deps, tx, conversationId);
  return out.generation;
}

/** A queued turn started outside a send (06-08): every participant's sidebar shows the chat answering. */
async function announceStarted(deps: QueueDeps, tx: Tx, conversationId: string): Promise<void> {
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  const [chat] = await tx.select().from(aiChats).where(eq(aiChats.conversationId, conversationId)).limit(1);
  if (conv && chat)
    await emitChatUpdated(deps.core, tx, conv, chat, { generating: true, gateway: deps.gateway });
}

/** One `startNext` in its own tenant transaction (the finalize hook's retry, the sweeper). */
export async function startNextAlone(
  deps: QueueDeps,
  organizationId: string,
  conversationId: string,
): Promise<GenerationRow | null> {
  return deps.core.db.withTenant({ organizationId }, (tx) => startNext(deps, tx, conversationId));
}

/**
 * The finalize hook (P-08): in a multiplayer chat, whatever ended the answer (completed, stopped, failed,
 * interrupted), the next coalesced turn starts in the same transaction and everyone gets the new queue.
 */
export function registerQueue(deps: QueueDeps): void {
  deps.runLoop.onAfterFinalize(async (tx, done) => {
    if (!(await isMultiplayer(tx, done.chatId))) return;
    const out = await startNextIn(deps, tx, done.chatId, { tryLock: true });
    await publishQueue(deps.core, tx, done.chatId);
    // After the finalize's `generating: false`, the next turn's start is what every sidebar shows (06-08).
    if (out.generation) await announceStarted(deps, tx, done.chatId);
    if (out.busy) {
      const { organizationId, afterCommit } = tenantOf(tx);
      afterCommit(async () => {
        await startNextAlone(deps, organizationId, done.chatId).catch((err: unknown) =>
          deps.core.log.warn({ name: (err as Error)?.name ?? "unknown" }, "ai queue: deferred start failed"),
        );
      });
    }
  });
}
