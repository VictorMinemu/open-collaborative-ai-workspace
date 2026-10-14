import type { Tx } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
// Types only: the approval service (07.2-06) is injected; 07.5-07 registers the `tool.call` kind on it.
import type { ApprovalService } from "../approval";
import { createPermissionService } from "../organization";
import {
  type ApprovalSubject,
  approvalModesFor,
  approverLabel,
  type LoadCatalog,
  loadToolApprovalPolicies,
  resolveFor,
  type StoredPolicy,
} from "./policies";
import type { ResolvedApproval } from "./resolve";
import { registerToolApprovalRoutes } from "./routes";

export {
  type ApprovalSubject,
  approvableCatalog,
  approvalFactsFor,
  approvalModesFor,
  approverLabel,
  approverLabels,
  type CatalogSourceLike,
  type LoadCatalog,
  loadToolApprovalPolicies,
  resolveFor,
  type StoredPolicy,
} from "./policies";
export { type ApprovalFacts, type PolicyRow, type ResolvedApproval, resolveToolApproval } from "./resolve";

export interface ToolApprovalDeps {
  approvals: ApprovalService;
  /** `bot-capabilities` `loadCatalog`, injected so this module never imports it (P-10). */
  loadCatalog: LoadCatalog;
}

/** What later plans (07.5-07 gate, 07.5-11 turn assembly) and tests use. */
export interface ToolApprovalService {
  /** Every rule of the caller's organization with its scope path. */
  policies(tx: Tx): Promise<StoredPolicy[]>;
  /** Per offered tool, `always` or `when_tainted` (absent: no approval) for turn assembly (07.5-11). */
  approvalModesFor(
    tx: Tx,
    subject: ApprovalSubject,
    tools: readonly string[],
  ): Promise<Map<string, "always" | "when_tainted">>;
  /** The effective rule for one call (the gate's call-time re-decision, 07.5-07). */
  resolveFor(tx: Tx, subject: ApprovalSubject, tool: string): Promise<ResolvedApproval | null>;
  /** "Leads of Sales", "Admins", "Marta Gil or 2 others", "The person who asked". */
  approverLabel(tx: Tx, r: ResolvedApproval): Promise<string>;
}

/**
 * `tool-approval` module (Phase 07.5, D-01, D-04, APPROVE-01): per-tool approval policies of an organization and its
 * units, resolved strictest-wins for an (agent, human, tool). Routes (all `authz: user`):
 * GET `/tool-approval-policies/access`, GET/POST `/tool-approval-policies`.
 */
export function createToolApprovalModule(
  core: Core,
  deps: ToolApprovalDeps,
): { module: ApiModule; service: ToolApprovalService } {
  const perms = createPermissionService(core);
  const service: ToolApprovalService = {
    policies: (tx) => loadToolApprovalPolicies(tx),
    approvalModesFor,
    resolveFor,
    approverLabel,
  };
  return {
    service,
    module: {
      name: "tool-approval",
      register(app: App) {
        registerToolApprovalRoutes(app, core, perms, { loadCatalog: deps.loadCatalog });
      },
    },
  };
}
