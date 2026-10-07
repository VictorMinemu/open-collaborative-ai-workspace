import { AiChatPolicy, AiModelList, aiToolStates, UpdateAiChatPolicyRequest } from "@ocw/contracts";
import { type App, authOf, type Core, tenant } from "../../core";
import { createPermissionService, orgResource } from "../organization";
import type { ModelGateway } from "./index";
import { loadAiChatPolicy, saveAiChatPolicy, webPolicyReason } from "./policy";

/**
 * `GET /ai-chat/models`: the models the member may pick, decided by `ai_chat.use` at organization scope, and the
 * member's tool toggles before a model is chosen (05-11: policy and `ai_chat.web`).
 * `GET|PUT /ai-chat/policy` (05-08, D-06): the organization's AI chat policy (backends, daily caps, web search,
 * context size, concurrency, plan model allowlist, title models), admins only (`provider.manage`); every change is
 * audited as `ai_chat.policy_updated` with the changed keys and applies to the next send.
 */
export function registerModelRoutes(app: App, core: Core, gateway: ModelGateway): void {
  const perms = createPermissionService(core);
  const manage = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("provider.manage")],
  };
  app.get(
    "/ai-chat/models",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags: ["ai-chat"], response: { 200: AiModelList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const userId = authOf(req).userId;
        const list = await gateway.listModels(tx, userId);
        // The toggles before a model is picked (05-11): the composer adds each model's own web support.
        const webReason = await webPolicyReason(tx, perms, userId, await loadAiChatPolicy(tx));
        return { ...list, tools: aiToolStates({ reason: webReason, on: false }) };
      }),
  );

  app.get(
    "/ai-chat/policy",
    { ...manage, schema: { tags: ["ai-chat"], response: { 200: AiChatPolicy } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => loadAiChatPolicy(tx)),
  );

  app.put(
    "/ai-chat/policy",
    {
      ...manage,
      schema: { tags: ["ai-chat"], body: UpdateAiChatPolicyRequest, response: { 200: AiChatPolicy } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { policy, changed } = await saveAiChatPolicy(tx, req.body, auth.userId);
        if (changed.length > 0) {
          // Keys only: the values are in the policy row (no secret ever lives here).
          await core.audit.record(tx, {
            action: "ai_chat.policy_updated",
            resourceType: "ai_chat_policy",
            resourceId: auth.organizationId,
            sessionId: auth.sessionId,
            metadata: { changed },
          });
        }
        return policy;
      }),
  );
}
