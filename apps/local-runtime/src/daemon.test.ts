import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalDecision,
  CommandFrame,
  DeviceToServerFrame,
  PromptPayload,
  RuntimeCatalog,
  RuntimeInfo,
  SessionEvent,
  SessionSettingsPatch,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { controlRequest } from "./control-socket.js";
import { Daemon } from "./daemon.js";
import { type Logger, silentLogger } from "./logger.js";
import type { AgentRuntime, EventSink, RuntimeCapabilities, StartSessionOptions } from "./runtime.js";

// Fake credential assembled at runtime so secret scanners do not flag the test.
const LEAKY_KEY = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

class FakeRuntime implements AgentRuntime {
  readonly id = "claude-code" as const;
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: false,
    supportsResume: true,
    supportsPermissionModes: ["default", "acceptEdits", "plan"],
    supportsImages: false,
  };
  readonly started: StartSessionOptions[] = [];
  readonly resolved: Array<[string, ApprovalDecision]> = [];
  readonly prompts: PromptPayload[] = [];
  readonly configured: SessionSettingsPatch[] = [];
  /** Order in which configure / prompt calls reached the runtime. */
  readonly calls: string[] = [];
  configureDelayMs = 0;
  sinks = new Map<string, EventSink>();

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
      ],
      permissionModes: [...this.capabilities.supportsPermissionModes],
      fastModeCost: null,
      collectedAt: new Date().toISOString(),
    };
  }
  async configure(_sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    this.calls.push(`configure:${patch.model ?? patch.permissionMode ?? "?"}`);
    if (this.configureDelayMs) await sleep(this.configureDelayMs);
    this.configured.push(patch);
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
  async interrupt(): Promise<void> {}
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
  ) {
    return this.waitFor(() =>
      this.connections
        .flatMap((c) => c.frames)
        .find(
          (f): f is Extract<DeviceToServerFrame, { type: T }> =>
            f.type === type && pred(f as Extract<DeviceToServerFrame, { type: T }>),
        ),
    );
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
    expect(sync.projects).toEqual([{ localId, name: "acme", gitRemote: null, defaultBranch: "main" }]);
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
      payload: { settings: { permissionMode: "fullAccess" }, reason: "user" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "k2")).toMatchObject({
      ok: false,
      error: expect.stringContaining("permission mode fullAccess is not available on this device"),
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
