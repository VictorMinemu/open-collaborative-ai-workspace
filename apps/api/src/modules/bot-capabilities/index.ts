import type { ApiModule, Core } from "../../core";
// Types only: the memory service (07.2-08) is injected; the legacy notes live in its private MEMORY.md (07.2-11).
import type { MemoryService } from "../memory";
import { createPermissionService } from "../organization";
import { type ConfinedSource, registerBotCapabilityRoutes } from "./routes";

export {
  type CatalogSource,
  confinedCapabilities,
  effectiveCapabilities,
  effectiveTools,
  readCapabilities,
} from "./capabilities";
export { loadAllGrants, loadCatalog, loadGrants, replaceGrants } from "./catalog";
export {
  crossSiteFor,
  MEMBER_DATA_SITES_MAX,
  recordMemberData,
  type StickyMemberData,
  stickyMemberData,
} from "./member-data";
export {
  bulletsOf,
  clearMemories,
  flattenNote,
  listMemories,
  loadTurnMemory,
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
export { findBot, governanceList, loadBotFacts, notifyCellConfig, usageToday } from "./routes";
export {
  type CurrentTurnTools,
  cellAgentCapabilities,
  currentTurn,
  currentTurnTools,
  inChannel,
  memberAccountAllowed,
  memberAccountFacts,
  recordLimitReached,
  type TurnAudience,
  type TurnDecision,
  type TurnKeys,
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
 * caller's own notes only, D-10; since 07.2-11 the bullets of their private `MEMORY.md` with the bot).
 */
export function createBotCapabilitiesModule(
  core: Core,
  deps: { memory: MemoryService; sandbox?: ConfinedSource },
): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "bot-capabilities",
    register(app) {
      registerBotCapabilityRoutes(app, core, perms, deps.memory, deps.sandbox);
    },
  };
}
