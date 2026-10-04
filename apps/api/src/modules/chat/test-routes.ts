import { AgentUsername, Id, MessageBody } from "@ocw/contracts";
import { agents } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import { createPermissionService } from "../organization";

/**
 * TEST-ONLY routes (registered only when NODE_ENV=test): let E2E specs exercise the chat side of the bridge
 * without OpenClaw — seed a bot, simulate its typing/reply, and read the mentions chat emitted.
 * Never mounted in development or production builds.
 */
export function registerChatTestRoutes(app: App, core: Core): void {
  const captured: AgentMention[] = [];
  core.chatAgent.onAgentMention(async (_tx, mention) => {
    captured.push(mention);
    if (captured.length > 200) captured.shift();
  });

  const hide = { hide: true, tags: ["test"] };
  // Test-only, but still decided: any signed-in member of the organization (org.read).
  const perms = createPermissionService(core);
  const preHandler = [core.identity.requireUser, perms.requirePermission("org.read")];

  app.post(
    "/test/chat/agents",
    {
      config: { authz: "user" },
      preHandler,
      schema: {
        ...hide,
        body: z.object({
          name: z.string().min(1).max(80),
          username: AgentUsername,
          avatarUrl: z.string().max(200).optional(),
        }),
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const [existing] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.username, req.body.username)))
          .limit(1);
        if (existing) return { id: existing.id };
        const [row] = await tx
          .insert(agents)
          .values({
            organizationId: auth.organizationId,
            name: req.body.name,
            username: req.body.username,
            avatarUrl: req.body.avatarUrl ?? null,
            instructions: "Test bot",
            modelProvider: "mock",
            modelId: "mock-1",
            status: "ready",
            createdBy: auth.userId,
          })
          .returning({ id: agents.id });
        return { id: row?.id };
      }),
  );

  app.post(
    "/test/chat/agent-reply",
    {
      config: { authz: "user" },
      preHandler,
      schema: {
        ...hide,
        body: z.object({
          agentId: Id,
          conversationId: Id,
          threadRootId: Id.nullable().optional(),
          body: MessageBody,
          idempotencyKey: z.string().min(1).max(64),
        }),
      },
    },
    async (req) =>
      core.chatAgent.postAgentMessage(
        { organizationId: authOf(req).organizationId, userId: null },
        { ...req.body, threadRootId: req.body.threadRootId ?? null },
      ),
  );

  app.post(
    "/test/chat/agent-typing",
    {
      config: { authz: "user" },
      preHandler,
      schema: {
        ...hide,
        body: z.object({ agentId: Id, conversationId: Id, threadRootId: Id.nullable().optional() }),
      },
    },
    async (req) => {
      await core.chatAgent.agentTyping(
        { organizationId: authOf(req).organizationId, userId: null },
        req.body.agentId,
        req.body.conversationId,
        req.body.threadRootId ?? null,
      );
      return { ok: true };
    },
  );

  app.get("/test/chat/mentions", { config: { authz: "user" }, preHandler, schema: hide }, async (req) => ({
    mentions: captured.filter((m) => m.organizationId === authOf(req).organizationId),
  }));
}
