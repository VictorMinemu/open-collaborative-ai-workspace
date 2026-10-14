import type { Tx } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
// Types only: the approval service (07.2-06) is injected; 07.5-07 registers the `tool.call` kind on it.
import type { ApprovalService } from "../approval";
import { createPermissionService } from "../organization";
import { type LoadCatalog, loadToolApprovalPolicies, type StoredPolicy } from "./policies";
import { registerToolApprovalRoutes } from "./routes";

export {
  approvableCatalog,
  approverLabel,
  approverLabels,
  type CatalogSourceLike,
  type LoadCatalog,
  loadToolApprovalPolicies,
  type StoredPolicy,
} from "./policies";
export type { PolicyRow } from "./resolve";

export interface ToolApprovalDeps {
  approvals: ApprovalService;
  /** `bot-capabilities` `loadCatalog`, injected so this module never imports it (P-10). */
  loadCatalog: LoadCatalog;
}

/** What later plans (07.5-07 gate, 07.5-11 turn assembly) and tests use. */
export interface ToolApprovalService {
  /** Every rule of the caller's organization with its scope path. */
  policies(tx: Tx): Promise<StoredPolicy[]>;
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
