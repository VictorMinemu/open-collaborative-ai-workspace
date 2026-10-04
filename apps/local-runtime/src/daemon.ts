// Local Runtime daemon core: config + project registry, outbound Device Link, command handling
// with acks, event forwarding through sanitizeEvent(), and the local control socket.

import { realpathSync } from "node:fs";
import { arch, platform } from "node:os";
import {
  ApprovalResolvePayload,
  type CommandFrame,
  DEVICE_LINK_PROTOCOL_VERSION,
  DeviceAccessToken,
  type DeviceToServerFrame,
  DiffRequestPayload,
  PromptPayload,
  type RuntimeId,
  type RuntimeInfo,
  type SessionEvent,
  SessionStartPayload,
} from "@ocw/contracts";
import { ClaudeCodeRuntime } from "./claude/claude-runtime.js";
import { CodexRuntime } from "./codex/codex-runtime.js";
import {
  deviceName,
  ensureOcwHome,
  type LocalProject,
  loadConfig,
  loadDeviceToken,
  ocwHome,
  ProjectRegistry,
  type RuntimeConfig,
  toWebSocketUrl,
} from "./config.js";
import { type ControlRequest, ControlSocketServer, controlSocketPath } from "./control-socket.js";
import { DeviceLink, type DeviceLinkOptions } from "./device-link.js";
import { FakeRuntime } from "./fake/fake-runtime.js";
import { changedFiles, ensureSessionWorktree, repoInfo, unifiedPatch } from "./git.js";
import { createLogger, errorMessage, type Logger } from "./logger.js";
import type { AgentRuntime } from "./runtime.js";
import { sanitizeEvent, sanitizeString, sanitizeValue } from "./sanitize.js";

export const DAEMON_VERSION = "0.0.0";
const DETECT_CACHE_MS = 60_000;
const MAX_REMEMBERED_COMMANDS = 1000;
/** A cached device JWT is replaced once fewer than this many milliseconds of validity remain. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** `POST {serverUrl}/api/v1/devices/token`: device token → 10-minute device JWT (keeps any path prefix). */
export function toDeviceTokenUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/$/, "")}/api/v1/devices/token`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** The server refused the device token (revoked or unknown device); retried with the link's backoff. */
export class DeviceTokenRejectedError extends Error {
  constructor(readonly status: number) {
    super(`device token rejected by server (HTTP ${status})`);
  }
}

export interface DaemonOptions {
  /** Defaults to OCW_HOME or ~/.ocw */
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: Partial<RuntimeConfig>;
  /** Override the token (tests); otherwise OCW_DEVICE_TOKEN or the token file. */
  token?: string | null;
  runtimes?: AgentRuntime[];
  logger?: Logger;
  link?: Partial<
    Pick<DeviceLinkOptions, "heartbeatMs" | "backoffMinMs" | "backoffMaxMs" | "maxOfflineFrames">
  >;
  /** Socket path override, or false to disable the control socket. */
  controlSocket?: string | false;
}

interface ActiveSession {
  sessionId: string;
  runtime: AgentRuntime;
  project: LocalProject;
  cwd: string;
  worktreeBranch: string | null;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class Daemon {
  readonly registry: ProjectRegistry;
  private link: DeviceLink | null = null;
  private control: ControlSocketServer | null = null;
  private readonly runtimes = new Map<RuntimeId, AgentRuntime>();
  private readonly sessions = new Map<string, ActiveSession>();
  /** Roots per session survive session end so late events are still contained. */
  private readonly rootsBySession = new Map<string, string[]>();
  private readonly seqBySession = new Map<string, number>();
  private readonly processedCommands = new Set<string>();
  private detectCache: { at: number; value: RuntimeInfo[] } | null = null;
  private started = false;
  /** The current device JWT (never logged). */
  private accessToken: { token: string; expiresAtMs: number } | null = null;
  private legacyServerWarned = false;

  private constructor(
    readonly home: string,
    readonly config: RuntimeConfig,
    private readonly token: string | null,
    runtimes: AgentRuntime[],
    private readonly log: Logger,
    private readonly opts: DaemonOptions,
  ) {
    this.registry = new ProjectRegistry(home);
    for (const r of runtimes) this.runtimes.set(r.id, r);
  }

  static async create(opts: DaemonOptions = {}): Promise<Daemon> {
    const env = opts.env ?? process.env;
    const home = opts.home ?? ocwHome(env);
    await ensureOcwHome(home);
    const loaded = await loadConfig(home, env);
    const config = { ...loaded, ...opts.config };
    const log = opts.logger ?? createLogger(config.logLevel);
    const token = opts.token !== undefined ? opts.token : await loadDeviceToken(home, config, env);
    const fake = env.OCW_RUNTIME_FAKE === "1";
    if (fake) log.warn("OCW_RUNTIME_FAKE=1: using the fake runtime (tests/demos only, no model is called)");
    const runtimes = opts.runtimes ??
      (fake ? [new FakeRuntime("claude-code"), new FakeRuntime("codex")] : null) ?? [
        new ClaudeCodeRuntime({
          logger: log,
          useApiKey: config.claude.useApiKey,
          ...(config.claude.path ? { claudePath: config.claude.path } : {}),
        }),
        new CodexRuntime({
          logger: log,
          useApiKey: config.codex.useApiKey,
          ...(config.codex.path ? { codexPath: config.codex.path } : {}),
        }),
      ];
    const daemon = new Daemon(home, config, token, runtimes, log, opts);
    await daemon.registry.load();
    return daemon;
  }

  get isConnected(): boolean {
    return this.link?.connected ?? false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.opts.controlSocket !== false) {
      const path = this.opts.controlSocket ?? controlSocketPath(this.home);
      this.control = new ControlSocketServer(path, (req) => this.handleControl(req), this.log);
      await this.control.listen();
      this.log.info("control socket listening");
    }
    if (!this.token) {
      this.log.warn("no device token found; pair this device from the desktop app, then restart the runtime");
      return;
    }
    this.link = new DeviceLink({
      url: toWebSocketUrl(this.config.serverUrl),
      token: this.token,
      getAccessToken: ({ refresh }) => this.getAccessToken(refresh),
      onOpenFrames: () => this.handshakeFrames(),
      onCommand: (cmd) => void this.handleCommand(cmd),
      logger: this.log,
      ...this.opts.link,
    });
    this.link.start();
    this.log.info("connecting to server", { serverUrl: this.config.serverUrl });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((r) => r.stopAll().catch(() => undefined)));
    this.sessions.clear();
    await this.link?.stop();
    await this.control?.close();
    this.started = false;
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      paired: this.token !== null,
      connected: this.isConnected,
      serverUrl: this.config.serverUrl,
      deviceName: deviceName(this.config),
      queuedFrames: this.link?.queuedFrames ?? 0,
      runtimes: await this.detectRuntimes(),
      projects: this.registry.list().length,
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        projectLocalId: s.project.localId,
        runtime: s.runtime.id,
        worktreeBranch: s.worktreeBranch,
      })),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Device Link

  /**
   * Bearer credential for the next Device Link connect: a 10-minute device JWT exchanged for the device
   * token, cached until fewer than 60 s remain. A server without the exchange (404, built before Phase 2)
   * gets the raw device token. A refused device token (401/403) is logged and rethrown so the link backs
   * off. Neither token is ever logged.
   */
  private async getAccessToken(refresh = false): Promise<string> {
    const deviceToken = this.token;
    if (!deviceToken) throw new Error("device is not paired");
    const cached = this.accessToken;
    if (!refresh && cached && cached.expiresAtMs - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    this.accessToken = null;
    const res = await fetch(toDeviceTokenUrl(this.config.serverUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      if (!this.legacyServerWarned) {
        this.legacyServerWarned = true;
        this.log.warn("server has no device token exchange; connecting with the device token");
      }
      return deviceToken;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      this.log.error("device token rejected by server", { status: res.status });
      throw new DeviceTokenRejectedError(res.status);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`device token exchange failed (HTTP ${res.status})`);
    }
    const parsed = DeviceAccessToken.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("device token exchange returned an invalid answer");
    this.accessToken = { token: parsed.data.token, expiresAtMs: Date.parse(parsed.data.expiresAt) };
    return parsed.data.token;
  }

  private async detectRuntimes(): Promise<RuntimeInfo[]> {
    if (this.detectCache && Date.now() - this.detectCache.at < DETECT_CACHE_MS) return this.detectCache.value;
    const value = await Promise.all(
      [...this.runtimes.values()].map((r) =>
        r.detect().catch((): RuntimeInfo => ({ id: r.id, installed: false, version: null, loggedIn: false })),
      ),
    );
    this.detectCache = { at: Date.now(), value };
    return value;
  }

  private async handshakeFrames(): Promise<DeviceToServerFrame[]> {
    return [
      {
        type: "hello",
        protocolVersion: DEVICE_LINK_PROTOCOL_VERSION,
        device: {
          name: deviceName(this.config),
          platform: platform(),
          arch: arch(),
          daemonVersion: DAEMON_VERSION,
        },
        runtimes: await this.detectRuntimes(),
        sessions: [...this.sessions.keys()],
      },
      { type: "projects.sync", projects: this.registry.toSynced() },
    ];
  }

  private send(frame: DeviceToServerFrame): void {
    this.link?.send(frame);
  }

  private syncProjects(): void {
    // Offline changes are covered by the handshake on reconnect; never queue a stale list.
    if (!this.isConnected) return;
    this.send({ type: "projects.sync", projects: this.registry.toSynced() });
  }

  private rootsFor(cwd: string, project?: LocalProject): string[] {
    const roots = [cwd, realpathOr(cwd)];
    if (project) roots.push(project.path, realpathOr(project.path));
    return roots;
  }

  /** The only path by which runtime events leave the device. */
  forwardEvent(sessionId: string, event: SessionEvent): void {
    const roots = this.rootsBySession.get(sessionId) ?? [];
    // Seeded from the clock (µs-scale) so a restarted daemon never reuses a localSeq the server has
    // already stored for this session; the server drops events whose localSeq is not increasing.
    const localSeq = (this.seqBySession.get(sessionId) ?? Date.now() * 1000) + 1;
    this.seqBySession.set(sessionId, localSeq);
    this.send({ type: "event", sessionId, event: sanitizeEvent(event, roots), localSeq });
  }

  private ack(commandId: string, error?: string, roots: string[] = []): void {
    if (error === undefined) this.send({ type: "ack", commandId, ok: true });
    else this.send({ type: "ack", commandId, ok: false, error: sanitizeString(error, roots) });
  }

  private remember(commandId: string): void {
    this.processedCommands.add(commandId);
    if (this.processedCommands.size > MAX_REMEMBERED_COMMANDS) {
      const first = this.processedCommands.values().next().value;
      if (first !== undefined) this.processedCommands.delete(first);
    }
  }

  async handleCommand(cmd: CommandFrame): Promise<void> {
    if (this.processedCommands.has(cmd.id)) {
      this.ack(cmd.id); // replayed command; already executed
      return;
    }
    this.remember(cmd.id);
    const roots = this.rootsBySession.get(cmd.sessionId) ?? [];
    try {
      switch (cmd.kind) {
        case "session.start":
          await this.startSession(cmd);
          break;
        case "prompt": {
          const s = this.requireSession(cmd.sessionId);
          const prompt = PromptPayload.parse(cmd.payload);
          if (prompt.delivery === "steer" && s.runtime.capabilities.supportsSteer && s.runtime.steer) {
            await s.runtime.steer(cmd.sessionId, prompt);
          } else {
            await s.runtime.prompt(cmd.sessionId, prompt);
          }
          break;
        }
        case "interrupt":
          await this.requireSession(cmd.sessionId).runtime.interrupt(cmd.sessionId);
          break;
        case "approval.resolve": {
          const p = ApprovalResolvePayload.parse(cmd.payload);
          const ok = this.requireSession(cmd.sessionId).runtime.resolveApproval(
            cmd.sessionId,
            p.approvalId,
            p.decision,
            p.comment,
          );
          if (!ok) throw new Error("approval not pending (unknown, expired or already resolved)");
          break;
        }
        case "session.stop": {
          const s = this.sessions.get(cmd.sessionId);
          if (s) {
            await s.runtime.stop(cmd.sessionId);
            this.sessions.delete(cmd.sessionId);
          }
          break;
        }
        case "diff.request":
          await this.sendDiff(cmd);
          break;
      }
      this.ack(cmd.id);
    } catch (err) {
      const message = errorMessage(err);
      this.log.warn("command failed", {
        kind: cmd.kind,
        commandId: cmd.id,
        error: sanitizeString(message, roots),
      });
      this.ack(cmd.id, message, this.rootsBySession.get(cmd.sessionId) ?? roots);
      if (cmd.kind === "session.start") {
        this.forwardEvent(cmd.sessionId, { type: "session.error", message });
        this.forwardEvent(cmd.sessionId, { type: "session.state", status: "failed" });
      }
    }
  }

  private requireSession(sessionId: string): ActiveSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("session is not active on this device");
    return s;
  }

  private async startSession(cmd: CommandFrame): Promise<void> {
    if (this.sessions.has(cmd.sessionId)) return; // idempotent
    const rawMode = (cmd.payload as { permissionMode?: unknown } | undefined)?.permissionMode;
    if (rawMode === "bypassPermissions" || rawMode === "dontAsk" || rawMode === "auto") {
      throw new Error(`permission mode '${String(rawMode)}' is not allowed`);
    }
    const payload = SessionStartPayload.parse(cmd.payload ?? {});
    const project = this.registry.get(payload.projectLocalId);
    if (!project) throw new Error("project is not registered on this device");
    const runtime = this.runtimes.get(payload.runtime);
    if (!runtime) throw new Error(`runtime ${payload.runtime} is not available on this device`);

    let cwd = project.path;
    let worktreeBranch: string | null = null;
    if (payload.worktree) {
      const wt = await ensureSessionWorktree(project.path, cmd.sessionId);
      cwd = wt.path;
      worktreeBranch = wt.branch;
    }
    this.rootsBySession.set(cmd.sessionId, this.rootsFor(cwd, project));
    this.sessions.set(cmd.sessionId, { sessionId: cmd.sessionId, runtime, project, cwd, worktreeBranch });
    try {
      await runtime.start(
        {
          sessionId: cmd.sessionId,
          cwd,
          permissionMode: payload.permissionMode,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.resumeRuntimeSessionId
            ? { resumeRuntimeSessionId: payload.resumeRuntimeSessionId }
            : {}),
        },
        (event) => {
          this.forwardEvent(cmd.sessionId, event);
          if (event.type === "session.state" && (event.status === "failed" || event.status === "completed")) {
            this.sessions.delete(cmd.sessionId);
          }
        },
      );
    } catch (err) {
      this.sessions.delete(cmd.sessionId);
      throw err;
    }
  }

  private async sendDiff(cmd: CommandFrame): Promise<void> {
    const payload = DiffRequestPayload.parse(cmd.payload ?? {});
    const active = this.sessions.get(cmd.sessionId);
    let cwd: string;
    let project: LocalProject | undefined;
    if (active) {
      cwd = active.cwd;
      project = active.project;
    } else {
      project = payload.projectLocalId ? this.registry.get(payload.projectLocalId) : undefined;
      if (!project) throw new Error("no active session or registered project for diff");
      cwd = project.path;
    }
    const roots = this.rootsFor(cwd, project);
    const [files, { patch, truncated }, info] = await Promise.all([
      changedFiles(cwd),
      unifiedPatch(cwd),
      repoInfo(cwd),
    ]);
    this.send(
      sanitizeValue(
        {
          type: "diff.result",
          requestId: cmd.id,
          files,
          patch,
          truncated,
          branch: info.branch,
          headSha: info.headSha,
        },
        roots,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Control socket (local desktop shell only; absolute paths may appear here, never on the wire)

  private async handleControl(req: ControlRequest): Promise<unknown> {
    switch (req.cmd) {
      case "status":
        return this.status();
      case "listProjects":
        return this.registry.list();
      case "addProject": {
        const project = await this.registry.add(req.path, req.name);
        this.syncProjects();
        return project;
      }
      case "removeProject": {
        const removed = await this.registry.remove(req.localId);
        if (removed) this.syncProjects();
        return { removed };
      }
    }
  }
}
