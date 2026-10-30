import type { AutomationActionKind, AutomationRunReason, AutomationTriggerInput } from "@ocw/contracts";
import type { automationRuns, automations, Tx } from "@ocw/db";
import type { Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";
import type { AutomationService } from "./service";

/** One automation as stored (`app.automations`). */
export type AutomationRow = typeof automations.$inferSelect;
/** One run as stored (`app.automation_runs`). */
export type RunRow = typeof automationRuns.$inferSelect;

/** What firing one run produced: the run card posted (and maybe answered), or a skip / failure with its code. */
export type FireResult =
  | { status: "delivered" | "answered"; anchorMessageId?: string }
  | { status: "skipped" | "failed"; reason: AutomationRunReason };

/**
 * Fires one run of an automation of its kind, inside the runner's transaction (`agent_turn` by 07.6-09, `digest` by
 * 07.6-13). The runner re-decides the target and the limits before calling it and records the result on the run.
 */
export interface ActionKindHandler {
  fire(tx: Tx, ctx: { run: RunRow; automation: AutomationRow }): Promise<FireResult>;
}

/** The action-kind registry: each kind registers once. */
export function createActionRegistry() {
  const kinds = new Map<AutomationActionKind, ActionKindHandler>();
  return {
    register(kind: AutomationActionKind, handler: ActionKindHandler): void {
      if (kinds.has(kind)) throw new Error(`automation action kind ${kind} is already registered`);
      kinds.set(kind, handler);
    },
    get(kind: AutomationActionKind): ActionKindHandler | null {
      return kinds.get(kind) ?? null;
    },
  };
}

/**
 * What every seam of the module receives (P-01: `index.ts` wires each seam once; plans 09, 10, 11, 12 and 21 fill
 * their own file and never edit the index).
 */
export interface AutomationSeamDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
  service: AutomationService;
}

/** What a trigger adapter is called with, besides the transaction. */
export interface TriggerDeps {
  core: Core;
  perms: PermissionService;
}

/**
 * The entity behind a webhook or mail trigger (R3, P-10): one endpoint or mailbox per automation, created by its first
 * save (or by a trigger change), changed with it and deleted with it, always inside the automation's own transaction.
 * The service calls `onDelete` of the old kind and `onCreate` of the new one when the trigger kind changes, and
 * `onUpdate` when a save keeps the kind. `view` is the entity as the automation DTO shows it (null when there is none).
 */
export interface TriggerAdapter<V> {
  onCreate(
    tx: Tx,
    a: AutomationRow,
    input: AutomationTriggerInput,
    deps: TriggerDeps,
  ): Promise<{ webhookSecret?: string }>;
  onUpdate(
    tx: Tx,
    before: AutomationRow,
    after: AutomationRow,
    input: AutomationTriggerInput,
    deps: TriggerDeps,
  ): Promise<{ webhookSecret?: string }>;
  onDelete(tx: Tx, a: AutomationRow, deps: TriggerDeps): Promise<void>;
  view(tx: Tx, a: AutomationRow, deps: TriggerDeps): Promise<V | null>;
}
