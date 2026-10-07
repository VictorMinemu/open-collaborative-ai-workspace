import {
  AiGenerationParams,
  EventTypes,
  IdParams,
  type ModelRef,
  RegenerateRequest,
  type SendAiMessageResponse,
  SendAiMessageResponse as SendAiMessageResponseSchema,
  StopAiGenerationResponse,
} from "@ocw/contracts";
import { aiChats, aiGenerations, messages, messageVersions, type Tx } from "@ocw/db";
import { and, count, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict, forbidden, notFound } from "../../lib/errors";
import { attachmentsForMessages } from "../artifact";
import { convTopic, createConversationAccess, lockNextSeq } from "../chat";
import { loadAiChatPolicy, type ModelGateway } from "../model-gateway";
import { channelResource, createPermissionService } from "../organization";
import { assertMessageReadableBy } from "./attachments";
import {
  aiMessage,
  chatSummary,
  directoryOf,
  EMPTY_DIRECTORY,
  type GenerationRow,
  generationDto,
  viewOf,
} from "./dto";
import { consumeGeneration, refuseOverLimit } from "./limits";
import type { RunLoop } from "./run-loop";
import { capOr429, createChatGuards, refuseArchived, resolveModelOr409 } from "./service";
import { backendClassOf } from "./usage";

/**
 * The generation lifecycle routes (05-06, D-05). Stop may land on any API instance: the route authorizes and
 * audits, then publishes `{organizationId, generationId}` on `ocw:ai:abort`; every instance listens and the one
 * holding the stream aborts it, which keeps the partial text (finalize `stopped`). The hint carries ids only and is
 * parsed defensively: a forged one can only end a generation early, and its text is kept (T-05-06-02).
 *
 * Regenerate (AICHAT-02/03) streams the chat's last answer again on the same message, with the previous model or
 * another one: in one transaction the replaced body goes to `message_versions` (kind `regenerate`, append-only),
 * the message is reset to an empty streaming answer and attempt N+1 starts (the one-running index still gates it).
 *
 * Shared chats (Phase 6, P-04, P-07): stop is for whoever can read the chat, but only the running generation's
 * requester or the owner may press it (403 `not_generation_requester`); regenerate needs `ai_chat.use` and is for the
 * owner or the requester of the answer's latest attempt (403 `not_answer_requester`). The new attempt is resolved for,
 * and paid by, the caller.
 */

export const ABORT_CHANNEL = "ocw:ai:abort";

const NOT_FOUND = "AI chat not found";
const GENERATION_NOT_FOUND = "Generation not found";
const IN_PROGRESS = "An answer is still being generated in this chat";
const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One `ai_generation.stopped` audit per generation even when Stop is pressed twice before it lands. */
const STOP_AUDITED_TTL_SECONDS = 600;
const stopAuditedKey = (generationId: string) => `ocw:ai:stop-audited:${generationId}`;

export interface AbortHint {
  organizationId: string;
  generationId: string;
}

/** The abort hint, or null for anything that is not exactly two UUIDs. */
export function parseAbortHint(raw: string): AbortHint | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.organizationId !== "string" || !UUID.test(o.organizationId)) return null;
  if (typeof o.generationId !== "string" || !UUID.test(o.generationId)) return null;
  return { organizationId: o.organizationId, generationId: o.generationId };
}

export async function registerGenerationRoutes(
  app: App,
  ctx: { core: Core; gateway: ModelGateway; runLoop: RunLoop },
): Promise<() => Promise<void>> {
  const { core, gateway, runLoop } = ctx;
  const access = createConversationAccess(core);
  const perms = createPermissionService(core);
  const tags = ["ai-chat"];

  const guards = createChatGuards(access, perms);
  /** The owner of the chat holds `ai_chat.manage` on it; nobody else does. */
  const manages = (req: FastifyRequest, tx: Tx, facts: Parameters<typeof channelResource>[0]) =>
    perms.can(req, tx, "ai_chat.manage", channelResource(facts));

  app.post(
    "/ai-chats/:id/generations/:gid/stop",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags, params: AiGenerationParams, response: { 202: StopAiGenerationResponse } },
    },
    async (req, reply) => {
      const { id, gid } = req.params;
      const out = await core.db.withTenant(tenant(req), async (tx, afterCommit) => {
        const { conv, facts } = await guards.readableChat(req, tx, id);
        const [gen] = await tx
          .select({
            id: aiGenerations.id,
            status: aiGenerations.status,
            requesterUserId: aiGenerations.requesterUserId,
          })
          .from(aiGenerations)
          .where(and(eq(aiGenerations.id, gid), eq(aiGenerations.conversationId, conv.id)))
          .limit(1);
        if (!gen) throw notFound(GENERATION_NOT_FOUND);
        if (gen.requesterUserId !== authOf(req).userId && !(await manages(req, tx, facts))) {
          throw forbidden(
            "Only the person who asked, or the chat's owner, can stop this answer",
            "not_generation_requester",
          );
        }
        if (gen.status !== "running") return { status: gen.status };
        const first = await core.bus.pub.set(stopAuditedKey(gen.id), "1", {
          NX: true,
          EX: STOP_AUDITED_TTL_SECONDS,
        });
        if (first === "OK") {
          await core.audit.record(tx, {
            action: "ai_generation.stopped",
            resourceType: "ai_chat",
            resourceId: conv.id,
            metadata: { conversationId: conv.id, generationId: gen.id },
          });
        }
        const hint: AbortHint = { organizationId: conv.organizationId, generationId: gen.id };
        afterCommit(() => core.bus.publish(ABORT_CHANNEL, JSON.stringify(hint)));
        return { status: gen.status };
      });
      return reply.status(202).send(out);
    },
  );

  const regenerateLimit = app.rateLimit({
    max: core.env.OCW_AI_SEND_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-regenerate:${req.auth?.userId ?? req.ip}`,
  });

  app.post(
    "/ai-chats/:id/regenerate",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: regenerateLimit,
      schema: {
        tags,
        params: IdParams,
        body: RegenerateRequest,
        response: { 201: SendAiMessageResponseSchema },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const body = req.body;
      const out = await core.db.withTenant(tenant(req), async (tx) => {
        const { conv, facts } = await guards.writableChat(req, tx, req.params.id);
        // An archived chat opens read-only (05-10).
        refuseArchived(conv);
        const topic = convTopic(conv.id);
        // Serializes with sends and other regenerates of this chat.
        await lockNextSeq(tx, topic);
        const [busy] = await tx
          .select({ id: aiGenerations.id })
          .from(aiGenerations)
          .where(and(eq(aiGenerations.conversationId, conv.id), eq(aiGenerations.status, "running")))
          .limit(1);
        if (busy) throw conflict(IN_PROGRESS, "generation_in_progress");

        const [last] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conv.id),
              isNull(messages.threadId),
              ne(messages.authorKind, "system"),
            ),
          )
          .orderBy(desc(messages.seq))
          .limit(1)
          .for("update");
        if (last?.authorKind !== "agent") {
          throw conflict("There is no answer to regenerate", "nothing_to_regenerate");
        }
        if (body.messageId && body.messageId !== last.id) {
          throw conflict("Only the last answer can be regenerated", "not_last_answer");
        }
        const [prev] = await tx
          .select()
          .from(aiGenerations)
          .where(eq(aiGenerations.assistantMessageId, last.id))
          .orderBy(desc(aiGenerations.attempt))
          .limit(1);
        const [userRow] = await tx
          .select()
          .from(messages)
          .where(
            prev?.userMessageId
              ? eq(messages.id, prev.userMessageId)
              : and(
                  eq(messages.conversationId, conv.id),
                  isNull(messages.threadId),
                  eq(messages.authorKind, "user"),
                  lt(messages.seq, last.seq),
                ),
          )
          .orderBy(desc(messages.seq))
          .limit(1);
        if (!prev || !userRow) throw conflict("There is no answer to regenerate", "nothing_to_regenerate");
        // P-04: the owner, or whoever asked for this answer's latest attempt; the caller pays (P-07).
        if (prev.requesterUserId !== auth.userId && !(await manages(req, tx, facts))) {
          throw forbidden(
            "Only the person who asked, or the chat's owner, can regenerate this answer",
            "not_answer_requester",
          );
        }

        const ref =
          body.model ??
          ({ backend: prev.backend, provider: prev.provider, modelId: prev.modelId } as ModelRef);
        const resolved = await resolveModelOr409(gateway, tx, ref, auth.userId);
        // The question's files must be readable by the model that answers again (05-12).
        await assertMessageReadableBy(tx, userRow.id, resolved.caps, resolved.label);
        const policy = await loadAiChatPolicy(tx);
        await capOr429(tx, auth.userId, policy.concurrentGenerationsPerUser);
        // A regenerate is an answer too: it counts against the same daily cap (05-08), before anything changes.
        const limit = { userId: auth.userId, backendClass: backendClassOf(resolved.ref.backend) };
        const counted = await consumeGeneration(tx, { ...limit, policy });
        if (!counted.ok) return { refused: await refuseOverLimit(core, tx, counted, limit) };

        // The replaced answer, append-only (T-05-06-03), before the message is reset.
        const [versions] = await tx
          .select({ n: count() })
          .from(messageVersions)
          .where(eq(messageVersions.messageId, last.id));
        await tx.insert(messageVersions).values({
          organizationId: last.organizationId,
          messageId: last.id,
          version: Number(versions?.n ?? 0) + 1,
          kind: "regenerate",
          body: last.body,
          mentions: last.mentions,
          editedByKind: "user",
          editedBy: auth.userId,
        });
        const [row] = await tx
          .update(messages)
          .set({ body: "", status: "streaming" })
          .where(eq(messages.id, last.id))
          .returning();
        if (!row) throw new Error("assistant message missing at regenerate");
        let gen: GenerationRow | undefined;
        try {
          [gen] = await tx
            .insert(aiGenerations)
            .values({
              organizationId: conv.organizationId,
              conversationId: conv.id,
              userMessageId: userRow.id,
              assistantMessageId: last.id,
              requesterUserId: auth.userId,
              backend: resolved.ref.backend,
              provider: resolved.ref.provider,
              modelId: resolved.ref.modelId,
              attempt: prev.attempt + 1,
              status: "running",
              instanceId: runLoop.instanceId,
            })
            .returning();
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict(IN_PROGRESS, "generation_in_progress");
          throw err;
        }
        if (!gen) throw new Error("generation insert returned no row");

        const generation = generationDto(gen, null, gateway);
        const assistantMessage = aiMessage(row, EMPTY_DIRECTORY, generation);
        await core.realtime.appendEvent(tx, topic, EventTypes.messageUpdated, { message: assistantMessage });
        const at = new Date().toISOString();
        const [chat] = await tx
          .update(aiChats)
          .set({ lastModel: resolved.ref, lastActivityAt: at, updatedAt: at })
          .where(eq(aiChats.conversationId, conv.id))
          .returning();
        if (!chat) throw notFound(NOT_FOUND);
        const summary = chatSummary(conv, chat, {
          generating: true,
          gateway,
          view: await viewOf(tx, chat, chat.ownerUserId),
        });
        await core.realtime.appendEvent(tx, `user:${chat.ownerUserId}`, EventTypes.aiChatUpdated, {
          chat: summary,
        });
        // Ids, backend, provider, model and attempt only: never a body.
        await core.audit.record(tx, {
          action: "ai_chat.regenerated",
          resourceType: "ai_chat",
          resourceId: conv.id,
          metadata: {
            conversationId: conv.id,
            messageId: last.id,
            generationId: gen.id,
            backend: gen.backend,
            provider: gen.provider,
            modelId: gen.modelId,
            attempt: gen.attempt,
          },
        });
        const dir = await directoryOf(tx, [userRow.authorId ?? ""]);
        const files = (await attachmentsForMessages(tx, [userRow.id])).get(userRow.id) ?? [];
        const response: SendAiMessageResponse = {
          chat:
            auth.userId === chat.ownerUserId
              ? summary
              : chatSummary(conv, chat, {
                  generating: true,
                  gateway,
                  view: await viewOf(tx, chat, auth.userId),
                }),
          userMessage: aiMessage(userRow, dir, undefined, files),
          assistantMessage,
          generation,
        };
        return { response, start: gen };
      });
      // The refusal's audit row is committed; the answer and its versions are untouched.
      if ("refused" in out) throw out.refused;
      runLoop.start({ organizationId: out.start.organizationId, generationId: out.start.id });
      return reply.status(201).send(out.response);
    },
  );

  // Every instance: abort the generation if this process holds it (the others ignore the hint).
  return core.bus.subscribe(ABORT_CHANNEL, (raw) => {
    const hint = parseAbortHint(raw);
    if (hint) runLoop.abort(hint.generationId, "stop");
  });
}
