import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { MemoryService } from "../memory";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";

/**
 * Phase 07.6 (AUTO-06, D-06, D-10, D-11, ADR-0028): a finished Work Zone session becomes a summary proposal in its team
 * project's memory (07.2 promotion flow; the session owner pays, usage kind `session_summary`). The project is 07.9's
 * (`work_project_repos`), and sessions are read only through the work-session module's audience rule (`sessionFacts`),
 * imported from its public index. Wired once in app.ts (07.6-03); later 07.6 plans fill it.
 */
export interface WorkMemoryDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  memory: MemoryService;
  modelGateway: ModelGateway;
}

export function createWorkMemoryModule(_core: Core, _deps: WorkMemoryDeps): ApiModule {
  return {
    name: "work-memory",
    register() {},
  };
}
