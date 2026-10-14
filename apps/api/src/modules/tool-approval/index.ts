import type { Tx } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
// Types only: the approval service (07.2-06) is injected; 07.5-07 registers the `tool.call` kind on it.
import type { ApprovalService } from "../approval";
import { createPermissionService } from "../organization";
import { createToolCallKind } from "./kind";
import {
  type ApprovalSubject,
  approvalModesFor,
  approverLabel,
  type LoadCatalog,
  loadToolApprovalPolicies,
  resolveFor,
  type StoredPolicy,
} from "./policies";
import { type ApprovalForCallInput, type ApprovalOutcome, approvalForCall } from "./request";
import type { ResolvedApproval } from "./resolve";
import { registerToolApprovalRoutes } from "./routes";

export { TOOL_CALL_KIND } from "@ocw/contracts";
export { TOOL_CALL_RESOURCE } from "./kind";
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
export {
  type ApprovalForCallDeps,
  type ApprovalForCallInput,
  type ApprovalOutcome,
  approvalForCall,
  type ToolCallSource,
} from "./request";
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
  /**
   * The one decision of an agent action that may need a person (07.5-07): none, the grant consumed for this call, one
   * pending request with its card, or a refusal. Inside the caller's claim transaction, opened as the turn's human.
   */
  approvalForCall(tx: Tx, c: ApprovalForCallInput): Promise<ApprovalOutcome>;
}

/**
 * `tool-approval` module (Phase 07.5, D-01, D-04, APPROVE-01): per-tool approval policies of an organization and its
 * units, resolved strictest-wins for an (agent, human, tool). Routes (all `authz: user`):
 * GET `/tool-approval-policies/access`, GET/POST `/tool-approval-policies`, PATCH/DELETE `/tool-approval-policies/:id`,
 * GET `/tool-approval-policies/history`. Every change is audited (`tool_approval_policy.created|updated|deleted`).
 */
export function createToolApprovalModule(
  core: Core,
  deps: ToolApprovalDeps,
): { module: ApiModule; service: ToolApprovalService } {
  const perms = createPermissionService(core);
  // 07.5-07: the `tool.call` grant kind lives on the injected 07.2 primitive.
  deps.approvals.register(createToolCallKind({ core, perms }));
  const service: ToolApprovalService = {
    policies: (tx) => loadToolApprovalPolicies(tx),
    approvalModesFor,
    resolveFor,
    approverLabel,
    approvalForCall: (tx, c) => approvalForCall(tx, { approvals: deps.approvals }, c),
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
