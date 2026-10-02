import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import { DiffFile } from "./device-link";
import { ApprovalDecision, WorkSessionStatus } from "./session-events";

export const PermissionMode = z.enum(["default", "acceptEdits", "plan"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const WorkSession = z.object({
  id: Id,
  conversationId: Id,
  projectId: Id,
  deviceId: Id,
  runtime: z.literal("claude-code"),
  model: z.string().nullable(),
  permissionMode: PermissionMode,
  status: WorkSessionStatus,
  title: z.string(),
  createdBy: Id,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastSeq: z.number().int().nonnegative().optional(),
});
export type WorkSession = z.infer<typeof WorkSession>;

export const WorkSessionList = z.object({ sessions: z.array(WorkSession) });

export const CreateWorkSessionRequest = z.object({
  projectId: Id,
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().max(200).optional(),
  permissionMode: PermissionMode.default("default"),
  /** Optional first prompt queued immediately. */
  prompt: z.string().trim().min(1).max(50_000).optional(),
});
export type CreateWorkSessionRequest = z.infer<typeof CreateWorkSessionRequest>;

export const PromptStatus = z.enum(["queued", "dispatched", "running", "completed", "failed", "cancelled"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const WorkPrompt = z.object({
  id: Id,
  workSessionId: Id,
  authorUserId: Id,
  originDeviceId: Id.nullable(),
  body: z.string(),
  status: PromptStatus,
  position: z.number().int(),
  createdAt: IsoDateTime,
  dispatchedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
});
export type WorkPrompt = z.infer<typeof WorkPrompt>;

export const CreatePromptRequest = z.object({ body: z.string().trim().min(1).max(50_000) });
export const UpdatePromptRequest = z.object({
  body: z.string().trim().min(1).max(50_000).optional(),
  position: z.number().int().optional(),
  status: z.literal("cancelled").optional(),
});

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);

export const WorkApproval = z.object({
  id: Id,
  workSessionId: Id,
  request: z.object({ tool: z.string(), summary: z.string(), paths: z.array(z.string()) }),
  status: ApprovalStatus,
  decidedBy: Id.nullable(),
  decision: ApprovalDecision.nullable(),
  comment: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type WorkApproval = z.infer<typeof WorkApproval>;

export const ResolveApprovalRequest = z.object({
  decision: ApprovalDecision,
  comment: z.string().max(2000).optional(),
});

export const WorkSessionDetail = z.object({
  session: WorkSession,
  prompts: z.array(WorkPrompt),
  approvals: z.array(WorkApproval),
});
export type WorkSessionDetail = z.infer<typeof WorkSessionDetail>;

export const WorkSessionDiff = z.object({
  files: z.array(DiffFile),
  patch: z.string(),
  branch: z.string().nullable(),
  generatedAt: IsoDateTime,
});
export type WorkSessionDiff = z.infer<typeof WorkSessionDiff>;
