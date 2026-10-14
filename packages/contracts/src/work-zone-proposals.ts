import { z } from "zod";

/**
 * Work Zone proposals (Phase 07.5, D-03, D-04, P-08): an agent proposes a session (project, device, prompt and an
 * optional runtime) and the person it acted for starts it with one click. Imports `common` and `session-events` only;
 * `approvals.ts` and `agent-cards.ts` import this file, never the reverse.
 */

/** Why Start is not possible right now (shown on the card and the review; Start stays disabled). */
export const WorkZoneStartBlock = z.enum([
  "device_offline",
  "runtime_unavailable",
  "device_not_shared",
  "project_not_found",
  "not_allowed",
]);
export type WorkZoneStartBlock = z.infer<typeof WorkZoneStartBlock>;
