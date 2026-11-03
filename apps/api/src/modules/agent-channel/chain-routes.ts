import { AgentChainCancelResponse, IdParams } from "@ocw/contracts";
import { agentChains, conversations } from "@ocw/db";
import { eq } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError, notFound } from "../../lib/errors";
import { channelFacts } from "../chat";
import { channelResource, type PermissionService } from "../organization";
import { cancelChain } from "./chains";

/**
 * Stop (Phase 07.7-06; A2A-02, A2A-03; D-04, P-14; ADR-0027): `POST /api/v1/agent-chains/:id/cancel`, a person stops an
 * agent-to-agent chain in a thread they read. Who may: the chain's human (the person every hop works and pays for) or
 * a moderator of that channel (`message.delete_any`, decided by the resolver on the channel's facts: admins, never in a
 * direct conversation). Anyone else who reads the thread is refused 403 `not_chain_owner`; a chain of a conversation the
 * caller cannot read, of another organization (RLS) or that does not exist is 404 `chain_not_found` (existence hidden).
 * Idempotent: a stopped or completed chain answers its state and audits nothing more.
 */

const tags = ["agent-channel"];
const NOT_FOUND = "Chain not found";

export function registerChainUserRoutes(app: App, core: Core, perms: PermissionService): void {
  app.register(
    async (raw) => {
      // Child scopes lose the Zod type provider in their inferred type; restore it.
      const scope = raw as unknown as App;
      scope.post(
        "/agent-chains/:id/cancel",
        {
          config: { authz: "user" as const },
          preHandler: core.identity.requireUser,
          schema: { tags, params: IdParams, response: { 200: AgentChainCancelResponse } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { userId } = authOf(req);
            const [chain] = await tx
              .select()
              .from(agentChains)
              .where(eq(agentChains.id, req.params.id))
              .limit(1);
            if (!chain) throw notFound(NOT_FOUND, "chain_not_found");
            // A thread is read through its channel (single-level threads); chains live only in channels (v1).
            const [conv] = await tx
              .select()
              .from(conversations)
              .where(eq(conversations.id, chain.conversationId))
              .limit(1);
            const judgedId = conv?.kind === "thread" ? conv.parentConversationId : (conv?.id ?? null);
            const [judged] = judgedId
              ? await tx.select().from(conversations).where(eq(conversations.id, judgedId)).limit(1)
              : [];
            if (judged?.kind !== "channel") throw notFound(NOT_FOUND, "chain_not_found");
            // The resolver, for this request: the caller reads the channel (else the chain does not exist for them)…
            const channel = channelResource(await channelFacts(tx, judged, { kind: "user", id: userId }));
            if (!(await perms.can(req, tx, "channel.read", channel)))
              throw notFound(NOT_FOUND, "chain_not_found");
            // …and is the chain's human, or moderates the channel.
            if (chain.humanUserId !== userId) {
              if (!(await perms.can(req, tx, "message.delete_any", channel))) {
                throw new HttpError(
                  403,
                  "not_chain_owner",
                  "Only the person this chain works for or a channel moderator can stop it",
                );
              }
            }
            await cancelChain(tx, { core }, chain.id, { byUserId: userId, reason: "user" });
            const [after] = await tx
              .select({ status: agentChains.status })
              .from(agentChains)
              .where(eq(agentChains.id, chain.id))
              .limit(1);
            return { chainId: chain.id, status: after?.status ?? chain.status };
          }),
      );
    },
    { prefix: "/api/v1" },
  );
}
