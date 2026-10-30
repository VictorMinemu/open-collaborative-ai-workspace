import { tenantOf } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
import type { ObjectStorage } from "../artifact";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import { createPermissionService } from "../organization";
import { registerGenerationRoutes } from "./generations";
import { registerGrantRoutes } from "./grants";
import { registerMemberRoutes, registerPersonaActivity } from "./members";
import { registerPreferenceRoutes } from "./prefs";
import { registerQueue } from "./queue";
import { registerAiChatRoutes } from "./routes";
import { createRunLoop } from "./run-loop";
import { createAiChatService } from "./service";
import { registerShareRoutes } from "./shares";
import { createGenerationSweeper } from "./sweeper";
import { createTitler } from "./titles";
import { registerUsageRoutes } from "./usage-routes";

export {
  AI_IMAGE_ORIGINAL_MAX_BYTES,
  aiAttachmentKind,
  attachmentPartsFor,
  modelPartsFor,
} from "./attachments";
/**
 * Direct AI chat (Phase 5, AICHAT-02/03/07): private chats with one owner, answers streamed by one run loop over
 * the realtime WebSocket and persisted with a usage record, under daily per-member caps (05-08). Prompts come only from `buildModelMessages`.
 */
export { type BuildInput, type BuiltPrompt, buildModelMessages } from "./build-model-messages";
/** For search (06-04): how a viewer sees a chat, with the same helpers as the AI chat list. */
export { answerModelsOf, ownerAuthor, sharedSql } from "./dto";
export { ABORT_CHANNEL } from "./generations";
export { registerGrantRoutes } from "./grants";
export { consumeGeneration, usageToday } from "./limits";
/** For agent-channel and bot-capabilities (06-10, P-10): a persona's roster and audience in an AI chat. */
export { audienceOf, participantsOf, registerMemberRoutes } from "./members";
/** Phase 07.6 (P-16): model calls that are not chat generations (digests, Work Zone session summaries). */
export { runOneShot } from "./one-shot";
export { loadPreferences, registerPreferenceRoutes } from "./prefs";
export { type AfterFinalize, createRunLoop, type RunLoop } from "./run-loop";
export { registerShareRoutes, snapshotOf } from "./shares";
export { createGenerationSweeper, type GenerationSweeper } from "./sweeper";
export { createTitler, heuristicTitle, pickTitleModel, type Titler } from "./titles";
export { toolStates, webAllowed } from "./tools-state";
export { backendClassOf, type ReportedUsage, recordStandaloneUsage } from "./usage";
export { searxngWebSearchTool } from "./web-tools";

export function createAiChatModule(
  core: Core,
  /** `storage`: where attachment bytes are read for the model (05-12); null = attachments are not configured. */
  deps: { gateway: ModelGateway; storage?: ObjectStorage | null },
): ApiModule {
  const runLoop = createRunLoop(core, { gateway: deps.gateway, storage: deps.storage ?? null });
  // Auto titles (05-10): the hook only schedules, after the finalize commits; the call runs in its own transactions.
  const titler = createTitler(core, { gateway: deps.gateway, timeoutMs: core.env.OCW_AI_TITLE_TIMEOUT_MS });
  runLoop.onAfterFinalize(async (tx, done) => {
    if (!done.firstAnswer) return;
    const { organizationId, afterCommit } = tenantOf(tx);
    afterCommit(() => titler.schedule(organizationId, done.chatId, done.generation.id));
  });
  // Shared chats (06-06, P-08): whatever ended the answer, the next queued turn starts in the same finalize.
  registerQueue({ core, gateway: deps.gateway, runLoop });
  // A persona's reply (06-10) is activity in the chat: every participant's sidebar hears it, with their own unread.
  registerPersonaActivity(core, deps.gateway);
  const service = createAiChatService({
    core,
    gateway: deps.gateway,
    runLoop,
    access: createConversationAccess(core),
    perms: createPermissionService(core),
  });
  // Finalizes answers whose API process died (stale heartbeat), one process at a time (D-05).
  const sweeper = createGenerationSweeper(core, { runLoop, gateway: deps.gateway });
  let unsubscribeAbort: (() => Promise<void>) | null = null;
  return {
    name: "ai-chat",
    async register(app: App) {
      registerAiChatRoutes(app, core, service);
      // The member's own defaults: personal instructions, default model, Web on new chats (05-11).
      registerPreferenceRoutes(app, { core, gateway: deps.gateway });
      // Today's usage (05-08); 05-09 adds the reports to usage-routes.ts, never here.
      registerUsageRoutes(app, { core });
      // Read-only snapshot share links (05-13, AICHAT-09): signed-in members of the organization only.
      registerShareRoutes(app, { core, gateway: deps.gateway, storage: deps.storage ?? null });
      // Sharing in place (Phase 6, D-03): grants on the same conversation, owner only.
      registerGrantRoutes(app, { core, gateway: deps.gateway });
      // Agents as participants (06-10, D-07): owner adds/removes personas; readers list the participants.
      registerMemberRoutes(app, { core });
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
