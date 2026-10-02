import { z } from "zod";
import { RelativePath } from "./common";

/**
 * Unified Session Event Protocol (MVP 0 subset). Every runtime adapter maps its native events to this set
 * on the device; unknown events are forwarded as `runtime.raw`. All text passes redact() + contain()
 * before leaving the device (no secrets, no absolute paths).
 */

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
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const ApprovalDecision = z.enum(["once", "session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

export const SessionEvent = z.discriminatedUnion("type", [
  ev("session.started", { runtimeSessionId: z.string().optional() }),
  ev("session.state", { status: WorkSessionStatus }),
  ev("prompt.started", { promptId: z.uuid() }),
  /** Ephemeral (never persisted with a seq). */
  ev("assistant.delta", { messageId: z.string(), text: z.string() }),
  ev("assistant.message", { messageId: z.string(), text: z.string() }),
  ev("tool.started", { toolUseId: z.string(), name: z.string(), summary: z.string() }),
  ev("tool.completed", {
    toolUseId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    output: z.string().max(16_000).optional(),
  }),
  ev("approval.requested", {
    approvalId: z.uuid(),
    tool: z.string(),
    summary: z.string(),
    paths: z.array(RelativePath),
  }),
  ev("approval.resolved", { approvalId: z.uuid(), decision: ApprovalDecision }),
  ev("prompt.completed", { promptId: z.uuid(), usage: Usage.optional(), costUsd: z.number().optional() }),
  ev("session.error", { message: z.string() }),
  ev("runtime.raw", { rawType: z.string(), data: z.unknown() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];

/** Event types that are never persisted (ephemeral `eph` frames only). */
export const EPHEMERAL_SESSION_EVENTS: ReadonlySet<SessionEventType> = new Set(["assistant.delta"]);
