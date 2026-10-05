// Claude Code runtime adapter (Claude Agent SDK, streaming-input mode).
//
// Security invariants (AGENTS.md):
// - never `bypassPermissions`: only default | acceptEdits | plan are accepted, and the CLI is
//   started with `disableBypassPermissionsMode` and without `allowDangerouslySkipPermissions`;
// - secret paths are denied three times over: settings deny rules, a PreToolUse hook and canUseTool;
// - user/local Claude settings are not loaded, so personal allow-rules cannot skip cloud approvals;
// - OCW_* variables (device token) are stripped from the Claude Code process environment;
// - billing: runs on the user's local Claude Code login (subscription) through the installed CLI;
//   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped unless `useApiKey` is set.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalDecision,
  PermissionMode,
  type PromptPayload,
  type RuntimeInfo,
  type SessionEvent,
  type WorkSessionStatus,
} from "@ocw/contracts";
import { AsyncQueue } from "../async-queue.js";
import { filterEnv, findExecutable } from "../exec-path.js";
import { errorMessage, type Logger, silentLogger } from "../logger.js";
import {
  type AgentRuntime,
  type EventSink,
  type RuntimeCapabilities,
  RuntimeError,
  type StartSessionOptions,
} from "../runtime.js";
import { redact } from "../sanitize.js";
import { detectClaudeCode } from "./detect.js";
import { ClaudeEventMapper } from "./mapper.js";
import { extractPaths, secretDenyReason, secretDenyRules, summarizeToolInput } from "./tool-policy.js";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 5_000;

/** The subset of the SDK `Query` the adapter uses; lets tests inject a fake. */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

export interface ClaudeCodeRuntimeOptions {
  queryFn?: QueryFn;
  approvalTimeoutMs?: number;
  /**
   * Claude Code executable. Defaults to the `claude` on PATH (the user's installed CLI, so the
   * session uses the same subscription login as the terminal); falls back to the SDK's bundled CLI.
   */
  claudePath?: string;
  /** Let ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN through to the CLI (metered API billing). Default false. */
  useApiKey?: boolean;
  logger?: Logger;
  detect?: () => Promise<RuntimeInfo>;
}

type ApprovalOutcome = ApprovalDecision | "expired";

interface PendingApproval {
  toolName: string;
  settle(outcome: ApprovalOutcome, comment?: string): void;
}

interface Session {
  id: string;
  cwd: string;
  input: AsyncQueue<SDKUserMessage>;
  q: QueryHandle | null;
  mapper: ClaudeEventMapper;
  sink: EventSink;
  abort: AbortController;
  queue: PromptPayload[];
  running: PromptPayload | null;
  interruptRequested: boolean;
  approvals: Map<string, PendingApproval>;
  sessionAllowedTools: Set<string>;
  status: WorkSessionStatus | null;
  stopping: boolean;
  done: Promise<void>;
}

/**
 * Variables describing an enclosing Claude Code session (set when the daemon itself is launched
 * from a Claude Code terminal). Inheriting them would make the child think it is nested.
 */
const PARENT_SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|EXECPATH|MESSAGING_.*))$/;

/** API credentials that would silently switch billing from the user's subscription to the API. */
export const CLAUDE_API_KEY_VARS: readonly string[] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Environment for the Claude Code child process: never leak daemon credentials (OCW_*), and by
 * default strip Anthropic API keys so the session runs on the local Claude Code login
 * (Pro/Max subscription). `useApiKey` opts back in.
 */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  useApiKey = false,
): Record<string, string | undefined> {
  return filterEnv(
    env,
    (k) =>
      k.startsWith("OCW_") || PARENT_SESSION_VARS.test(k) || (!useApiKey && CLAUDE_API_KEY_VARS.includes(k)),
  );
}

function toUserMessage(prompt: PromptPayload): SDKUserMessage {
  const content =
    prompt.images && prompt.images.length > 0
      ? [
          ...prompt.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.dataBase64 },
          })),
          { type: "text" as const, text: prompt.text },
        ]
      : prompt.text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = "claude-code" as const;
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: false,
    supportsResume: true,
    supportsPermissionModes: ["default", "acceptEdits", "plan"],
    supportsImages: true,
  };

  private readonly sessions = new Map<string, Session>();
  private readonly queryFn: QueryFn;
  private readonly approvalTimeoutMs: number;
  private readonly log: Logger;
  private readonly claudePath: string | null;

  constructor(private readonly opts: ClaudeCodeRuntimeOptions = {}) {
    this.queryFn = opts.queryFn ?? ((params) => sdkQuery(params));
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.log = opts.logger ?? silentLogger;
    this.claudePath = opts.claudePath ?? findExecutable("claude");
  }

  detect(): Promise<RuntimeInfo> {
    if (this.opts.detect) return this.opts.detect();
    return detectClaudeCode({
      ...(this.claudePath ? { claudePath: this.claudePath } : {}),
      useApiKey: this.opts.useApiKey ?? false,
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async start(options: StartSessionOptions, sink: EventSink): Promise<void> {
    if (this.sessions.has(options.sessionId)) {
      throw new RuntimeError(`session ${options.sessionId} already running`, "session_exists");
    }
    const mode = PermissionMode.safeParse(options.permissionMode);
    // The widened platform enum (auto, fullAccess) must never reach the runtime before this adapter supports
    // the mode: anything outside its own capability list is refused first (T-03.2-01-01).
    if (!mode.success || !this.capabilities.supportsPermissionModes.includes(mode.data)) {
      throw new RuntimeError(
        `permission mode not allowed: ${String(options.permissionMode)}`,
        "permission_mode_rejected",
      );
    }
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw new RuntimeError("project directory not found on this device", "runtime_unavailable");
    }

    const input = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const session: Session = {
      id: options.sessionId,
      cwd: options.cwd,
      input,
      mapper: new ClaudeEventMapper(),
      sink,
      abort,
      queue: [],
      running: null,
      interruptRequested: false,
      approvals: new Map(),
      sessionAllowedTools: new Set(),
      status: null,
      stopping: false,
      q: null,
      done: Promise.resolve(),
    };

    const sdkOptions: Options = {
      cwd: options.cwd,
      permissionMode: sdkPermissionMode(mode.data),
      allowDangerouslySkipPermissions: false,
      includePartialMessages: true,
      canUseTool: this.makeCanUseTool(session),
      hooks: { PreToolUse: [{ hooks: [this.makePreToolUseHook(session)] }] },
      // No UI can answer free-form questions yet; the model must ask in its reply instead.
      disallowedTools: ["AskUserQuestion"],
      // Project settings + CLAUDE.md only. User/local settings could carry personal allow-rules
      // (or defaultMode) that would bypass the platform approval gate.
      settingSources: ["project"],
      settings: { permissions: { deny: secretDenyRules(), disableBypassPermissionsMode: "disable" } },
      env: childEnv(process.env, this.opts.useApiKey ?? false),
      abortController: abort,
      stderr: (data: string) =>
        this.log.debug(`[claude-code ${options.sessionId}] ${redact(data.trimEnd())}`),
    };
    if (options.model) sdkOptions.model = options.model;
    if (options.resumeRuntimeSessionId) sdkOptions.resume = options.resumeRuntimeSessionId;
    if (this.claudePath) sdkOptions.pathToClaudeCodeExecutable = this.claudePath;

    const q = this.queryFn({ prompt: input, options: sdkOptions });
    session.q = q;
    this.sessions.set(session.id, session);
    this.emit(session, { type: "session.state", status: "idle" });
    session.done = this.consume(session, q);
  }

  async prompt(sessionId: string, prompt: PromptPayload): Promise<void> {
    const s = this.get(sessionId);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    if (s.running) {
      s.queue.push(prompt);
      return;
    }
    this.dispatch(s, prompt);
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s.running) return;
    s.interruptRequested = true;
    this.settleAllApprovals(s, "deny", "Interrupted");
    try {
      await s.q?.interrupt();
    } catch (err) {
      this.log.warn("interrupt failed", { sessionId, error: errorMessage(err) });
    }
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): boolean {
    const s = this.sessions.get(sessionId);
    const pending = s?.approvals.get(approvalId);
    if (!s || !pending) return false;
    pending.settle(decision, comment);
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.stopping = true;
    s.queue.length = 0;
    if (s.running) await this.interrupt(sessionId);
    this.settleAllApprovals(s, "deny", "Session stopped");
    s.input.close();
    const finished = await Promise.race([
      s.done.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS).unref()),
    ]);
    if (!finished) {
      s.abort.abort();
      try {
        s.q?.close();
      } catch {
        // already closed
      }
      await s.done.catch(() => undefined);
    }
    this.sessions.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  // -------------------------------------------------------------------------------------------

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RuntimeError(`unknown session ${sessionId}`, "unknown_session");
    return s;
  }

  private emit(s: Session, event: SessionEvent): void {
    if (event.type === "session.state") {
      if (s.status === event.status) return;
      s.status = event.status;
    }
    try {
      s.sink(event);
    } catch (err) {
      this.log.error("event sink failed", { sessionId: s.id, error: errorMessage(err) });
    }
  }

  private dispatch(s: Session, prompt: PromptPayload): void {
    s.running = prompt;
    s.interruptRequested = false;
    s.mapper.currentPromptId = prompt.promptId;
    this.emit(s, { type: "prompt.started", promptId: prompt.promptId });
    this.emit(s, { type: "session.state", status: "running" });
    s.input.push(toUserMessage(prompt));
  }

  private async consume(s: Session, q: QueryHandle): Promise<void> {
    try {
      for await (const message of q) {
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.permissionMode === "bypassPermissions"
        ) {
          // Must never happen (we never request it and disable it); fail closed if it does.
          this.emit(s, {
            type: "session.error",
            message: "Runtime reported bypassPermissions mode; session aborted.",
          });
          s.stopping = true;
          s.abort.abort();
          q.close();
          break;
        }
        for (const ev of s.mapper.map(message)) {
          // Session state is owned by the adapter (prompt lifecycle + approvals), not the SDK.
          if (ev.type === "session.state") continue;
          // An interrupted turn ends with an error result; that is expected, not a session error.
          if (ev.type === "session.error" && s.interruptRequested) continue;
          if (ev.type === "prompt.completed") {
            if (s.interruptRequested) ev.interrupted = true;
            this.emit(s, ev);
            this.onTurnComplete(s);
            continue;
          }
          this.emit(s, ev);
        }
      }
      this.finish(s, s.stopping ? null : "Claude Code process exited unexpectedly");
    } catch (err) {
      this.finish(s, s.stopping ? null : errorMessage(err));
    }
  }

  private onTurnComplete(s: Session): void {
    s.running = null;
    s.interruptRequested = false;
    const next = s.queue.shift();
    if (next && !s.stopping) this.dispatch(s, next);
    else this.emit(s, { type: "session.state", status: "idle" });
  }

  private finish(s: Session, error: string | null): void {
    this.settleAllApprovals(s, "deny", "Session ended");
    if (s.running) {
      this.emit(s, {
        type: "prompt.completed",
        promptId: s.running.promptId,
        usage: { inputTokens: 0, outputTokens: 0 },
        isError: true,
        ...(s.interruptRequested ? { interrupted: true } : {}),
      });
      s.running = null;
    }
    if (error) {
      this.emit(s, { type: "session.error", message: error });
      this.emit(s, { type: "session.state", status: "failed" });
    } else {
      this.emit(s, { type: "session.state", status: "completed" });
    }
    if (!s.stopping) this.sessions.delete(s.id);
  }

  private settleAllApprovals(s: Session, outcome: ApprovalOutcome, comment: string): void {
    for (const pending of [...s.approvals.values()]) pending.settle(outcome, comment);
  }

  private makePreToolUseHook(s: Session): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolInput = (
        input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {}
      ) as Record<string, unknown>;
      const reason = secretDenyReason(input.tool_name, toolInput, s.cwd);
      if (!reason) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    };
  }

  private makeCanUseTool(s: Session): CanUseTool {
    return async (toolName, input, { signal, blockedPath, title }): Promise<PermissionResult> => {
      const denied = secretDenyReason(toolName, input, s.cwd);
      if (denied) return { behavior: "deny", message: denied };
      if (s.sessionAllowedTools.has(toolName)) return { behavior: "allow", updatedInput: input };
      if (s.stopping) return { behavior: "deny", message: "Session is stopping." };

      const approvalId = randomUUID();
      const paths = extractPaths(toolName, input);
      if (blockedPath && !paths.includes(blockedPath)) paths.push(blockedPath);
      const detail = summarizeToolInput(toolName, input);
      const summary = title && !detail.startsWith(title) ? `${title}\n${detail}` : detail;

      const result = new Promise<{ outcome: ApprovalOutcome; comment?: string }>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => settle("expired"), this.approvalTimeoutMs);
        const onAbort = () => settle("deny", "Cancelled");
        function settle(outcome: ApprovalOutcome, comment?: string) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          s.approvals.delete(approvalId);
          resolve(comment === undefined ? { outcome } : { outcome, comment });
        }
        signal.addEventListener("abort", onAbort, { once: true });
        s.approvals.set(approvalId, { toolName, settle });
      });

      this.emit(s, { type: "approval.requested", approvalId, tool: toolName, summary, paths });
      this.emit(s, { type: "session.state", status: "waiting_approval" });

      const { outcome, comment } = await result;
      this.emit(s, { type: "approval.resolved", approvalId, decision: outcome });
      if (s.approvals.size === 0 && s.running) this.emit(s, { type: "session.state", status: "running" });

      if (outcome === "session") s.sessionAllowedTools.add(toolName);
      if (outcome === "once" || outcome === "session") return { behavior: "allow", updatedInput: input };
      const message =
        outcome === "expired"
          ? "Approval request expired after 10 minutes without a decision."
          : comment
            ? `Denied by the workspace user: ${comment}`
            : "Denied by the workspace user.";
      return { behavior: "deny", message };
    };
  }
}

/**
 * Platform mode → SDK mode. `fullAccess` is refused here until ADR-0012's path is wired in this adapter
 * (Plan 06): it never becomes `bypassPermissions` by accident.
 */
export function sdkPermissionMode(mode: PermissionMode): NonNullable<Options["permissionMode"]> {
  if (mode === "fullAccess") {
    throw new RuntimeError("full access is not available in this adapter", "permission_mode_rejected");
  }
  return mode;
}
