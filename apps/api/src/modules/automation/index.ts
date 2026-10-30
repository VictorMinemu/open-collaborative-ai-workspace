import type { Tx } from "@ocw/db";
import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";

/**
 * Phase 07.6 (AUTO-01 … AUTO-03, ADR-0028): standing orders that run as their creator on a schedule, a signed webhook or
 * a mailbox, delivered to a target by stable ids. Wired once in app.ts (07.6-03); 07.6-05 fills the service and routes,
 * 09 the runner on `core.jobs`, 10 webhooks, 11 mailboxes, 12 the approval kind, 21 inbound events.
 */

export type AutomationActionKind = "agent_turn" | "digest";

/** Fires one run of an automation of its kind (07.6-05 gives `ctx` its run and automation rows). */
export interface ActionKindHandler {
  fire(tx: Tx, ctx: unknown): Promise<unknown>;
}

export interface AutomationService {
  /** Each action kind registers once: `agent_turn` (09), `digest` (13). */
  registerActionKind(kind: AutomationActionKind, handler: ActionKindHandler): void;
  actionKind(kind: AutomationActionKind): ActionKindHandler | null;
}

export interface AutomationDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
}

export function createAutomationModule(
  _core: Core,
  _deps: AutomationDeps,
): { module: ApiModule; service: AutomationService } {
  const kinds = new Map<AutomationActionKind, ActionKindHandler>();
  const service: AutomationService = {
    registerActionKind(kind, handler) {
      if (kinds.has(kind)) throw new Error(`automation action kind ${kind} is already registered`);
      kinds.set(kind, handler);
    },
    actionKind(kind) {
      return kinds.get(kind) ?? null;
    },
  };
  return {
    service,
    module: {
      name: "automation",
      register() {},
    },
  };
}
