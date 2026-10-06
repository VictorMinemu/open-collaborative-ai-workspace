// AgentRuntime: the only surface the daemon uses to drive a coding runtime (AGENTS.md principle 5).
// Nothing outside an adapter may depend on Codex / Claude Code / OpenCode internals.

import type {
  ApprovalDecision,
  PermissionMode,
  PromptPayload,
  RuntimeCatalog,
  RuntimeId,
  RuntimeInfo,
  SessionEvent,
  SessionSettingsPatch,
} from "@ocw/contracts";

/**
 * A one-shot title call (D-18, P-17): the session runtime's small model names the first prompt. Never the
 * session's own query or thread, no tools, nothing saved to the runtime's history.
 */
export interface TitleRequest {
  /** The start of the session's first prompt (at most `TITLE_PROMPT_MAX_CHARS`). */
  prompt: string;
  /** The small model to use (`TITLE_MODEL[runtime]`), already checked against this runtime's catalog. */
  model: string;
  /** Fired by the daemon's own timeout; the adapter stops the call and releases its process. */
  signal: AbortSignal;
}

export interface RuntimeCapabilities {
  /** Adding input to the RUNNING turn (`steer()`). Claude Code: false (prompts queue). Codex: true. */
  supportsSteer: boolean;
  /** Can reattach to an earlier runtime session id. */
  supportsResume: boolean;
  /**
   * Platform permission modes the adapter accepts (the daemon refuses anything else before calling it). The
   * runtime bypass literals are never among them. `fullAccess` is listed only while the adapter's
   * `allowFullAccess()` gate answers true (ADR-0012), so adapters expose this as a getter.
   */
  supportsPermissionModes: readonly PermissionMode[];
  supportsImages: boolean;
}

export interface StartSessionOptions {
  /** Platform work session id (opaque, from the Control Plane). */
  sessionId: string;
  /** Absolute working directory. Stays on the device; never put it in an event. */
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  contextWindow?: number;
  /** Runtime-native session id from a previous `session.started` event. */
  resumeRuntimeSessionId?: string;
}

/**
 * Options every adapter constructor accepts besides its own. `allowFullAccess` is the daemon's device-local opt-in
 * (ADR-0012, P-12), re-read on every call: false (the default) = the adapter never offers, starts, configures or runs
 * `fullAccess`, whatever the server asks. The daemon checks it too, before any adapter call (defence in depth).
 */
export interface FullAccessGateOptions {
  allowFullAccess?: () => boolean;
}

/** Receives normalised, NOT yet sanitised events; the daemon sanitises before they leave the device. */
export type EventSink = (event: SessionEvent) => void;

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  /** Detect whether this runtime is installed and authenticated on this machine. */
  detect(): Promise<RuntimeInfo>;
  /** Start (or resume) a long-lived session that accepts many prompts. */
  start(options: StartSessionOptions, sink: EventSink): Promise<void>;
  /** Queue a prompt. Prompts run one at a time, in order. */
  prompt(sessionId: string, prompt: PromptPayload): Promise<void>;
  /**
   * Add input to the running turn. Only when `capabilities.supportsSteer`; if no turn is running
   * it behaves like `prompt()`.
   */
  steer?(sessionId: string, prompt: PromptPayload): Promise<void>;
  /** Interrupt the running turn (if any). The session stays alive. */
  interrupt(sessionId: string): Promise<void>;
  /** Resolve a pending `approval.requested`. Returns false if the approval is unknown or already resolved. */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): boolean;
  /**
   * Apply settings between turns (D-07, D-14): while a turn runs they are held and applied before the next one;
   * the adapter then reports the effective values as `session.settings`. Throws `settings_rejected` for a value
   * it cannot apply. Absent = the adapter cannot change settings in a live session.
   */
  configure?(sessionId: string, patch: SessionSettingsPatch): Promise<void>;
  /**
   * What this runtime offers on this device (models, efforts, modes). Never sends a model turn. Absent or null =
   * no catalog (the web then shows no model choices, D-08).
   */
  catalog?(): Promise<RuntimeCatalog | null>;
  /**
   * Generate a short session title with a small model, isolated from every session (D-18). Returns the model's raw
   * text; the daemon normalizes, sanitizes and validates it (`runTitle`). Absent = no automatic titles.
   */
  generateTitle?(req: TitleRequest): Promise<string>;
  /** Stop the session and release the runtime process. */
  stop(sessionId: string): Promise<void>;
  /** Stop every session (daemon shutdown). */
  stopAll(): Promise<void>;
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown_session"
      | "session_exists"
      | "permission_mode_rejected"
      | "runtime_unavailable"
      | "invalid_state"
      | "settings_rejected"
      | "slash_command_refused",
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
