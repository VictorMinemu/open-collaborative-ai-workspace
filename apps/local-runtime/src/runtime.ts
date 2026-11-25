// AgentRuntime: the only surface the daemon uses to drive a coding runtime (AGENTS.md principle 5).
// Nothing outside an adapter may depend on Codex / Claude Code / OpenCode internals.

import type {
  AccountUsageSnapshot,
  ApprovalDecision,
  PermissionMode,
  PoolLimitReason,
  PromptPayload,
  RuntimeCatalog,
  RuntimeId,
  RuntimeInfo,
  SessionEvent,
  SessionSettingsPatch,
} from "@ocw/contracts";
import type { SessionBrowserTools } from "./browser/manager.js";

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
  /**
   * 07.18-19 R1.8: the session the title is for. An adapter runs a pool session's title on that session's own account
   * (never the device owner's login); absent or unknown = the device's own login, as before.
   */
  sessionId?: string;
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
  /**
   * 07.18 (PD-04): the pool account kinds this adapter can run a session on. Absent or empty = none: the daemon refuses
   * a start or prompt naming an account of another kind before the adapter sees it.
   */
  supportsAccounts?: readonly ("token" | "device_slot")[];
}

/**
 * 07.18 (D-02, PD-03): the pool account a session runs on, as the daemon hands it to an adapter. `ref` is the
 * platform's account id (opaque here). A token lives only in the adapter's memory for that session: never logged,
 * never written to a file, never put in an event, an error or a frame.
 */
export type RuntimeAccount = { ref: string; label: string } & (
  | { kind: "token"; oauthToken: string }
  | { kind: "device_slot"; slotId: string; codexHome: string }
);

/**
 * 07.18 (A-01, A-02 fallback): the session could not resume its conversation under the next account. The turn fails
 * with this message; an adapter never starts a fresh conversation silently instead.
 */
export const ACCOUNT_SWITCH_FAILED_MESSAGE =
  "This conversation could not continue on the next account. Start a new session.";

/**
 * 07.18 (D-07, D-09, PD-05, PD-09): what an adapter reports about the account of a session. `limited` is sent before
 * the turn's `prompt.completed`, at most once per turn; `usage` whenever the runtime reports usage. Signals carry no
 * credential and no account e-mail; the daemon adds the account ref it stored.
 */
export type AccountSignal =
  | { kind: "limited"; promptId: string | null; reason: PoolLimitReason; resetsAt: string | null }
  | { kind: "usage"; usage: AccountUsageSnapshot };

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
  /** 07.18 (PD-03): the pool account to run on. Absent or null = the device's own login (as before 07.18). */
  account?: RuntimeAccount | null;
  /** 07.18 (PD-05): where the adapter reports limits and usage of the session's account. */
  onAccountSignal?: (signal: AccountSignal) => void;
  /**
   * 07.13 (D-07, D-08, PD-07, PD-08): the session's Work Zone browser. The adapter only exposes it (Claude: the
   * in-process `ocw_browser` MCP server; Codex: the stdio shim), and offers the tools only while `available`; every
   * rule (opt-in, turn grant, lease, approvals, admin rules) is the manager's, decided per call. Absent = no browser.
   */
  browser?: SessionBrowserTools;
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
   * 07.18-19 R1.8: whether `catalog()` can answer although the device's own login is signed out (a pool account is in
   * the adapter's memory). Absent = only with the device's own login.
   */
  catalogReadyWithoutLogin?(): boolean;
  /**
   * Generate a short session title with a small model, isolated from every session (D-18). Returns the model's raw
   * text; the daemon normalizes, sanitizes and validates it (`runTitle`). Absent = no automatic titles.
   */
  generateTitle?(req: TitleRequest): Promise<string>;
  /**
   * Sessions of this runtime with a turn running, waiting on an approval or prompts queued in the adapter; never
   * sends anything (07.11 D-03). The update gate updates runtime R only while this is 0 for R.
   */
  activeTurns(): number;
  /**
   * Closes the CLI process of every session with no turn in flight; each resumes lazily on its next prompt or
   * settings change (so it runs on the binary installed by then). Never interrupts, never ends a session; returns how
   * many it retired (07.11 D-03a).
   */
  retireIdle(): Promise<number>;
  /**
   * 07.18 (D-08, PD-03): run the session's next turns on `account` (null = the device's own login). The same account
   * ref changes nothing; otherwise the adapter switches between turns (never inside one), resuming the same runtime
   * session. Absent = the adapter cannot change accounts in a live session.
   */
  useAccount?(sessionId: string, account: RuntimeAccount | null): Promise<void>;
  /** Re-resolve the CLI path and drop cached catalogs after an update (07.11). Absent = nothing cached. */
  refreshInstall?(): void;
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
