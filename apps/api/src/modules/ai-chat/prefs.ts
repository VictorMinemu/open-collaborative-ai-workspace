import { AiUserPreferences, modelRefKey, UpdateAiUserPreferencesRequest } from "@ocw/contracts";
import { aiUserPreferences, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest } from "../../lib/errors";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService, orgResource } from "../organization";
import { parseModelRef } from "./dto";

/**
 * A member's own AI chat preferences (05-11, AICHAT-05): personal instructions (only ever sent in chats where they are
 * the one human, PRD §113), the default model and whether new chats start with Web on. Per caller: there is no way to
 * read or write another member's. Every change is audited as `ai_preferences.updated` with the changed keys only
 * (never the instruction text).
 */

const KEYS = ["instructions", "defaultModel", "webDefault"] as const;

/** The caller's preferences (defaults when never saved). */
export async function loadPreferences(tx: Tx, userId: string): Promise<AiUserPreferences> {
  const [row] = await tx
    .select()
    .from(aiUserPreferences)
    .where(eq(aiUserPreferences.userId, userId))
    .limit(1);
  return {
    instructions: row?.instructions ?? "",
    defaultModel: parseModelRef(row?.defaultModel),
    webDefault: row?.webDefault ?? false,
  };
}

export function registerPreferenceRoutes(app: App, ctx: { core: Core; gateway: ModelGateway }): void {
  const { core, gateway } = ctx;
  const perms = createPermissionService(core);
  const tags = ["ai-chat"];

  app.get(
    "/me/ai-preferences",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: AiUserPreferences } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return loadPreferences(tx, authOf(req).userId);
      }),
  );

  app.put(
    "/me/ai-preferences",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, body: UpdateAiUserPreferencesRequest, response: { 200: AiUserPreferences } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const auth = authOf(req);
        const before = await loadPreferences(tx, auth.userId);
        const next: AiUserPreferences = { ...before };
        if (req.body.instructions !== undefined) next.instructions = req.body.instructions;
        if (req.body.webDefault !== undefined) next.webDefault = req.body.webDefault;
        if (req.body.defaultModel !== undefined) {
          const ref = req.body.defaultModel;
          if (ref) {
            // Only a model the member can pick right now (it may become unavailable later: the list then falls back).
            const list = await gateway.listModels(tx, auth.userId);
            if (!list.models.some((m) => m.available && modelRefKey(m.ref) === modelRefKey(ref))) {
              throw badRequest("This model is not available to you", "model_unavailable");
            }
          }
          next.defaultModel = ref;
        }
        const changed = KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
        if (changed.length === 0) return before;
        const at = new Date().toISOString();
        const values = {
          instructions: next.instructions,
          defaultModel: next.defaultModel,
          webDefault: next.webDefault,
          updatedAt: at,
        };
        await tx
          .insert(aiUserPreferences)
          .values({ organizationId: tenantOf(tx).organizationId, userId: auth.userId, ...values })
          .onConflictDoUpdate({
            target: [aiUserPreferences.organizationId, aiUserPreferences.userId],
            set: values,
          });
        await core.audit.record(tx, {
          action: "ai_preferences.updated",
          resourceType: "ai_user_preferences",
          resourceId: auth.userId,
          sessionId: auth.sessionId,
          metadata: { changed: [...changed].sort() },
        });
        return next;
      }),
  );
}
