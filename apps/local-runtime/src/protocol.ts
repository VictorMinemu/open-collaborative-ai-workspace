// TEMP: replace with @ocw/contracts once merged
//
// Mirrors 01-BUILD-SPEC.md sections "Unified Session Event Protocol" and "Realtime -> Device"
// (Device Link frames). Fields marked "additive" are optional extras the daemon sends that the
// spec does not list yet; the integrator should either add them to @ocw/contracts or drop them.

import { z } from 'zod';

export const DEVICE_LINK_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------------------------

/** Permission modes a work session may request. `bypassPermissions` is never accepted. */
export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const WorkSessionStatusSchema = z.enum([
  'provisioning',
  'idle',
  'running',
  'waiting_approval',
  'host_offline',
  'completed',
  'failed',
  'archived',
]);
export type WorkSessionStatus = z.infer<typeof WorkSessionStatusSchema>;

export const ApprovalDecisionSchema = z.enum(['once', 'session', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const RuntimeIdSchema = z.enum(['claude-code', 'codex']);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

// ---------------------------------------------------------------------------------------------
// Unified Session Event Protocol (MVP 0 subset)
// ---------------------------------------------------------------------------------------------

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.started'),
    // additive: runtime metadata, useful for resume and the session header
    runtime: RuntimeIdSchema.optional(),
    runtimeSessionId: z.string().optional(),
    runtimeVersion: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
  }),
  z.object({ type: z.literal('session.state'), status: WorkSessionStatusSchema }),
  z.object({ type: z.literal('prompt.started'), promptId: z.string() }),
  z.object({ type: z.literal('assistant.delta'), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal('assistant.message'), messageId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool.started'),
    toolUseId: z.string(),
    name: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    toolUseId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    output: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval.requested'),
    approvalId: z.string(),
    tool: z.string(),
    summary: z.string(),
    paths: z.array(z.string()),
  }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: z.string(),
    // additive: 'expired' when the 10 min timeout denies the request
    decision: z.union([ApprovalDecisionSchema, z.literal('expired')]),
  }),
  z.object({
    type: z.literal('prompt.completed'),
    promptId: z.string(),
    usage: UsageSchema,
    costUsd: z.number().optional(),
    // additive: lets the server mark the work_prompt failed / cancelled
    isError: z.boolean().optional(),
    interrupted: z.boolean().optional(),
  }),
  z.object({ type: z.literal('session.error'), message: z.string() }),
  // The spec names this event's fields `{type, data}`, which collides with the discriminator, so
  // the runtime's own message type travels as `rawType`.
  z.object({ type: z.literal('runtime.raw'), rawType: z.string(), data: z.unknown() }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
export type RuntimeRawEvent = Extract<SessionEvent, { type: 'runtime.raw' }>;

// ---------------------------------------------------------------------------------------------
// Device Link frames  (device <-> server over GET /runtime/ws, Bearer device token)
// ---------------------------------------------------------------------------------------------

export const RuntimeInfoSchema = z.object({
  id: RuntimeIdSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const DeviceInfoSchema = z.object({
  name: z.string(),
  platform: z.string(),
  arch: z.string().optional(),
  daemonVersion: z.string().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** Project as announced to the server. Never carries an absolute path. */
export const SyncedProjectSchema = z.object({
  localId: z.string(),
  name: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
});
export type SyncedProject = z.infer<typeof SyncedProjectSchema>;

export const DiffFileSchema = z.object({
  path: z.string(), // repo-relative
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'copied', 'unmerged']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  oldPath: z.string().optional(), // additive: renames
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

// device -> server
export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  device: DeviceInfoSchema,
  runtimes: z.array(RuntimeInfoSchema),
});
export const ProjectsSyncFrameSchema = z.object({
  type: z.literal('projects.sync'),
  projects: z.array(SyncedProjectSchema),
});
export const HeartbeatFrameSchema = z.object({ type: z.literal('heartbeat') });
export const AckFrameSchema = z.object({
  type: z.literal('ack'),
  commandId: z.string(),
  // additive: command outcome
  ok: z.boolean().optional(),
  error: z.string().optional(),
});
export const EventFrameSchema = z.object({
  type: z.literal('event'),
  sessionId: z.string(),
  event: SessionEventSchema,
  // additive: per-session monotonic sequence assigned by the device, for de-duplication on replay
  localSeq: z.number().int().nonnegative().optional(),
});
export const DiffResultFrameSchema = z.object({
  type: z.literal('diff.result'),
  requestId: z.string(),
  files: z.array(DiffFileSchema),
  patch: z.string(),
  // additive
  truncated: z.boolean().optional(),
  branch: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
});

export const DeviceFrameSchema = z.discriminatedUnion('type', [
  HelloFrameSchema,
  ProjectsSyncFrameSchema,
  HeartbeatFrameSchema,
  AckFrameSchema,
  EventFrameSchema,
  DiffResultFrameSchema,
]);
export type DeviceFrame = z.infer<typeof DeviceFrameSchema>;
export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;
export type DiffResultFrame = z.infer<typeof DiffResultFrameSchema>;
export type AckFrame = z.infer<typeof AckFrameSchema>;

// server -> device
export const CommandKindSchema = z.enum([
  'session.start',
  'prompt',
  'interrupt',
  'approval.resolve',
  'session.stop',
  'diff.request',
]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const SessionStartPayloadSchema = z.object({
  projectLocalId: z.string(),
  runtime: RuntimeIdSchema.default('claude-code'),
  // Explicitly reject anything outside the allowed set, including 'bypassPermissions'.
  permissionMode: PermissionModeSchema.default('default'),
  model: z.string().optional(),
  worktree: z.boolean().optional(),
  resumeRuntimeSessionId: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const PromptImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  dataBase64: z.string(),
});

export const PromptPayloadSchema = z.object({
  promptId: z.string(),
  text: z.string(),
  images: z.array(PromptImageSchema).optional(),
  // additive: 'steer' adds the input to the running turn when the runtime supports it (Codex);
  // otherwise the prompt is queued.
  delivery: z.enum(['queue', 'steer']).optional(),
});
export type PromptPayload = z.infer<typeof PromptPayloadSchema>;

export const ApprovalResolvePayloadSchema = z.object({
  approvalId: z.string(),
  decision: ApprovalDecisionSchema,
  comment: z.string().optional(),
});
export type ApprovalResolvePayload = z.infer<typeof ApprovalResolvePayloadSchema>;

export const DiffRequestPayloadSchema = z.object({
  // Optional when the session is active on this device; required otherwise.
  projectLocalId: z.string().optional(),
});

export const CommandFrameSchema = z.object({
  type: z.literal('command'),
  id: z.string(),
  kind: CommandKindSchema,
  sessionId: z.string(),
  payload: z.unknown().optional(),
});
export type CommandFrame = z.infer<typeof CommandFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion('type', [CommandFrameSchema]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
