import { z } from "zod";
import { Id } from "./common";
import { RuntimeId } from "./session-events";
import { ApprovalOrigin } from "./tool-approvals";

/**
 * Work Zone proposals (Phase 07.5, D-03, D-04, P-08): an agent proposes a session (project, device, prompt and an
 * optional runtime) and the person it acted for starts it with one click. Imports `common`, `session-events` and
 * `tool-approvals` (for `ApprovalOrigin`) only; `approvals.ts` and `agent-cards.ts` import this file, never the reverse.
 */

/** Why Start is not possible right now (shown on the card and the review; Start stays disabled). */
export const WorkZoneStartBlock = z.enum([
  "device_offline",
  "runtime_unavailable",
  "device_not_shared",
  "project_not_found",
  "not_allowed",
  /** 07.9 (D-13): the repository belongs to a team project the person is not in. */
  "not_in_project",
]);
export type WorkZoneStartBlock = z.infer<typeof WorkZoneStartBlock>;

/** Every accepted default of D-04 for proposals (P-08). */
export const WORK_ZONE_PROPOSAL_LIMITS = {
  /** Same bound as a Work Zone prompt (`CreatePromptRequest.body`). */
  promptChars: 50_000,
  /** Pending proposals per (agent, requester). */
  pendingPerRequester: 3,
  /** A pending proposal expires after 24 h. */
  pendingTtlMs: 24 * 60 * 60 * 1000,
  /** The prompt excerpt on the card. */
  excerptChars: 500,
} as const;

/** The `work_zone.start` approval kind (mode `server_apply`): Start creates the session as the person who clicked. */
export const WORK_ZONE_START_KIND = "work_zone.start";

/**
 * `POST /agent-channel/v1/work-zone/projects` (the `ocw_work_zone_projects` tool): the projects the turn's human may
 * start a session on. Strict: the human is the stored turn's, never a field (a `userId` key is refused).
 */
export const AgentChannelWorkZoneProjects = z.strictObject({ eventId: Id, agentId: Id });
export type AgentChannelWorkZoneProjects = z.infer<typeof AgentChannelWorkZoneProjects>;

/** Names and ids only: a project's host path never leaves the device (principle 7), so it has no field here. */
export const AgentChannelWorkZoneProjectsResponse = z.object({
  projects: z
    .array(
      z.object({
        projectId: Id,
        name: z.string().max(200),
        device: z.object({ id: Id, name: z.string().max(120), online: z.boolean() }),
        /** Runtimes installed on the device; `available` = signed in and usable now. */
        runtimes: z
          .array(z.object({ id: RuntimeId, label: z.string().max(60), available: z.boolean() }))
          .max(4),
      }),
    )
    .max(50),
});
export type AgentChannelWorkZoneProjectsResponse = z.infer<typeof AgentChannelWorkZoneProjectsResponse>;

/**
 * `POST /agent-channel/v1/work-zone/proposals` (the `ocw_start_work_zone` tool). Strict, and deliberately without a
 * mode: a `permissionMode`, `mode`, `model`, `fullAccess` or `userId` key is a 400, so a bot can never choose Full
 * access (D-03); the session starts in `default` and the person may raise it later through ADR-0012's controls.
 */
export const AgentChannelWorkZonePropose = z.strictObject({
  eventId: Id,
  agentId: Id,
  projectId: Id,
  deviceId: Id,
  prompt: z.string().trim().min(1).max(WORK_ZONE_PROPOSAL_LIMITS.promptChars),
  /** Absent = the device's default runtime. */
  runtime: RuntimeId.optional(),
});
export type AgentChannelWorkZonePropose = z.infer<typeof AgentChannelWorkZonePropose>;

/** Why a proposal was refused before any card existed (the plugin turns each into a fixed sentence). */
export const WorkZoneProposalRefusal = z.enum([
  "unknown_turn",
  "not_in_turn",
  "tainted",
  "cap_reached",
  "not_allowed",
  "prompt_not_allowed",
  "project_not_found",
  "device_not_shared",
  "device_offline",
  "runtime_unavailable",
  "too_many_pending",
]);
export type WorkZoneProposalRefusal = z.infer<typeof WorkZoneProposalRefusal>;

/** `created: false` = an identical proposal (same event, project, device and prompt) was already pending. */
export const AgentChannelWorkZoneProposeResponse = z.union([
  z.strictObject({ approvalId: Id, created: z.boolean() }),
  z.strictObject({ refused: WorkZoneProposalRefusal }),
]);
export type AgentChannelWorkZoneProposeResponse = z.infer<typeof AgentChannelWorkZoneProposeResponse>;

const Person = z.object({ id: Id, displayName: z.string().max(200) });

/**
 * `GET /api/v1/approvals/:id` view of a `work_zone.start` proposal (UI-SPEC Surface 2, R8, R9). Only the requester (the
 * only decider) receives it. `mode` is the literal `default` ("Supervised"): the view cannot express any other.
 */
export const WorkZoneProposalView = z.object({
  type: z.literal("work_zone_proposal"),
  title: z.string().trim().min(1).max(200),
  project: z.object({ id: Id, name: z.string().max(200), removed: z.boolean() }),
  device: z.object({ id: Id, name: z.string().max(120), online: z.boolean(), usable: z.boolean() }),
  runtime: z.object({ id: RuntimeId, label: z.string().max(60), available: z.boolean() }),
  mode: z.literal("default"),
  /** The bot's full prompt (untrusted, plain text). */
  prompt: z.string().max(WORK_ZONE_PROPOSAL_LIMITS.promptChars),
  agent: Person,
  requestedFor: Person,
  origin: ApprovalOrigin.nullable(),
  /** Set once Start created the session. */
  workSessionId: Id.nullable(),
  /** Why Start is disabled right now; null when it can start. */
  startBlocked: WorkZoneStartBlock.nullable(),
});
export type WorkZoneProposalView = z.infer<typeof WorkZoneProposalView>;
