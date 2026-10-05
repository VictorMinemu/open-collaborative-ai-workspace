import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { registerBotCapabilityRoutes } from "./routes";

export {
  type CatalogSource,
  effectiveCapabilities,
  effectiveTools,
  readCapabilities,
} from "./capabilities";
export { loadAllGrants, loadCatalog, loadGrants, replaceGrants } from "./catalog";
export {
  clearMemories,
  listMemories,
  loadTurnMemory,
  MEMORY_CAP,
  type MemoryRefusal,
  type SaveMemoryResult,
  saveMemory,
  TURN_MEMORY_LIMIT,
} from "./memory";
export {
  availableSearchProviders,
  internetConfigured,
  loadPolicy,
  type SearchEnv,
  savePolicy,
} from "./policy";
export { findBot, governanceList, notifyCellConfig, usageToday } from "./routes";
export {
  cellAgentCapabilities,
  currentTurnTools,
  recordLimitReached,
  type TurnDecision,
  turnNow,
  turnPolicy,
} from "./turn-policy";
export {
  claimChannelNotice,
  consumeTurn,
  effectiveDailyLimit,
  limitNotice,
  nextResetAt,
  turnsToday,
  usageOf,
  utcDay,
} from "./usage";

/**
 * bot-capabilities module (Phase 3.1, D-06 … D-08; BOT-04, BOT-05, BOT-10): the capability model of every
 * bot (built-in toggles and MCP / plugin tool grants), the organization bot policy and personal-bot
 * governance. Decisions go through the one resolver; the pure decision lives in capabilities.ts.
 *
 * Routes (all `authz: user`): GET/PATCH `/agents/:id/capabilities`, GET/PUT `/bot-policy`,
 * GET `/bot-governance`, GET/DELETE `/agents/:id/memories`, DELETE `/agents/:id/memories/:memoryId` (the
 * caller's own notes only, D-10).
 */
export function createBotCapabilitiesModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "bot-capabilities",
    register(app) {
      registerBotCapabilityRoutes(app, core, perms);
    },
  };
}
