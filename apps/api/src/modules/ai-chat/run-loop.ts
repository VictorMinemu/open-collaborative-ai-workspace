import { randomUUID } from "node:crypto";
import {
  AI_DELTA_COALESCE_MS,
  AI_HEARTBEAT_MS,
  AI_PARTIAL_FLUSH_MS,
  type AiDeltaEvent,
  type AiErrorCode,
  type AiGeneration,
  type AiGenerationStatus,
  type AiUsage,
  EphemeralTypes,
  EventTypes,
  type ModelRef,
} from "@ocw/contracts";
import { aiChats, aiGenerations, conversations, messages, type Tx } from "@ocw/db";
import { streamText } from "ai";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { convTopic } from "../chat";
import { createPermissionService } from "../organization";
import {
  type ClassifiedModelError,
  loadAiChatPolicy,
  type ModelGateway,
  ModelUnavailableError,
  PlanTokenUnavailableError,
  type ResolvedModel,
} from "../model-gateway";
import { aiMessage, chatSummary, EMPTY_DIRECTORY, type GenerationRow, generationDto } from "./dto";
import { loadTurn, type Turn } from "./turn";
import { type ReportedUsage, recordUsage } from "./usage";

/**
 * One run loop for every backend (P-06, P-07): `streamText` on the gateway's provider instance with the prompt
 * `buildModelMessages` built from persisted rows (turn.ts). Deltas are coalesced every 50 ms into ephemeral
 * `ai.delta` frames on `conv:<id>` (offset = UTF-16 length already emitted); partial text is flushed to
 * `ai_generations.partial_text` every second (never to `messages.body`); one finalize transaction writes the body,
 * the generation outcome, exactly one usage record and the durable `message.updated`.
 *
 * Provider errors are logged as `{code, status, provider}` only: AI SDK errors carry the request body (P-10).
 *
 * Web search (05-11): `source` parts (URL citations of the plan's hosted search) and the SearXNG tool's results
 * give the answer's source domains (hostnames, deduplicated, at most 20); `web_search` tool calls count the
 * searches. None of them is ever published as a delta: only answer text streams. At finalize the generation records
 * `web_used` / `source_domains` and, when the web was used, `ai_generation.web_used` is audited (domains only).
 */

export type AfterFinalize = (
  tx: Tx,
  done: {
    chatId: string;
    generation: AiGeneration;
    ref: ModelRef;
    requesterUserId: string;
    firstAnswer: boolean;
  },
) => Promise<void>;

export interface RunLoop {
  start(job: { organizationId: string; generationId: string }): void;
  /** Aborts a generation this instance holds; false when it is not running here. */
  abort(generationId: string, reason: "stop" | "shutdown"): boolean;
  onAfterFinalize(fn: AfterFinalize): void;
  running(): number;
  /** The text produced so far by a generation this instance holds (snapshots), else null. */
  textOf(generationId: string): string | null;
  /**
   * Finalizes a generation no process streams anymore (its heartbeat is older than `staleBefore`) as
   * `interrupted`, keeping its last flushed `partial_text` (the sweeper, 05-06). False when it is not running and
   * stale anymore, or when this process holds it.
   */
  finalizeStale(organizationId: string, generationId: string, staleBefore: Date): Promise<boolean>;
  shutdown(): Promise<void>;
  readonly instanceId: string;
}

/** AiDeltaEvent.text max. */
const DELTA_MAX = 16_000;
/** `ai_generations.source_domains` / `AiGeneration.sourceDomains` max. */
const SOURCE_DOMAINS_MAX = 20;

/** What the web contributed to one answer (05-11). */
export interface WebActivity {
  searches: number;
  domains: string[];
}

/** The hostname of a URL a source points at (lowercased, `www.` dropped), or null when it is not http(s). */
export function sourceDomain(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./u, "");
    return host && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

/** Collects the domains (≤ 20, first seen first) and searches of one answer. */
export function webCollector() {
  const domains = new Set<string>();
  let searches = 0;
  return {
    addUrl(url: string) {
      const d = sourceDomain(url);
      if (d && domains.size < SOURCE_DOMAINS_MAX) domains.add(d);
    },
    addSearch() {
      searches++;
    },
    get(): WebActivity {
      return { searches, domains: [...domains] };
    },
  };
}

interface Active {
  controller: AbortController;
  /** The answer so far; frozen once the controller fires (later provider deltas are dropped). */
  text: string;
  reason: "stop" | "shutdown" | null;
  /** Publishes the not-yet-sent tail as `ai.delta` (set once streaming starts); called right before an abort. */
  flushDeltas: (() => void) | null;
  done: Promise<void>;
  /** Set once prepared: what a crash fail-safe needs to finalize the generation as failed. */
  prepared: { gen: GenerationRow; ref: ModelRef; turn: Turn } | null;
}

interface Outcome {
  status: AiGenerationStatus;
  finishReason: string | null;
  error: ClassifiedModelError | null;
  usage: ReportedUsage | null;
  /** Absent = the web was not used. */
  web?: WebActivity;
}

/** Text of a built prompt for the usage estimate (attachments count nothing here). */
function promptText(turn: Turn): string {
  const parts: string[] = [turn.instructions];
  for (const m of turn.messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else
      for (const p of m.content as Array<{ type: string; text?: string }>)
        if (p.type === "text") parts.push(p.text ?? "");
  }
  return parts.join("\n");
}

/** Sums the usage of finished steps (undefined counts stay undefined: the record is then estimated). */
function addUsage(
  acc: ReportedUsage | null,
  u: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    inputTokenDetails?: { cacheReadTokens?: number | undefined };
    outputTokenDetails?: { reasoningTokens?: number | undefined };
  },
): ReportedUsage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? undefined : a + b;
  const next: ReportedUsage = {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens,
  };
  if (!acc) return next;
  return {
    inputTokens: sum(acc.inputTokens, next.inputTokens),
    outputTokens: sum(acc.outputTokens, next.outputTokens),
    cachedInputTokens: sum(acc.cachedInputTokens, next.cachedInputTokens),
    reasoningTokens: sum(acc.reasoningTokens, next.reasoningTokens),
  };
}

const unavailableCode = (e: ModelUnavailableError): AiErrorCode =>
  e.reason === "not_connected" ? "not_connected" : "model_unavailable";

export function createRunLoop(core: Core, deps: { gateway: ModelGateway; now?: () => Date }): RunLoop {
  const instanceId = randomUUID();
  const now = deps.now ?? (() => new Date());
  const active = new Map<string, Active>();
  const listeners: AfterFinalize[] = [];
  const perms = createPermissionService(core);

  async function prepare(organizationId: string, generationId: string) {
    const orgName = (await core.identity.organizationName(organizationId)) ?? "your organization";
    return core.db.withTenant({ organizationId }, async (tx) => {
      const [gen] = await tx.select().from(aiGenerations).where(eq(aiGenerations.id, generationId)).limit(1);
      if (gen?.status !== "running" || gen.instanceId !== instanceId) return null;
      const policy = await loadAiChatPolicy(tx);
      const ref = { backend: gen.backend, provider: gen.provider, modelId: gen.modelId } as ModelRef;
      let resolved: ResolvedModel;
      try {
        resolved = await deps.gateway.resolve(tx, ref, gen.requesterUserId);
      } catch (err) {
        if (err instanceof ModelUnavailableError || err instanceof PlanTokenUnavailableError) {
          const turn = await loadTurn(tx, gen, { orgName, now: now(), policy });
          return { gen, turn, ref, unavailable: err };
        }
        throw err;
      }
      // Tools are decided here, per turn, for the requester and the resolved model (05-11).
      const turn = await loadTurn(tx, gen, { orgName, now: now(), policy, tools: { resolved, perms } });
      return { gen, turn, ref, resolved };
    });
  }

  async function finalize(
    organizationId: string,
    gen: GenerationRow,
    ref: ModelRef,
    text: string,
    outcome: Outcome,
    turn: Turn | null,
  ): Promise<void> {
    await core.db.withTenant({ organizationId, userId: gen.requesterUserId }, (tx) =>
      finalizeIn(tx, gen, ref, text, outcome, turn),
    );
  }

  /** The one finalize: generation outcome, message body + status, one usage record, the durable events. */
  async function finalizeIn(
    tx: Tx,
    gen: GenerationRow,
    ref: ModelRef,
    text: string,
    outcome: Outcome,
    turn: Turn | null,
  ): Promise<boolean> {
    const finishedAt = now().toISOString();
    const [g] = await tx
      .update(aiGenerations)
      .set({
        status: outcome.status,
        finishReason: outcome.finishReason,
        errorCode: outcome.error?.code ?? null,
        errorParam: outcome.error?.param ?? null,
        partialText: text,
        truncated: turn?.truncated ?? false,
        webUsed: outcome.web !== undefined,
        sourceDomains: outcome.web?.domains.slice(0, SOURCE_DOMAINS_MAX) ?? [],
        heartbeatAt: finishedAt,
        finishedAt,
      })
      .where(and(eq(aiGenerations.id, gen.id), eq(aiGenerations.status, "running")))
      .returning();
    // Someone else finalized it (the sweeper, 05-06): their outcome stands.
    if (!g) return false;
    const [row] = await tx
      .update(messages)
      .set({ body: text, status: outcome.status === "failed" ? "failed" : "completed" })
      .where(eq(messages.id, g.assistantMessageId))
      .returning();
    if (!row) throw new Error("assistant message missing at finalize");
    const usage: AiUsage = await recordUsage(tx, {
      generation: g,
      kind: "chat",
      reported: outcome.usage,
      promptText: turn ? promptText(turn) : "",
      outputText: text,
    });
    if (outcome.error) await deps.gateway.reportFailure(tx, ref, g.requesterUserId, outcome.error);
    if (outcome.web) {
      // Domains and counts only: never a query, a URL path or result text (05-11).
      await core.audit.record(tx, {
        action: "ai_generation.web_used",
        resourceType: "ai_chat",
        resourceId: g.conversationId,
        actorKind: "user",
        userId: g.requesterUserId,
        metadata: { generationId: g.id, domains: outcome.web.domains, searches: outcome.web.searches },
      });
    }
    const [chat] = await tx
      .update(aiChats)
      .set({ lastActivityAt: finishedAt, updatedAt: finishedAt })
      .where(eq(aiChats.conversationId, g.conversationId))
      .returning();
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, g.conversationId))
      .limit(1);
    const generation = generationDto(g, usage, deps.gateway);
    await core.realtime.appendEvent(tx, convTopic(g.conversationId), EventTypes.messageUpdated, {
      message: aiMessage(row, EMPTY_DIRECTORY, generation),
    });
    if (chat && conv) {
      await core.realtime.appendEvent(tx, `user:${chat.ownerUserId}`, EventTypes.aiChatUpdated, {
        chat: chatSummary(conv, chat, { generating: false, gateway: deps.gateway }),
      });
    }
    const [earlier] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(aiGenerations)
      .where(
        and(
          eq(aiGenerations.conversationId, g.conversationId),
          eq(aiGenerations.status, "completed"),
          ne(aiGenerations.id, g.id),
        ),
      );
    const done = {
      chatId: g.conversationId,
      generation,
      ref,
      requesterUserId: g.requesterUserId,
      firstAnswer: outcome.status === "completed" && (earlier?.n ?? 0) === 0,
    };
    for (const fn of listeners) await fn(tx, done);
    return true;
  }

  async function run(job: { organizationId: string; generationId: string }, entry: Active): Promise<void> {
    const prep = await prepare(job.organizationId, job.generationId);
    if (!prep) return;
    const { gen, turn, ref } = prep;
    entry.prepared = { gen, ref, turn };
    if ("unavailable" in prep && prep.unavailable) {
      const e = prep.unavailable;
      await finalize(
        job.organizationId,
        gen,
        ref,
        "",
        {
          status: "failed",
          finishReason: null,
          error: {
            code: e instanceof ModelUnavailableError ? unavailableCode(e) : "usage_unavailable",
            param: e instanceof ModelUnavailableError ? e.reason : null,
            status: null,
            credentialState: null,
            retryable: false,
          },
          usage: null,
        },
        turn,
      );
      return;
    }
    const resolved = (prep as { resolved: ResolvedModel }).resolved;
    // A string model id would route through the metered Vercel AI Gateway (P-04): never.
    if (typeof resolved.model === "string") throw new Error("model gateway returned a string model id");

    const topic = convTopic(gen.conversationId);
    let emitted = 0;
    let flushedLength = 0;
    let lastWrite = Date.now();
    let publishing: Promise<void> = Promise.resolve();
    let writing: Promise<void> = Promise.resolve();

    const publishPending = () => {
      while (emitted < entry.text.length) {
        const chunk = entry.text.slice(emitted, emitted + DELTA_MAX);
        const delta: AiDeltaEvent = {
          conversationId: gen.conversationId,
          messageId: gen.assistantMessageId,
          generationId: gen.id,
          offset: emitted,
          text: chunk,
        };
        emitted += chunk.length;
        publishing = publishing
          .then(() => core.realtime.publishEphemeral(topic, EphemeralTypes.aiDelta, delta))
          .catch(() => {});
      }
    };
    const writePartial = (heartbeatOnly: boolean) => {
      const text = entry.text;
      lastWrite = Date.now();
      flushedLength = text.length;
      writing = writing
        .then(() =>
          core.db.withTenant({ organizationId: job.organizationId }, async (tx) => {
            await tx
              .update(aiGenerations)
              .set({ heartbeatAt: new Date().toISOString(), ...(heartbeatOnly ? {} : { partialText: text }) })
              .where(and(eq(aiGenerations.id, gen.id), eq(aiGenerations.status, "running")));
          }),
        )
        .catch((err: unknown) => {
          core.log.warn(
            { generationId: gen.id, code: (err as { code?: string })?.code },
            "partial flush failed",
          );
        });
    };
    let lastFlushCheck = Date.now();
    const timer = setInterval(() => {
      publishPending();
      const t = Date.now();
      if (t - lastFlushCheck >= AI_PARTIAL_FLUSH_MS) {
        lastFlushCheck = t;
        if (entry.text.length !== flushedLength) writePartial(false);
        else if (t - lastWrite >= AI_HEARTBEAT_MS) writePartial(true);
      }
    }, AI_DELTA_COALESCE_MS);
    timer.unref();
    // An abort publishes the tail it has now and freezes the text: no delta is ever sent after the controller
    // fires, so what the browser saw equals the body that finalize persists.
    entry.flushDeltas = publishPending;

    let error: unknown = null;
    let aborted = false;
    let usage: ReportedUsage | null = null;
    /** Usage of the steps that finished before an abort (Pitfall 3); null when none did. */
    let stepUsage: ReportedUsage | null = null;
    let finishReason: string | null = null;
    const web = webCollector();
    try {
      const result = streamText({
        model: resolved.model,
        instructions: turn.instructions,
        messages: turn.messages,
        ...(turn.tools ? { tools: turn.tools, stopWhen: turn.stopWhen } : {}),
        abortSignal: entry.controller.signal,
        maxRetries: resolved.maxRetries,
        providerOptions: resolved.providerOptions,
        // The default handler console.error()s the error object, which carries the prompt (P-10).
        onError: () => {},
      });
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          if (!entry.controller.signal.aborted) entry.text += part.text;
        } else if (part.type === "source") {
          // Citations of the hosted search: their hostnames only, never published.
          if (part.sourceType === "url") web.addUrl(part.url);
        } else if (part.type === "tool-call") {
          if (part.toolName === "web_search") web.addSearch();
        } else if (part.type === "finish-step") {
          stepUsage = addUsage(stepUsage, part.usage);
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = {
            inputTokens: part.totalUsage.inputTokens,
            outputTokens: part.totalUsage.outputTokens,
            cachedInputTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens,
            reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
          };
        } else if (part.type === "error") error ??= part.error;
        else if (part.type === "abort") aborted = true;
      }
    } catch (err) {
      if (entry.controller.signal.aborted) aborted = true;
      else error ??= err;
    } finally {
      clearInterval(timer);
    }
    publishPending();
    await publishing;
    await writing;

    const activity = web.get();
    const webUsed = activity.searches > 0 || activity.domains.length > 0 ? { web: activity } : {};
    let outcome: Outcome;
    if (aborted || entry.controller.signal.aborted) {
      const shutdown = entry.reason !== "stop";
      outcome = {
        status: shutdown ? "interrupted" : "stopped",
        finishReason: "abort",
        error: shutdown ? deps.gateway.classify(new DOMException("aborted", "AbortError")) : null,
        // Provider counts arrive with the last event, so an aborted stream usually has none: estimated then.
        usage: usage ?? stepUsage,
        ...webUsed,
      };
    } else if (error !== null) {
      const classified = deps.gateway.classify(error);
      core.log.warn(
        {
          code: classified.code,
          status: classified.status,
          provider: ref.backend === "chatgpt_plan" ? "chatgpt_plan" : ref.provider,
        },
        "ai generation failed",
      );
      outcome = { status: "failed", finishReason: finishReason ?? "error", error: classified, usage, ...webUsed };
    } else {
      outcome = { status: "completed", finishReason, error: null, usage, ...webUsed };
    }
    await finalize(job.organizationId, gen, ref, entry.text, outcome, turn);
  }

  /**
   * A crash between prepare and finalize must not leave the generation running: fail it and keep its text.
   * Idempotent: finalize only touches a generation that is still `running`.
   */
  async function failSafe(organizationId: string, entry: Active): Promise<void> {
    if (!entry.prepared) return;
    const { gen, ref, turn } = entry.prepared;
    const error: ClassifiedModelError = {
      code: "provider_error",
      param: null,
      status: null,
      credentialState: null,
      retryable: false,
    };
    await finalize(
      organizationId,
      gen,
      ref,
      entry.text,
      { status: "failed", finishReason: "error", error, usage: null },
      turn,
    );
  }

  const loop: RunLoop = {
    instanceId,
    start(job) {
      if (active.has(job.generationId)) return;
      const entry: Active = {
        controller: new AbortController(),
        text: "",
        reason: null,
        flushDeltas: null,
        done: Promise.resolve(),
        prepared: null,
      };
      active.set(job.generationId, entry);
      entry.done = run(job, entry)
        .catch((err: unknown) => {
          // Never the error object: it may carry the prompt.
          core.log.error(
            { generationId: job.generationId, name: (err as Error)?.name ?? "unknown" },
            "ai run loop failed",
          );
          return failSafe(job.organizationId, entry).catch(() => {});
        })
        .finally(() => {
          active.delete(job.generationId);
        });
    },
    abort(generationId, reason) {
      const entry = active.get(generationId);
      if (!entry) return false;
      entry.reason ??= reason;
      if (!entry.controller.signal.aborted) entry.flushDeltas?.();
      entry.controller.abort(reason);
      return true;
    },
    onAfterFinalize(fn) {
      listeners.push(fn);
    },
    running: () => active.size,
    textOf: (generationId) => active.get(generationId)?.text ?? null,
    async finalizeStale(organizationId, generationId, staleBefore) {
      if (active.has(generationId)) return false;
      const orgName = (await core.identity.organizationName(organizationId)) ?? "your organization";
      return core.db.withTenant({ organizationId }, async (tx) => {
        const [gen] = await tx
          .select()
          .from(aiGenerations)
          .where(
            and(
              eq(aiGenerations.id, generationId),
              eq(aiGenerations.status, "running"),
              lt(aiGenerations.heartbeatAt, staleBefore.toISOString()),
            ),
          )
          .for("update");
        if (!gen) return false;
        // The prompt is rebuilt only to estimate the input tokens of the estimated usage record.
        const turn = await loadTurn(tx, gen, { orgName, now: now(), policy: await loadAiChatPolicy(tx) });
        const ref = { backend: gen.backend, provider: gen.provider, modelId: gen.modelId } as ModelRef;
        const error = deps.gateway.classify(new DOMException("interrupted", "AbortError"));
        return finalizeIn(
          tx,
          gen,
          ref,
          gen.partialText,
          { status: "interrupted", finishReason: null, error, usage: null },
          turn,
        );
      });
    },
    async shutdown() {
      for (const [id] of active) loop.abort(id, "shutdown");
      await Promise.allSettled([...active.values()].map((e) => e.done));
    },
  };
  return loop;
}
