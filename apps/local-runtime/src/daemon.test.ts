import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApprovalDecision,
  type CommandFrame,
  type DeviceToServerFrame,
  type PromptPayload,
  RUNTIME_COMPATIBILITY_MANIFEST,
  type RuntimeCatalog,
  type RuntimeInfo,
  type ServerToDeviceFrame,
  type SessionEvent,
  type SessionSettingsPatch,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { setFullAccessOptIn, setRuntimeUpdatesLevel } from "./config.js";
import { controlRequest } from "./control-socket.js";
import { Daemon } from "./daemon.js";
import { FakeRuntime as ScriptedRuntime } from "./fake/fake-runtime.js";
import { type Logger, silentLogger } from "./logger.js";
import type { RuntimeGate } from "./maintenance/gate.js";
import type { RuntimeMaintenanceOptions } from "./maintenance/maintenance.js";
import type {
  AgentRuntime,
  EventSink,
  RuntimeCapabilities,
  StartSessionOptions,
  TitleRequest,
} from "./runtime.js";

// Fake credential assembled at runtime so secret scanners do not flag the test.
const LEAKY_KEY = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

class FakeRuntime implements AgentRuntime {
  readonly id = "claude-code" as const;
  /** ADR-0012: the daemon's opt-in gate; `fullAccess` is offered only while it answers true. */
  constructor(private readonly allowFullAccess: () => boolean = () => false) {}
  get capabilities(): RuntimeCapabilities {
    return {
      supportsSteer: false,
      supportsResume: true,
      supportsPermissionModes: [
        "default",
        "acceptEdits",
        "plan",
        ...(this.allowFullAccess() ? (["fullAccess"] as const) : []),
      ],
      supportsImages: this.supportsImages,
    };
  }
  /** 06.1-03: whether this stub says it can take images (the daemon refuses image prompts otherwise). */
  supportsImages = false;
  /** When set, `prompt()` rejects with this message (a runtime error echoing its input). */
  promptError: string | null = null;
  interrupts: string[] = [];
  readonly started: StartSessionOptions[] = [];
  readonly resolved: Array<[string, ApprovalDecision]> = [];
  readonly prompts: PromptPayload[] = [];
  readonly configured: SessionSettingsPatch[] = [];
  /** Order in which configure / prompt calls reached the runtime. */
  readonly calls: string[] = [];
  configureDelayMs = 0;
  /** 07.11: what `activeTurns()` reports (0 unless a test sets it); `retireIdle()` calls are counted. */
  activeTurnsCount = 0;
  retireIdleCalls = 0;
  refreshInstallCalls = 0;
  refreshInstall(): void {
    this.refreshInstallCalls++;
  }
  activeTurns(): number {
    return this.activeTurnsCount;
  }
  async retireIdle(): Promise<number> {
    this.retireIdleCalls++;
    return 0;
  }
  sinks = new Map<string, EventSink>();
  /** Catalog rows besides `opus` (the title tests add `haiku`). */
  extraModels: string[] = [];
  /** The title call (03.2-12); default answers like a chatty small model. */
  titleImpl: (req: TitleRequest) => Promise<string> = async () => '"Fix login redirect bug."';
  readonly titleRequests: TitleRequest[] = [];
  generateTitle(req: TitleRequest): Promise<string> {
    this.calls.push(`title:${req.model}`);
    this.titleRequests.push(req);
    return this.titleImpl(req);
  }

  async catalog(): Promise<RuntimeCatalog> {
    return {
      runtime: "claude-code",
      runtimeVersion: "9.9.9",
      models: [
        {
          id: "opus",
          displayName: "Claude Opus",
          description: `lives in ${process.cwd()}`,
          legacy: false,
          isDefault: true,
          badge: null,
          efforts: [],
          defaultEffort: null,
          contextWindows: [],
          defaultContextWindow: null,
          fastMode: { supported: false, reason: null },
          supportsAutoMode: false,
        },
        ...this.extraModels.map((id) => ({
          id,
          displayName: id,
          description: null,
          legacy: false,
          isDefault: false,
          badge: null,
          efforts: [],
          defaultEffort: null,
          contextWindows: [],
          defaultContextWindow: null,
          fastMode: { supported: false, reason: null },
          supportsAutoMode: false,
        })),
      ],
      permissionModes: [...this.capabilities.supportsPermissionModes],
      fastModeCost: null,
      collectedAt: new Date().toISOString(),
    };
  }
  async configure(sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    this.calls.push(`configure:${patch.model ?? patch.permissionMode ?? "?"}`);
    if (this.configureDelayMs) await sleep(this.configureDelayMs);
    this.configured.push(patch);
    if (patch.permissionMode) {
      this.sinks.get(sessionId)?.({ type: "session.settings", permissionMode: patch.permissionMode });
    }
  }

  detect(): Promise<RuntimeInfo> {
    return Promise.resolve({ id: "claude-code", installed: true, version: "9.9.9", loggedIn: true });
  }
  async start(o: StartSessionOptions, sink: EventSink): Promise<void> {
    this.started.push(o);
    this.sinks.set(o.sessionId, sink);
    sink({ type: "session.state", status: "idle" });
  }
  async prompt(sessionId: string, p: PromptPayload): Promise<void> {
    this.calls.push(`prompt:${p.promptId}`);
    this.prompts.push(p);
    if (this.promptError !== null) throw new Error(this.promptError);
    const sink = this.sinks.get(sessionId);
    const cwd = this.started.find((s) => s.sessionId === sessionId)?.cwd ?? "";
    sink?.({ type: "prompt.started", promptId: p.promptId });
    sink?.({ type: "assistant.message", messageId: "m1", text: `Edited ${cwd}/src/x.ts using ${LEAKY_KEY}` });
    sink?.({
      type: "approval.requested",
      approvalId: "ap1",
      tool: "Edit",
      summary: `Edit ${cwd}/src/x.ts`,
      paths: [`${cwd}/src/x.ts`],
    });
  }
  async interrupt(sessionId: string): Promise<void> {
    this.interrupts.push(sessionId);
  }
  resolveApproval(_s: string, approvalId: string, decision: ApprovalDecision): boolean {
    if (approvalId !== "ap1") return false;
    this.resolved.push([approvalId, decision]);
    return true;
  }
  async stop(sessionId: string): Promise<void> {
    this.sinks.get(sessionId)?.({ type: "session.state", status: "completed" });
  }
  async stopAll(): Promise<void> {}
  emit(sessionId: string, e: SessionEvent): void {
    this.sinks.get(sessionId)?.(e);
  }
}

type TokenAnswer = { status: number; body?: unknown };

/**
 * The API as the daemon sees it: `POST /api/v1/devices/token` (device token → device JWT) and the Device
 * Link WebSocket on the same HTTP server.
 */
class FakeServer {
  readonly http: Server;
  readonly wss: WebSocketServer;
  readonly connections: Array<{ ws: WebSocket; req: IncomingMessage; frames: DeviceToServerFrame[] }> = [];
  /** Headers of every token exchange request, in order. */
  readonly exchanges: IncomingHttpHeaders[] = [];
  /** Every device JWT handed out, in order. */
  readonly issued: string[] = [];
  /** How the exchange answers; default: a fresh 10-minute JWT-shaped token. */
  tokenAnswer: () => TokenAnswer = () => this.issue(600_000);
  private listeners: Array<() => void> = [];

  constructor() {
    this.http = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/api/v1/devices/token") {
        res.writeHead(404).end();
        return;
      }
      this.exchanges.push(req.headers);
      const answer = this.tokenAnswer();
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws, req) => {
      const conn = { ws, req, frames: [] as DeviceToServerFrame[] };
      this.connections.push(conn);
      ws.on("message", (d) => {
        conn.frames.push(JSON.parse(d.toString()) as DeviceToServerFrame);
        for (const l of this.listeners) l();
      });
      for (const l of this.listeners) l();
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.http.listen(0, "127.0.0.1", () => resolve()));
  }
  get url(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }
  /** A JWT-shaped device token valid for `ttlMs`. */
  issue(ttlMs: number): TokenAnswer {
    const token = `eyJhbGciOiJFZERTQSJ9.device-${this.issued.length + 1}.signature`;
    this.issued.push(token);
    return { status: 200, body: { token, expiresAt: new Date(Date.now() + ttlMs).toISOString() } };
  }
  get last() {
    const c = this.connections.at(-1);
    if (!c) throw new Error("no connection");
    return c;
  }
  waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = fn();
        if (v !== undefined) {
          this.listeners = this.listeners.filter((l) => l !== check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== check);
        reject(new Error("timed out waiting for frame"));
      }, timeoutMs);
      this.listeners.push(check);
      check();
    });
  }
  frame<T extends DeviceToServerFrame["type"]>(
    type: T,
    pred: (f: Extract<DeviceToServerFrame, { type: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ) {
    return this.waitFor(
      () =>
        this.connections
          .flatMap((c) => c.frames)
          .find(
            (f): f is Extract<DeviceToServerFrame, { type: T }> =>
              f.type === type && pred(f as Extract<DeviceToServerFrame, { type: T }>),
          ),
      timeoutMs,
    );
  }
  /** Every frame the daemon sent, across connections. */
  get allFrames(): DeviceToServerFrame[] {
    return this.connections.flatMap((c) => c.frames);
  }
  /** A server → device frame on the current connection (welcome, runtime.config, …). */
  push(frame: ServerToDeviceFrame): void {
    this.last.ws.send(JSON.stringify(frame));
  }
  send(cmd: Omit<CommandFrame, "type">): void {
    this.last.ws.send(JSON.stringify({ type: "command", ...cmd }));
  }
  async close(): Promise<void> {
    for (const c of this.connections) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}

let home: string;
let project: string;
let server: FakeServer;
let runtime: FakeRuntime;
let daemon: Daemon;
const socketPath = () => join(home, "rt.sock");

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-d-")));
  project = join(home, "acme");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  writeFileSync(join(project, "README.md"), "hello\n");
  server = new FakeServer();
  await server.listen();
  runtime = new FakeRuntime();
  daemon = await Daemon.create({
    home,
    env: {},
    token: "device-token-123",
    config: { serverUrl: server.url },
    runtimes: [runtime],
    logger: silentLogger,
    controlSocket: socketPath(),
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
  });
});

afterEach(async () => {
  await daemon?.stop();
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

/** Through the control socket once the daemon runs; directly in the registry before start(). */
async function addProject(): Promise<string> {
  if (!daemon.isConnected && !existsSync(socketPath())) return (await daemon.registry.add(project)).localId;
  const res = await controlRequest(socketPath(), { cmd: "addProject", path: project });
  expect(res.ok).toBe(true);
  return (res.result as { localId: string }).localId;
}

describe("Daemon <-> Device Link", () => {
  it("handshakes with a device JWT exchanged for the device token, hello and projects.sync (no absolute paths)", async () => {
    await daemon.start();
    const localId = await addProject();
    await server.frame("hello");
    expect(server.exchanges.map((h) => h.authorization)).toEqual(["Bearer device-token-123"]);
    expect(server.last.req.headers.authorization).toBe(`Bearer ${server.issued[0]}`);
    const hello = await server.frame("hello");
    expect(hello).toMatchObject({
      protocolVersion: 1,
      runtimes: [{ id: "claude-code", installed: true, version: "9.9.9", loggedIn: true }],
      fullAccessOptIn: false,
    });
    const sync = await server.frame("projects.sync", (f) => f.projects.length === 1);
    expect(sync.projects).toEqual([
      { localId, name: "acme", gitRemote: null, defaultBranch: "main", git: true },
    ]);
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it("session.start -> events -> prompt -> approval flow, all acked and sanitised", async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");

    server.send({
      id: "c1",
      kind: "session.start",
      sessionId: "ws1",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    await server.frame("ack", (f) => f.commandId === "c1");
    expect(runtime.started[0]).toMatchObject({
      sessionId: "ws1",
      cwd: realpathSync(project),
      permissionMode: "acceptEdits",
    });
    expect(await server.frame("event", (f) => f.sessionId === "ws1")).toMatchObject({
      event: { type: "session.state", status: "idle" },
      localSeq: expect.any(Number),
    });

    server.send({ id: "c2", kind: "prompt", sessionId: "ws1", payload: { promptId: "p1", text: "fix it" } });
    expect(await server.frame("ack", (f) => f.commandId === "c2")).toMatchObject({ ok: true });
    const msg = await server.frame("event", (f) => f.event.type === "assistant.message");
    expect(msg.event).toEqual({
      type: "assistant.message",
      messageId: "m1",
      text: "Edited src/x.ts using [REDACTED:anthropic-key]",
    });
    const approval = await server.frame("event", (f) => f.event.type === "approval.requested");
    expect(approval.event).toMatchObject({ summary: "Edit src/x.ts", paths: ["src/x.ts"] });

    server.send({
      id: "c3",
      kind: "approval.resolve",
      sessionId: "ws1",
      payload: { approvalId: "ap1", decision: "session" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "c3")).toMatchObject({ ok: true });
    expect(runtime.resolved).toEqual([["ap1", "session"]]);

    server.send({
      id: "c4",
      kind: "approval.resolve",
      sessionId: "ws1",
      payload: { approvalId: "nope", decision: "once" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "c4")).toMatchObject({ ok: false });

    // replayed command id: acked again, not re-executed
    server.send({ id: "c2", kind: "prompt", sessionId: "ws1", payload: { promptId: "p1", text: "fix it" } });
    await server.waitFor(() =>
      server.last.frames.filter((f) => f.type === "ack" && f.commandId === "c2").length === 2
        ? true
        : undefined,
    );
    expect(runtime.prompts).toHaveLength(1);

    const seqs = server.last.frames
      .filter((f) => f.type === "event")
      .map((f) => (f as { localSeq: number }).localSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBeGreaterThan(Date.now() * 1000 - 60_000_000);
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it("rejects bypassPermissions and unknown projects with a failed ack", async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: "b1",
      kind: "session.start",
      sessionId: "ws2",
      payload: { projectLocalId: localId, permissionMode: "bypassPermissions" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "b1")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not allowed"),
    });
    expect(
      await server.frame("event", (f) => f.sessionId === "ws2" && f.event.type === "session.state"),
    ).toMatchObject({
      event: { status: "failed" },
    });
    server.send({
      id: "b2",
      kind: "session.start",
      sessionId: "ws3",
      payload: { projectLocalId: "lp_missing" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "b2")).toMatchObject({ ok: false });
    expect(runtime.started).toHaveLength(0);
  });

  it("a project without git: announced git false, a session starts, the diff says no git, a worktree is refused clearly", async () => {
    const plain = join(home, "notes");
    mkdirSync(plain);
    writeFileSync(join(plain, "todo.md"), "- one\n");
    await daemon.start();
    await server.frame("hello");
    const res = await controlRequest(socketPath(), { cmd: "addProject", path: plain });
    expect(res.ok).toBe(true);
    const localId = (res.result as { localId: string }).localId;
    const sync = await server.frame("projects.sync", (f) => f.projects.length === 1);
    expect(sync.projects).toEqual([
      { localId, name: "notes", gitRemote: null, defaultBranch: null, git: false },
    ]);

    server.send({
      id: "n1",
      kind: "session.start",
      sessionId: "wn1",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "n1")).toMatchObject({ ok: true });
    expect(runtime.started[0]).toMatchObject({ sessionId: "wn1", cwd: realpathSync(plain) });

    server.send({ id: "n2", kind: "diff.request", sessionId: "wn1", payload: { projectLocalId: localId } });
    const diff = await server.frame("diff.result", (f) => f.requestId === "n2");
    expect(diff).toMatchObject({
      files: [],
      patch: "",
      truncated: false,
      branch: null,
      headSha: null,
      git: false,
    });
    expect(await server.frame("ack", (f) => f.commandId === "n2")).toMatchObject({ ok: true });

    server.send({
      id: "n3",
      kind: "session.start",
      sessionId: "wn2",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits", worktree: true },
    });
    const refused = await server.frame("ack", (f) => f.commandId === "n3");
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining("this project has no git repository; isolated worktrees need git"),
    });
    expect(runtime.started).toHaveLength(1);
    expect(existsSync(join(plain, ".git"))).toBe(false);
    expect(existsSync(join(plain, ".ocw-worktrees"))).toBe(false);
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it("sends the runtimes' catalogs in a capabilities frame after connect (sanitised, opt-in off)", async () => {
    await daemon.start();
    const caps = await server.frame("capabilities");
    expect(caps.fullAccessOptIn).toBe(false);
    expect(caps.catalogs.map((c) => c.runtime)).toEqual(["claude-code"]);
    expect(caps.catalogs[0]!.models.map((m) => m.id)).toEqual(["opus"]);
    expect(JSON.stringify(caps)).not.toContain(process.cwd());
  });

  it("session.configure reaches the runtime with the parsed patch and is acked", async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "s1", kind: "session.start", sessionId: "wc1", payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "s1");
    server.send({
      id: "k1",
      kind: "session.configure",
      sessionId: "wc1",
      payload: { settings: { model: "sonnet", effort: null }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "k1")).toMatchObject({ ok: true });
    expect(runtime.configured).toEqual([{ model: "sonnet", effort: null }]);
  });

  it("a configure with a mode outside the adapter's capabilities fails and never reaches the runtime", async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "s2", kind: "session.start", sessionId: "wc2", payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "s2");
    server.send({
      id: "k2",
      kind: "session.configure",
      sessionId: "wc2",
      payload: { settings: { permissionMode: "auto" }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "k2")).toMatchObject({
      ok: false,
      error: expect.stringContaining("permission mode auto is not available on this device"),
    });
    server.send({
      id: "k3",
      kind: "session.configure",
      sessionId: "wc2",
      payload: { settings: { permissionMode: "bypassPermissions" }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "k3")).toMatchObject({ ok: false });
    expect(runtime.configured).toEqual([]);
  });

  it("a prompt right after a configure of the same session reaches the runtime after the configure resolved", async () => {
    const localId = await addProject();
    runtime.configureDelayMs = 150;
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "s3", kind: "session.start", sessionId: "wc3", payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "s3");
    server.send({
      id: "k4",
      kind: "session.configure",
      sessionId: "wc3",
      payload: { settings: { model: "haiku" }, reason: "user" },
    });
    server.send({ id: "p4", kind: "prompt", sessionId: "wc3", payload: { promptId: "pp4", text: "go" } });
    await server.frame("ack", (f) => f.commandId === "p4");
    expect(runtime.calls).toEqual(["configure:haiku", "prompt:pp4"]);
    expect(runtime.configured).toEqual([{ model: "haiku" }]);
  });

  it("answers diff.request with repo-relative files and patch", async () => {
    const localId = await addProject();
    writeFileSync(join(project, "new.ts"), "export {};\n");
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "d1", kind: "diff.request", sessionId: "ws9", payload: { projectLocalId: localId } });
    const diff = await server.frame("diff.result", (f) => f.requestId === "d1");
    expect(diff.files.map((f) => f.path).sort()).toEqual(["README.md", "new.ts"]);
    expect(diff.patch).toContain("b/new.ts");
    expect(diff.patch).not.toContain(home);
    await server.frame("ack", (f) => f.commandId === "d1");
  });

  it("buffers events while offline and replays them in order after reconnect", async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "r1", kind: "session.start", sessionId: "ws5", payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "r1");

    const first = server.last;
    first.ws.terminate();
    await server.waitFor(() => (daemon.isConnected ? undefined : true));
    runtime.emit("ws5", { type: "tool.started", toolUseId: "t1", name: "Bash", summary: "$ ls" });
    runtime.emit("ws5", { type: "assistant.delta", messageId: "m", text: "ephemeral" });
    runtime.emit("ws5", { type: "tool.completed", toolUseId: "t1", ok: true, summary: "done" });

    await server.waitFor(() =>
      server.connections.length === 2 && server.last.frames.length >= 5 ? true : undefined,
    );
    const types = server.last.frames.map((f) => (f.type === "event" ? f.event.type : f.type));
    expect(types.slice(0, 5)).toEqual([
      "hello",
      "projects.sync",
      "capabilities",
      "tool.started",
      "tool.completed",
    ]);
  });
});

/** A logger that keeps every line (message + meta) for assertions. */
function captureLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = (level: string) => (msg: string, meta?: Record<string, unknown>) =>
    lines.push(`${level} ${msg} ${meta ? JSON.stringify(meta) : ""}`);
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** Replace the default daemon with one that logs into `logger` (no control socket). */
async function daemonWith(logger: Logger): Promise<Daemon> {
  await daemon.stop();
  daemon = await Daemon.create({
    home,
    env: {},
    token: "device-token-123",
    config: { serverUrl: server.url },
    runtimes: [runtime],
    logger,
    controlSocket: false,
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
  });
  return daemon;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Device JWT exchange", () => {
  it("reuses a cached device JWT on reconnect while more than 60 s remain", async () => {
    await daemon.start();
    await server.frame("hello");
    server.last.ws.terminate();
    await server.waitFor(() => (server.connections.length === 2 ? true : undefined));
    await server.waitFor(() => (server.last.frames.some((f) => f.type === "hello") ? true : undefined));
    expect(server.exchanges).toHaveLength(1);
    expect(server.connections.map((c) => c.req.headers.authorization)).toEqual([
      `Bearer ${server.issued[0]}`,
      `Bearer ${server.issued[0]}`,
    ]);
  });

  it("fetches a fresh device JWT on reconnect when the cached one has less than 60 s left", async () => {
    server.tokenAnswer = () => server.issue(30_000);
    await daemon.start();
    await server.frame("hello");
    server.last.ws.terminate();
    await server.waitFor(() => (server.connections.length === 2 ? true : undefined));
    expect(server.exchanges).toHaveLength(2);
    expect(server.last.req.headers.authorization).toBe(`Bearer ${server.issued[1]}`);
  });

  it("falls back to the raw device token when the server has no exchange (404, older server)", async () => {
    const logger = captureLogger();
    await daemonWith(logger);
    server.tokenAnswer = () => ({ status: 404 });
    await daemon.start();
    await server.frame("hello");
    expect(server.last.req.headers.authorization).toBe("Bearer device-token-123");
    expect(logger.lines.join("\n")).toContain("server has no device token exchange");
  });

  it("a refused device token is logged and retried with backoff, never in a tight loop", async () => {
    const logger = captureLogger();
    await daemonWith(logger);
    server.tokenAnswer = () => ({ status: 401, body: { error: { code: "invalid_device_token" } } });
    await daemon.start();
    await sleep(400);
    expect(server.connections).toHaveLength(0);
    // Backoff 20–50 ms in this test: a handful of attempts in 400 ms, not hundreds.
    expect(server.exchanges.length).toBeGreaterThanOrEqual(2);
    expect(server.exchanges.length).toBeLessThanOrEqual(25);
    const text = logger.lines.join("\n");
    expect(text).toContain("device token rejected by server");
    expect(text).not.toContain("device-token-123");
    expect(daemon.isConnected).toBe(false);
  });

  it("asks for a fresh JWT after the Device Link refused the cached one", async () => {
    let refuse = true;
    server.wss.options.verifyClient = (_info: unknown, done: (ok: boolean, code?: number) => void) => {
      const ok = !refuse;
      refuse = false;
      done(ok, 401);
    };
    await daemon.start();
    await server.frame("hello");
    expect(server.exchanges).toHaveLength(2);
    expect(server.last.req.headers.authorization).toBe(`Bearer ${server.issued[1]}`);
  });

  it("never logs a token", async () => {
    const logger = captureLogger();
    await daemonWith(logger);
    await daemon.start();
    await server.frame("hello");
    const text = logger.lines.join("\n");
    expect(text).not.toContain("device-token-123");
    expect(text).not.toContain(server.issued[0]);
  });
});

describe("Control socket", () => {
  it("is a 0600 unix socket supporting status, list, add and remove", async () => {
    await daemon.start();
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
    const localId = await addProject();
    const list = await controlRequest(socketPath(), { cmd: "listProjects" });
    expect(list.result).toMatchObject([{ localId, path: realpathSync(project), name: "acme" }]);
    const status = await controlRequest(socketPath(), { cmd: "status" });
    expect(status.result).toMatchObject({ paired: true, projects: 1 });
    expect(await controlRequest(socketPath(), { cmd: "removeProject", localId })).toMatchObject({
      ok: true,
      result: { removed: true },
    });
    expect(
      await controlRequest(socketPath(), { cmd: "addProject", path: join(home, "missing") }),
    ).toMatchObject({ ok: false });
  });
});

/** Replace the default daemon with one whose runtime sees the daemon's own Full access gate (ADR-0012). */
async function gatedDaemon(env: NodeJS.ProcessEnv): Promise<Daemon> {
  await daemon.stop();
  daemon = await Daemon.create({
    home,
    env,
    token: "device-token-123",
    config: { serverUrl: server.url },
    runtimes: (allowFullAccess) => {
      runtime = new FakeRuntime(allowFullAccess);
      return [runtime];
    },
    logger: silentLogger,
    controlSocket: socketPath(),
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
  });
  return daemon;
}

const FULL_ACCESS_OFF = "Full access is not enabled on this device";

describe("Full access: the device's own opt-in (ADR-0012, D-02, P-12)", () => {
  it("opt-in off: hello and capabilities say false, no catalog lists fullAccess", async () => {
    await gatedDaemon({});
    await daemon.start();
    expect((await server.frame("hello")).fullAccessOptIn).toBe(false);
    const caps = await server.frame("capabilities");
    expect(caps.fullAccessOptIn).toBe(false);
    expect(caps.catalogs.flatMap((c) => c.permissionModes)).not.toContain("fullAccess");
    const status = await controlRequest(socketPath(), { cmd: "status" });
    expect(status.result).toMatchObject({ fullAccessOptIn: false, fullAccessSource: "config" });
  });

  it("opt-in off: a fullAccess start, configure or prompt fails before reaching the runtime", async () => {
    await gatedDaemon({});
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: "f1",
      kind: "session.start",
      sessionId: "wf1",
      payload: { projectLocalId: localId, permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "f1")).toMatchObject({
      ok: false,
      error: expect.stringContaining(FULL_ACCESS_OFF),
    });
    expect(runtime.started).toEqual([]);

    server.send({
      id: "f2",
      kind: "session.start",
      sessionId: "wf2",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "f2")).toMatchObject({ ok: true });
    server.send({
      id: "f3",
      kind: "session.configure",
      sessionId: "wf2",
      payload: { settings: { permissionMode: "fullAccess" }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "f3")).toMatchObject({
      ok: false,
      error: expect.stringContaining(FULL_ACCESS_OFF),
    });
    expect(runtime.configured).toEqual([]);
    server.send({
      id: "f4",
      kind: "prompt",
      sessionId: "wf2",
      payload: { promptId: "pf4", text: "go", permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "f4")).toMatchObject({
      ok: false,
      error: expect.stringContaining(FULL_ACCESS_OFF),
    });
    expect(runtime.prompts).toEqual([]);
  });

  it("opt-in on (OCW_ALLOW_FULL_ACCESS=1): reported true, fullAccess in the catalog, commands reach the runtime", async () => {
    await gatedDaemon({ OCW_ALLOW_FULL_ACCESS: "1" });
    const localId = await addProject();
    await daemon.start();
    expect((await server.frame("hello")).fullAccessOptIn).toBe(true);
    const caps = await server.frame("capabilities");
    expect(caps.fullAccessOptIn).toBe(true);
    for (const c of caps.catalogs) expect(c.permissionModes).toContain("fullAccess");
    const status = await controlRequest(socketPath(), { cmd: "status" });
    expect(status.result).toMatchObject({ fullAccessOptIn: true, fullAccessSource: "env" });

    server.send({
      id: "g1",
      kind: "session.start",
      sessionId: "wg1",
      payload: { projectLocalId: localId, permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "g1")).toMatchObject({ ok: true });
    expect(runtime.started[0]).toMatchObject({ sessionId: "wg1", permissionMode: "fullAccess" });
    server.send({
      id: "g2",
      kind: "session.configure",
      sessionId: "wg1",
      payload: { settings: { permissionMode: "fullAccess" }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "g2")).toMatchObject({ ok: true });
    expect(runtime.configured).toEqual([{ permissionMode: "fullAccess" }]);
    server.send({
      id: "g3",
      kind: "prompt",
      sessionId: "wg1",
      payload: { promptId: "pg3", text: "go", permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "g3")).toMatchObject({ ok: true });
    expect(runtime.prompts.map((p) => p.permissionMode)).toEqual(["fullAccess"]);
  });

  it("a fullAccess prompt in an acceptEdits session runs at acceptEdits (min rule, never a raise)", async () => {
    await daemon.stop();
    daemon = await Daemon.create({
      home,
      env: { OCW_ALLOW_FULL_ACCESS: "1" },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: (allowFullAccess) => [new ScriptedRuntime("claude-code", 1, { allowFullAccess })],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: "m1",
      kind: "session.start",
      sessionId: "wm1",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    await server.frame("ack", (f) => f.commandId === "m1");
    server.send({
      id: "m2",
      kind: "prompt",
      sessionId: "wm1",
      payload: { promptId: "pm2", text: "go", permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "m2")).toMatchObject({ ok: true });
    const done = await server.frame(
      "event",
      (f) => f.sessionId === "wm1" && f.event.type === "assistant.message" && f.event.text.includes("Mode:"),
    );
    expect(done.event).toMatchObject({ text: expect.stringContaining("Mode: acceptEdits") });
    const modes = server.last.frames.flatMap((f) =>
      f.type === "event" && f.event.type === "session.settings" ? [f.event.permissionMode] : [],
    );
    expect(modes).not.toContain("fullAccess");
  });
});

describe("Full access: reloadConfig (the desktop menu / CLI path, D-02, P-12)", () => {
  it("turning the opt-in off interrupts full-access turns, lowers the sessions, refuses fullAccess and tells the server", async () => {
    await setFullAccessOptIn(home, true);
    await gatedDaemon({});
    const localId = await addProject();
    await daemon.start();
    expect((await server.frame("hello")).fullAccessOptIn).toBe(true);
    server.send({
      id: "o1",
      kind: "session.start",
      sessionId: "wo1",
      payload: { projectLocalId: localId, permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "o1")).toMatchObject({ ok: true });
    server.send({
      id: "o2",
      kind: "session.start",
      sessionId: "wo2",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    await server.frame("ack", (f) => f.commandId === "o2");

    await setFullAccessOptIn(home, false);
    const res = await controlRequest(socketPath(), { cmd: "reloadConfig" });
    expect(res).toMatchObject({ ok: true, result: { fullAccessOptIn: false, fullAccessSource: "config" } });
    expect(runtime.interrupts).toEqual(["wo1"]);
    const caps = await server.frame(
      "capabilities",
      (f) => !f.fullAccessOptIn && server.last.frames.indexOf(f) > 2,
    );
    expect(caps.catalogs.flatMap((c) => c.permissionModes)).not.toContain("fullAccess");
    await server.waitFor(() => (runtime.configured.length > 0 ? true : undefined));
    expect(runtime.configured).toEqual([{ permissionMode: "acceptEdits" }]);
    expect(
      await server.frame("event", (f) => f.sessionId === "wo1" && f.event.type === "session.settings"),
    ).toMatchObject({ event: { permissionMode: "acceptEdits" } });

    server.send({
      id: "o3",
      kind: "prompt",
      sessionId: "wo1",
      payload: { promptId: "po3", text: "go", permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "o3")).toMatchObject({
      ok: false,
      error: expect.stringContaining(FULL_ACCESS_OFF),
    });
    // The session now runs at acceptEdits: an uncapped prompt is fine.
    server.send({ id: "o4", kind: "prompt", sessionId: "wo1", payload: { promptId: "po4", text: "go" } });
    expect(await server.frame("ack", (f) => f.commandId === "o4")).toMatchObject({ ok: true });

    // Turning it back on is reported at once too.
    await setFullAccessOptIn(home, true);
    await controlRequest(socketPath(), { cmd: "reloadConfig" });
    const back = await server.frame(
      "capabilities",
      (f) => f.fullAccessOptIn && server.last.frames.indexOf(f) > 2,
    );
    for (const c of back.catalogs) expect(c.permissionModes).toContain("fullAccess");
  });

  it("turning Full access off while the runtime's CLI updates lowers the session only once the update ends (07.11 review ME-06)", async () => {
    await setFullAccessOptIn(home, true);
    await gatedDaemon({});
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: "u1",
      kind: "session.start",
      sessionId: "wu1",
      payload: { projectLocalId: localId, permissionMode: "fullAccess" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "u1")).toMatchObject({ ok: true });

    // An update of this runtime is running: its gate is closed.
    const gate = (daemon as unknown as { gates: Map<string, RuntimeGate> }).gates.get(runtime.id);
    gate?.close();
    await setFullAccessOptIn(home, false);
    expect(await controlRequest(socketPath(), { cmd: "reloadConfig" })).toMatchObject({
      ok: true,
      result: { fullAccessOptIn: false },
    });
    await sleep(100);
    // Nothing launched the CLI mid-update.
    expect(runtime.configured).toEqual([]);
    gate?.open();
    await server.waitFor(() => (runtime.configured.length > 0 ? true : undefined));
    expect(runtime.configured).toEqual([{ permissionMode: "acceptEdits" }]);
  });

  it("the request carries no value: it only re-reads runtime.json, and the environment still wins", async () => {
    await gatedDaemon({});
    await daemon.start();
    await server.frame("hello");
    const forged = await controlRequest(socketPath(), {
      cmd: "reloadConfig",
      fullAccess: { optIn: true },
    } as never);
    expect(forged.ok).toBe(false);
    expect(daemon.fullAccessOn).toBe(false);
    expect(await controlRequest(socketPath(), { cmd: "reloadConfig" })).toMatchObject({
      ok: true,
      result: { fullAccessOptIn: false },
    });

    await gatedDaemon({ OCW_ALLOW_FULL_ACCESS: "1" });
    await daemon.start();
    await setFullAccessOptIn(home, false);
    expect(await controlRequest(socketPath(), { cmd: "reloadConfig" })).toMatchObject({
      ok: true,
      result: { fullAccessOptIn: true, fullAccessSource: "env" },
    });
  });
});

describe("Automatic session titles (03.2-12, D-18, P-15, P-19)", () => {
  const SID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
  const titleCmd = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "session.title" as const,
    sessionId: SID,
    payload: {
      runtime: "claude-code",
      model: "haiku",
      prompt: "Please fix the login redirect bug",
      ...extra,
    },
  });

  async function restartWithTitleTimeout(titleTimeoutMs: number) {
    await daemon.stop();
    daemon = await Daemon.create({
      home,
      env: {},
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [runtime],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
      titleTimeoutMs,
    });
  }

  it("a session.title command answers with one title.result (normalized), then an ok ack", async () => {
    runtime.extraModels = ["haiku"];
    await daemon.start();
    await server.frame("hello");
    server.send(titleCmd("t1"));
    const ack = await server.frame("ack", (f) => f.commandId === "t1");
    expect(ack.ok).toBe(true);
    const results = server.last.frames.filter((f) => f.type === "title.result");
    expect(results).toEqual([
      {
        type: "title.result",
        requestId: "t1",
        sessionId: SID,
        title: "Fix login redirect bug",
        model: "haiku",
      },
    ]);
    const frames = server.last.frames;
    expect(frames.indexOf(results[0]!)).toBeLessThan(frames.indexOf(ack));
    expect(runtime.titleRequests.map((r) => [r.model, r.prompt])).toEqual([
      ["haiku", "Please fix the login redirect bug"],
    ]);
  });

  it("a failure is a failed ack whose error starts with the code; no frame, no session event", async () => {
    await daemon.start();
    await server.frame("hello");
    server.send(titleCmd("t2")); // haiku is not in this runtime's catalog
    expect(await server.frame("ack", (f) => f.commandId === "t2")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^title_model_not_in_catalog: /),
    });
    runtime.extraModels = ["haiku"];
    runtime.titleImpl = async () => {
      throw new Error("model overloaded");
    };
    server.send(titleCmd("t3"));
    expect(await server.frame("ack", (f) => f.commandId === "t3")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^title_failed: /),
    });
    runtime.titleImpl = async () => "Ok";
    server.send(titleCmd("t4"));
    expect(await server.frame("ack", (f) => f.commandId === "t4")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^title_invalid_shape: /),
    });
    const frames = server.last.frames;
    expect(frames.filter((f) => f.type === "title.result")).toEqual([]);
    expect(frames.filter((f) => f.type === "event")).toEqual([]);
  });

  it("a slow title never blocks the session: a later prompt runs and completes first, then the title times out", async () => {
    await restartWithTitleTimeout(300);
    runtime.extraModels = ["haiku"];
    runtime.titleImpl = () => new Promise<string>(() => {});
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "s9", kind: "session.start", sessionId: SID, payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "s9");
    server.send(titleCmd("t5"));
    server.send({ id: "p9", kind: "prompt", sessionId: SID, payload: { promptId: "pp9", text: "go" } });
    const promptAck = await server.frame("ack", (f) => f.commandId === "p9");
    expect(promptAck.ok).toBe(true);
    const titleAck = await server.frame("ack", (f) => f.commandId === "t5");
    expect(titleAck).toMatchObject({ ok: false, error: expect.stringMatching(/^title_timeout: /) });
    const frames = server.last.frames;
    expect(frames.indexOf(promptAck)).toBeLessThan(frames.indexOf(titleAck));
    expect([...runtime.calls].sort()).toEqual(["prompt:pp9", "title:haiku"]);
    expect(runtime.titleRequests[0]!.signal.aborted).toBe(true);
    const events = frames.flatMap((f) => (f.type === "event" ? [f.event] : []));
    expect(events.filter((e) => e.type === "session.error")).toEqual([]);
    expect(events.filter((e) => e.type === "session.state" && e.status !== "idle")).toEqual([]);
  });

  it("a payload runtime other than the active session's runtime is refused before any call", async () => {
    runtime.extraModels = ["haiku"];
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({ id: "s10", kind: "session.start", sessionId: SID, payload: { projectLocalId: localId } });
    await server.frame("ack", (f) => f.commandId === "s10");
    server.send(titleCmd("t6", { runtime: "codex", model: "gpt-6-luna" }));
    expect(await server.frame("ack", (f) => f.commandId === "t6")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^title_runtime_mismatch: /),
    });
    expect(runtime.titleRequests).toEqual([]);
  });
});

describe("Prompt images (06.1-03, D-05, P-01, P-10, P-11)", () => {
  /** 1×1 PNG and 1×1 lossless WebP. */
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
  /** 300 base64 characters, as a runtime might echo an image back in an error. */
  const LONG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(10).slice(0, 300);

  async function startSession(sessionId: string, permissionMode = "acceptEdits"): Promise<void> {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: `start-${sessionId}`,
      kind: "session.start",
      sessionId,
      payload: { projectLocalId: localId, permissionMode },
    });
    expect(await server.frame("ack", (f) => f.commandId === `start-${sessionId}`)).toMatchObject({
      ok: true,
    });
  }

  it("the fake runtime receives the images through the real daemon and says so in its reply", async () => {
    await daemon.stop();
    daemon = await Daemon.create({
      home,
      env: {},
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [new ScriptedRuntime("claude-code", 1)],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    });
    await startSession("wi1", "plan");
    server.send({
      id: "pi1",
      kind: "prompt",
      sessionId: "wi1",
      payload: {
        promptId: "ppi1",
        text: "what is in these screenshots?",
        images: [
          { mediaType: "image/png", dataBase64: PNG },
          { mediaType: "image/webp", dataBase64: WEBP },
        ],
      },
    });
    expect(await server.frame("ack", (f) => f.commandId === "pi1")).toMatchObject({ ok: true });
    const reply = await server.frame(
      "event",
      (f) => f.sessionId === "wi1" && f.event.type === "assistant.message" && f.event.text.includes("Mode:"),
    );
    const text = reply.event.type === "assistant.message" ? reply.event.text : "";
    expect(text.trimEnd().endsWith("Mode: plan\nImages: 2 (image/png, image/webp)")).toBe(true);
    await server.frame("event", (f) => f.sessionId === "wi1" && f.event.type === "prompt.completed");

    server.send({
      id: "pi2",
      kind: "prompt",
      sessionId: "wi1",
      payload: { promptId: "ppi2", text: "and now?" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "pi2")).toMatchObject({ ok: true });
    const plain = await server.frame(
      "event",
      (f) =>
        f.sessionId === "wi1" &&
        f.event.type === "assistant.message" &&
        f.event.messageId.startsWith("ppi2") &&
        f.event.text.includes("Mode:"),
    );
    expect(plain.event.type === "assistant.message" ? plain.event.text : "").not.toContain("Images:");
    // Nothing the daemon sent back carries the image bytes.
    expect(JSON.stringify(server.last.frames)).not.toContain(PNG);
    expect(JSON.stringify(server.last.frames)).not.toContain(WEBP);
  });

  it("a runtime that cannot take images refuses the prompt visibly; the runtime is never called", async () => {
    await startSession("wi2");
    server.send({
      id: "pi3",
      kind: "prompt",
      sessionId: "wi2",
      payload: { promptId: "ppi3", text: "look", images: [{ mediaType: "image/png", dataBase64: PNG }] },
    });
    expect(await server.frame("ack", (f) => f.commandId === "pi3")).toEqual({
      type: "ack",
      commandId: "pi3",
      ok: false,
      error: "This runtime can't receive images",
    });
    expect(runtime.prompts).toEqual([]);
    // Without images the same runtime still runs prompts.
    server.send({ id: "pi4", kind: "prompt", sessionId: "wi2", payload: { promptId: "ppi4", text: "go" } });
    expect(await server.frame("ack", (f) => f.commandId === "pi4")).toMatchObject({ ok: true });
    expect(runtime.prompts.map((p) => p.promptId)).toEqual(["ppi4"]);
  });

  it("a payload outside the contract bounds (5 images, an SVG) is refused before any runtime call", async () => {
    runtime.supportsImages = true;
    await startSession("wi3");
    const five = Array.from({ length: 5 }, () => ({ mediaType: "image/png", dataBase64: PNG }));
    server.send({
      id: "pi5",
      kind: "prompt",
      sessionId: "wi3",
      payload: { promptId: "ppi5", text: "five", images: five },
    });
    server.send({
      id: "pi6",
      kind: "prompt",
      sessionId: "wi3",
      payload: {
        promptId: "ppi6",
        text: "svg",
        images: [{ mediaType: "image/svg+xml", dataBase64: "PHN2Zz48L3N2Zz4=" }],
      },
    });
    expect(await server.frame("ack", (f) => f.commandId === "pi5")).toMatchObject({ ok: false });
    expect(await server.frame("ack", (f) => f.commandId === "pi6")).toMatchObject({ ok: false });
    expect(runtime.prompts).toEqual([]);
  });

  it("a runtime error echoing image data reaches neither the ack nor the log", async () => {
    const logger = captureLogger();
    await daemonWith(logger);
    runtime.supportsImages = true;
    runtime.promptError = `bad input data:image/png;base64,${LONG_BASE64}`;
    await startSession("wi4");
    server.send({
      id: "pi7",
      kind: "prompt",
      sessionId: "wi4",
      payload: { promptId: "ppi7", text: "look", images: [{ mediaType: "image/png", dataBase64: PNG }] },
    });
    const ack = await server.frame("ack", (f) => f.commandId === "pi7");
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining("bad input") });
    const warning = logger.lines.find((l) => l.includes("command failed")) ?? "";
    expect(warning).toContain("bad input");
    for (const text of [ack.ok ? "" : (ack.error ?? ""), warning]) {
      expect(text).not.toContain(";base64,");
      expect(text).not.toContain(LONG_BASE64);
      expect(text).not.toContain(LONG_BASE64.slice(0, 64));
    }
  });

  it("a session.error carrying a data URL leaves the device without it; a diff patch is unchanged", async () => {
    await startSession("wi5");
    runtime.emit("wi5", {
      type: "session.error",
      message: `Claude Code could not read an attached image: data:image/png;base64,${LONG_BASE64}`,
    });
    const err = await server.frame("event", (f) => f.sessionId === "wi5" && f.event.type === "session.error");
    const message = err.event.type === "session.error" ? err.event.message : "";
    expect(message).toContain("Claude Code could not read an attached image");
    expect(message).not.toContain(";base64,");
    expect(message).not.toContain(LONG_BASE64.slice(0, 64));

    const dataUrl = `data:image/png;base64,${PNG}`;
    writeFileSync(join(project, "inline.md"), `![dot](${dataUrl})\n`);
    const localId = daemon.registry.list()[0]!.localId;
    server.send({ id: "di1", kind: "diff.request", sessionId: "wi5", payload: { projectLocalId: localId } });
    const diff = await server.frame("diff.result", (f) => f.requestId === "di1");
    expect(diff.patch).toContain(dataUrl);
  });
});

// ---------------------------------------------------------------------------------------------
// 07.11 runtime updates: the daemon keeps its CLIs current by itself (D-02, D-03, D-07, D-09, D-10, PD-19)

const FAKE_CLI = fileURLToPath(new URL("./maintenance/fake-cli/fake-cli.mjs", import.meta.url));

/** The npm registry as the daemon sees it (`OCW_RUNTIME_REGISTRY_URL`): one dist-tag answer, every request counted. */
class RegistryStub {
  readonly requests: string[] = [];
  version = "2.1.300";
  private readonly http: Server;
  constructor() {
    this.http = createServer((req, res) => {
      this.requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "x", version: this.version }));
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.http.listen(0, "127.0.0.1", () => resolve()));
  }
  get url(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}

const sleep07 = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("07.11 runtime updates: the daemon updates its CLIs by itself", () => {
  let registry: RegistryStub;
  let userHome: string;
  let nodeBin: string;
  let codex: ScriptedRuntime;

  beforeEach(async () => {
    registry = new RegistryStub();
    await registry.listen();
    userHome = join(home, "user");
    mkdirSync(userHome);
    nodeBin = join(userHome, "node-bin");
    mkdirSync(nodeBin);
    symlinkSync(process.execPath, join(nodeBin, "node"));
  });

  afterEach(async () => {
    await registry.close();
  });

  const claudeBin = () => join(userHome, ".local", "bin");
  const nativeRoot = () => join(userHome, ".local", "share", "claude");
  /** The scratch fake CLI's own answer (PD-19: never the machine's real `claude`). */
  const fakeClaudeVersion = () =>
    execFileSync(join(claudeBin(), "claude"), ["--version"], { env: { PATH: `${nodeBin}:/usr/bin:/bin` } })
      .toString()
      .trim();

  /** A native fake Claude Code 2.1.290 in a scratch user home whose update goes to 2.1.300; a daemon around it. */
  async function updatesDaemon(
    o: {
      env?: Record<string, string>;
      fakeUpdate?: Record<string, unknown>;
      maintenance?: Partial<RuntimeMaintenanceOptions>;
    } = {},
  ): Promise<void> {
    await daemon.stop();
    execFileSync(process.execPath, [FAKE_CLI, "install-fake", "claude-native", userHome, "2.1.290"]);
    writeFileSync(
      join(nativeRoot(), "fake-update.json"),
      JSON.stringify({ next: "2.1.300", ...o.fakeUpdate }),
    );
    runtime = new FakeRuntime();
    codex = new ScriptedRuntime("codex", 1);
    daemon = await Daemon.create({
      home,
      env: {
        PATH: [claudeBin(), nodeBin, "/usr/bin", "/bin"].join(":"),
        HOME: userHome,
        OCW_RUNTIME_REGISTRY_URL: registry.url,
        ...o.env,
      },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [runtime, codex],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
      maintenance: {
        userHome,
        which: (name) => (name === "claude" ? join(claudeBin(), "claude") : null),
        ...o.maintenance,
      },
    });
  }

  const welcome = (): ServerToDeviceFrame => ({
    type: "welcome",
    deviceId: randomUUID(),
    organizationId: randomUUID(),
  });

  it("automatic: a behind Claude Code is updated at start while no turn runs, and the server hears every step", async () => {
    await updatesDaemon();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push({ type: "runtime.config", policy: "automatic", manifest: RUNTIME_COMPATIBILITY_MANIFEST });

    const started = await server.frame("runtime.update.run", (f) => f.phase === "started", 15_000);
    expect(started).toMatchObject({
      runtime: "claude-code",
      trigger: "automatic",
      fromVersion: "2.1.290",
      candidate: "2.1.300",
      method: "native",
    });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 20_000);
    expect(finished).toMatchObject({
      runId: started.runId,
      outcome: "succeeded",
      fromVersion: "2.1.290",
      toVersion: "2.1.300",
    });
    const snapshot = await server.frame(
      "runtime.maintenance",
      (f) => f.runtimes.some((s) => s.runtime === "claude-code" && s.installedVersion === "2.1.300"),
      10_000,
    );
    expect(snapshot).toMatchObject({
      orgLevelReceived: true,
      effectiveLevel: "automatic",
      localLevel: "automatic",
    });
    expect(snapshot.runtimes.find((s) => s.runtime === "claude-code")).toMatchObject({
      advisory: "current",
      method: "native",
      location: "~/.local/bin",
      lastRun: { outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300" },
      state: "idle",
    });
    const finishedAt = server.allFrames.indexOf(finished);
    await server.waitFor(
      () =>
        server.allFrames.slice(finishedAt + 1).some((f) => f.type === "capabilities") ? true : undefined,
      10_000,
    );
    expect(server.allFrames.indexOf(started)).toBeLessThan(finishedAt);
    expect(finishedAt).toBeLessThan(server.allFrames.indexOf(snapshot));
    expect(runtime.retireIdleCalls).toBe(1);
    expect(runtime.refreshInstallCalls).toBe(1);
    expect(runtime.interrupts).toEqual([]);
    expect(fakeClaudeVersion()).toBe("2.1.300 (Claude Code)");
    const wire = JSON.stringify(server.allFrames);
    expect(wire).not.toContain(userHome);
    expect(wire).not.toContain(home);
    const status = (await daemon.status()) as { runtimeUpdates?: { effectiveLevel: string } };
    expect(status.runtimeUpdates).toMatchObject({ effectiveLevel: "automatic", orgLevelReceived: true });
  }, 40_000);

  it("D-10: without a runtime.config the daemon checks and reports behind but never installs", async () => {
    await updatesDaemon({ maintenance: { orgLevelGraceMs: 50 } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    const behind = await server.frame(
      "runtime.maintenance",
      (f) => f.runtimes.some((s) => s.runtime === "claude-code" && s.advisory === "behind"),
      10_000,
    );
    expect(behind).toMatchObject({
      orgLevelReceived: false,
      effectiveLevel: "notify",
      localLevel: "automatic",
    });
    expect(behind.runtimes.find((s) => s.runtime === "claude-code")).toMatchObject({
      installedVersion: "2.1.290",
      latestVersion: "2.1.300",
      state: "idle",
    });
    await sleep07(1500);
    expect(server.allFrames.filter((f) => f.type === "runtime.update.run")).toEqual([]);
    expect(fakeClaudeVersion()).toBe("2.1.290 (Claude Code)");
    expect(registry.requests.length).toBeGreaterThan(0);
    expect(registry.requests[0]).toContain("/@anthropic-ai%2Fclaude-code/");
  }, 20_000);

  it("off: no registry request at all; the snapshot still reports the installed version and method", async () => {
    await updatesDaemon();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push({ type: "runtime.config", policy: "off", manifest: RUNTIME_COMPATIBILITY_MANIFEST });
    const off = await server.frame(
      "runtime.maintenance",
      (f) =>
        f.orgLevelReceived &&
        f.runtimes.some((s) => s.runtime === "claude-code" && s.installedVersion === "2.1.290"),
      10_000,
    );
    expect(off.effectiveLevel).toBe("off");
    expect(off.runtimes.find((s) => s.runtime === "claude-code")).toMatchObject({
      method: "native",
      latestVersion: null,
      checkedAt: null,
    });
    await sleep07(500);
    expect(registry.requests).toEqual([]);
    expect(server.allFrames.filter((f) => f.type === "runtime.update.run")).toEqual([]);
  }, 20_000);

  it("PD-19: test runtimes without DaemonOptions.maintenance never start maintenance (no request, no snapshot)", async () => {
    await daemon.stop();
    runtime = new FakeRuntime();
    daemon = await Daemon.create({
      home,
      env: { OCW_RUNTIME_REGISTRY_URL: registry.url, HOME: userHome },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [runtime],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    });
    await daemon.start();
    await server.frame("hello");
    server.push({ type: "runtime.config", policy: "automatic", manifest: RUNTIME_COMPATIBILITY_MANIFEST });
    await server.frame("capabilities");
    await sleep07(300);
    expect(registry.requests).toEqual([]);
    expect(server.allFrames.filter((f) => f.type === "runtime.maintenance")).toEqual([]);
    expect(((await daemon.status()) as { runtimeUpdates?: unknown }).runtimeUpdates).toBeUndefined();
  });

  it("PD-19: fake mode without OCW_RUNTIME_FAKE_CLI=1, or with the real HOME, never starts maintenance", async () => {
    await daemon.stop();
    const base = { home, token: null, logger: silentLogger, controlSocket: false as const };
    daemon = await Daemon.create({
      ...base,
      env: { OCW_RUNTIME_FAKE: "1", OCW_RUNTIME_REGISTRY_URL: registry.url, HOME: userHome },
    });
    expect(((await daemon.status()) as { runtimeUpdates?: unknown }).runtimeUpdates).toBeUndefined();
    await daemon.start();
    await sleep07(200);
    await daemon.stop();
    daemon = await Daemon.create({
      ...base,
      env: {
        OCW_RUNTIME_FAKE: "1",
        OCW_RUNTIME_FAKE_CLI: "1",
        OCW_RUNTIME_REGISTRY_URL: registry.url,
        HOME: userInfo().homedir,
      },
    });
    expect(((await daemon.status()) as { runtimeUpdates?: unknown }).runtimeUpdates).toBeUndefined();
    expect(registry.requests).toEqual([]);
    // With a scratch HOME the fake-CLI daemon does maintain (status reports the levels; not started here).
    daemon = await Daemon.create({
      ...base,
      env: { OCW_RUNTIME_FAKE: "1", OCW_RUNTIME_FAKE_CLI: "1", HOME: userHome, PATH: nodeBin },
    });
    expect(((await daemon.status()) as { runtimeUpdates?: unknown }).runtimeUpdates).toMatchObject({
      localLevel: "automatic",
      orgLevelReceived: false,
    });
  });
  // ---- 07.11 Task 2: never cut a turn (D-03, D-03a, D-03b, PD-07) ----

  async function startOn(sessionId: string, rt: "claude-code" | "codex", localId: string): Promise<void> {
    server.send({
      id: `start-${sessionId}`,
      kind: "session.start",
      sessionId,
      payload: { projectLocalId: localId, runtime: rt, permissionMode: "default" },
    });
    expect(await server.frame("ack", (f) => f.commandId === `start-${sessionId}`)).toMatchObject({
      ok: true,
    });
  }
  const ackOf = (id: string, timeoutMs = 3000) => server.frame("ack", (f) => f.commandId === id, timeoutMs);
  const hasAck = (id: string) => server.allFrames.some((f) => f.type === "ack" && f.commandId === id);
  const updateEvents = (sessionId: string) =>
    server.allFrames.flatMap((f) =>
      f.type === "event" && f.sessionId === sessionId && f.event.type === "runtime.update" ? [f.event] : [],
    );
  const claudeState = (f: Extract<DeviceToServerFrame, { type: "runtime.maintenance" }>) =>
    f.runtimes.find((s) => s.runtime === "claude-code");
  const automatic = (): ServerToDeviceFrame => ({
    type: "runtime.config",
    policy: "automatic",
    manifest: RUNTIME_COMPATIBILITY_MANIFEST,
  });
  const WAITING = { type: "runtime.update", runtime: "claude-code", phase: "waiting" };

  it("a Claude turn in flight: the update waits with the gate open, then takes the idle moment; during the run only new Claude turns wait", async () => {
    await updatesDaemon({ fakeUpdate: { delayMs: 1500 }, maintenance: { drainPollMs: 20 } });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    await startOn("B", "claude-code", localId);
    await startOn("C", "codex", localId);
    runtime.activeTurnsCount = 1; // A's turn is running
    server.push(automatic());
    await server.frame("runtime.maintenance", (f) => claudeState(f)?.state === "pending", 10_000);

    // Opportunistic phase: the gate is open for every session and for Codex.
    server.send({ id: "pb1", kind: "prompt", sessionId: "B", payload: { promptId: "b1", text: "go" } });
    server.send({ id: "pc1", kind: "prompt", sessionId: "C", payload: { promptId: "c1", text: "go" } });
    expect(await ackOf("pb1")).toMatchObject({ ok: true });
    expect(await ackOf("pc1")).toMatchObject({ ok: true });
    expect(runtime.prompts.map((p) => p.promptId)).toContain("b1");
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);

    // A's turn ends: the update starts right away.
    runtime.activeTurnsCount = 0;
    runtime.emit("A", {
      type: "prompt.completed",
      promptId: "a1",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await server.frame("runtime.update.run", (f) => f.phase === "started", 2000);

    // During the run (the fake CLI takes 1.5 s): a new Claude turn waits; Codex, interrupts and approvals pass.
    server.send({ id: "pb2", kind: "prompt", sessionId: "B", payload: { promptId: "b2", text: "next" } });
    server.send({ id: "pc2", kind: "prompt", sessionId: "C", payload: { promptId: "c2", text: "next" } });
    server.send({ id: "ia", kind: "interrupt", sessionId: "A" });
    server.send({
      id: "ra",
      kind: "approval.resolve",
      sessionId: "A",
      payload: { approvalId: "ap1", decision: "once" },
    });
    expect(await ackOf("pc2")).toMatchObject({ ok: true });
    expect(await ackOf("ia")).toMatchObject({ ok: true });
    expect(await ackOf("ra")).toMatchObject({ ok: true });
    await sleep07(200);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run" && f.phase === "finished")).toBe(
      false,
    );
    expect(hasAck("pb2")).toBe(false);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("b2");
    expect(updateEvents("B")).toEqual([WAITING]);

    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished.outcome).toBe("succeeded");
    expect(await ackOf("pb2", 5000)).toMatchObject({ ok: true });
    expect(runtime.prompts.map((p) => p.promptId)).toContain("b2");
    await server.waitFor(() => (updateEvents("B").length === 2 ? true : undefined));
    expect(updateEvents("B")).toEqual([
      WAITING,
      { type: "runtime.update", runtime: "claude-code", phase: "done", version: "2.1.300" },
    ]);
    expect(updateEvents("A")).toEqual([]);
    expect(updateEvents("C")).toEqual([]);
    expect(runtime.interrupts).toEqual(["A"]); // only the member's own interrupt command
  }, 40_000);

  it("after the drain delay new Claude starts are held while the in-flight turn finishes; stale is reported; nothing is interrupted", async () => {
    await updatesDaemon({
      maintenance: { drainAfterMs: 300, staleAfterMs: 900, pollMs: 50, drainPollMs: 20 },
    });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    runtime.activeTurnsCount = 1; // stuck busy
    server.push(automatic());
    await server.frame("runtime.maintenance", (f) => claudeState(f)?.state === "draining", 10_000);

    server.send({
      id: "start-D",
      kind: "session.start",
      sessionId: "D",
      payload: { projectLocalId: localId, runtime: "claude-code", permissionMode: "default" },
    });
    await startOn("E", "codex", localId); // Codex is never held
    await sleep07(200);
    expect(hasAck("start-D")).toBe(false);
    expect(updateEvents("D")).toEqual([WAITING]);

    const stale = await server.frame("runtime.maintenance", (f) => claudeState(f)?.stale === true, 10_000);
    expect(claudeState(stale)?.pendingSince).not.toBeNull();
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);

    runtime.activeTurnsCount = 0; // the in-flight turn ends on its own
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished.outcome).toBe("succeeded");
    expect(await ackOf("start-D", 5000)).toMatchObject({ ok: true });
    expect(runtime.interrupts).toEqual([]);
    await server.waitFor(() => (updateEvents("D").length === 2 ? true : undefined));
    expect(updateEvents("D")[1]).toMatchObject({ phase: "done", version: "2.1.300" });
  }, 40_000);

  it("a failed run reopens the gate: the held turn runs, its session is told failed, lastRun is failed", async () => {
    await updatesDaemon({ fakeUpdate: { exitCode: 1, delayMs: 1000 } });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("B", "claude-code", localId);
    server.push(automatic());
    await server.frame("runtime.update.run", (f) => f.phase === "started", 10_000);
    server.send({ id: "pb1", kind: "prompt", sessionId: "B", payload: { promptId: "b1", text: "go" } });
    await sleep07(150);
    expect(hasAck("pb1")).toBe(false);
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({ outcome: "failed", fromVersion: "2.1.290", toVersion: null });
    expect(finished.output).toContain("exited with code 1");
    expect(JSON.stringify(finished)).not.toContain(userHome);
    expect(await ackOf("pb1", 5000)).toMatchObject({ ok: true });
    await server.waitFor(() => (updateEvents("B").length === 2 ? true : undefined));
    expect(updateEvents("B")[1]).toMatchObject({ phase: "failed" });
    const snap = await server.frame(
      "runtime.maintenance",
      (f) => claudeState(f)?.lastRun?.outcome === "failed",
    );
    expect(claudeState(snap)).toMatchObject({ installedVersion: "2.1.290", state: "idle" });
    expect(fakeClaudeVersion()).toBe("2.1.290 (Claude Code)");
  }, 40_000);

  it("session.title and catalog collection for Claude wait while its gate is closed; Codex's do not", async () => {
    await updatesDaemon({ fakeUpdate: { delayMs: 1500 } });
    runtime.extraModels = ["haiku"];
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    await startOn("C", "codex", localId);
    server.push(automatic());
    await server.frame("runtime.update.run", (f) => f.phase === "started", 10_000);

    const title = (id: string, sessionId: string, rt: string) =>
      server.send({
        id,
        kind: "session.title",
        sessionId,
        payload: { runtime: rt, model: "haiku", prompt: "Please fix the login redirect bug" },
      });
    title("tA", "A", "claude-code");
    title("tC", "C", "codex");
    await ackOf("tC", 1000); // answered (ok or not) while Claude updates
    const catalogs = await (
      daemon as unknown as { collectCatalogs(): Promise<RuntimeCatalog[]> }
    ).collectCatalogs();
    expect(catalogs.map((c) => c.runtime)).not.toContain("claude-code");
    expect(server.allFrames.some((f) => f.type === "runtime.update.run" && f.phase === "finished")).toBe(
      false,
    );
    expect(hasAck("tA")).toBe(false);
    expect(server.allFrames.some((f) => f.type === "title.result" && f.requestId === "tA")).toBe(false);

    await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(await ackOf("tA", 5000)).toMatchObject({ ok: true });
    const after = await (
      daemon as unknown as { collectCatalogs(): Promise<RuntimeCatalog[]> }
    ).collectCatalogs();
    expect(after.map((c) => c.runtime)).toContain("claude-code");
  }, 40_000);
  // ---- 07.11 Task 3: "Update now" from the web and the control socket (D-05, PD-08) ----

  const updateCmd = (payload: unknown) => ({
    id: randomUUID(),
    kind: "runtime.update" as const,
    sessionId: randomUUID(),
    payload,
  });
  const notify = (): ServerToDeviceFrame => ({
    type: "runtime.config",
    policy: "notify",
    manifest: RUNTIME_COMPATIBILITY_MANIFEST,
  });

  it('"Update now": acked ok, drains at once (no opportunistic hour), the run carries trigger manual and the command id', async () => {
    await updatesDaemon({ maintenance: { drainPollMs: 20 } });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(notify());
    await server.frame("runtime.maintenance", (f) => claudeState(f)?.advisory === "behind", 10_000);
    await startOn("A", "claude-code", localId);
    runtime.activeTurnsCount = 1;
    const cmd = updateCmd({ runtime: "claude-code" });
    server.send(cmd);
    expect(await ackOf(cmd.id, 10_000)).toMatchObject({ ok: true });
    await server.frame("runtime.maintenance", (f) => claudeState(f)?.state === "draining", 5000);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
    runtime.activeTurnsCount = 0;
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({
      trigger: "manual",
      commandId: cmd.id,
      outcome: "succeeded",
      fromVersion: "2.1.290",
      toVersion: "2.1.300",
    });
    expect(
      server.allFrames.find((f) => f.type === "runtime.update.run" && f.phase === "started"),
    ).toMatchObject({ trigger: "manual", commandId: cmd.id });
    expect(runtime.interrupts).toEqual([]);
  }, 40_000);

  it('"Update now" refusals: off on this device; an extra key, an unknown runtime or no payload is an invalid payload; nothing runs', async () => {
    await updatesDaemon({ env: { OCW_RUNTIME_UPDATES: "off" } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(automatic());
    const off = updateCmd({ runtime: "claude-code" });
    server.send(off);
    expect(await ackOf(off.id, 10_000)).toMatchObject({ ok: false, error: "updates are off on this device" });
    for (const payload of [{ runtime: "claude-code", command: "rm" }, { runtime: "opencode" }, undefined]) {
      const c = updateCmd(payload);
      server.send(c);
      expect(await ackOf(c.id)).toMatchObject({ ok: false, error: "invalid payload" });
    }
    await sleep07(200);
    expect(registry.requests).toEqual([]);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
    expect(fakeClaudeVersion()).toBe("2.1.290 (Claude Code)");
  }, 20_000);

  it('"Update now" refusals: a fresh registry check says current → already up to date', async () => {
    registry.version = "2.1.290";
    await updatesDaemon();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(notify());
    const c = updateCmd({ runtime: "claude-code" });
    server.send(c);
    expect(await ackOf(c.id, 10_000)).toMatchObject({ ok: false, error: "already up to date" });
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
  }, 20_000);

  it('"Update now" refusals: a second request while the first runs → already updating', async () => {
    await updatesDaemon({ fakeUpdate: { delayMs: 1500 } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(notify());
    const first = updateCmd({ runtime: "claude-code" });
    server.send(first);
    expect(await ackOf(first.id, 10_000)).toMatchObject({ ok: true });
    const second = updateCmd({ runtime: "claude-code" });
    server.send(second);
    expect(await ackOf(second.id, 10_000)).toMatchObject({ ok: false, error: "already updating" });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({ commandId: first.id, outcome: "succeeded" });
    expect(
      server.allFrames.filter((f) => f.type === "runtime.update.run" && f.phase === "started"),
    ).toHaveLength(1);
  }, 40_000);

  it("control socket: runtimeCheck answers fresh statuses, runtimeUpdate runs with trigger local, both strict", async () => {
    await updatesDaemon();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(notify());
    await server.frame("runtime.maintenance", (f) => f.orgLevelReceived, 10_000);
    const before = registry.requests.length;
    const check = await controlRequest(socketPath(), { cmd: "runtimeCheck" });
    expect(check).toMatchObject({ ok: true, result: { effectiveLevel: "notify", orgLevelReceived: true } });
    const statuses = (check.result as { runtimes: Array<{ runtime: string }> }).runtimes;
    expect(statuses.find((s) => s.runtime === "claude-code")).toMatchObject({
      installedVersion: "2.1.290",
      latestVersion: "2.1.300",
      advisory: "behind",
      method: "native",
    });
    expect(statuses.find((s) => s.runtime === "codex")).toMatchObject({ method: "not_installed" });
    expect(registry.requests.length).toBeGreaterThan(before); // fresh: not the cached answer
    expect(await controlRequest(socketPath(), { cmd: "runtimeCheck", args: ["x"] } as never)).toMatchObject({
      ok: false,
      error: "invalid request",
    });
    expect(
      await controlRequest(socketPath(), {
        cmd: "runtimeUpdate",
        runtime: "claude-code",
        command: "rm",
      } as never),
    ).toMatchObject({ ok: false, error: "invalid request" });
    expect(await controlRequest(socketPath(), { cmd: "runtimeUpdate", runtime: "codex" })).toMatchObject({
      ok: true,
      result: { accepted: false, reason: "not installed on this device" },
    });
    expect(
      await controlRequest(socketPath(), { cmd: "runtimeUpdate", runtime: "claude-code" }),
    ).toMatchObject({
      ok: true,
      result: { accepted: true },
    });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({ trigger: "local", outcome: "succeeded", toVersion: "2.1.300" });
    expect(finished.commandId).toBeUndefined();
    const status = (await daemon.status()) as {
      runtimeUpdates: { runtimes: Array<{ runtime: string; installedVersion: string | null }> };
    };
    expect(status.runtimeUpdates.runtimes.find((s) => s.runtime === "claude-code")?.installedVersion).toBe(
      "2.1.300",
    );
  }, 40_000);

  // ---- 07.11-08: the device owner's level through the value-less reloadConfig (D-02) ----

  const reload = async () => {
    const res = await controlRequest(socketPath(), { cmd: "reloadConfig" });
    expect(res.ok).toBe(true);
    return res.result as Record<string, unknown>;
  };

  it("reloadConfig applies the device level at once: notify cancels a pending automatic update and the server hears it; off stops registry checks; automatic resumes them", async () => {
    await updatesDaemon({ maintenance: { pollMs: 50 } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    runtime.activeTurnsCount = 1; // a Claude turn is running: the automatic update waits (opportunistic)
    server.push(automatic());
    await server.frame("runtime.maintenance", (f) => claudeState(f)?.state === "pending", 10_000);

    await setRuntimeUpdatesLevel(home, "notify");
    const marker = server.allFrames.length;
    expect(await reload()).toMatchObject({
      fullAccessOptIn: false,
      fullAccessSource: "config",
      runtimeUpdatesLevel: "notify",
      runtimeUpdatesSource: "config",
    });
    const lowered = await server.frame(
      "runtime.maintenance",
      (f) => server.allFrames.indexOf(f) >= marker && f.localLevel === "notify",
      10_000,
    );
    expect(lowered).toMatchObject({
      localLevelSource: "config",
      effectiveLevel: "notify",
      orgLevelReceived: true,
    });
    expect(claudeState(lowered)).toMatchObject({ state: "idle", advisory: "behind" });
    // The turn ends: nothing runs any more.
    runtime.activeTurnsCount = 0;
    await sleep07(400);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
    expect(fakeClaudeVersion()).toBe("2.1.290 (Claude Code)");

    // off: no registry request, even for a fresh check.
    await setRuntimeUpdatesLevel(home, "off");
    expect(await reload()).toMatchObject({ runtimeUpdatesLevel: "off", runtimeUpdatesSource: "config" });
    await server.frame(
      "runtime.maintenance",
      (f) => f.localLevel === "off" && f.effectiveLevel === "off",
      10_000,
    );
    const before = registry.requests.length;
    expect(await controlRequest(socketPath(), { cmd: "runtimeCheck" })).toMatchObject({
      ok: true,
      result: { localLevel: "off", effectiveLevel: "off" },
    });
    await sleep07(200);
    expect(registry.requests.length).toBe(before);

    // automatic again: checks resume (and the behind CLI is updated at the idle moment).
    await setRuntimeUpdatesLevel(home, "automatic");
    expect(await reload()).toMatchObject({ runtimeUpdatesLevel: "automatic" });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 20_000);
    expect(finished).toMatchObject({ trigger: "automatic", outcome: "succeeded", toVersion: "2.1.300" });
    const resumed = registry.requests.length;
    await controlRequest(socketPath(), { cmd: "runtimeCheck" });
    expect(registry.requests.length).toBeGreaterThan(resumed); // a fresh check reaches the registry again
  }, 60_000);

  it("lowering the level while an update runs lets it finish", async () => {
    await updatesDaemon({ fakeUpdate: { delayMs: 1500 } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(automatic());
    await server.frame("runtime.update.run", (f) => f.phase === "started", 15_000);
    await setRuntimeUpdatesLevel(home, "off");
    expect(await reload()).toMatchObject({ runtimeUpdatesLevel: "off" });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 20_000);
    expect(finished).toMatchObject({ outcome: "succeeded", toVersion: "2.1.300" });
    expect(fakeClaudeVersion()).toBe("2.1.300 (Claude Code)");
    const status = (await daemon.status()) as { runtimeUpdates: Record<string, unknown> };
    expect(status.runtimeUpdates).toMatchObject({ localLevel: "off", effectiveLevel: "off" });
  }, 40_000);

  it("OCW_RUNTIME_UPDATES in the daemon's env wins over the file on reload (source env, no effect)", async () => {
    await updatesDaemon({ env: { OCW_RUNTIME_UPDATES: "notify" } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(automatic());
    await server.frame("runtime.maintenance", (f) => f.orgLevelReceived, 10_000);
    await setRuntimeUpdatesLevel(home, "off");
    expect(await reload()).toMatchObject({ runtimeUpdatesLevel: "notify", runtimeUpdatesSource: "env" });
    const status = (await daemon.status()) as { runtimeUpdates: Record<string, unknown> };
    expect(status.runtimeUpdates).toMatchObject({
      localLevel: "notify",
      localLevelSource: "env",
      effectiveLevel: "notify",
    });
    // The request still carries no value (strict), whatever the level.
    expect(
      await controlRequest(socketPath(), {
        cmd: "reloadConfig",
        runtimeUpdates: { level: "automatic" },
      } as never),
    ).toMatchObject({ ok: false });
  }, 20_000);
});
