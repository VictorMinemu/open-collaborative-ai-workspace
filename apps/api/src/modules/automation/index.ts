import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import { createConversationAccess } from "../chat";
import type { MemoryService } from "../memory";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";
import type { AutomationSeamDeps } from "./actions";
import { type AutomationProposals, registerAutomationApprovalKind } from "./approval-kind";
import { type AutomationFanOut, createAutomationFanOut } from "./fan-out";
import { registerInbound } from "./inbound";
import { registerMailboxRoutes } from "./mailboxes";
import { registerAutomationRoutes } from "./routes";
import { registerRunner } from "./runner";
import { type AutomationService, createAutomationService } from "./service";
import { registerWebhookRoutes } from "./webhook-routes";

/**
 * Phase 07.6 (AUTO-01 … AUTO-03, ADR-0028): standing orders that run as their creator on a schedule, a signed webhook or
 * a mailbox, delivered to a target by stable ids. Wired once in app.ts (07.6-03); 07.6-05 fills the service and routes,
 * 09 the runner on `core.jobs`, 10 webhooks, 11 mailboxes, 12 the approval kind, 21 inbound events.
 */

export type { AutomationActor, TargetDecision, UsableBot } from "./access";
export { canCreate, canManage, canWebhook, decideConversation, decideTarget, usableBots } from "./access";
export type {
  ActionKindHandler,
  AutomationRow,
  AutomationSeamDeps,
  FireResult,
  RunRow,
  SettledFireResult,
  TriggerAdapter,
  TriggerDeps,
} from "./actions";
export {
  AUTOMATION_CREATE_KIND,
  type AutomationProposals,
  type ProposalRefusal,
  type ProposingTurn,
} from "./approval-kind";
export { type AutomationFanOut, externalKeyHash, type FanOutOpenInput } from "./fan-out";
export { firstRunAt, missedPolicy, nextRunAfter, nextRuns, validateSchedule } from "./schedule";
export {
  type AutomationCaps,
  type AutomationService,
  DEFAULT_AUTOMATION_CAPS,
  targetOf,
} from "./service";
export { refusalReason } from "./targets";

export type AutomationActionKind = "agent_turn" | "digest";

export interface AutomationDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
  /** The bot's memory in run turns (09's runner hands it to `deliverAutomationRun`). */
  memory?: MemoryService;
}

export function createAutomationModule(
  core: Core,
  deps: AutomationDeps,
): {
  module: ApiModule;
  service: AutomationService;
  proposals: AutomationProposals;
  /** 07.17 (PD-07): the open call of a fan-out run, served by the Agent Channel's `/conversations/open`. */
  fanOut: AutomationFanOut;
} {
  const service = createAutomationService(core, deps.perms, createConversationAccess(core), deps.approvals);
  const seams: AutomationSeamDeps = { ...deps, service };
  // Each seam is wired here once; its plan fills its own file (09 runner, 10 webhooks, 11 mailboxes, 12 the approval
  // kind, 21 inbound) and never edits this index (P-01). 12 also returns the proposal entry point the Agent Channel serves.
  const proposals = registerAutomationApprovalKind(deps.approvals, service, { core, perms: deps.perms });
  const fanOut = createAutomationFanOut(core, { perms: deps.perms });
  return {
    service,
    proposals,
    fanOut,
    module: {
      name: "automation",
      register(app) {
        registerAutomationRoutes(app, core, service, deps.perms);
        registerWebhookRoutes(app, core, seams);
        registerMailboxRoutes(app, core, seams);
        // Workers and ticks register during module registration, before `core.jobs` starts (onReady).
        registerRunner(core, seams);
        registerInbound(core, seams);
      },
    },
  };
}
