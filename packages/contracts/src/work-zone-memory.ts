import { z } from "zod";
import { Id } from "./common";

/**
 * Work Zone → project memory (Phase 07.6, AUTO-06, D-06 as amended by D-10, D-11). A finished session can propose a
 * summary into the memory of the team project its repository is linked to (07.9's `work_project_repos`); a person
 * approves it through 07.2's promotion flow. This file carries no repository mapping: 07.9's `work-projects.ts`
 * (`WorkProjectRepo`, `LinkWorkProjectRepoRequest`, `LinkableRepos`) owns linking (D-10).
 */

/** `unmapped`: the session's repository is linked to no team project yet. */
export const SessionMemoryStatus = z.enum([
  "none",
  "unmapped",
  "writing",
  "pending",
  "applied",
  "denied",
  "failed",
]);
export type SessionMemoryStatus = z.infer<typeof SessionMemoryStatus>;

/**
 * `GET /work-sessions/:id/memory`: a per-viewer DTO (D-11), served only on per-viewer surfaces, never on `ws:<id>`.
 */
export const SessionMemorySummary = z.object({
  status: SessionMemoryStatus,
  /** The 07.9 team project the session's repository is linked to; null when unmapped. */
  unit: z.object({ id: Id, name: z.string() }).nullable(),
  proposalId: Id.nullable(),
  /** The proposal was made automatically (the owner's preference). */
  auto: z.boolean(),
  /** The last proposal already covers everything the session did (`last_local_seq`). */
  nothingNew: z.boolean(),
  decidedBy: z.object({ id: Id, displayName: z.string() }).nullable(),
  decisionNote: z.string().max(500).nullable(),
  /** Per viewer: only the session owner proposes (and pays). */
  canPropose: z.boolean(),
  /** Per viewer: may use 07.9's linking flow (`work_project.manage` + `device.use`); meaningful only when unmapped. */
  canMap: z.boolean(),
  /** The model that writes the summary; `metered` = billed per use, `plan` = a member's plan. */
  model: z.object({ label: z.string(), metered: z.boolean(), plan: z.boolean() }).nullable(),
});
export type SessionMemorySummary = z.infer<typeof SessionMemorySummary>;

/** `GET|PUT /me/preferences` (R7): automatic summaries are off until the person turns them on. */
export const MemoryPreferences = z.object({ autoProposeSessionSummaries: z.boolean().default(false) });
export type MemoryPreferences = z.infer<typeof MemoryPreferences>;

/** `work_session_memory.updated` on `user:<reader>` only (D-11): the session id, nothing else. */
export const WorkSessionMemoryUpdatedEvent = z.strictObject({ workSessionId: Id });
export type WorkSessionMemoryUpdatedEvent = z.infer<typeof WorkSessionMemoryUpdatedEvent>;
