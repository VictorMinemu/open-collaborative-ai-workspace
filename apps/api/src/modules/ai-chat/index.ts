import { tenantOf } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService } from "../organization";
import { registerGenerationRoutes } from "./generations";
import { registerPreferenceRoutes } from "./prefs";
import { registerAiChatRoutes } from "./routes";
import { createRunLoop } from "./run-loop";
import { createAiChatService } from "./service";
import { createGenerationSweeper } from "./sweeper";
import { createTitler } from "./titles";
import { registerUsageRoutes } from "./usage-routes";

/**
 * Direct AI chat (Phase 5, AICHAT-02/03/07): private chats with one owner, answers streamed by one run loop over
 * the realtime WebSocket and persisted with a usage record, under daily per-member caps (05-08). Prompts come only from `buildModelMessages`.
 */
export { type BuildInput, type BuiltPrompt, buildModelMessages } from "./build-model-messages";
export { ABORT_CHANNEL } from "./generations";
export { consumeGeneration, usageToday } from "./limits";
export { loadPreferences, registerPreferenceRoutes } from "./prefs";
export { type AfterFinalize, createRunLoop, type RunLoop } from "./run-loop";
export { createGenerationSweeper, type GenerationSweeper } from "./sweeper";
export { createTitler, heuristicTitle, pickTitleModel, type Titler } from "./titles";
export { toolStates, webAllowed } from "./tools-state";
export { searxngWebSearchTool } from "./web-tools";

export function createAiChatModule(core: Core, deps: { gateway: ModelGateway }): ApiModule {
  const runLoop = createRunLoop(core, { gateway: deps.gateway });
  // Auto titles (05-10): the hook only schedules, after the finalize commits; the call runs in its own transactions.
  const titler = createTitler(core, { gateway: deps.gateway, timeoutMs: core.env.OCW_AI_TITLE_TIMEOUT_MS });
  runLoop.onAfterFinalize(async (tx, done) => {
    if (!done.firstAnswer) return;
    const { organizationId, afterCommit } = tenantOf(tx);
    afterCommit(() => titler.schedule(organizationId, done.chatId, done.generation.id));
  });
  const service = createAiChatService({
    core,
    gateway: deps.gateway,
    runLoop,
    access: createConversationAccess(core),
    perms: createPermissionService(core),
  });
  // Finalizes answers whose API process died (stale heartbeat), one process at a time (D-05).
  const sweeper = createGenerationSweeper(core, { runLoop });
  let unsubscribeAbort: (() => Promise<void>) | null = null;
  return {
    name: "ai-chat",
    async register(app: App) {
      registerAiChatRoutes(app, core, service);
      // The member's own defaults: personal instructions, default model, Web on new chats (05-11).
      registerPreferenceRoutes(app, { core, gateway: deps.gateway });
      // Today's usage (05-08); 05-09 adds the reports to usage-routes.ts, never here.
      registerUsageRoutes(app, { core });
      unsubscribeAbort = await registerGenerationRoutes(app, { core, gateway: deps.gateway, runLoop });
      sweeper.start();
    },
    async close() {
      // Stop taking abort hints, then end what this process still streams as `interrupted` (text kept).
      sweeper.stop();
      await unsubscribeAbort?.();
      await runLoop.shutdown();
      await titler.close();
    },
  };
}
