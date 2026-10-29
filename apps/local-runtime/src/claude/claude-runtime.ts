// Claude Code runtime adapter (Claude Agent SDK, streaming-input mode).
//
// Security invariants (AGENTS.md, ADR-0012):
// - `bypassPermissions` only through ADR-0012's path: the platform mode `fullAccess`, authorized by the server
//   (org policy ∩ device opt-in ∩ grain) AND by this device's own opt-in (`allowFullAccess()`, re-read on every
//   start, change and turn). Only then is the CLI launched with `permissionMode: "bypassPermissions"` +
//   `allowDangerouslySkipPermissions`; every other process is launched with `disableBypassPermissionsMode` and
//   without it. Entering or leaving fullAccess (also a per-turn cap below it) relaunches the CLI between turns
//   with `resume` (P-11), so no process keeps bypass availability outside an authorized fullAccess turn;
// - a runtime report of bypassPermissions that nobody authorized (e.g. repo settings) aborts the session (D-03);
// - settings change between turns only (setModel / setPermissionMode / applyFlagSettings with scalar keys,
//   never `permissions`); each turn runs at min(configured mode, the prompt's cap) (P-07);
// - settings / unknown slash commands are refused before they can reach the CLI (D-13 backstop);
// - secret paths are denied three times over: settings deny rules, a PreToolUse hook and canUseTool; the deny
//   rules and the hook stay in Full access too (canUseTool is not consulted in bypass mode) (D-04);
// - user/local Claude settings are not loaded, so personal allow-rules cannot skip cloud approvals;
// - OCW_* variables (device token) are stripped from the Claude Code process environment;
// - billing: runs on the user's local Claude Code login (subscription) through the installed CLI;
//   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped unless `useApiKey` is set;
// - one update authority (07.11 D-12): every CLI process the daemon launches (sessions, catalog, titles) runs with
//   DISABLE_AUTOUPDATER=1, so the CLI never updates itself behind the daemon's update gate;
// - runtime updates never cut a turn (07.11 D-03a): `retireIdle()` closes only the CLI processes of sessions with
//   no turn in flight; such a session is `dormant` and relaunches with `resume` on its next prompt or settings change.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  type CanUseTool,
  type HookCallback,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalDecision,
  minMode,
  PermissionMode,
  type PromptPayload,
  type RuntimeCatalog,
  type RuntimeInfo,
  type SessionEvent,
  type SessionSettingsPatch,
  slashDisposition,
  type WorkSessionStatus,
} from "@ocw/contracts";
import { AsyncQueue } from "../async-queue.js";
import { ocwHome } from "../config.js";
import { filterEnv, findExecutable } from "../exec-path.js";
import { errorMessage, type Logger, silentLogger } from "../logger.js";
import {
  type AgentRuntime,
  type EventSink,
  type FullAccessGateOptions,
  type RuntimeCapabilities,
  RuntimeError,
  type StartSessionOptions,
  type TitleRequest,
} from "../runtime.js";
import { redact } from "../sanitize.js";
import { collectClaudeCatalog, ONE_M_CONTEXT, runtimeModelId } from "./catalog.js";
import { detectClaudeCode } from "./detect.js";
import { ClaudeEventMapper } from "./mapper.js";
import { generateClaudeTitle } from "./title.js";
import { extractPaths, secretDenyReason, secretDenyRules, summarizeToolInput } from "./tool-policy.js";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 5_000;

/** The subset of the SDK `Query` the adapter uses; lets tests inject a fake. */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Next response's model (streaming input only); undefined = the runtime default. sdk.d.ts:2887-2893 */
  setModel(model?: string): Promise<void>;
  /** sdk.d.ts:2858-2864. Never `bypassPermissions` outside ADR-0012's path (Plan 06). */
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  /**
   * Flag settings layer (sdk.d.ts:2920-2944). Only scalar keys: a `permissions` key would REPLACE the secret deny
   * rules and `disableBypassPermissionsMode` passed at start (T-03.2-02-01), so the type does not even allow it.
   */
  applyFlagSettings(settings: {
    effortLevel?: SdkEffortLevel | null;
    fastMode?: boolean | null;
  }): Promise<void>;
  initializationResult(): Promise<{ models: ModelInfo[] }>;
  getContextUsage(opts?: { detail?: "summary" | "full" }): Promise<{ maxTokens: number; model: string }>;
}

type SdkPermissionMode = NonNullable<Options["permissionMode"]>;
type SdkEffortLevel = NonNullable<Options["effort"]>;

/** What the session runs with (platform values; `model` is the catalog id, without the `[1m]` suffix). */
interface RuntimeSettings {
  model: string | null;
  contextWindow: number | null;
  effort: string | null;
  fastMode: boolean;
  permissionMode: PermissionMode;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

export interface ClaudeCodeRuntimeOptions extends FullAccessGateOptions {
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
  /** Working directory of the throw-away catalog query. Default: the OCW home. */
  catalogCwd?: string;
}

/** How long a collected catalog is reused (P-05: the daemon re-sends it on every handshake). */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

type ApprovalOutcome = ApprovalDecision | "expired";

interface PendingApproval {
  toolName: string;
  settle(outcome: ApprovalOutcome, comment?: string): void;
}

interface Session {
  id: string;
  cwd: string;
  /** Runtime session id given at start (resume), used when no init has reported one yet. */
  resumeId: string | null;
  /** The model id last handed to the CLI (catalog id, possibly with `[1m]`); relaunches keep it. */
  runtimeModel: string | undefined;
  /** The current CLI process was launched in bypass mode (authorized fullAccess only). */
  bypass: boolean;
  /** Queries closed by a relaunch or a retirement: their end is not the session's end. */
  retired: WeakSet<QueryHandle>;
  /**
   * The CLI process was retired while idle (07.11 D-03a): no query runs, the session lives on. The next prompt or
   * settings change wakes it with `resume` (so it runs on the binary installed now).
   */
  dormant: boolean;
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
  /** The settings as last authorized by the platform (session.configure / start). */
  configured: RuntimeSettings;
  /** What the runtime currently runs (the permission mode may be lowered for one turn, P-07). */
  applied: RuntimeSettings;
  /** Changes received during a turn, merged (last value wins), applied before the next one (D-14). */
  pending: SessionSettingsPatch | null;
  /** Serialises control requests (settings changes, the per-turn mode) on this session. */
  applying: Promise<void>;
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
 * (Pro/Max subscription). `useApiKey` opts back in. The CLI's own background updater is always off
 * (07.11 D-12): the daemon is the only update authority for the processes it launches. The user's own
 * interactive CLI keeps its updater (nothing outside this env changes).
 */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  useApiKey = false,
): Record<string, string | undefined> {
  return {
    ...filterEnv(
      env,
      (k) =>
        k.startsWith("OCW_") ||
        PARENT_SESSION_VARS.test(k) ||
        (!useApiKey && CLAUDE_API_KEY_VARS.includes(k)),
    ),
    DISABLE_AUTOUPDATER: "1",
  };
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

  get capabilities(): RuntimeCapabilities {
    return {
      supportsSteer: false,
      supportsResume: true,
      // `auto` confirmed by the 2.1.289 settings fixture (setPermissionMode("auto") → init permissionMode "auto").
      // `fullAccess` only while this device's opt-in is on (ADR-0012).
      supportsPermissionModes: [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        ...(this.allowFullAccess() ? (["fullAccess"] as const) : []),
      ],
      supportsImages: true,
    };
  }

  private readonly sessions = new Map<string, Session>();
  private readonly queryFn: QueryFn;
  private readonly approvalTimeoutMs: number;
  private readonly log: Logger;
  /** Re-resolved by `refreshInstall()` (an update may install the CLI where none was found at start). */
  private claudePath: string | null;
  private readonly allowFullAccess: () => boolean;
  private catalogCache: { at: number; value: RuntimeCatalog } | null = null;
  private catalogInFlight: Promise<RuntimeCatalog | null> | null = null;

  constructor(private readonly opts: ClaudeCodeRuntimeOptions = {}) {
    this.queryFn = opts.queryFn ?? ((params) => sdkQuery(params));
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.log = opts.logger ?? silentLogger;
    this.claudePath = opts.claudePath ?? findExecutable("claude");
    this.allowFullAccess = opts.allowFullAccess ?? (() => false);
  }

  detect(): Promise<RuntimeInfo> {
    if (this.opts.detect) return this.opts.detect();
    return detectClaudeCode({
      ...(this.claudePath ? { claudePath: this.claudePath } : {}),
      useApiKey: this.opts.useApiKey ?? false,
    });
  }

  /**
   * The models, efforts, context windows and fast-mode support this login really has (D-08 … D-11), from one
   * throw-away query that never sends a turn. Cached for 10 minutes; null when the CLI is missing or signed out.
   */
  async catalog(): Promise<RuntimeCatalog | null> {
    // The modes follow the device opt-in at the moment of asking, not when the catalog was collected.
    const value = await this.collectCatalog();
    return value && { ...value, permissionModes: [...this.capabilities.supportsPermissionModes] };
  }

  private async collectCatalog(): Promise<RuntimeCatalog | null> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS)
      return this.catalogCache.value;
    if (this.catalogInFlight) return this.catalogInFlight;
    this.catalogInFlight = (async () => {
      const info = await this.detect();
      if (!info.installed || !info.loggedIn) return null;
      const cwd = this.opts.catalogCwd ?? ocwHome();
      await mkdir(cwd, { recursive: true });
      const value = await collectClaudeCatalog(this.queryFn, {
        claudePath: this.claudePath,
        env: childEnv(process.env, this.opts.useApiKey ?? false),
        cwd,
        runtimeVersion: info.version,
        permissionModes: [...this.capabilities.supportsPermissionModes],
      });
      this.catalogCache = { at: Date.now(), value };
      return value;
    })().finally(() => {
      this.catalogInFlight = null;
    });
    return this.catalogInFlight;
  }

  /**
   * A session title from the small model (D-18): a separate one-shot query (claude/title.ts), never a session's
   * own query, input queue or mapper. The init must report the alias or the catalog row's resolved model.
   */
  async generateTitle(req: TitleRequest): Promise<string> {
    const catalog = await this.collectCatalog();
    const row = catalog?.models.find((m) => m.id === req.model);
    return generateClaudeTitle(this.queryFn, {
      claudePath: this.claudePath,
      env: childEnv(process.env, this.opts.useApiKey ?? false),
      prompt: req.prompt,
      model: req.model,
      resolvedModel: row?.resolvedModel ?? null,
      signal: req.signal,
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Sessions with a turn running, waiting on an approval or prompts queued (07.11 D-03). Sends nothing. */
  activeTurns(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (isBusy(s)) n++;
    return n;
  }

  /**
   * Closes the CLI process of every session with no turn in flight (07.11 D-03a), exactly as `relaunch()` closes
   * one, without ending the session: no state, no error. Each wakes lazily with `resume` on its next prompt or
   * settings change. Never interrupts; a session that got busy meanwhile is left alone.
   */
  async retireIdle(): Promise<number> {
    const candidates = [...this.sessions.values()].filter((s) => !s.dormant && !s.stopping && !isBusy(s));
    const retired = await Promise.all(
      candidates.map((s) =>
        // Serialized with settings changes and the per-turn mode, so no control request hits a closing query.
        this.serially(s, async () => {
          if (s.dormant || s.stopping || isBusy(s)) return false;
          await this.closeQuery(s);
          s.q = null;
          s.dormant = true;
          this.log.info("claude-code process retired while idle", { sessionId: s.id });
          return true;
        }),
      ),
    );
    return retired.filter(Boolean).length;
  }

  /** After an update: find the CLI again (unless configured) and collect a fresh catalog next time. */
  refreshInstall(): void {
    this.claudePath = this.opts.claudePath ?? findExecutable("claude");
    this.catalogCache = null;
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
      resumeId: options.resumeRuntimeSessionId ?? null,
      runtimeModel: options.model,
      bypass: mode.data === "fullAccess",
      retired: new WeakSet(),
      dormant: false,
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
      configured: {
        model: options.model ?? null,
        contextWindow: null,
        effort: null,
        fastMode: false,
        permissionMode: mode.data,
      },
      applied: {
        model: options.model ?? null,
        contextWindow: null,
        effort: null,
        fastMode: false,
        permissionMode: mode.data,
      },
      pending: null,
      applying: Promise.resolve(),
    };
    // Start-time effort / fast mode / context window go through the same between-turn path (first turn).
    const initial: SessionSettingsPatch = {};
    if (options.effort !== undefined) initial.effort = options.effort;
    // Fast mode is off unless asked for (no control request for the default).
    if (options.fastMode === true) initial.fastMode = true;
    if (options.contextWindow !== undefined) initial.contextWindow = options.contextWindow;
    if (Object.keys(initial).length > 0) session.pending = initial;

    const sdkOptions = this.launchOptions(session, mode.data, session.resumeId);
    const q = this.queryFn({ prompt: input, options: sdkOptions });
    session.q = q;
    this.sessions.set(session.id, session);
    this.emit(session, { type: "session.state", status: "idle" });
    session.done = this.consume(session, q);
  }

  /**
   * The CLI launch options for `mode`, the ONLY place bypass can be requested (ADR-0012): `fullAccess` with the
   * device gate open → `bypassPermissions` + `allowDangerouslySkipPermissions`, keeping the secret deny rules, the
   * PreToolUse hook and canUseTool (D-04); anything else → bypass disabled outright.
   */
  private launchOptions(s: Session, mode: PermissionMode, resume: string | null): Options {
    const bypass = mode === "fullAccess";
    if (bypass && !this.allowFullAccess()) {
      throw new RuntimeError("Full access is not enabled on this device", "permission_mode_rejected");
    }
    const o: Options = {
      cwd: s.cwd,
      permissionMode: bypass ? "bypassPermissions" : sdkPermissionMode(mode),
      allowDangerouslySkipPermissions: bypass,
      includePartialMessages: true,
      canUseTool: this.makeCanUseTool(s),
      hooks: { PreToolUse: [{ hooks: [this.makePreToolUseHook(s)] }] },
      // No UI can answer free-form questions yet; the model must ask in its reply instead.
      disallowedTools: ["AskUserQuestion"],
      // Project settings + CLAUDE.md only. User/local settings could carry personal allow-rules
      // (or defaultMode) that would bypass the platform approval gate.
      settingSources: ["project"],
      settings: {
        permissions: bypass
          ? { deny: secretDenyRules() }
          : { deny: secretDenyRules(), disableBypassPermissionsMode: "disable" },
      },
      env: childEnv(process.env, this.opts.useApiKey ?? false),
      abortController: s.abort,
      stderr: (data: string) => this.log.debug(`[claude-code ${s.id}] ${redact(data.trimEnd())}`),
    };
    if (s.runtimeModel) o.model = s.runtimeModel;
    if (resume) o.resume = resume;
    if (this.claudePath) o.pathToClaudeCodeExecutable = this.claudePath;
    return o;
  }

  /**
   * P-11: bypass availability is fixed when the CLI starts, so entering or leaving fullAccess replaces the process
   * between turns: the current query is closed (its end is not reported as the session's end), a new one resumes
   * the same runtime session with the launch options of `mode`, and the flag settings it ran with are re-applied.
   */
  private async relaunch(s: Session, mode: PermissionMode): Promise<void> {
    const options = this.launchOptions(s, mode, s.mapper.runtimeSessionId ?? s.resumeId);
    await this.closeQuery(s);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    await this.launch(s, mode, options);
    this.log.info("claude-code relaunched for a permission mode change", {
      sessionId: s.id,
      fullAccess: s.bypass,
    });
  }

  /**
   * Wakes a dormant session (07.11 D-03a): a new CLI process resuming the same runtime session in `mode`, with the
   * flag settings it ran with re-applied, exactly like `relaunch()` minus the close. Callers pass the mode the next
   * step needs, so waking never costs a second launch.
   */
  private async wake(s: Session, mode: PermissionMode): Promise<void> {
    const options = this.launchOptions(s, mode, s.mapper.runtimeSessionId ?? s.resumeId);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    s.dormant = false;
    await this.launch(s, mode, options);
    this.log.info("claude-code woke a retired session", { sessionId: s.id, fullAccess: s.bypass });
  }

  /** Closes the current query so that its end is not the session's end (relaunch, retirement). */
  private async closeQuery(s: Session): Promise<void> {
    const old = s.q;
    if (old) s.retired.add(old);
    s.input.close();
    try {
      old?.close();
    } catch {
      // already closed
    }
    await s.done.catch(() => undefined);
  }

  /** Starts a new query for the session with `options` and re-applies its scalar flag settings. */
  private async launch(s: Session, mode: PermissionMode, options: Options): Promise<void> {
    s.abort = new AbortController();
    options.abortController = s.abort;
    s.input = new AsyncQueue<SDKUserMessage>();
    const q = this.queryFn({ prompt: s.input, options });
    s.q = q;
    s.bypass = mode === "fullAccess";
    s.applied.permissionMode = mode;
    s.done = this.consume(s, q);
    const flags: { effortLevel?: SdkEffortLevel | null; fastMode?: boolean } = {};
    if (s.applied.effort !== null) flags.effortLevel = s.applied.effort as SdkEffortLevel;
    if (s.applied.fastMode) flags.fastMode = true;
    if (Object.keys(flags).length > 0) await q.applyFlagSettings(flags);
  }

  async prompt(sessionId: string, prompt: PromptPayload): Promise<void> {
    const s = this.get(sessionId);
    refuseSlashCommand(prompt.text);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    if (s.running) {
      s.queue.push(prompt);
      return;
    }
    await this.dispatch(s, prompt);
  }

  /**
   * Settings between turns (D-07, D-14): applied at once while idle, otherwise held (merged) and applied before the
   * next turn's user message is pushed. The effective values are reported as `session.settings`; the next
   * `system/init` refines them (D-15).
   */
  async configure(sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    const s = this.get(sessionId);
    if (s.stopping) throw new RuntimeError("session is stopping", "invalid_state");
    if (
      patch.permissionMode !== undefined &&
      !this.capabilities.supportsPermissionModes.includes(patch.permissionMode)
    ) {
      throw new RuntimeError(`permission mode ${patch.permissionMode} is not supported`, "settings_rejected");
    }
    s.pending = { ...(s.pending ?? {}), ...patch };
    if (s.running) return;
    await this.serially(s, async () => {
      // A retired CLI wakes directly in the mode being set, so the change costs one launch.
      if (s.dormant) await this.wake(s, s.pending?.permissionMode ?? s.configured.permissionMode);
      await this.applyPending(s, true);
    });
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
    if (s.dormant) {
      // No process to close: the retired query already ended without reporting.
      await s.applying;
      this.finish(s, null);
      this.sessions.delete(sessionId);
      return;
    }
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

  private async dispatch(s: Session, prompt: PromptPayload): Promise<void> {
    s.running = prompt;
    s.interruptRequested = false;
    this.emit(s, { type: "prompt.started", promptId: prompt.promptId });
    this.emit(s, { type: "session.state", status: "running" });
    // Held settings first: a failure is reported and dropped, the turn still runs with the previous values.
    // Then the turn's mode = min(configured, the author's cap) (P-07): if it cannot be set, the turn fails
    // instead of running at a higher mode.
    const capped = await this.serially(s, async () => {
      if (s.dormant) {
        // 07.11 D-03a: the retired CLI wakes directly in this turn's mode (held mode change and cap included).
        const configured = s.pending?.permissionMode ?? s.configured.permissionMode;
        const mode = prompt.permissionMode ? minMode(configured, prompt.permissionMode) : configured;
        try {
          await this.wake(s, mode);
        } catch (err) {
          if (!s.stopping) {
            this.emit(s, {
              type: "session.error",
              message: `Claude Code could not be restarted for this turn: ${redact(errorMessage(err)).slice(0, 300)}`,
            });
          }
          return false;
        }
      }
      await this.applyPending(s, false);
      try {
        await this.syncMode(s, prompt.permissionMode);
        return true;
      } catch (err) {
        this.emit(s, {
          type: "session.error",
          message: `Permission mode could not be set for this turn: ${redact(errorMessage(err)).slice(0, 300)}`,
        });
        return false;
      }
    });
    // finish() / stop() completes the prompt (a session still dormant only failed to wake: completed below).
    if (s.stopping || (s.input.isClosed && !s.dormant)) return;
    if (!capped) {
      this.emit(s, {
        type: "prompt.completed",
        promptId: prompt.promptId,
        usage: { inputTokens: 0, outputTokens: 0 },
        isError: true,
      });
      await this.onTurnComplete(s);
      return;
    }
    s.mapper.currentPromptId = prompt.promptId;
    s.input.push(toUserMessage(prompt));
  }

  /** Runs `fn` after every earlier control request of this session (never two at once). */
  private serially<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const run = s.applying.then(fn);
    s.applying = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Applies the held change. `strict`: reject with `settings_rejected` (configure while idle). */
  private async applyPending(s: Session, strict: boolean): Promise<void> {
    const patch = s.pending;
    s.pending = null;
    if (!patch || Object.keys(patch).length === 0) return;
    const before = JSON.stringify(s.applied);
    try {
      await this.applyPatch(s, patch);
    } catch (err) {
      const message = redact(errorMessage(err)).slice(0, 500);
      this.emit(s, { type: "session.error", message: `Settings change not applied: ${message}` });
      // Whatever was applied before the failure is still reported (the runtime runs it now).
      if (JSON.stringify(s.applied) !== before) this.emitSettings(s);
      if (strict) throw new RuntimeError(message, "settings_rejected");
      return;
    }
    this.emitSettings(s);
  }

  /** One control request per kind of change; `configured` / `applied` follow each successful step. */
  private async applyPatch(s: Session, patch: SessionSettingsPatch): Promise<void> {
    const q = s.q;
    if (!q) throw new Error("runtime not started");
    if (patch.model !== undefined || patch.contextWindow !== undefined) {
      const model = patch.model !== undefined ? patch.model : s.configured.model;
      const window = patch.contextWindow !== undefined ? patch.contextWindow : s.configured.contextWindow;
      const target = await this.resolveModel(model, window, patch.contextWindow !== undefined);
      await q.setModel(target.runtimeModel);
      s.runtimeModel = target.runtimeModel;
      s.configured.model = s.applied.model = model;
      s.configured.contextWindow = target.requested;
      s.applied.contextWindow = target.reported;
    }
    const flags: { effortLevel?: SdkEffortLevel | null; fastMode?: boolean } = {};
    if (patch.effort !== undefined) flags.effortLevel = patch.effort as SdkEffortLevel | null;
    if (patch.fastMode !== undefined) flags.fastMode = patch.fastMode;
    if (Object.keys(flags).length > 0) {
      await q.applyFlagSettings(flags);
      if (patch.effort !== undefined) s.configured.effort = s.applied.effort = patch.effort;
      if (patch.fastMode !== undefined) s.configured.fastMode = s.applied.fastMode = patch.fastMode;
    }
    if (patch.permissionMode !== undefined && patch.permissionMode !== s.configured.permissionMode) {
      const previous = s.configured.permissionMode;
      s.configured.permissionMode = patch.permissionMode;
      if (!s.running) {
        try {
          await this.syncMode(s, undefined);
        } catch (err) {
          s.configured.permissionMode = previous;
          throw err;
        }
      }
    }
  }

  /**
   * The model id for `setModel` and the window it gives (D-10). A window is selected by re-selecting the model with
   * or without `[1m]`, only where the catalog lists both values; a model's fixed window is accepted as a no-op
   * choice; anything else is `settings_rejected`. `requested` is what the platform asked for (null = default),
   * `reported` the window the runtime will run (from the catalog; null when unknown).
   */
  private async resolveModel(
    model: string | null,
    contextWindow: number | null,
    windowRequested: boolean,
  ): Promise<{ runtimeModel: string | undefined; requested: number | null; reported: number | null }> {
    const catalog = windowRequested ? await this.catalog().catch(() => null) : this.cachedCatalog();
    const id = model ?? catalog?.models.find((m) => m.isDefault)?.id ?? null;
    const entry = id ? catalog?.models.find((m) => m.id === id) : undefined;
    const selectable = entry !== undefined && entry.contextWindows.length > 1;
    if (windowRequested && contextWindow !== null) {
      const fixed = entry?.defaultContextWindow === contextWindow;
      if (!fixed && !(selectable && entry.contextWindows.includes(contextWindow))) {
        throw new RuntimeError(
          `context window ${contextWindow} is not offered for ${id ?? "the default model"}`,
          "settings_rejected",
        );
      }
    }
    // A window kept across a model change only where the new model offers it too.
    const requested =
      selectable && contextWindow !== null && entry.contextWindows.includes(contextWindow)
        ? contextWindow
        : null;
    const oneM = requested === ONE_M_CONTEXT;
    return {
      runtimeModel:
        id && (model !== null || oneM) ? runtimeModelId(id, oneM ? ONE_M_CONTEXT : null) : undefined,
      requested: windowRequested ? contextWindow : requested,
      reported: requested ?? entry?.defaultContextWindow ?? null,
    };
  }

  private cachedCatalog(): RuntimeCatalog | null {
    return this.catalogCache?.value ?? null;
  }

  /**
   * Puts the runtime in `min(configured mode, cap)` (P-07); no request when it already runs that mode. A turn in
   * fullAccess needs the device gate open right now; crossing the fullAccess boundary relaunches the CLI (P-11).
   */
  private async syncMode(s: Session, cap: PermissionMode | undefined): Promise<void> {
    const target = cap ? minMode(s.configured.permissionMode, cap) : s.configured.permissionMode;
    const full = target === "fullAccess";
    if (full && !this.allowFullAccess()) {
      throw new RuntimeError("Full access is not enabled on this device", "permission_mode_rejected");
    }
    if (full !== s.bypass) {
      await this.relaunch(s, target);
      return;
    }
    if (target === s.applied.permissionMode) return;
    // Only an authorized bypass process may be put back into bypass (e.g. after the runtime left it by itself).
    await s.q?.setPermissionMode(full ? "bypassPermissions" : sdkPermissionMode(target));
    s.applied.permissionMode = target;
  }

  private emitSettings(s: Session): void {
    const a = s.applied;
    const ev: Extract<SessionEvent, { type: "session.settings" }> = {
      type: "session.settings",
      permissionMode: a.permissionMode,
      effort: a.effort,
      fastMode: a.fastMode,
    };
    // null model = the runtime default: the next init reports which one it is.
    if (a.model) ev.model = a.model;
    if (a.contextWindow !== null) ev.contextWindow = a.contextWindow;
    this.emit(s, ev);
  }

  private async consume(s: Session, q: QueryHandle): Promise<void> {
    try {
      for await (const message of q) {
        if (s.retired.has(q)) break;
        if (reportsBypass(message) && !this.bypassAuthorized(s)) {
          // D-03 (replaced, not deleted): bypass that did not come through an authorized fullAccess launch
          // (repo settings, a runtime bug) fails closed.
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
            void this.onTurnComplete(s).catch((err: unknown) =>
              this.log.error("next turn failed", { sessionId: s.id, error: errorMessage(err) }),
            );
            continue;
          }
          if (ev.type === "session.settings") this.noteReported(s, ev);
          this.emit(s, ev);
        }
      }
      if (s.retired.has(q)) return; // replaced by a relaunch: not the session's end
      this.finish(s, s.stopping ? null : "Claude Code process exited unexpectedly");
    } catch (err) {
      if (s.retired.has(q)) return;
      this.finish(s, s.stopping ? null : errorMessage(err));
    }
  }

  /** The running process is an authorized fullAccess launch and the device opt-in is still on. */
  private bypassAuthorized(s: Session): boolean {
    return s.bypass && s.applied.permissionMode === "fullAccess" && this.allowFullAccess();
  }

  private async onTurnComplete(s: Session): Promise<void> {
    s.running = null;
    s.interruptRequested = false;
    const next = s.queue.shift();
    if (next && !s.stopping) {
      await this.dispatch(s, next);
      return;
    }
    this.emit(s, { type: "session.state", status: "idle" });
    // A change received during the turn with no prompt behind it is applied now, not at some later prompt.
    if (s.pending && !s.stopping) await this.serially(s, () => this.applyPending(s, false));
  }

  /**
   * The runtime's own report (init) is authoritative for the mode it runs: e.g. leaving plan mode through
   * ExitPlanMode changes it without us (D-15). The server compares it with the authorized mode (Plan 04).
   */
  private noteReported(s: Session, ev: Extract<SessionEvent, { type: "session.settings" }>): void {
    const mode = PermissionMode.safeParse(ev.permissionMode);
    if (mode.success) s.applied.permissionMode = mode.data;
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

/** A turn in flight: running, waiting on an approval or with prompts queued in the adapter (07.11 D-03). */
function isBusy(s: Session): boolean {
  return s.running !== null || s.queue.length > 0 || s.approvals.size > 0;
}

/**
 * D-13 backstop (P-10): a settings command (`/model`, `/effort`, `/fast`, `/permissions`) or any command outside the
 * passthrough allowlist (`/config`, `/mcp`, …) never reaches the CLI raw: it could change runtime state behind the
 * platform's policy and audit. The API already routes or refuses them; this is the device-side guard.
 */
export function refuseSlashCommand(text: string): void {
  const slash = slashDisposition(text, "claude-code");
  if (!slash || slash.kind === "passthrough") return;
  throw new RuntimeError(
    slash.kind === "settings"
      ? `/${slash.name} must be changed from the session controls`
      : `/${slash.name} is not available from the workspace`,
    "slash_command_refused",
  );
}

/** A system frame (init or status) saying the CLI runs `bypassPermissions`. */
function reportsBypass(message: SDKMessage): boolean {
  if (message.type !== "system") return false;
  const m = message as { subtype?: unknown; permissionMode?: unknown };
  return (m.subtype === "init" || m.subtype === "status") && m.permissionMode === "bypassPermissions";
}

/**
 * Platform mode → SDK mode for `setPermissionMode` and non-bypass launches. `fullAccess` is always refused here:
 * it becomes `bypassPermissions` only through `launchOptions` / an authorized bypass process (ADR-0012), never by
 * accident.
 */
export function sdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  if (mode === "fullAccess") {
    throw new RuntimeError("full access is not available in this adapter", "permission_mode_rejected");
  }
  return mode;
}
