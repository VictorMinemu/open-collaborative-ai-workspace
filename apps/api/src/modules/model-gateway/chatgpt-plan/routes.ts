import { ChatgptPlanStatus } from "@ocw/contracts";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../../core";
import { randomToken } from "../../../lib/crypto";
import { createPermissionService, orgResource } from "../../organization";
import { loadAiChatPolicy } from "../policy";
import { credentialOf, PLAN_USAGE_SCOPE, planStatusOf, storeCredential } from "./credentials";

/** Scopes "Sign in with ChatGPT – ChatGPT plan usage" grants (developers.openai.com/siwc). */
const PLAN_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_USAGE_SCOPE];

/**
 * The test seed route exists only in non-production mock mode pointed at a fake ChatGPT API (P-12, T-05-02-07):
 * loadEnv already refuses the override in production, this is the second lock.
 */
export function chatgptPlanSeedEnabled(core: Core): boolean {
  return (
    core.env.NODE_ENV !== "production" &&
    core.env.OCW_MODEL_PROVIDER === "mock" &&
    core.env.OCW_CHATGPT_API_BASE_URL !== null
  );
}

export function registerChatgptPlanRoutes(app: App, core: Core): void {
  const perms = createPermissionService(core);
  const tags = ["ai-chat"];

  app.get(
    "/me/model-credentials/chatgpt",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: ChatgptPlanStatus } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return planStatusOf(await credentialOf(tx, authOf(req).userId), await loadAiChatPolicy(tx));
      }),
  );

  if (!chatgptPlanSeedEnabled(core)) return;

  // TEST-ONLY (P-12): connects the caller's own plan with fake tokens the fake Responses API accepts.
  app.post(
    "/test/ai/chatgpt-plan",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: {
        hide: true,
        tags: ["test"],
        body: z.object({ planType: z.string().max(40).optional() }).optional(),
        response: { 200: ChatgptPlanStatus },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const auth = authOf(req);
        const row = await storeCredential(
          tx,
          core,
          auth.userId,
          {
            accessToken: `fake-plan-${auth.userId}-${randomToken(12)}`,
            refreshToken: `fake-refresh-${randomToken(12)}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            clientId: "oaiapp_fake",
          },
          {
            issuedClientId: "oaiapp_fake",
            subject: `fake-sub-${auth.userId}`,
            email: auth.email,
            planType: req.body?.planType ?? "plus",
            scopes: PLAN_SCOPES,
          },
        );
        await core.audit.record(tx, {
          action: "ai_credential.connected",
          resourceType: "user_model_credential",
          resourceId: row.id,
          metadata: { provider: "chatgpt_plan", source: "test_seed" },
        });
        return planStatusOf(row, await loadAiChatPolicy(tx));
      }),
  );
}
