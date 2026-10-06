import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { DiffFile } from "./device-link";
import { Permission } from "./permissions";
import {
  ApprovalOutcome,
  PermissionMode,
  RuntimeId,
  SessionEvent,
  WorkSessionStatus,
} from "./session-events";
import { ContextWindow, EffortLevel, WorkSessionSettings } from "./session-settings";
import { TitleSource } from "./session-title";

/** Working-tree change totals of a session (from the device's last `diff.result`). */
export const DiffStat = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

export const WorkSession = z.object({
  id: Id,
  conversationId: Id,
  projectId: Id,
  projectName: z.string(),
  deviceId: Id,
  deviceName: z.string(),
  deviceOnline: z.boolean(),
  runtime: RuntimeId,
  model: z.string().nullable(),
  permissionMode: PermissionMode,
  worktree: z.boolean(),
  /** Git branch the session works on (reported by the device). */
  branch: z.string().nullable(),
  status: WorkSessionStatus,
  title: z.string(),
  /** Typed (`user`, never replaced), the prompt's first line (`heuristic`) or generated (`auto`) (D-19). */
  titleSource: TitleSource,
  createdBy: Id,
  createdByName: z.string().nullable(),
  /** Prompts waiting in the shared queue. */
  queuedCount: z.number().int().nonnegative(),
  /** Approval requests nobody answered yet ("Needs attention"). */
  pendingApprovals: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** Requested (authorized) settings, what the device reported, and whether a change is pending (D-07, D-14). */
  settings: WorkSessionSettings,
  /** Full access is requested or reported (persistent badge for every controller, D-04). */
  fullAccess: z.boolean(),
  /** When the in-flight turn was dispatched ("Working 5m"); null when nothing runs. */
  runningSince: IsoDateTime.nullable(),
  diffStat: DiffStat.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkSession = z.infer<typeof WorkSession>;

export const WorkSessionList = z.object({ sessions: z.array(WorkSession) });
export type WorkSessionList = z.infer<typeof WorkSessionList>;

export const CreateWorkSessionRequest = z.object({
  projectId: Id,
  /** Optional cross-check: the project's device. */
  deviceId: Id.optional(),
  runtime: RuntimeId.default("claude-code"),
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  permissionMode: PermissionMode.default("default"),
  effort: EffortLevel.optional(),
  fastMode: z.boolean().optional(),
  contextWindow: ContextWindow.optional(),
  /** Work in a dedicated git worktree on the device. */
  worktree: z.boolean().default(false),
  /** Optional first prompt queued immediately. */
  prompt: z.string().trim().min(1).max(50_000).optional(),
});
export type CreateWorkSessionRequest = z.input<typeof CreateWorkSessionRequest>;

export const PromptStatus = z.enum(["queued", "dispatched", "running", "completed", "failed", "cancelled"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const WorkPrompt = z.object({
  id: Id,
  workSessionId: Id,
  authorUserId: Id,
  authorName: z.string().nullable(),
  originDeviceId: Id.nullable(),
  body: z.string(),
  status: PromptStatus,
  position: z.number().int(),
  createdAt: IsoDateTime,
  dispatchedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
});
export type WorkPrompt = z.infer<typeof WorkPrompt>;

/** `POST /api/v1/work-sessions/:id/commands`: a `/` command typed in the composer (P-10). */
export const SessionCommandRequest = z.object({ text: z.string().trim().min(2).max(2000) });
export type SessionCommandRequest = z.infer<typeof SessionCommandRequest>;

export const SessionCommandResult = z.object({
  kind: z.enum(["settings", "prompt", "refused"]),
  command: z.string().max(64),
  notice: z.string().max(500),
  session: WorkSession.optional(),
  prompt: WorkPrompt.optional(),
});
export type SessionCommandResult = z.infer<typeof SessionCommandResult>;

export const CreatePromptRequest = z.object({ body: z.string().trim().min(1).max(50_000) });
export type CreatePromptRequest = z.infer<typeof CreatePromptRequest>;

/** Edit, move (0-based index among queued prompts) or cancel a prompt while it is still queued. */
export const UpdatePromptRequest = z.object({
  body: z.string().trim().min(1).max(50_000).optional(),
  index: z.number().int().nonnegative().optional(),
  status: z.literal("cancelled").optional(),
});
export type UpdatePromptRequest = z.infer<typeof UpdatePromptRequest>;

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const WorkApproval = z.object({
  id: Id,
  workSessionId: Id,
  request: z.object({ tool: z.string(), summary: z.string(), paths: z.array(z.string()) }),
  status: ApprovalStatus,
  decidedBy: Id.nullable(),
  decidedByName: z.string().nullable(),
  decision: ApprovalOutcome.nullable(),
  comment: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type WorkApproval = z.infer<typeof WorkApproval>;

export const ResolveApprovalRequest = z.object({
  decision: z.enum(["once", "session", "deny"]),
  comment: z.string().trim().max(2000).optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

/** A persisted session event (stream `ws:<id>`, type `work_session.event`). */
export const WorkSessionEventRecord = z.object({
  seq: z.number().int().positive(),
  at: IsoDateTime,
  event: SessionEvent,
});
export type WorkSessionEventRecord = z.infer<typeof WorkSessionEventRecord>;

export const WorkSessionDetail = z.object({
  session: WorkSession,
  prompts: z.array(WorkPrompt),
  approvals: z.array(WorkApproval),
  /** Durable session events in order (latest window). Subscribe to `ws:<id>` with `afterSeq = lastSeq`. */
  events: z.array(WorkSessionEventRecord),
  lastSeq: z.number().int().nonnegative(),
  /** Permissions the caller holds on this resource, decided by the API resolver (UI gating only). */
  viewerCan: z.array(Permission).optional(),
});
export type WorkSessionDetail = z.infer<typeof WorkSessionDetail>;

export const WorkSessionDiff = z.object({
  files: z.array(DiffFile),
  patch: z.string(),
  truncated: z.boolean(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  generatedAt: IsoDateTime,
});
export type WorkSessionDiff = z.infer<typeof WorkSessionDiff>;

/**
 * Payloads of the durable events on stream `ws:<id>` (see EventTypes):
 * - `work_session.event` → WorkSessionEventPayload (runtime event from the device)
 * - `work_session.updated` → WorkSession
 * - `prompt.updated` → WorkPrompt
 * - `approval.updated` → WorkApproval
 * and the ephemeral `assistant.delta` → `{ messageId, text }`.
 */
export const WorkSessionEventPayload = z.object({ at: IsoDateTime, event: SessionEvent });
export type WorkSessionEventPayload = z.infer<typeof WorkSessionEventPayload>;

/** `work_session.changes`: file summary of the working tree after a turn (patch via GET /diff). */
export const WorkSessionChanges = z.object({
  files: z.array(DiffFile),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  truncated: z.boolean(),
  at: IsoDateTime,
});
export type WorkSessionChanges = z.infer<typeof WorkSessionChanges>;
