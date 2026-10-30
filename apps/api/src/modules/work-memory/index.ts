import type { ApiModule, App, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { MemoryService } from "../memory";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";
import { registerWorkMemoryRoutes } from "./routes";
import { summarizeSession } from "./summarize";

export { canMapFor, memoryRecipients, unitForSession } from "./session-unit";
export {
  buildSessionInput,
  collectSessionInput,
  SUMMARY_INPUT_MAX_CHARS,
  summarizeSession,
  toRepoRelative,
} from "./summarize";

/**
 * Phase 07.6 (AUTO-06, D-06, D-07, D-10, D-11, ADR-0028): a finished Work Zone session becomes a summary proposal in its
 * team project's memory (07.2 promotion flow, system origin; the session owner pays, usage kind `session_summary`). The
 * project is 07.9's (`work_project_repos`, read only), and sessions are read only through the work-session module's
 * audience rule (`sessionFacts` / `sessionFactsForUsers`), imported from its public index. State changes reach each
 * reader's own `user:` topic (`work_session_memory.updated`), never `ws:` or `org:`.
 */
export interface WorkMemoryDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  memory: MemoryService;
  modelGateway: ModelGateway;
}

export function createWorkMemoryModule(core: Core, deps: WorkMemoryDeps): ApiModule {
  const summaryDeps = { perms: deps.perms, memory: deps.memory, gateway: deps.modelGateway };
  return {
    name: "work-memory",
    register(app: App) {
      core.jobs.work("work_session.summarize", (data, ctx) => summarizeSession(core, summaryDeps, data, ctx));
      registerWorkMemoryRoutes(app, { core, perms: deps.perms, gateway: deps.modelGateway });
    },
  };
}
