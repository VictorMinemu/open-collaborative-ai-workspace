import type { AutomationActionKind, AutomationRunReason } from "@ocw/contracts";
import type { automationRuns, automations, Tx } from "@ocw/db";

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
