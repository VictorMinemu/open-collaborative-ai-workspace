// AgentRuntime: the only surface the daemon uses to drive a coding runtime (AGENTS.md principle 5).
// Nothing outside an adapter may depend on Codex / Claude Code / OpenCode internals.

import type {
  ApprovalDecision,
  PermissionMode,
  PromptPayload,
  RuntimeId,
  RuntimeInfo,
  SessionEvent,
} from './protocol.js';

export interface RuntimeCapabilities {
  /** Adding input to the RUNNING turn (`steer()`). Claude Code: false (prompts queue). Codex: true. */
  supportsSteer: boolean;
  /** Can reattach to an earlier runtime session id. */
  supportsResume: boolean;
  /** Permission modes the adapter accepts. `bypassPermissions` is never among them. */
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
  resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision, comment?: string): boolean;
  /** Stop the session and release the runtime process. */
  stop(sessionId: string): Promise<void>;
  /** Stop every session (daemon shutdown). */
  stopAll(): Promise<void>;
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unknown_session'
      | 'session_exists'
      | 'permission_mode_rejected'
      | 'runtime_unavailable'
      | 'invalid_state',
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}
