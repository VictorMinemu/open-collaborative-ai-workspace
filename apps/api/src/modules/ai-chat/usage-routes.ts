import { AiUsageToday } from "@ocw/contracts";
import { type App, authOf, type Core, tenant } from "../../core";
import { loadAiChatPolicy } from "../model-gateway";
import { createPermissionService, orgResource } from "../organization";
import { usageToday } from "./limits";

/**
 * AI chat usage routes (05-08, AICHAT-07, D-06), registered once by `ai-chat/index.ts`; the 30-day reports (05-09)
 * are added here. Usage views carry ids, counts and money only, never prompt or answer text (T-05-08-04).
 *
 *   GET /me/ai-usage/today → the caller's own counters for today against the organization's caps (T-05-08-03:
 *   only the caller's rows, RLS isolates organizations).
 */
export function registerUsageRoutes(app: App, ctx: { core: Core }): void {
  const { core } = ctx;
  const perms = createPermissionService(core);
  app.get(
    "/me/ai-usage/today",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags: ["ai-chat"], response: { 200: AiUsageToday } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return usageToday(tx, authOf(req).userId, await loadAiChatPolicy(tx));
      }),
  );
}
