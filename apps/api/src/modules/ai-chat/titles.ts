import {
  type AiChatPolicy,
  type ModelProviderKind,
  type ModelRef,
  normalizeSessionTitle,
  priceOf,
  SessionTitle,
  TITLE_TIMEOUT_MS,
  titleProblems,
} from "@ocw/contracts";
import { aiChats, aiGenerations, conversations, messages, type Tx } from "@ocw/db";
import { type ModelMessage, streamText } from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import {
  loadAiChatPolicy,
  type ModelGateway,
  ModelUnavailableError,
  PlanTokenUnavailableError,
  type ResolvedModel,
} from "../model-gateway";
import { buildModelMessages, type PersistedTurn } from "./build-model-messages";
import { DEFAULT_CHAT_TITLE, emitChatUpdated, type GenerationRow } from "./dto";
import { type ReportedUsage, recordUsage } from "./usage";

/**
 * Automatic AI chat titles (05-10, AICHAT-04, D-06) with ADR-0014 semantics. A chat starts with `heuristicTitle` of
 * its first message (`title_source = 'heuristic'`). After its FIRST completed answer — and only while the title is
 * still the heuristic one — the run loop's after-commit hook schedules one small-model call:
 *
 * - on the SAME backend as the chat and the chat OWNER's own credential (`gateway.resolve(…, ownerId)`; never another
 *   member's, never a pooled key), with the model `pickTitleModel` chooses;
 * - with the prompt `buildModelMessages({purpose: "title"})` builds (title instructions + the first message only);
 * - under `OCW_AI_TITLE_TIMEOUT_MS` (20 s by default), outside any transaction, with no tools;
 * - its answer is normalized (`normalizeSessionTitle`) and validated (`SessionTitle`) before one conditional update
 *   (`where title_source = 'heuristic'`), so a title the member typed meanwhile is never replaced;
 * - every call that answered is metered as a `title` usage record of the same generation (on the title model);
 *   a call that failed or timed out records nothing and leaves the heuristic title;
 * - the owner's `user:` topic gets `ai_chat.updated`.
 *
 * Failures are logged as codes only: provider errors carry the request body, which is the prompt (P-10).
 */

/** ADR-0014 fallback when the shape rule cannot hold: the first line cut to 32 characters on a word boundary. */
const FALLBACK_MAX = 32;

/** The title a chat starts with: the first message's first non-empty line in the ADR-0014 shape when possible. */
export function heuristicTitle(firstMessage: string): string {
  const normalized = normalizeSessionTitle(firstMessage);
  if (normalized) return normalized;
  const line = (firstMessage.split(/\r?\n/u).find((l) => l.trim().length > 0) ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!line) return DEFAULT_CHAT_TITLE;
  if (line.length <= FALLBACK_MAX) return line;
  const cut = line.slice(0, FALLBACK_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/** The small plan model used when the policy names none: a listed slug containing "luna" (05-RESEARCH A10). */
const PLAN_SMALL_MODEL = "luna";

/**
 * The model a title runs on, always on the chat's own backend:
 * - `chatgpt_plan` → `policy.titleModels.chatgpt_plan`, else a listed plan slug containing "luna", else the chat's;
 * - `org_key` → `policy.titleModels[provider]`, else the cheapest available allowed model of that provider by output
 *   price (unpriced models are never assumed cheap), else the chat's;
 * - `mock` → the mock.
 * Only models the owner can use right now (`listModels(…, ownerId)`, available) are picked.
 */
export async function pickTitleModel(
  tx: Tx,
  gateway: ModelGateway,
  chatRef: ModelRef,
  ownerId: string,
  policy: AiChatPolicy,
): Promise<ModelRef> {
  if (chatRef.backend === "mock") return chatRef;
  const listed = (await gateway.listModels(tx, ownerId)).models.filter((m) => m.available);
  if (chatRef.backend === "chatgpt_plan") {
    const plan = listed.filter((m) => m.ref.backend === "chatgpt_plan");
    const configured = policy.titleModels.chatgpt_plan;
    const pick =
      (configured ? plan.find((m) => m.ref.modelId === configured) : undefined) ??
      plan.find((m) => m.ref.modelId.includes(PLAN_SMALL_MODEL));
    return pick?.ref ?? chatRef;
  }
  const same = listed.filter((m) => m.ref.backend === "org_key" && m.ref.provider === chatRef.provider);
  const configured = policy.titleModels[chatRef.provider];
  const set = configured ? same.find((m) => m.ref.modelId === configured) : undefined;
  if (set) return set.ref;
  const priced = same
    .map((m) => ({ ref: m.ref, price: priceOf(m.ref.provider as ModelProviderKind, m.ref.modelId) }))
    .filter((p): p is { ref: ModelRef; price: NonNullable<typeof p.price> } => p.price !== null)
    .sort(
      (a, b) =>
        a.price.outputPerMTokUsd - b.price.outputPerMTokUsd ||
        a.price.inputPerMTokUsd - b.price.inputPerMTokUsd,
    );
  return priced[0]?.ref ?? chatRef;
}

export interface Titler {
  /** Starts the title job of a chat's first answer (call after the finalize committed); never throws. */
  schedule(organizationId: string, chatId: string, generationId: string): void;
  /** Resolves when every scheduled job finished (tests, shutdown). */
  idle(): Promise<void>;
  /** Aborts running calls and waits for them (module close). */
  close(): Promise<void>;
}

interface Prepared {
  gen: GenerationRow;
  ownerId: string;
  resolved: ResolvedModel;
  instructions: string;
  prompt: ModelMessage[];
  promptText: string;
}

/** `{code}` of an error for the log line: never its message or body (they may carry the prompt). */
const codeOf = (err: unknown): string =>
  err instanceof ModelUnavailableError
    ? `model_unavailable:${err.reason}`
    : err instanceof PlanTokenUnavailableError
      ? "usage_unavailable"
      : ((err as { name?: string })?.name ?? "unknown");

export function createTitler(core: Core, deps: { gateway: ModelGateway; timeoutMs?: number }): Titler {
  const timeoutMs = deps.timeoutMs ?? TITLE_TIMEOUT_MS;
  const running = new Set<Promise<void>>();
  const closing = new AbortController();

  /** Phase 1 (own tenant transaction): still heuristic, owner's generation, model and prompt resolved. */
  async function prepare(
    organizationId: string,
    chatId: string,
    generationId: string,
  ): Promise<Prepared | null> {
    return core.db.withTenant({ organizationId }, async (tx) => {
      const [chat] = await tx.select().from(aiChats).where(eq(aiChats.conversationId, chatId)).limit(1);
      if (chat?.titleSource !== "heuristic") return null;
      const [gen] = await tx.select().from(aiGenerations).where(eq(aiGenerations.id, generationId)).limit(1);
      // Only the owner's own answer, on the owner's own credential (T-05-10-03).
      if (!gen || gen.conversationId !== chatId || gen.requesterUserId !== chat.ownerUserId) return null;
      const rows = await tx
        .select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, chatId),
            isNull(messages.threadId),
            eq(messages.authorKind, "user"),
          ),
        )
        .orderBy(asc(messages.seq))
        .limit(20);
      const turns: PersistedTurn[] = rows.map((r) => ({
        id: r.id,
        role: "user",
        body: r.body,
        status: "sent",
        generationStatus: null,
        deleted: r.deletedAt !== null,
      }));
      const built = buildModelMessages({
        purpose: "title",
        rows: turns,
        viewer: { displayName: "", orgName: "", now: new Date() },
        chat: { instructions: "", usePersonalInstructions: false, humanMembers: 1 },
        personalInstructions: "",
        attachments: new Map(),
        maxContextTokens: 0,
      });
      if (built.messages.length === 0) return null;
      const policy = await loadAiChatPolicy(tx);
      const chatRef = { backend: gen.backend, provider: gen.provider, modelId: gen.modelId } as ModelRef;
      let ref = chatRef;
      try {
        ref = await pickTitleModel(tx, deps.gateway, chatRef, chat.ownerUserId, policy);
      } catch (err) {
        core.log.warn({ chatId, code: codeOf(err) }, "ai title model choice failed");
      }
      let resolved: ResolvedModel;
      try {
        resolved = await deps.gateway.resolve(tx, ref, chat.ownerUserId);
      } catch (err) {
        if (ref === chatRef) throw err;
        // The small model is not usable right now: the chat's own model, same backend and owner.
        resolved = await deps.gateway.resolve(tx, chatRef, chat.ownerUserId);
      }
      const promptText = [built.instructions, ...built.messages.map((m) => String(m.content))].join("\n");
      return {
        gen,
        ownerId: chat.ownerUserId,
        resolved,
        instructions: built.instructions,
        prompt: built.messages,
        promptText,
      };
    });
  }

  /** Phase 2 (no transaction): the model call under the deadline. */
  async function call(p: Prepared): Promise<{ text: string; usage: ReportedUsage | null }> {
    // A string id would route through the metered Vercel AI Gateway (P-04): never.
    if (typeof p.resolved.model === "string") throw new Error("model gateway returned a string model id");
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), closing.signal]);
    const result = streamText({
      model: p.resolved.model,
      instructions: p.instructions,
      messages: p.prompt,
      abortSignal: signal,
      maxRetries: 0,
      providerOptions: p.resolved.providerOptions,
      // The default handler console.error()s the error object, which carries the prompt (P-10).
      onError: () => {},
    });
    let text = "";
    let usage: ReportedUsage | null = null;
    let error: unknown = null;
    for await (const part of result.stream) {
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "finish") {
        usage = {
          inputTokens: part.totalUsage.inputTokens,
          outputTokens: part.totalUsage.outputTokens,
          cachedInputTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens,
          reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
        };
      } else if (part.type === "error") error ??= part.error;
      else if (part.type === "abort") error ??= new DOMException("aborted", "AbortError");
    }
    if (signal.aborted) throw new DOMException("title deadline", "TimeoutError");
    if (error !== null) throw error;
    return { text, usage };
  }

  /** Phase 3 (owner's tenant transaction): meter, validate, conditional update, announce. */
  async function store(
    organizationId: string,
    chatId: string,
    p: Prepared,
    out: { text: string; usage: ReportedUsage | null },
  ): Promise<void> {
    await core.db.withTenant({ organizationId, userId: p.ownerId }, async (tx) => {
      await recordUsage(tx, {
        generation: p.gen,
        kind: "title",
        model: p.resolved.ref,
        reported: out.usage,
        promptText: p.promptText,
        outputText: out.text,
      });
      const title = normalizeSessionTitle(out.text);
      const valid = title !== null && SessionTitle.safeParse(title).success;
      if (!valid || title === null) {
        core.log.info(
          { chatId, problems: title === null ? ["shape"] : titleProblems(title) },
          "ai title refused",
        );
        return;
      }
      const at = new Date().toISOString();
      // The one conditional update (ADR-0014): a title the member typed meanwhile is never replaced.
      const [chat] = await tx
        .update(aiChats)
        .set({ titleSource: "auto", updatedAt: at })
        .where(and(eq(aiChats.conversationId, chatId), eq(aiChats.titleSource, "heuristic")))
        .returning();
      if (!chat) return;
      const [conv] = await tx
        .update(conversations)
        .set({ name: title })
        .where(eq(conversations.id, chatId))
        .returning();
      if (!conv) return;
      const [live] = await tx
        .select({ id: aiGenerations.id })
        .from(aiGenerations)
        .where(and(eq(aiGenerations.conversationId, chatId), eq(aiGenerations.status, "running")))
        .limit(1);
      // The new title reaches every participant's sidebar, each with their own view (06-08).
      await emitChatUpdated(core, tx, conv, chat, { generating: live !== undefined, gateway: deps.gateway });
    });
  }

  async function run(organizationId: string, chatId: string, generationId: string): Promise<void> {
    let prepared: Prepared | null = null;
    try {
      prepared = await prepare(organizationId, chatId, generationId);
      if (!prepared) return;
      const out = await call(prepared);
      await store(organizationId, chatId, prepared, out);
    } catch (err) {
      const provider = prepared
        ? prepared.resolved.ref.backend === "chatgpt_plan"
          ? "chatgpt_plan"
          : prepared.resolved.ref.provider
        : null;
      const known =
        err instanceof DOMException ||
        err instanceof ModelUnavailableError ||
        err instanceof PlanTokenUnavailableError;
      const code = known ? codeOf(err) : deps.gateway.classify(err).code;
      core.log.warn({ chatId, provider, code }, "ai title failed");
    }
  }

  return {
    schedule(organizationId, chatId, generationId) {
      if (closing.signal.aborted) return;
      const job = run(organizationId, chatId, generationId).finally(() => running.delete(job));
      running.add(job);
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
    async close() {
      closing.abort();
      await this.idle();
    },
  };
}
