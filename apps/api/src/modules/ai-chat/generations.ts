import { AiGenerationParams, StopAiGenerationResponse } from "@ocw/contracts";
import { aiGenerations, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, type Core, tenant } from "../../core";
import { notFound } from "../../lib/errors";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { channelResource, createPermissionService } from "../organization";
import type { RunLoop } from "./run-loop";

/**
 * The generation lifecycle routes (05-06, D-05). Stop may land on any API instance: the route authorizes and
 * audits, then publishes `{organizationId, generationId}` on `ocw:ai:abort`; every instance listens and the one
 * holding the stream aborts it, which keeps the partial text (finalize `stopped`). The hint carries ids only and is
 * parsed defensively: a forged one can only end a generation early, and its text is kept (T-05-06-02).
 */

export const ABORT_CHANNEL = "ocw:ai:abort";

const NOT_FOUND = "AI chat not found";
const GENERATION_NOT_FOUND = "Generation not found";
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
  const { core, runLoop } = ctx;
  const access = createConversationAccess(core);
  const perms = createPermissionService(core);
  const tags = ["ai-chat"];

  /** The chat if the caller owns it (hidden = 404 for everyone else, admins included). */
  async function ownedChat(req: FastifyRequest, tx: Tx, chatId: string) {
    const { conv, facts } = await access.readable(req, tx, chatId, {
      kinds: ["ai_chat"],
      notFoundMessage: NOT_FOUND,
    });
    await perms.assertCan(req, tx, "ai_chat.use", channelResource(facts), { hideAs404: true });
    return conv;
  }

  app.post(
    "/ai-chats/:id/generations/:gid/stop",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: AiGenerationParams, response: { 202: StopAiGenerationResponse } },
    },
    async (req, reply) => {
      const { id, gid } = req.params;
      const out = await core.db.withTenant(tenant(req), async (tx, afterCommit) => {
        const conv = await ownedChat(req, tx, id);
        const [gen] = await tx
          .select({ id: aiGenerations.id, status: aiGenerations.status })
          .from(aiGenerations)
          .where(and(eq(aiGenerations.id, gid), eq(aiGenerations.conversationId, conv.id)))
          .limit(1);
        if (!gen) throw notFound(GENERATION_NOT_FOUND);
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

  // Every instance: abort the generation if this process holds it (the others ignore the hint).
  return core.bus.subscribe(ABORT_CHANNEL, (raw) => {
    const hint = parseAbortHint(raw);
    if (hint) runLoop.abort(hint.generationId, "stop");
  });
}
