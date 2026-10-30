import type { ApiModule, Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { AutomationService } from "../automation";
import type { ModelGateway } from "../model-gateway";
import type { PermissionService } from "../organization";

/**
 * Phase 07.6 (AUTO-05, D-05, ADR-0028): the personal digest. A deterministic OCW query, an optional metered summary
 * (opt-in, usage kind `digest`), delivered by a bot the person can DM; it runs as a `digest` automation, so it
 * registers its action kind on the automation service (07.6-13). Wired once in app.ts (07.6-03).
 */
export interface DigestDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
  automation: AutomationService;
}

export function createDigestModule(_core: Core, _deps: DigestDeps): ApiModule {
  return {
    name: "digest",
    register() {},
  };
}
