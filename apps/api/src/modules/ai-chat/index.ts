import type { ApiModule, App, Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService } from "../organization";
import { registerGenerationRoutes } from "./generations";
import { registerAiChatRoutes } from "./routes";
import { createRunLoop } from "./run-loop";
import { createAiChatService } from "./service";

/**
 * Direct AI chat (Phase 5, AICHAT-02/03/07): private chats with one owner, answers streamed by one run loop over
 * the realtime WebSocket and persisted with a usage record. Prompts come only from `buildModelMessages`.
 */
export { type BuildInput, type BuiltPrompt, buildModelMessages } from "./build-model-messages";
export { ABORT_CHANNEL } from "./generations";
export { type AfterFinalize, createRunLoop, type RunLoop } from "./run-loop";

export function createAiChatModule(core: Core, deps: { gateway: ModelGateway }): ApiModule {
  const runLoop = createRunLoop(core, { gateway: deps.gateway });
  const service = createAiChatService({
    core,
    gateway: deps.gateway,
    runLoop,
    access: createConversationAccess(core),
    perms: createPermissionService(core),
  });
  let unsubscribeAbort: (() => Promise<void>) | null = null;
  return {
    name: "ai-chat",
    async register(app: App) {
      registerAiChatRoutes(app, core, service);
      unsubscribeAbort = await registerGenerationRoutes(app, { core, gateway: deps.gateway, runLoop });
    },
    async close() {
      // Stop taking abort hints, then end what this process still streams as `interrupted` (text kept).
      await unsubscribeAbort?.();
      await runLoop.shutdown();
    },
  };
}
