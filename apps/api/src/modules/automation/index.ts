import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import { createConversationAccess } from "../chat";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";
import { registerAutomationRoutes } from "./routes";
import { type AutomationService, createAutomationService } from "./service";

/**
 * Phase 07.6 (AUTO-01 … AUTO-03, ADR-0028): standing orders that run as their creator on a schedule, a signed webhook or
 * a mailbox, delivered to a target by stable ids. Wired once in app.ts (07.6-03); 07.6-05 fills the service and routes,
 * 09 the runner on `core.jobs`, 10 webhooks, 11 mailboxes, 12 the approval kind, 21 inbound events.
 */

export type { AutomationActor, TargetDecision, UsableBot } from "./access";
export { canCreate, canManage, canWebhook, decideConversation, decideTarget, usableBots } from "./access";
export type { ActionKindHandler, AutomationRow, FireResult, RunRow } from "./actions";
export { firstRunAt, missedPolicy, nextRunAfter, nextRuns, validateSchedule } from "./schedule";
export {
  type AutomationCaps,
  type AutomationService,
  DEFAULT_AUTOMATION_CAPS,
  targetOf,
} from "./service";

export type AutomationActionKind = "agent_turn" | "digest";

export interface AutomationDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
}

export function createAutomationModule(
  core: Core,
  deps: AutomationDeps,
): { module: ApiModule; service: AutomationService } {
  const service = createAutomationService(core, deps.perms, createConversationAccess(core));
  return {
    service,
    module: {
      name: "automation",
      register(app) {
        registerAutomationRoutes(app, core, service, deps.perms);
      },
    },
  };
}
