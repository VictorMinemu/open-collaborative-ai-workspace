import { AiModelList } from "@ocw/contracts";
import { type App, authOf, type Core, tenant } from "../../core";
import { createPermissionService, orgResource } from "../organization";
import type { ModelGateway } from "./index";

/** `GET /ai-chat/models`: the models the member may pick, decided by `ai_chat.use` at organization scope. */
export function registerModelRoutes(app: App, core: Core, gateway: ModelGateway): void {
  const perms = createPermissionService(core);
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
        return gateway.listModels(tx, authOf(req).userId);
      }),
  );
}
