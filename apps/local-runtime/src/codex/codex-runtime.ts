// Codex runtime adapter over `codex app-server` (JSON-RPC on stdio, one process per session).
//
// Security / billing invariants:
// - sandbox, approval policy and reviewer come from one table (`mode-policy.ts`, D-12): Supervised is a
//   read-only sandbox with `untrusted` approvals; never `danger-full-access` or `never` (Plan 06 owns
//   ADR-0012's path). The thread is aborted if Codex reports a full-access sandbox.
// - settings (model, effort, fast tier, mode) are stable per-turn overrides on the next `turn/start`
//   (D-07, D-14); every turn carries the policy of its own mode = min(session mode, the prompt's cap, P-07).
//   `experimentalApi` stays false: no `thread/settings/update`, `collaborationMode` or `permissions`.
// - runs on the user's local Codex login (ChatGPT subscription); OPENAI_API_KEY / CODEX_API_KEY are
//   stripped from the child environment unless `useApiKey` is set. OCW_* never reaches Codex.
// - approval requests (commands, patches, extra permissions) are forwarded as approval.requested
//   and answered from approval.resolve; secret paths are declined without asking.
// Known limit: Codex's sandbox restricts writes and network, not reads; secrets read by a sandboxed
// command are still caught on the way out by redact().

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  type ApprovalDecision,
  minMode,
  PermissionMode,
  type PromptPayload,
  type RuntimeInfo,
  type SessionEvent,
  type SessionSettingsPatch,
  type WorkSessionStatus,
} from "@ocw/contracts";
import { commandTouchesSecrets, isSecretPath } from "../claude/tool-policy.js";
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
import { detectCodex } from "./detect.js";
import type { ApplyPatchApprovalParams } from "./generated/ApplyPatchApprovalParams.js";
import type { ExecCommandApprovalParams } from "./generated/ExecCommandApprovalParams.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { ReviewDecision } from "./generated/ReviewDecision.js";
import type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision.js";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams.js";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams.js";
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { UserInput } from "./generated/v2/UserInput.js";
import { JsonRpcError, type JsonRpcNotification, JsonRpcPeer, type JsonRpcRequest } from "./jsonrpc.js";
import {
  type CodexEffectiveSettings,
  CodexEventMapper,
  codexSettingsEvent,
  summarizeItem,
} from "./mapper.js";
import { type CodexPolicyMode, codexModePolicy, isUnrestrictedCodexPolicy } from "./mode-policy.js";

export const CODEX_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 3_000;

export interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): void;
  once(event: "exit", cb: (code: number | null) => void): unknown;
}

export type SpawnAppServer = (opts: {
  cwd: string;
  env: Record<string, string | undefined>;
}) => AppServerProcess;

export interface CodexRuntimeOptions {
  codexPath?: string;
  /** Let OPENAI_API_KEY / CODEX_API_KEY through (metered API billing). Default false. */
  useApiKey?: boolean;
  approvalTimeoutMs?: number;
  logger?: Logger;
  spawnAppServer?: SpawnAppServer;
  detect?: () => Promise<RuntimeInfo>;
  /** Observe every JSON-RPC message (fixture recording). */
  onRpcMessage?: (direction: "in" | "out", message: unknown) => void;
}

const CODEX_API_KEY_VARS: readonly string[] = ["OPENAI_API_KEY", "CODEX_API_KEY"];
const PARENT_CODEX_VARS = /^CODEX_(SANDBOX.*|THREAD_ID|SESSION_ID|MANAGED_BY_.*)$/;

export function codexChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  useApiKey = false,
): Record<string, string | undefined> {
  return filterEnv(
    env,
    (k) =>
      k.startsWith("OCW_") || PARENT_CODEX_VARS.test(k) || (!useApiKey && CODEX_API_KEY_VARS.includes(k)),
  );
}

type Outcome = ApprovalDecision | "expired";

/** What the platform authorized for the session (merged `configure()` patches; null = runtime default). */
interface ConfiguredSettings {
  model: string | null;
  effort: string | null;
  /** undefined = never chosen: no service tier is sent. */
  fastMode: boolean | undefined;
  permissionMode: CodexPolicyMode;
}

interface Session {
  id: string;
  cwd: string;
  configured: ConfiguredSettings;
  /** Keys changed by `configure()` that no `turn/start` has carried yet (D-14). */
  pending: SessionSettingsPatch | null;
  /** Last effective configuration (thread/start response, readback, or what the last turn/start sent). */
  applied: CodexEffectiveSettings;
  /** Mode of the running turn (P-07). */
  turnMode: CodexPolicyMode | null;
  /** Dedupe key of the last `session.settings` emitted (one event per applied change). */
  lastSettingsKey: string | null;
  proc: AppServerProcess;
  peer: JsonRpcPeer;
  threadId: string;
  mapper: CodexEventMapper;
  sink: EventSink;
  queue: PromptPayload[];
  running: PromptPayload | null;
  steered: string[];
  interruptRequested: boolean;
  approvals: Map<string, (o: Outcome, comment?: string) => void>;
  status: WorkSessionStatus | null;
  stopping: boolean;
  exited: Promise<void>;
  finished: boolean;
}

function toInput(p: PromptPayload): UserInput[] {
  const input: UserInput[] = [];
  for (const img of p.images ?? [])
    input.push({ type: "image", url: `data:${img.mediaType};base64,${img.dataBase64}` });
  input.push({ type: "text", text: p.text, text_elements: [] });
  return input;
}

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: true,
    supportsResume: true,
    supportsPermissionModes: ["default", "acceptEdits", "plan"],
    supportsImages: true,
  };

  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly codexPath: string | null;
  private readonly approvalTimeoutMs: number;

  constructor(private readonly opts: CodexRuntimeOptions = {}) {
    this.log = opts.logger ?? silentLogger;
    this.codexPath = opts.codexPath ?? findExecutable("codex");
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? CODEX_APPROVAL_TIMEOUT_MS;
  }

  detect(): Promise<RuntimeInfo> {
    if (this.opts.detect) return this.opts.detect();
    return detectCodex({
      ...(this.codexPath ? { codexPath: this.codexPath } : {}),
      useApiKey: this.opts.useApiKey ?? false,
    });
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

    const env = codexChildEnv(process.env, this.opts.useApiKey ?? false);
    const proc = this.opts.spawnAppServer
      ? this.opts.spawnAppServer({ cwd: options.cwd, env })
      : this.spawnReal(options.cwd, env);
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) =>
      this.log.debug(`[codex ${options.sessionId}] ${redact(d.trimEnd())}`),
    );

    // The session object is completed once the thread exists; handlers only run after that.
    const startMode = mode.data as CodexPolicyMode;
    const policy = codexModePolicy(startMode, options.cwd);
    const session = {
      id: options.sessionId,
      cwd: options.cwd,
      configured: {
        model: options.model ?? null,
        effort: options.effort ?? null,
        fastMode: options.fastMode,
        permissionMode: startMode,
      },
      pending: null,
      applied: {
        model: options.model ?? null,
        effort: null,
        serviceTier: null,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        approvalsReviewer: policy.approvalsReviewer,
      },
      turnMode: null,
      lastSettingsKey: null,
      proc,
      threadId: "",
      mapper: new CodexEventMapper(),
      sink,
      queue: [],
      running: null,
      steered: [],
      interruptRequested: false,
      approvals: new Map(),
      status: null,
      stopping: false,
      finished: false,
    } as Omit<Session, "peer" | "exited"> as Session;

    session.exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    session.peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
      onNotification: (n) => this.onNotification(session, n),
      onRequest: (r) => this.onServerRequest(session, r),
      onClose: (err) =>
        this.finish(
          session,
          session.stopping ? null : err ? errorMessage(err) : "Codex app-server exited unexpectedly",
        ),
      ...(this.opts.onRpcMessage ? { onLine: this.opts.onRpcMessage } : {}),
    });

    try {
      const init: InitializeParams = {
        clientInfo: { name: "ocw_local_runtime", title: "Open Collaborative AI Workspace", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      await session.peer.request("initialize", init, 30_000);
      session.peer.notify("initialized");

      const threadParams: ThreadStartParams = {
        cwd: options.cwd,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
        ...(options.model ? { model: options.model } : {}),
        ...(options.fastMode !== undefined ? { serviceTier: options.fastMode ? "priority" : "default" } : {}),
      };
      const resp = options.resumeRuntimeSessionId
        ? await session.peer.request<ThreadStartResponse>(
            "thread/resume",
            { ...threadParams, threadId: options.resumeRuntimeSessionId },
            60_000,
          )
        : await session.peer.request<ThreadStartResponse>("thread/start", threadParams, 60_000);
      if (isUnrestrictedCodexPolicy({ approvalPolicy: resp.approvalPolicy, sandboxPolicy: resp.sandbox })) {
        throw new RuntimeError(
          "Codex reported an unrestricted sandbox/approval policy; session aborted",
          "permission_mode_rejected",
        );
      }
      session.threadId = resp.thread.id;
      this.sessions.set(session.id, session);
      this.emit(session, {
        type: "session.started",
        runtime: "codex",
        runtimeSessionId: resp.thread.id,
        model: resp.model,
        permissionMode: mode.data,
      });
      session.applied = {
        model: resp.model ?? session.applied.model,
        effort: resp.reasoningEffort ?? null,
        serviceTier: resp.serviceTier ?? null,
        approvalPolicy: resp.approvalPolicy ?? null,
        sandboxPolicy: resp.sandbox ?? null,
        approvalsReviewer: resp.approvalsReviewer ?? null,
      };
      this.emitSettings(session, codexSettingsEvent(session.applied));
      this.emit(session, { type: "session.state", status: "idle" });
    } catch (err) {
      session.stopping = true;
      session.peer.close();
      proc.kill("SIGTERM");
      throw err instanceof RuntimeError
        ? err
        : new RuntimeError(`codex app-server failed to start: ${errorMessage(err)}`, "runtime_unavailable");
    }
  }

  /**
   * D-07 / D-14: merge authorized settings; nothing is sent now (the stable API has no between-turn setter).
   * The next `turn/start` carries them, and the effective values come back as `session.settings`.
   */
  async configure(sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    const s = this.get(sessionId);
    if (
      patch.permissionMode !== undefined &&
      !this.capabilities.supportsPermissionModes.includes(patch.permissionMode)
    ) {
      throw new RuntimeError(
        `permission mode ${patch.permissionMode} is not supported by Codex`,
        "settings_rejected",
      );
    }
    if (patch.contextWindow !== undefined && patch.contextWindow !== null) {
      throw new RuntimeError(
        "the Codex context window is not selectable (display only)",
        "settings_rejected",
      );
    }
    const c = s.configured;
    if (patch.model !== undefined) c.model = patch.model;
    if (patch.effort !== undefined) c.effort = patch.effort;
    if (patch.fastMode !== undefined) c.fastMode = patch.fastMode;
    if (patch.permissionMode !== undefined) c.permissionMode = patch.permissionMode as CodexPolicyMode;
    s.pending = { ...(s.pending ?? {}), ...patch };
  }

  async prompt(sessionId: string, prompt: PromptPayload): Promise<void> {
    const s = this.get(sessionId);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    if (s.running) {
      s.queue.push(prompt);
      return;
    }
    await this.dispatch(s, prompt);
  }

  async steer(sessionId: string, prompt: PromptPayload): Promise<void> {
    const s = this.get(sessionId);
    const turnId = s.mapper.currentTurnId;
    if (!s.running || !turnId) return this.prompt(sessionId, prompt);
    await s.peer.request("turn/steer", {
      threadId: s.threadId,
      input: toInput(prompt),
      expectedTurnId: turnId,
    });
    s.steered.push(prompt.promptId);
    this.emit(s, { type: "prompt.started", promptId: prompt.promptId });
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s.running) return;
    s.interruptRequested = true;
    this.settleAll(s, "deny", "Interrupted");
    const turnId = s.mapper.currentTurnId;
    if (!turnId) return;
    try {
      await s.peer.request("turn/interrupt", { threadId: s.threadId, turnId }, 15_000);
    } catch (err) {
      this.log.warn("codex interrupt failed", { sessionId, error: errorMessage(err) });
    }
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): boolean {
    const settle = this.sessions.get(sessionId)?.approvals.get(approvalId);
    if (!settle) return false;
    settle(decision, comment);
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.stopping = true;
    s.queue.length = 0;
    if (s.running) await this.interrupt(sessionId);
    this.settleAll(s, "deny", "Session stopped");
    s.proc.stdin.end();
    s.proc.kill("SIGTERM");
    const exited = await Promise.race([
      s.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS).unref()),
    ]);
    if (!exited) s.proc.kill("SIGKILL");
    s.peer.close();
    this.finish(s, null);
    this.sessions.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  // -------------------------------------------------------------------------------------------

  private spawnReal(cwd: string, env: Record<string, string | undefined>): ChildProcess & AppServerProcess {
    if (!this.codexPath) throw new RuntimeError("codex CLI not found on PATH", "runtime_unavailable");
    const child = spawn(this.codexPath, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    return child as ChildProcess & AppServerProcess;
  }

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RuntimeError(`unknown session ${sessionId}`, "unknown_session");
    return s;
  }

  /** One `session.settings` per applied change: the same effective values are never reported twice. */
  private emitSettings(s: Session, event: Extract<SessionEvent, { type: "session.settings" }>): void {
    const { type: _t, contextWindow: _c, ...rest } = event;
    if (Object.keys(rest).length === 0) {
      this.emit(s, event); // context window only (the mapper dedupes it)
      return;
    }
    const key = JSON.stringify(rest);
    if (key === s.lastSettingsKey) return;
    s.lastSettingsKey = key;
    this.emit(s, event);
  }

  /** `turn/start` overrides for this prompt: the configured settings and the policy of the turn's mode. */
  private turnOverrides(
    s: Session,
    prompt: PromptPayload,
  ): { mode: CodexPolicyMode; params: Partial<TurnStartParams> } {
    const c = s.configured;
    // P-07: the turn runs at most at the prompt's cap. fullAccess never reaches here (not in the capabilities).
    const mode = minMode(c.permissionMode, prompt.permissionMode ?? c.permissionMode) as CodexPolicyMode;
    const policy = codexModePolicy(mode, s.cwd);
    return {
      mode,
      params: {
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: policy.sandboxPolicy,
        ...(c.model ? { model: c.model } : {}),
        ...(c.effort ? { effort: c.effort } : {}),
        ...(c.fastMode !== undefined ? { serviceTier: c.fastMode ? "priority" : "default" } : {}),
      },
    };
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

  private async dispatch(s: Session, prompt: PromptPayload): Promise<void> {
    s.running = prompt;
    s.interruptRequested = false;
    s.mapper.currentPromptId = prompt.promptId;
    this.emit(s, { type: "prompt.started", promptId: prompt.promptId });
    this.emit(s, { type: "session.state", status: "running" });
    const { mode, params } = this.turnOverrides(s, prompt);
    s.turnMode = mode;
    s.pending = null;
    try {
      const resp = await s.peer.request<TurnStartResponse>("turn/start", {
        threadId: s.threadId,
        input: toInput(prompt),
        ...params,
      } satisfies TurnStartParams);
      if (!s.mapper.currentTurnId && resp?.turn?.id) s.mapper.currentTurnId = resp.turn.id;
      // A5: when Codex did not report the overrides (thread/settings/updated), synthesize the readback from what
      // was sent. A later readback with the same values is deduplicated; a different one wins.
      s.applied = {
        ...s.applied,
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
        approvalPolicy: params.approvalPolicy ?? s.applied.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer ?? s.applied.approvalsReviewer,
        sandboxPolicy: params.sandboxPolicy ?? s.applied.sandboxPolicy,
      };
      this.emitSettings(s, codexSettingsEvent(s.applied));
    } catch (err) {
      if (s.running?.promptId !== prompt.promptId) return;
      this.emit(s, { type: "session.error", message: `turn/start failed: ${errorMessage(err)}` });
      this.emit(s, {
        type: "prompt.completed",
        promptId: prompt.promptId,
        usage: { inputTokens: 0, outputTokens: 0 },
        isError: true,
      });
      s.mapper.currentPromptId = null;
      this.onTurnComplete(s);
    }
  }

  private onNotification(s: Session, n: JsonRpcNotification): void {
    for (const ev of s.mapper.map(n)) {
      if (ev.type === "session.error" && s.interruptRequested) continue;
      if (ev.type === "session.settings") {
        this.onSettingsReadback(s, n);
        this.emitSettings(s, ev);
        continue;
      }
      if (ev.type === "prompt.completed") {
        this.emit(s, ev);
        for (const promptId of s.steered.splice(0)) {
          this.emit(s, { ...ev, promptId, usage: { inputTokens: 0, outputTokens: 0 } });
        }
        this.onTurnComplete(s);
        continue;
      }
      this.emit(s, ev);
    }
  }

  /** Effective state reported by Codex becomes the base for the next synthesized readback. */
  private onSettingsReadback(s: Session, n: JsonRpcNotification): void {
    if (n.method !== "thread/settings/updated") return;
    const t = (n.params as { threadSettings?: Partial<Record<keyof CodexEffectiveSettings, unknown>> })
      .threadSettings;
    if (!t) return;
    s.applied = {
      model: (t.model as string | null | undefined) ?? s.applied.model,
      effort: (t.effort as string | null | undefined) ?? null,
      serviceTier: (t.serviceTier as string | null | undefined) ?? null,
      approvalPolicy:
        (t.approvalPolicy as CodexEffectiveSettings["approvalPolicy"]) ?? s.applied.approvalPolicy,
      sandboxPolicy: (t.sandboxPolicy as CodexEffectiveSettings["sandboxPolicy"]) ?? s.applied.sandboxPolicy,
      approvalsReviewer:
        (t.approvalsReviewer as CodexEffectiveSettings["approvalsReviewer"]) ?? s.applied.approvalsReviewer,
    };
  }

  private onTurnComplete(s: Session): void {
    s.running = null;
    s.turnMode = null;
    s.interruptRequested = false;
    const next = s.queue.shift();
    if (next && !s.stopping) void this.dispatch(s, next);
    else this.emit(s, { type: "session.state", status: "idle" });
  }

  private finish(s: Session, error: string | null): void {
    if (s.finished) return;
    s.finished = true;
    this.settleAll(s, "deny", "Session ended");
    if (!this.sessions.has(s.id)) return; // never got past start(); start() reports the error
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

  private settleAll(s: Session, outcome: Outcome, comment: string): void {
    for (const settle of [...s.approvals.values()]) settle(outcome, comment);
  }

  /** Emit approval.requested and wait for approval.resolve (or timeout / interrupt). */
  private ask(
    s: Session,
    tool: string,
    summary: string,
    paths: string[],
  ): Promise<{ outcome: Outcome; comment?: string }> {
    if (s.stopping) return Promise.resolve({ outcome: "deny" });
    const approvalId = randomUUID();
    const result = new Promise<{ outcome: Outcome; comment?: string }>((resolve) => {
      const timer = setTimeout(() => settle("expired"), this.approvalTimeoutMs);
      const settle = (outcome: Outcome, comment?: string) => {
        if (!s.approvals.delete(approvalId)) return;
        clearTimeout(timer);
        resolve(comment === undefined ? { outcome } : { outcome, comment });
      };
      s.approvals.set(approvalId, settle);
    });
    this.emit(s, { type: "approval.requested", approvalId, tool, summary, paths });
    this.emit(s, { type: "session.state", status: "waiting_approval" });
    return result.then((r) => {
      this.emit(s, { type: "approval.resolved", approvalId, decision: r.outcome });
      if (s.approvals.size === 0 && s.running) this.emit(s, { type: "session.state", status: "running" });
      return r;
    });
  }

  private async onServerRequest(s: Session, r: JsonRpcRequest): Promise<unknown> {
    switch (r.method) {
      case "item/commandExecution/requestApproval": {
        const p = r.params as CommandExecutionRequestApprovalParams;
        const item = s.mapper.items.get(p.itemId);
        const command = p.command ?? (item?.type === "commandExecution" ? item.command : "");
        if (command && commandTouchesSecrets(command))
          return { decision: "decline" satisfies CommandExecutionApprovalDecision };
        const summary = [
          p.reason,
          command ? `$ ${command}` : null,
          p.networkApprovalContext ? "Requires network access" : null,
        ]
          .filter(Boolean)
          .join("\n");
        const { outcome } = await this.ask(s, "Bash", summary || "Run a command", p.cwd ? [p.cwd] : []);
        const decision: CommandExecutionApprovalDecision =
          outcome === "once" ? "accept" : outcome === "session" ? "acceptForSession" : "decline";
        return { decision };
      }
      case "item/fileChange/requestApproval": {
        const p = r.params as FileChangeRequestApprovalParams;
        const item = s.mapper.items.get(p.itemId);
        const paths = item?.type === "fileChange" ? item.changes.map((c) => c.path) : [];
        if (paths.some((x) => isSecretPath(x, s.cwd))) return { decision: "decline" };
        const summary = [
          p.reason,
          item ? summarizeItem(item) : "Apply file changes",
          p.grantRoot ? `Grant write access to ${p.grantRoot}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        const { outcome } = await this.ask(s, "Edit", summary, p.grantRoot ? [...paths, p.grantRoot] : paths);
        return {
          decision: outcome === "once" ? "accept" : outcome === "session" ? "acceptForSession" : "decline",
        };
      }
      case "item/permissions/requestApproval": {
        const p = r.params as PermissionsRequestApprovalParams;
        const summary = `Additional permissions requested${p.reason ? `: ${p.reason}` : ""}\n${JSON.stringify(p.permissions)}`;
        const { outcome } = await this.ask(s, "Permissions", summary, []);
        const granted: PermissionsRequestApprovalResponse =
          outcome === "once" || outcome === "session"
            ? {
                permissions: {
                  ...(p.permissions.network ? { network: p.permissions.network } : {}),
                  ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}),
                },
                scope: outcome === "session" ? "session" : "turn",
              }
            : { permissions: {}, scope: "turn" };
        return granted;
      }
      case "execCommandApproval": {
        const p = r.params as ExecCommandApprovalParams;
        const command = p.command.join(" ");
        if (commandTouchesSecrets(command))
          return { decision: { denied: { rejection: "secret access blocked" } } satisfies ReviewDecision };
        const { outcome } = await this.ask(s, "Bash", [p.reason, `$ ${command}`].filter(Boolean).join("\n"), [
          p.cwd,
        ]);
        return { decision: this.review(outcome) };
      }
      case "applyPatchApproval": {
        const p = r.params as ApplyPatchApprovalParams;
        const paths = Object.keys(p.fileChanges);
        if (paths.some((x) => isSecretPath(x, s.cwd)))
          return { decision: { denied: { rejection: "secret access blocked" } } };
        const { outcome } = await this.ask(
          s,
          "Edit",
          [p.reason, `Edit ${paths.join(", ")}`].filter(Boolean).join("\n"),
          paths,
        );
        return { decision: this.review(outcome) };
      }
      default:
        throw new JsonRpcError(`${r.method} is not supported by this client`, -32601);
    }
  }

  private review(outcome: Outcome): ReviewDecision {
    if (outcome === "once") return "approved";
    if (outcome === "session") return "approved_for_session";
    return {
      denied: { rejection: outcome === "expired" ? "approval expired" : "denied by the workspace user" },
    };
  }
}
