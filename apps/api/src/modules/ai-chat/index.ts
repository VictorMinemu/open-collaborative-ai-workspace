import type { ApiModule, App, Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService } from "../organization";
import { registerAiChatRoutes } from "./routes";
import { createRunLoop } from "./run-loop";
import { createAiChatService } from "./service";

/**
 * Direct AI chat (Phase 5, AICHAT-02/03/07): private chats with one owner, answers streamed by one run loop over
 * the realtime WebSocket and persisted with a usage record. Prompts come only from `buildModelMessages`.
 */
export { type BuildInput, type BuiltPrompt, buildModelMessages } from "./build-model-messages";
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
  return {
    name: "ai-chat",
    register(app: App) {
      registerAiChatRoutes(app, core, service);
    },
    close: () => runLoop.shutdown(),
  };
}
