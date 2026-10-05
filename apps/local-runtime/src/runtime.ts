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

export interface RuntimeCapabilities {
  /** Adding input to the RUNNING turn (`steer()`). Claude Code: false (prompts queue). Codex: true. */
  supportsSteer: boolean;
  /** Can reattach to an earlier runtime session id. */
  supportsResume: boolean;
  /**
   * Platform permission modes the adapter accepts (the daemon refuses anything else before calling it). The
   * runtime bypass literals are never among them; `fullAccess` only once Plan 06 wires ADR-0012's path.
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
