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

/**
 * Permission modes a work session may request (the platform names; adapters map them to their runtime).
 *
 * `fullAccess` is the platform name for a runtime's bypass mode (Claude `bypassPermissions`, Codex
 * `approvalPolicy: "never"` + `danger-full-access`). It is reachable ONLY through ADR-0012's path: org policy ∩
 * device opt-in ∩ the asker's grain, checked server-side on every turn and again by the daemon. The runtime
 * literals themselves (`RUNTIME_BYPASS_LITERALS`) are never accepted by this enum, anywhere.
 */
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "fullAccess"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** The mode ladder (P-03): every cap (policy, device grant, per-turn) is a rank on it. */
export const PERMISSION_MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  fullAccess: 4,
};

/** The less permissive of two modes. */
export function minMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return PERMISSION_MODE_RANK[a] <= PERMISSION_MODE_RANK[b] ? a : b;
}

/** True when `mode` is at or below `cap`; a missing cap (`null`) allows nothing. */
export function modeWithin(mode: PermissionMode, cap: PermissionMode | null): boolean {
  return cap !== null && PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[cap];
}

/** Runtime-native bypass values. Never valid as a `PermissionMode`; seen only in what a runtime reports. */
export const RUNTIME_BYPASS_LITERALS: readonly string[] = [
  "bypassPermissions",
  "dontAsk",
  "danger-full-access",
  "dangerFullAccess",
];

/** A runtime's reported mode means full access (the platform name or a runtime bypass literal). */
export function isFullAccessReport(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw === "fullAccess" || RUNTIME_BYPASS_LITERALS.includes(raw);
}

/** Fast mode as the runtime reports it (Claude `fast_mode_state`; Codex service tier). */
export const FastModeState = z.enum(["on", "off", "cooldown", "unavailable"]);
export type FastModeState = z.infer<typeof FastModeState>;

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
  /**
   * The effective settings the runtime applied (D-07): after a `session.configure`, after every runtime-side
   * change (Claude `system/init`, Codex `thread/settings/updated`) and at start. Values are the runtime's own
   * bounded strings, not enums (Codex effort is an open set).
   */
  ev("session.settings", {
    model: z.string().max(200).nullable().optional(),
    permissionMode: z.string().max(32).optional(),
    effort: z.string().max(32).nullable().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    fastMode: z.boolean().nullable().optional(),
    fastModeState: FastModeState.nullable().optional(),
    fastModeReason: z.string().max(64).nullable().optional(),
    serviceTier: z.string().max(64).nullable().optional(),
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
  /**
   * Phase 07.11 (D-03, PD-07): emitted by the daemon to a session whose new turn waits for a runtime update on its
   * device (`waiting`, once per hold), then `done` (with the new version) or `failed` when the update ends. Persisted
   * so the session timeline shows it after a reload; carries no path.
   */
  ev("runtime.update", {
    runtime: RuntimeId,
    phase: z.enum(["waiting", "done", "failed"]),
    version: z.string().max(64).optional(),
    /**
     * Phase 07.17.1 (PD-18): present when the hold is the OCW runtime's own restart; `runtime` stays the held
     * session's runtime. Old webs ignore it.
     */
    subject: z.literal("ocw-runtime").optional(),
  }),
  /** Unknown runtime event, forwarded as-is (sanitized). The runtime's own type travels as `rawType`. */
  ev("runtime.raw", { rawType: z.string().max(200), data: z.unknown() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];
export type RuntimeRawEvent = Extract<SessionEvent, { type: "runtime.raw" }>;

/** Event types that are never persisted (ephemeral `eph` frames only). */
export const EPHEMERAL_SESSION_EVENTS: ReadonlySet<SessionEventType> = new Set(["assistant.delta"]);
