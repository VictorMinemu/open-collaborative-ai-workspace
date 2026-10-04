import { z } from "zod";

/**
 * Unified Session Event Protocol (MVP 0 subset). Every runtime adapter maps its native events to this set
 * on the device; unknown events are forwarded as `runtime.raw`. All text passes redact() + contain()
 * before leaving the device (no secrets, no absolute paths). The server re-validates paths with
 * `RelativePath` and drops anything that is not repo-relative.
 */

/** Local runtimes; each uses the user's own subscription login on their device (no API keys). */
export const RuntimeId = z.enum(["claude-code", "codex"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

/** Permission modes a work session may request. `bypassPermissions` is never accepted, anywhere. */
export const PermissionMode = z.enum(["default", "acceptEdits", "plan"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const WorkSessionStatus = z.enum([
  "provisioning",
  "idle",
  "running",
  "waiting_approval",
  "host_offline",
  "completed",
  "failed",
  "archived",
]);
export type WorkSessionStatus = z.infer<typeof WorkSessionStatus>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** What a human can decide on an approval request. */
export const ApprovalDecision = z.enum(["once", "session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** How an approval ended on the device: a decision, or `expired` when nobody answered in time (deny). */
export const ApprovalOutcome = z.union([ApprovalDecision, z.literal("expired")]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

export const SessionEvent = z.discriminatedUnion("type", [
  ev("session.started", {
    runtime: RuntimeId.optional(),
    /** Runtime-native session id; the server stores it to resume after a daemon restart. */
    runtimeSessionId: z.string().max(256).optional(),
    runtimeVersion: z.string().max(64).optional(),
    model: z.string().max(200).optional(),
    permissionMode: z.string().max(32).optional(),
  }),
  ev("session.state", { status: WorkSessionStatus }),
  ev("prompt.started", { promptId: z.string().min(1).max(128) }),
  /** Ephemeral (never persisted with a seq). */
  ev("assistant.delta", { messageId: z.string().max(256), text: z.string() }),
  ev("assistant.message", { messageId: z.string().max(256), text: z.string() }),
  ev("tool.started", { toolUseId: z.string().max(256), name: z.string().max(200), summary: z.string() }),
  ev("tool.completed", {
    toolUseId: z.string().max(256),
    ok: z.boolean(),
    summary: z.string(),
    /** Truncated on the device. */
    output: z.string().max(64_000).optional(),
  }),
  ev("approval.requested", {
    approvalId: z.uuid(),
    tool: z.string().max(200),
    summary: z.string(),
    /** Repo-relative paths (the server drops anything else). */
    paths: z.array(z.string().max(1024)).max(200),
  }),
  ev("approval.resolved", { approvalId: z.uuid(), decision: ApprovalOutcome }),
  ev("prompt.completed", {
    promptId: z.string().min(1).max(128),
    usage: Usage,
    costUsd: z.number().optional(),
    /** The turn failed (the prompt is marked failed). */
    isError: z.boolean().optional(),
    /** The turn was interrupted by a user (the prompt is marked cancelled). */
    interrupted: z.boolean().optional(),
  }),
  ev("session.error", { message: z.string() }),
  /** Unknown runtime event, forwarded as-is (sanitized). The runtime's own type travels as `rawType`. */
  ev("runtime.raw", { rawType: z.string().max(200), data: z.unknown() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];
export type RuntimeRawEvent = Extract<SessionEvent, { type: "runtime.raw" }>;

/** Event types that are never persisted (ephemeral `eph` frames only). */
export const EPHEMERAL_SESSION_EVENTS: ReadonlySet<SessionEventType> = new Set(["assistant.delta"]);
