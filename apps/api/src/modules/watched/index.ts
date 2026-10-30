import type { ApiModule, Core } from "../../core";
import type { PermissionService } from "../organization";

/**
 * Phase 07.6 (AUTO-04, D-04, ADR-0028): watched records. A board card linked to an external record through a 07.4
 * connector; the API hashes the template's watched fields (07.5's `canonicalJson`), checks on access and on schedule
 * (`watched.check` jobs) and reports before → after in the card thread. Wired once in app.ts (07.6-03); later 07.6
 * plans fill it.
 */
export interface WatchedDeps {
  perms: PermissionService;
}

export function createWatchedModule(_core: Core, _deps: WatchedDeps): ApiModule {
  return {
    name: "watched",
    register() {},
  };
}
