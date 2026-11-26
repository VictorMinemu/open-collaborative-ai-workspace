import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type ApprovalDecision,
  type CommandFrame,
  type DeviceToServerFrame,
  originOf,
  type PromptPayload,
  RUNTIME_COMPATIBILITY_MANIFEST,
  RUNTIME_FILE_LAND_WITHIN_HEADER,
  type RuntimeCatalog,
  type RuntimeId,
  type RuntimeInfo,
  type ServerToDeviceFrame,
  type SessionBrowserGrant,
  type SessionEvent,
  type SessionSettingsPatch,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { CodexSlotStore } from "./accounts/codex-slots.js";
import type { ChildFactoryOptions, ManagedChild } from "./browser/manager.js";
import { CodexRuntime } from "./codex/codex-runtime.js";
import { setBrowserOptIn, setFullAccessOptIn, setIsolatedServer, setRuntimeUpdatesLevel } from "./config.js";
import { type ControlRequest, controlRequest } from "./control-socket.js";
import { Daemon, SELF_UPDATE_UNAVAILABLE_MESSAGE, toBrowserApiUrl, toRuntimeFileUrl } from "./daemon.js";
import { FakeRuntime as ScriptedRuntime } from "./fake/fake-runtime.js";
import { type Logger, silentLogger } from "./logger.js";
import type { RuntimeGate } from "./maintenance/gate.js";
import type { RuntimeMaintenanceOptions } from "./maintenance/maintenance.js";
import { defaultLockDir } from "./maintenance/runner.js";
import {
  type PrepareVersionOptions,
  prepareVersion,
  selfUpdateMarkerPath,
  writeSelfUpdateMarker,
} from "./maintenance/self-update.js";
import {
  type DistStub,
  fakeNpm,
  HOST_PATH_TOKEN_RE,
  type ScratchHome,
  scratchOcwHome,
  startDistStub,
} from "./maintenance/self-update-harness.js";
import type { SelfUpdateOptions } from "./maintenance/self-update-job.js";
import type {
  AgentRuntime,
  EventSink,
  RuntimeAccount,
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
      supportsAccounts: this.supportsAccounts,
    };
  }
  /** 06.1-03: whether this stub says it can take images (the daemon refuses image prompts otherwise). */
  supportsImages = false;
  /** 07.18: the pool account kinds this stub accepts. */
  supportsAccounts: ("token" | "device_slot")[] = ["token"];
  /** 07.18: every `useAccount` call, in order (null = the device's own login). */
  readonly accountSwitches: Array<{ sessionId: string; account: RuntimeAccount | null }> = [];
  async useAccount(sessionId: string, account: RuntimeAccount | null): Promise<void> {
    this.calls.push(`useAccount:${account?.ref ?? "device"}`);
    this.accountSwitches.push({ sessionId, account });
  }
  /** When set, `prompt()` rejects with this message (a runtime error echoing its input). */
  promptError: string | null = null;
  /** 07.17.1.1: when set, `prompt()` emits `prompt.started`, waits for it, then `prompt.completed` (a running turn). */
  promptHold: Promise<void> | null = null;
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

  /** 07.18-19 R1.8: whether the device's own Claude login is signed in, and whether a pool token is ready. */
  loggedIn = true;
  poolReady = false;
  catalogReadyWithoutLogin(): boolean {
    return this.poolReady;
  }
  detect(): Promise<RuntimeInfo> {
    return Promise.resolve({ id: "claude-code", installed: true, version: "9.9.9", loggedIn: this.loggedIn });
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
    // 07.17.1.1: a held turn (started, not yet handed back); it completes when the test releases it.
    if (this.promptHold) {
      await this.promptHold;
      sink?.({
        type: "prompt.completed",
        promptId: p.promptId,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      return;
    }
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

/** One request to the fake transfer route (07.17.1.1). */
interface FileRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentLength: string | undefined;
  sha256: string;
  bytes: number;
}

function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

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

  /** 07.17.1.1: a path prefix every HTTP route is served under (a server behind `/ocw`); others answer 404. */
  prefix = "";
  /** 07.17.1.1 (PD-05): every `GET|PUT /api/v1/runtime/files/:id`, in order (the body only as its size and sha256). */
  readonly fileRequests: FileRequest[] = [];
  /** Statuses the transfer route answers, one per request; 200 once empty. */
  fileStatuses: number[] = [];
  /** The bytes a `GET` answers with. */
  fileBody: Buffer = Buffer.alloc(0);
  /** Extra headers of a `GET`'s answer (review WR-01: the landing deadline). */
  fileHeaders: Record<string, string> = {};
  /** Called with each transfer request before it is answered (a test may await something). */
  onFileRequest: ((r: FileRequest) => Promise<void> | void) | null = null;

  constructor() {
    this.http = createServer((req, res) => {
      const url = req.url ?? "";
      const path = this.prefix
        ? url.startsWith(`${this.prefix}/`)
          ? url.slice(this.prefix.length)
          : ""
        : url;
      if (path.startsWith("/api/v1/runtime/files/") && (req.method === "GET" || req.method === "PUT")) {
        void this.serveFile(req, res, url);
        return;
      }
      if (req.method !== "POST" || path !== "/api/v1/devices/token") {
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
  private async serveFile(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) chunks.push(c as Buffer);
    } catch {
      res.destroy();
      return;
    }
    const body = Buffer.concat(chunks);
    const record: FileRequest = {
      method: req.method ?? "",
      url,
      authorization: req.headers.authorization,
      contentLength: req.headers["content-length"],
      sha256: sha256Hex(body),
      bytes: body.byteLength,
    };
    this.fileRequests.push(record);
    for (const l of this.listeners) l();
    await this.onFileRequest?.(record);
    const status = this.fileStatuses.shift() ?? 200;
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" }).end('{"error":"refused"}');
    } else if (req.method === "PUT") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, sizeBytes: body.byteLength }));
    } else {
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(this.fileBody.byteLength),
          ...this.fileHeaders,
        })
        .end(this.fileBody);
    }
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
    // 07.18: a scratch default Codex home, so no slot ever links the real ~/.codex.
    env: { CODEX_HOME: join(home, "codex-default") },
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

  // Quick 261119-ngw: a project registered before the flag existed was announced without it, so the server could not
  // tell that a bot session in it must run in place; every announcement now re-detects it.
  it("announces a project's git as it is now, also for an entry written before the flag", async () => {
    const plain = join(home, "notes");
    mkdirSync(plain);
    const entry = { gitRemote: null, defaultBranch: null, addedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(
      join(home, "projects.json"),
      JSON.stringify({
        projects: [
          { ...entry, localId: "lp_notes", path: plain, name: "notes" },
          { ...entry, localId: "lp_acme", path: project, name: "acme", git: false },
        ],
      }),
    );
    await daemon.registry.load();
    await daemon.start();
    const sync = await server.frame("projects.sync", (f) => f.projects.length === 2);
    expect(sync.projects).toEqual([
      { localId: "lp_notes", name: "notes", gitRemote: null, defaultBranch: null, git: false },
      { localId: "lp_acme", name: "acme", gitRemote: null, defaultBranch: null, git: true },
    ]);
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
      server.connections.length === 2 && server.last.frames.length >= 6 ? true : undefined,
    );
    const types = server.last.frames.map((f) => (f.type === "event" ? f.event.type : f.type));
    expect(types.slice(0, 6)).toEqual([
      "hello",
      "projects.sync",
      "capabilities",
      "accounts.sync",
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

describe("07.13.1 app update hold (D-07): the desktop app holds every gate for its restart", () => {
  const hold = (drain: boolean) => controlRequest(socketPath(), { cmd: "appUpdateHold", drain });
  const release = (holdId: string) => controlRequest(socketPath(), { cmd: "appUpdateRelease", holdId });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const appUpdateOf = async () =>
    ((await controlRequest(socketPath(), { cmd: "status" })).result as { appUpdate: unknown }).appUpdate;
  const hasAck = (id: string) => server.allFrames.some((f) => f.type === "ack" && f.commandId === id);

  async function startSession(sessionId: string): Promise<void> {
    const localId = await addProject();
    server.send({
      id: `start-${sessionId}`,
      kind: "session.start",
      sessionId,
      payload: { projectLocalId: localId, permissionMode: "default" },
    });
    expect(await server.frame("ack", (f) => f.commandId === `start-${sessionId}`)).toMatchObject({
      ok: true,
    });
  }

  it("an idle daemon is held at once; a prompt sent meanwhile waits until the release, then runs", async () => {
    await daemon.start();
    await server.frame("hello");
    await startSession("H");
    expect(await appUpdateOf()).toEqual({ state: "idle", running: 0 });
    const answer = await hold(false);
    expect(answer).toEqual({
      ok: true,
      result: { held: true, state: "held", running: 0, holdId: expect.stringMatching(UUID) },
    });
    const holdId = (answer.result as { holdId: string }).holdId;
    expect(await appUpdateOf()).toEqual({ state: "held", running: 0, holdId });
    // Review CR-01: a repeat hold is not the owner (no id), and a release naming another hold reopens nothing.
    expect(await hold(true)).toEqual({ ok: true, result: { held: true, state: "held", running: 0 } });
    expect(await release("00000000-0000-4000-8000-000000000000")).toEqual({
      ok: true,
      result: { released: false },
    });

    server.send({ id: "ph1", kind: "prompt", sessionId: "H", payload: { promptId: "h1", text: "go" } });
    await sleep(200);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("h1");
    expect(hasAck("ph1")).toBe(false);

    expect(await release(holdId)).toEqual({ ok: true, result: { released: true } });
    expect(await server.frame("ack", (f) => f.commandId === "ph1")).toMatchObject({ ok: true });
    expect(runtime.prompts.map((p) => p.promptId)).toContain("h1");
    expect(await appUpdateOf()).toEqual({ state: "idle", running: 0, lastEnd: "released" });
    expect(await release(holdId)).toEqual({ ok: true, result: { released: false } });
  });

  it("both commands are strict: a missing drain, an extra key or a value on the release is an invalid request", async () => {
    await daemon.start();
    expect(await controlRequest(socketPath(), { cmd: "appUpdateHold" } as never)).toMatchObject({
      ok: false,
      error: "invalid request",
    });
    expect(
      await controlRequest(socketPath(), { cmd: "appUpdateHold", drain: true, x: 1 } as never),
    ).toMatchObject({ ok: false, error: "invalid request" });
    expect(await controlRequest(socketPath(), { cmd: "appUpdateHold", drain: "yes" } as never)).toMatchObject(
      { ok: false, error: "invalid request" },
    );
    expect(
      await controlRequest(socketPath(), { cmd: "appUpdateRelease", drain: false } as never),
    ).toMatchObject({ ok: false, error: "invalid request" });
    // Review CR-01: a release must name the hold it ends (a UUID).
    expect(await controlRequest(socketPath(), { cmd: "appUpdateRelease" } as never)).toMatchObject({
      ok: false,
      error: "invalid request",
    });
    expect(
      await controlRequest(socketPath(), { cmd: "appUpdateRelease", holdId: "h1" } as never),
    ).toMatchObject({ ok: false, error: "invalid request" });
    // Nothing was held by the refused requests.
    expect(await appUpdateOf()).toEqual({ state: "idle", running: 0 });
  });

  const updateEvents = (sessionId: string) =>
    server.allFrames.flatMap((f) =>
      f.type === "event" && f.sessionId === sessionId && f.event.type === "runtime.update" ? [f.event] : [],
    );
  const RESTARTING = { type: "runtime.update", runtime: "claude-code", subject: "ocw-runtime" };

  it("a prompt held by the app's hold is told once the OCW runtime restarts, then failed after the release", async () => {
    await daemon.start();
    await server.frame("hello");
    await startSession("N");
    const held = (await hold(false)).result as { held: boolean; holdId: string };
    expect(held).toMatchObject({ held: true });
    server.send({ id: "pn1", kind: "prompt", sessionId: "N", payload: { promptId: "n1", text: "go" } });
    server.send({ id: "pn2", kind: "prompt", sessionId: "N", payload: { promptId: "n2", text: "again" } });
    await server.waitFor(() => (updateEvents("N").length > 0 ? true : undefined));
    await sleep(200);
    expect(updateEvents("N")).toEqual([{ ...RESTARTING, phase: "waiting" }]);
    expect(runtime.prompts).toEqual([]);

    expect((await release(held.holdId)).result).toEqual({ released: true });
    expect(await server.frame("ack", (f) => f.commandId === "pn1")).toMatchObject({ ok: true });
    expect(await server.frame("ack", (f) => f.commandId === "pn2")).toMatchObject({ ok: true });
    expect(updateEvents("N")).toEqual([
      { ...RESTARTING, phase: "waiting" },
      { ...RESTARTING, phase: "failed" },
    ]);
    // The `failed` line went out before the held prompt started.
    const frames = server.allFrames;
    const failedAt = frames.findIndex(
      (f) => f.type === "event" && f.event.type === "runtime.update" && f.event.phase === "failed",
    );
    const startedAt = frames.findIndex((f) => f.type === "event" && f.event.type === "prompt.started");
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(failedAt);
  });

  it("the daemon stops during the hold: the held prompt never runs, is never acked, and no failed line is sent", async () => {
    await daemon.start();
    await server.frame("hello");
    await startSession("S");
    expect((await hold(false)).result).toMatchObject({ held: true });
    server.send({ id: "ps1", kind: "prompt", sessionId: "S", payload: { promptId: "s1", text: "go" } });
    await server.waitFor(() => (updateEvents("S").length > 0 ? true : undefined));
    await daemon.stop();
    await sleep(200);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("s1");
    expect(hasAck("ps1")).toBe(false);
    expect(updateEvents("S")).toEqual([{ ...RESTARTING, phase: "waiting" }]);
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

describe("Isolated server and host kind (07.16, D-19, PD-18)", () => {
  it("a service host with the mark on reports host and isolatedServer in hello, capabilities and status", async () => {
    await setIsolatedServer(home, true);
    await gatedDaemon({ OCW_RUNTIME_HOST: "service" });
    await daemon.start();
    const hello = await server.frame("hello");
    expect(hello.device.host).toBe("service");
    expect(hello.isolatedServer).toBe(true);
    expect((await server.frame("capabilities")).isolatedServer).toBe(true);
    const status = await controlRequest(socketPath(), { cmd: "status" });
    expect(status.result).toMatchObject({
      isolatedServer: true,
      isolatedServerSource: "config",
      host: "service",
    });
    // Only the enum crosses the wire: no local path of the host decision.
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it("a desktop host never reports the mark, whatever the file says", async () => {
    await setIsolatedServer(home, true);
    await gatedDaemon({ OCW_RUNTIME_HOST: "desktop" });
    await daemon.start();
    const hello = await server.frame("hello");
    expect(hello.device.host).toBe("desktop");
    expect(hello.isolatedServer).toBe(false);
    expect((await server.frame("capabilities")).isolatedServer).toBe(false);
  });

  it("an unknown host sends no device.host and no mark", async () => {
    await setIsolatedServer(home, true);
    await gatedDaemon({});
    await daemon.start();
    const hello = await server.frame("hello");
    expect(hello.device).not.toHaveProperty("host");
    expect(hello.isolatedServer).toBe(false);
  });

  it("reloadConfig after turning the mark off sends capabilities with isolatedServer: false at once", async () => {
    await setIsolatedServer(home, true);
    await gatedDaemon({ OCW_RUNTIME_HOST: "service" });
    await daemon.start();
    expect((await server.frame("hello")).isolatedServer).toBe(true);
    await server.frame("capabilities", (f) => f.isolatedServer === true);
    await setIsolatedServer(home, false);
    const res = await controlRequest(socketPath(), { cmd: "reloadConfig" });
    expect(res).toMatchObject({
      ok: true,
      result: { isolatedServer: false, isolatedServerSource: "config", host: "service" },
    });
    await server.frame("capabilities", (f) => f.isolatedServer === false);
    // The environment wins over the file.
    await gatedDaemon({ OCW_RUNTIME_HOST: "service", OCW_ISOLATED_SERVER: "1" });
    await daemon.start();
    expect(await controlRequest(socketPath(), { cmd: "reloadConfig" })).toMatchObject({
      ok: true,
      result: { isolatedServer: true, isolatedServerSource: "env" },
    });
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
    // 07.18-19 R1.8: the adapter learns whose title it is (a pool session's title runs on its own token).
    expect(runtime.titleRequests[0]?.sessionId).toBe(SID);
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
      selfUpdate?: boolean;
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
      // 07.17.1 regression: the same daemon with a SelfUpdate (a checkout: no installed build, it never updates).
      ...(o.selfUpdate
        ? {
            exitForUpdate: async () => undefined,
            selfUpdate: {
              serverUrl: "http://127.0.0.1:9",
              running: null,
              supervision: { supervised: false, reason: "not_installed" as const },
            },
          }
        : {}),
    });
  }

  const welcome = (): ServerToDeviceFrame => ({
    type: "welcome",
    deviceId: randomUUID(),
    organizationId: randomUUID(),
  });

  it("07.17.1: with a SelfUpdate present, a Claude Code update command and its held turns behave exactly as in 07.11 (no subject)", async () => {
    await updatesDaemon({
      fakeUpdate: { delayMs: 1000 },
      maintenance: { drainPollMs: 20 },
      selfUpdate: true,
    });
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push({ type: "runtime.config", policy: "notify", manifest: RUNTIME_COMPATIBILITY_MANIFEST });
    const behind = await server.frame(
      "runtime.maintenance",
      (f) => f.runtimes.some((s) => s.runtime === "claude-code" && s.advisory === "behind"),
      10_000,
    );
    expect(behind.self).toMatchObject({ build: null, reason: "not_installed", canUpdate: false });
    server.send({
      id: "start-B",
      kind: "session.start",
      sessionId: "B",
      payload: { projectLocalId: localId, runtime: "claude-code", permissionMode: "default" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "start-B", 10_000)).toMatchObject({ ok: true });
    const cmd = { id: randomUUID(), kind: "runtime.update" as const, sessionId: randomUUID() };
    server.send({ ...cmd, payload: { runtime: "claude-code" } });
    expect(await server.frame("ack", (f) => f.commandId === cmd.id, 10_000)).toMatchObject({ ok: true });
    await server.frame("runtime.update.run", (f) => f.phase === "started" && f.commandId === cmd.id, 10_000);
    server.send({ id: "pb1", kind: "prompt", sessionId: "B", payload: { promptId: "b1", text: "go" } });
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({ runtime: "claude-code", commandId: cmd.id, outcome: "succeeded" });
    expect(await server.frame("ack", (f) => f.commandId === "pb1", 5000)).toMatchObject({ ok: true });
    const events = () =>
      server.allFrames.flatMap((f) =>
        f.type === "event" && f.sessionId === "B" && f.event.type === "runtime.update" ? [f.event] : [],
      );
    await server.waitFor(() => (events().length === 2 ? true : undefined));
    expect(events()).toEqual([
      { type: "runtime.update", runtime: "claude-code", phase: "waiting" },
      { type: "runtime.update", runtime: "claude-code", phase: "done", version: "2.1.300" },
    ]);
    // Every snapshot carries `self` while a SelfUpdate exists; it never asked anything.
    expect(
      server.allFrames.filter((f) => f.type === "runtime.maintenance").every((f) => f.self !== undefined),
    ).toBe(true);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run" && f.runtime === "ocw-runtime")).toBe(
      false,
    );
  }, 40_000);

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

  it("07.13.1 app update hold: no CLI job starts while the app holds, and the app is not held while a CLI job runs", async () => {
    await updatesDaemon({ fakeUpdate: { delayMs: 800 }, maintenance: { pollMs: 20, drainPollMs: 20 } });
    await daemon.start();
    await server.frame("hello");
    server.push(welcome());
    server.push(notify());
    await server.frame("runtime.maintenance", (f) => f.orgLevelReceived, 10_000);

    // The app holds first: an "Update now" is accepted but its job waits pending, nothing runs.
    const held = await controlRequest(socketPath(), { cmd: "appUpdateHold", drain: false });
    expect(held).toMatchObject({ ok: true, result: { held: true, state: "held" } });
    const holdId = (held.result as { holdId: string }).holdId;
    expect(
      await controlRequest(socketPath(), { cmd: "runtimeUpdate", runtime: "claude-code" }),
    ).toMatchObject({ ok: true, result: { accepted: true } });
    await sleep07(400);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run" && f.phase === "started")).toBe(
      false,
    );
    expect(fakeClaudeVersion()).toBe("2.1.290 (Claude Code)");

    // The release lets it run; while it runs the app's hold is refused and closes nothing more.
    expect(await controlRequest(socketPath(), { cmd: "appUpdateRelease", holdId })).toMatchObject({
      result: { released: true },
    });
    await server.frame("runtime.update.run", (f) => f.phase === "started", 10_000);
    const blocked = await controlRequest(socketPath(), { cmd: "appUpdateHold", drain: true });
    expect(blocked).toMatchObject({
      ok: true,
      result: { held: false, state: "idle", blocked: "runtime_update" },
    });
    const gates = (daemon as unknown as { gates: Map<RuntimeId, RuntimeGate> }).gates;
    expect(gates.get("codex")?.isOpen).toBe(true);
    const finished = await server.frame("runtime.update.run", (f) => f.phase === "finished", 15_000);
    expect(finished).toMatchObject({ outcome: "succeeded", toVersion: "2.1.300" });
    // Once the job is over the app can hold again.
    await vi.waitFor(
      async () =>
        expect(
          (await controlRequest(socketPath(), { cmd: "appUpdateHold", drain: false })).result,
        ).toMatchObject({ held: true }),
      { timeout: 5_000, interval: 50 },
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

// ---------------------------------------------------------------------------------------------
// 07.17.1 runtime self-update: the device end to end over a test Device Link (D-03, D-04, D-05, D-07, PD-12, PD-18,
// PD-19). A scratch OCW_HOME at 0.3.1 is the daemon's home, a loopback stub serves 0.3.2, the fake npm installs it,
// and the exit is a spy that runs the daemon's real hand-over (stop, then record the code; never process.exit).

const sha256Of = (data: string) => createHash("sha256").update(data).digest("hex");
const BUILD_DIR = /^[0-9a-f]{12}$/;

describe("07.17.1 runtime self-update: the daemon updates itself over the Device Link", () => {
  let scratch: ScratchHome;
  let stub: DistStub;
  let npmPath: string;
  let userHome: string;
  let codex: ScriptedRuntime;
  const extra: Daemon[] = [];

  beforeEach(async () => {
    await daemon.stop();
    scratch = await scratchOcwHome();
    stub = await startDistStub({ version: "0.3.2" });
    const root = join(scratch.ocwHome, "..");
    npmPath = await fakeNpm(join(root, "fake-bin"));
    userHome = join(root, "user");
    mkdirSync(userHome, { recursive: true });
  });

  afterEach(async () => {
    for (const d of extra.splice(0)) await d.stop();
    // PD-19, E30: the install lock was taken in the scratch home's lock directory, never in the OS user's.
    const lockName = `${sha256Of(join(scratch.ocwHome, "runtime"))}.lock`;
    expect(existsSync(join(userInfo().homedir, ".cache", "ocw", "runtime-updates", lockName))).toBe(false);
    await stub.close();
    scratch.cleanup();
  });

  const oldSelf = () => ({ version: "0.3.1", sha256: scratch.oldSha256 });
  const newSelf = () => ({ version: "0.3.2", sha256: stub.manifest.sha256 });
  const new12 = () => stub.manifest.sha256.slice(0, 12);
  const scratchLockFile = () =>
    join(defaultLockDir(userHome), `${sha256Of(join(scratch.ocwHome, "runtime"))}.lock`);

  /** A daemon on the scratch home with a Claude Code stub and a scripted Codex; the self-update aimed at the stub. */
  async function selfDaemon(
    o: {
      running?: { version: string; sha256: string } | null;
      supervision?: SelfUpdateOptions["supervision"];
      exitForUpdate?: ((code: number) => Promise<void>) | null;
      maxHoldMs?: number;
    } = {},
  ): Promise<Daemon> {
    runtime = new FakeRuntime();
    codex = new ScriptedRuntime("codex", 5);
    const d = await Daemon.create({
      home: scratch.ocwHome,
      env: { PATH: ["/usr/bin", "/bin"].join(":"), HOME: userHome },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [runtime, codex],
      logger: silentLogger,
      controlSocket: false,
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
      maintenance: {
        userHome,
        which: () => null,
        registry: { latest: async () => null },
        freshRegistry: { latest: async () => null },
      },
      ...(o.exitForUpdate === null ? {} : { exitForUpdate: o.exitForUpdate ?? (async () => undefined) }),
      selfUpdate: {
        serverUrl: stub.url,
        running: o.running === undefined ? oldSelf() : o.running,
        supervision: o.supervision ?? { supervised: true, reason: null },
        pollMs: 20,
        ...(o.maxHoldMs !== undefined ? { maxHoldMs: o.maxHoldMs } : {}),
        prepare: (p: PrepareVersionOptions) => prepareVersion({ ...p, npmPath }),
      },
    });
    extra.push(d);
    return d;
  }

  /** The exit spy: runs the daemon's real hand-over (`stop()`), then records the code; never exits the process. */
  function handOverSpy(of: () => Daemon) {
    const window = { from: -1, to: -1 };
    const spy: Mock<(code: number) => Promise<void>> = vi.fn(async (_code: number) => {
      window.from = server.allFrames.length;
      await of().stop();
      window.to = server.allFrames.length;
    });
    return { spy, window };
  }

  const welcome = (): ServerToDeviceFrame => ({
    type: "welcome",
    deviceId: randomUUID(),
    organizationId: randomUUID(),
  });
  const notify = (): ServerToDeviceFrame => ({
    type: "runtime.config",
    policy: "notify",
    manifest: RUNTIME_COMPATIBILITY_MANIFEST,
  });
  const selfCmd = () => ({
    id: randomUUID(),
    kind: "runtime.update" as const,
    sessionId: randomUUID(),
    payload: { runtime: "ocw-runtime" },
  });
  const ackOf = (id: string, timeoutMs = 10_000) => server.frame("ack", (f) => f.commandId === id, timeoutMs);
  const gatesOf = (d: Daemon) => (d as unknown as { gates: Map<RuntimeId, RuntimeGate> }).gates;
  type Snapshot = Extract<DeviceToServerFrame, { type: "runtime.maintenance" }>;
  const selfStates = (frames: DeviceToServerFrame[]) =>
    frames.flatMap((f) => (f.type === "runtime.maintenance" && f.self ? [f.self.state] : []));

  it("the click updates the daemon: started, downloading → installing → restarting, current switched, exit 75 once; the next daemon reports success", async () => {
    const { spy, window } = handOverSpy(() => first);
    const first = await selfDaemon({ exitForUpdate: spy });
    daemon = first;
    await first.start();
    await server.frame("hello");
    const hello = server.last;
    const handshake = await server.frame("runtime.maintenance", (f) => f.self !== undefined, 10_000);
    expect(handshake.self).toMatchObject({
      version: "0.3.1",
      build: scratch.oldSha12,
      supervised: true,
      canUpdate: true,
      reason: null,
      state: "idle",
    });
    server.push(welcome());
    // runtime.config → onConfig(): the device checks what its workspace serves (the stub) and reports it.
    server.push(notify());
    await server.frame("runtime.maintenance", (f) => f.self?.servedBuild === new12(), 10_000);

    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: true });
    const started = await server.frame(
      "runtime.update.run",
      (f) => f.phase === "started" && f.commandId === cmd.id,
      10_000,
    );
    expect(started).toMatchObject({
      runtime: "ocw-runtime",
      trigger: "manual",
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      fromBuild: scratch.oldSha12,
      toBuild: new12(),
      method: "ocw_bundle",
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 30_000, interval: 20 });
    await vi.waitFor(() => expect(window.to).toBeGreaterThanOrEqual(0), { timeout: 10_000, interval: 20 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(75);
    const states = selfStates(hello.frames);
    const at = (s: string) => states.indexOf(s as never);
    expect(at("downloading")).toBeGreaterThan(-1);
    expect(at("downloading")).toBeLessThan(at("installing"));
    expect(at("installing")).toBeLessThan(at("restarting"));
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${new12()}`);
    // E29: the hand-over sends no run frame (no `finished`); every gate stays closed into the exit.
    const during = server.allFrames.slice(window.from, window.to);
    expect(during.filter((f) => f.type === "runtime.update.run")).toEqual([]);
    expect(
      hello.frames.filter((f) => f.type === "runtime.update.run" && f.runId === started.runId),
    ).toHaveLength(1);
    expect([...gatesOf(first).values()].every((g) => !g.isOpen)).toBe(true);
    // The lock directory is the maintenance scope's (the scratch home): the lock is held into the exit there.
    expect(existsSync(scratchLockFile())).toBe(true);

    // The service manager starts the new build: a second daemon on the same home, running 0.3.2.
    const second = await selfDaemon({ running: newSelf() });
    daemon = second;
    await second.start();
    const conn = await server.waitFor(
      () => (server.connections.length > 1 && server.last.frames.length >= 3 ? server.last : undefined),
      10_000,
    );
    expect(conn.frames[0]?.type).toBe("hello");
    expect(conn.frames[1]).toMatchObject({
      type: "runtime.update.run",
      phase: "started",
      runId: started.runId,
      commandId: cmd.id,
    });
    expect(conn.frames[2]).toMatchObject({
      type: "runtime.update.run",
      phase: "finished",
      outcome: "succeeded",
      runId: started.runId,
      commandId: cmd.id,
      fromBuild: scratch.oldSha12,
      toBuild: new12(),
    });
    const after = (await server.waitFor(
      () => conn.frames.find((f) => f.type === "runtime.maintenance" && f.self !== undefined),
      10_000,
    )) as Snapshot;
    expect(after.self).toMatchObject({ version: "0.3.2", build: new12(), lastRun: { outcome: "succeeded" } });
    await vi.waitFor(() => expect(existsSync(selfUpdateMarkerPath(scratch.ocwHome))).toBe(false), {
      timeout: 5_000,
      interval: 20,
    });
    const versions = readdirSync(join(scratch.ocwHome, "runtime", "versions"));
    expect(versions.filter((n) => BUILD_DIR.test(n)).sort()).toEqual([scratch.oldSha12, new12()].sort());
    expect(versions.filter((n) => n.startsWith(".staging-"))).toEqual([]);

    // E17: the server redelivers the first command to the new daemon: acked ok, nothing runs again.
    const asked = stub.requests.length;
    server.send(cmd);
    expect(
      await server.waitFor(() => conn.frames.find((f) => f.type === "ack" && f.commandId === cmd.id), 10_000),
    ).toMatchObject({ ok: true });
    await sleep(300);
    expect(conn.frames.filter((f) => f.type === "runtime.update.run" && f.phase === "started")).toHaveLength(
      1,
    );
    expect(stub.requests.length).toBe(asked);

    // PD-25: no frame the server received carries a host path.
    for (const f of server.allFrames) expect(JSON.stringify(f)).not.toMatch(HOST_PATH_TOKEN_RE);
    // Only the stub was asked for the runtime (P1); nothing followed a redirect.
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.redirectRequests).toEqual([]);
  }, 60_000);

  // ---- Task 2: busy devices wait and say why; redelivered and refused commands are safe (D-04, D-05, PD-18) ----

  const hasAck = (id: string) => server.allFrames.some((f) => f.type === "ack" && f.commandId === id);
  const updateEvents = (sessionId: string) =>
    server.allFrames.flatMap((f) =>
      f.type === "event" && f.sessionId === sessionId && f.event.type === "runtime.update" ? [f.event] : [],
    );
  async function startOn(sessionId: string, rt: RuntimeId, localId: string): Promise<void> {
    server.send({
      id: `start-${sessionId}`,
      kind: "session.start",
      sessionId,
      payload: { projectLocalId: localId, runtime: rt, permissionMode: "default" },
    });
    expect(await ackOf(`start-${sessionId}`)).toMatchObject({ ok: true });
  }

  it("a Codex turn running: the update waits, a new Claude Code turn is held and told the OCW runtime restarts; the exit comes after the turn", async () => {
    const { spy, window } = handOverSpy(() => d);
    const d = await selfDaemon({ exitForUpdate: spy });
    daemon = d;
    const localId = (await d.registry.add(project)).localId;
    await d.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    await startOn("C", "codex", localId);
    // C's Codex turn runs and waits on an approval: a turn in flight.
    server.send({ id: "pc1", kind: "prompt", sessionId: "C", payload: { promptId: "c1", text: "go" } });
    const asked = await server.frame(
      "event",
      (f) => f.sessionId === "C" && f.event.type === "approval.requested",
      10_000,
    );
    expect(codex.activeTurns()).toBe(1);

    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: true });
    await server.frame("runtime.maintenance", (f) => f.self?.state === "waiting", 30_000);
    // A new Claude Code turn (and a title for it) is held; its session hears once that the OCW runtime restarts.
    server.send({ id: "pa1", kind: "prompt", sessionId: "A", payload: { promptId: "a1", text: "next" } });
    server.send({
      id: "ta1",
      kind: "session.title",
      sessionId: "A",
      payload: { runtime: "claude-code", model: "opus", prompt: "Please fix the login redirect bug" },
    });
    await server.waitFor(() => (updateEvents("A").length > 0 ? true : undefined), 10_000);
    await sleep(300);
    expect(updateEvents("A")).toEqual([
      { type: "runtime.update", runtime: "claude-code", phase: "waiting", subject: "ocw-runtime" },
    ]);
    expect(updateEvents("C")).toEqual([]);
    expect(hasAck("pa1")).toBe(false);
    expect(hasAck("ta1")).toBe(false);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("a1");
    expect(spy).not.toHaveBeenCalled();

    // The Codex turn ends (its approval is resolved; approvals never wait at the gate): then the restart.
    const approvalId = asked.event.type === "approval.requested" ? asked.event.approvalId : "";
    server.send({
      id: "rc1",
      kind: "approval.resolve",
      sessionId: "C",
      payload: { approvalId, decision: "once" },
    });
    expect(await ackOf("rc1")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(75), { timeout: 15_000, interval: 20 });
    await vi.waitFor(() => expect(window.to).toBeGreaterThanOrEqual(0), { timeout: 10_000, interval: 20 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      server.allFrames.some(
        (f) => f.type === "event" && f.sessionId === "C" && f.event.type === "prompt.completed",
      ),
    ).toBe(true);
    // The held prompt was never acked by this daemon: the server runs it after the restart (PD-27).
    expect(hasAck("pa1")).toBe(false);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("a1");
    expect(updateEvents("A")).toHaveLength(1);
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${new12()}`);
  }, 60_000);

  it("review WR-01: stopping the daemon during the hold never starts the held prompt; the run closes cancelled and the prompt stays unacked for PD-27", async () => {
    const spy = vi.fn(async (_code: number) => undefined);
    const d = await selfDaemon({ exitForUpdate: spy });
    daemon = d;
    const localId = (await d.registry.add(project)).localId;
    await d.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    await startOn("C", "codex", localId);
    server.send({ id: "pc1", kind: "prompt", sessionId: "C", payload: { promptId: "c1", text: "go" } });
    await server.frame("event", (f) => f.sessionId === "C" && f.event.type === "approval.requested", 10_000);

    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: true });
    await server.frame("runtime.maintenance", (f) => f.self?.state === "waiting", 30_000);
    server.send({ id: "pa1", kind: "prompt", sessionId: "A", payload: { promptId: "a1", text: "next" } });
    await server.waitFor(() => (updateEvents("A").length > 0 ? true : undefined), 10_000);

    // `ocw-runtime service restart` / `systemctl stop` while the hold is on.
    await d.stop();
    await sleep(300);
    expect(runtime.prompts.map((p) => p.promptId)).not.toContain("a1");
    expect(
      server.allFrames.some(
        (f) => f.type === "event" && f.sessionId === "A" && f.event.type === "prompt.started",
      ),
    ).toBe(false);
    expect(hasAck("pa1")).toBe(false);
    expect(
      server.allFrames.find(
        (f) => f.type === "runtime.update.run" && f.phase === "finished" && f.commandId === cmd.id,
      ),
    ).toMatchObject({ outcome: "failed", output: "cancelled: the runtime stopped" });
    expect(spy).not.toHaveBeenCalled();
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${scratch.oldSha12}`);
  }, 60_000);

  it("review IN-04 / WR-02: a hold that gives up tells the held session the update did not run, and its turn runs", async () => {
    const spy = vi.fn(async (_code: number) => undefined);
    const d = await selfDaemon({ exitForUpdate: spy, maxHoldMs: 1_500 });
    daemon = d;
    const localId = (await d.registry.add(project)).localId;
    await d.start();
    await server.frame("hello");
    server.push(welcome());
    await startOn("A", "claude-code", localId);
    await startOn("C", "codex", localId);
    server.send({ id: "pc1", kind: "prompt", sessionId: "C", payload: { promptId: "c1", text: "go" } });
    await server.frame("event", (f) => f.sessionId === "C" && f.event.type === "approval.requested", 10_000);

    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: true });
    await server.frame("runtime.maintenance", (f) => f.self?.state === "waiting", 30_000);
    server.send({ id: "pa1", kind: "prompt", sessionId: "A", payload: { promptId: "a1", text: "next" } });
    await server.frame("runtime.update.run", (f) => f.phase === "finished" && f.commandId === cmd.id, 15_000);
    await vi.waitFor(() => expect(runtime.prompts.map((p) => p.promptId)).toContain("a1"), {
      timeout: 10_000,
      interval: 20,
    });
    expect(updateEvents("A")).toEqual([
      { type: "runtime.update", runtime: "claude-code", phase: "waiting", subject: "ocw-runtime" },
      { type: "runtime.update", runtime: "claude-code", phase: "failed", subject: "ocw-runtime" },
    ]);
    expect(updateEvents("C")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  it("07.13.1 app update hold: the self-update closes no gate while the app holds; once it holds, the app is refused", async () => {
    const spy = vi.fn(async (_code: number) => undefined);
    const d = await selfDaemon({ exitForUpdate: spy });
    daemon = d;
    const control = (req: ControlRequest) =>
      (d as unknown as { handleControl(r: ControlRequest): Promise<unknown> }).handleControl(req);
    await d.start();
    await server.frame("hello");
    server.push(welcome());
    const held = (await control({ cmd: "appUpdateHold", drain: false })) as { held: boolean; holdId: string };
    expect(held).toMatchObject({ held: true });

    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: true });
    await server.frame("runtime.maintenance", (f) => f.self?.state === "waiting", 30_000);
    await sleep(300);
    expect(spy).not.toHaveBeenCalled();
    expect((d as unknown as { selfUpdate: { holding: boolean } }).selfUpdate.holding).toBe(false);

    // The app's release lets the self-update take its idle moment and switch.
    expect(await control({ cmd: "appUpdateRelease", holdId: held.holdId })).toEqual({ released: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(75), { timeout: 15_000, interval: 20 });
    // The self-update holds every gate into its exit: the app's hold is refused and changes nothing.
    expect(await control({ cmd: "appUpdateHold", drain: true })).toEqual({
      held: false,
      state: "idle",
      running: 0,
      blocked: "runtime_update",
    });
    expect((await d.status()).appUpdate).toEqual({ state: "idle", running: 0, lastEnd: "released" });
    expect([...gatesOf(d).values()].every((g) => !g.isOpen)).toBe(true);
  }, 60_000);

  it("review IN-06: a snapshot whose send throws does not stop later CLI snapshots, and stop() still closes the link", async () => {
    const d = await selfDaemon();
    daemon = d;
    await d.start();
    await server.frame("hello");
    const first = await server.frame("runtime.maintenance", (f) => f.self !== undefined, 10_000);
    const inner = d as unknown as {
      link: { send: (f: DeviceToServerFrame) => void };
      maintenance: { opts: { sendSnapshot: (f: Snapshot) => void } };
    };
    const send = inner.link.send.bind(inner.link);
    let thrown = 0;
    inner.link.send = (f) => {
      if (f.type === "runtime.maintenance" && thrown === 0) {
        thrown += 1;
        throw new Error("socket write failed");
      }
      send(f);
    };
    const before = server.allFrames.filter((f) => f.type === "runtime.maintenance").length;
    const { self: _self, ...cli } = first;
    inner.maintenance.opts.sendSnapshot(cli);
    inner.maintenance.opts.sendSnapshot(cli);
    await vi.waitFor(
      () => expect(server.allFrames.filter((f) => f.type === "runtime.maintenance").length).toBe(before + 1),
      { timeout: 5_000, interval: 20 },
    );
    expect(thrown).toBe(1);
    await d.stop();
    expect(d.isConnected).toBe(false);
  }, 30_000);

  it("not a service run: the click is refused with the device's sentence; nothing is fetched, current is unchanged", async () => {
    const spy = vi.fn(async (_code: number) => undefined);
    const d = await selfDaemon({
      supervision: { supervised: false, reason: "not_supervised" },
      exitForUpdate: spy,
    });
    daemon = d;
    await d.start();
    await server.frame("hello");
    const snap = await server.frame("runtime.maintenance", (f) => f.self !== undefined, 10_000);
    expect(snap.self).toMatchObject({ supervised: false, canUpdate: false, reason: "not_supervised" });
    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({
      ok: false,
      error: "Run as a service to update from the browser; or re-run the install command",
    });
    await sleep(200);
    expect(stub.requests).toEqual([]);
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${scratch.oldSha12}`);
    expect(existsSync(selfUpdateMarkerPath(scratch.ocwHome))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  }, 30_000);

  it("review CR-01: back on the previous build after a rollback, automatic does not re-install the build that did not come back, across restarts", async () => {
    // The owner pointed `current` back at 0.3.1 after 0.3.2 crash-looped: the marker still names 0.3.2.
    await writeSelfUpdateMarker(scratch.ocwHome, {
      runId: randomUUID(),
      commandId: null,
      trigger: "automatic",
      from: oldSelf(),
      to: newSelf(),
      startedAt: new Date().toISOString(),
    });
    const automatic = (): ServerToDeviceFrame => ({
      type: "runtime.config",
      policy: "automatic",
      manifest: RUNTIME_COMPATIBILITY_MANIFEST,
    });
    const startedRuns = () =>
      server.allFrames.filter((f) => f.type === "runtime.update.run" && f.phase === "started").length;
    const versionAsks = () => stub.requests.filter((p) => p.endsWith("/version")).length;
    const spy = vi.fn(async (_code: number) => undefined);

    const first = await selfDaemon({ exitForUpdate: spy });
    daemon = first;
    await first.start();
    await server.frame("runtime.update.run", (f) => f.phase === "finished" && f.outcome === "failed", 10_000);
    const reported = startedRuns();
    server.push(welcome());
    server.push(automatic());
    await vi.waitFor(() => expect(versionAsks()).toBe(1), { timeout: 10_000, interval: 20 });
    await sleep(500);
    expect(startedRuns()).toBe(reported);
    expect(spy).not.toHaveBeenCalled();
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${scratch.oldSha12}`);
    await vi.waitFor(() => expect(existsSync(selfUpdateMarkerPath(scratch.ocwHome))).toBe(false), {
      timeout: 5_000,
      interval: 20,
    });
    await first.stop();

    // The next start has no marker any more: the build is still remembered.
    const second = await selfDaemon({ exitForUpdate: spy });
    daemon = second;
    await second.start();
    await server.waitFor(() => (server.connections.length > 1 ? true : undefined), 10_000);
    server.push(welcome());
    server.push(automatic());
    await vi.waitFor(() => expect(versionAsks()).toBe(2), { timeout: 10_000, interval: 20 });
    await sleep(500);
    expect(startedRuns()).toBe(reported);
    expect(spy).not.toHaveBeenCalled();
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${scratch.oldSha12}`);
  }, 60_000);

  it("a daemon built without exitForUpdate refuses the click and its snapshots carry no self", async () => {
    const d = await selfDaemon({ exitForUpdate: null });
    daemon = d;
    await d.start();
    await server.frame("hello");
    const snap = await server.frame("runtime.maintenance", () => true, 10_000);
    expect(snap.self).toBeUndefined();
    const cmd = selfCmd();
    server.send(cmd);
    expect(await ackOf(cmd.id)).toMatchObject({ ok: false, error: SELF_UPDATE_UNAVAILABLE_MESSAGE });
    await sleep(200);
    expect(stub.requests).toEqual([]);
    expect(server.allFrames.filter((f) => f.type === "runtime.maintenance" && f.self !== undefined)).toEqual(
      [],
    );
    expect(server.allFrames.some((f) => f.type === "runtime.update.run")).toBe(false);
    expect(readlinkSync(join(scratch.ocwHome, "runtime", "current"))).toBe(`versions/${scratch.oldSha12}`);
    expect(
      readdirSync(join(scratch.ocwHome, "runtime", "versions")).filter((n) => BUILD_DIR.test(n)),
    ).toEqual([scratch.oldSha12]);
  }, 30_000);
});

// -------------------------------------------------------------------------------------------------
// 07.17.1.1: a bot's files between a session's tree and its server (D-02 … D-04, D-08, D-13, PD-05, PD-10, PD-18)

/** Replaces the default daemon with one whose transfer retries wait milliseconds, not seconds. */
async function fileDaemon(o: { serverUrl?: string; logger?: Logger } = {}): Promise<Daemon> {
  await daemon.stop();
  daemon = await Daemon.create({
    home,
    env: {},
    token: "device-token-123",
    config: { serverUrl: o.serverUrl ?? server.url },
    runtimes: [runtime],
    logger: o.logger ?? silentLogger,
    controlSocket: false,
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    fileRetryDelaysMs: [10, 20],
  });
  return daemon;
}

/** Registers the scratch project, connects and starts `sessionId` on it (cwd = the project). */
async function activeSession(sessionId: string): Promise<void> {
  const localId = (await daemon.registry.add(project)).localId;
  await daemon.start();
  await server.frame("hello");
  const id = `start-${sessionId}`;
  server.send({
    id,
    kind: "session.start",
    sessionId,
    payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
  });
  expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
}

function fileCmd(
  kind: "session.file.read" | "session.file.write",
  sessionId: string,
  payload: Record<string, unknown>,
): Omit<CommandFrame, "type"> {
  return { id: randomUUID(), kind, sessionId, payload };
}

function fileAck(id: string, timeoutMs = 5000) {
  return server.frame("ack", (f) => f.commandId === id, timeoutMs);
}

describe("07.17.1.1 session.file.read: one contained file streams to the server under the device JWT", () => {
  it("toRuntimeFileUrl keeps the server URL's path prefix and drops its query and hash", () => {
    expect(toRuntimeFileUrl("http://127.0.0.1:4000", "abc-1")).toBe(
      "http://127.0.0.1:4000/api/v1/runtime/files/abc-1",
    );
    expect(toRuntimeFileUrl("https://ocw.example/base/?x=1#h", "abc-1")).toBe(
      "https://ocw.example/base/api/v1/runtime/files/abc-1",
    );
    expect(() => toRuntimeFileUrl("https://ocw.example", "../devices/token")).toThrow();
  });

  it("PUTs exactly the file's bytes with the device JWT and content-length, then acks ok", async () => {
    await fileDaemon();
    await activeSession("wf-r1");
    const bytes = randomBytes(70_000);
    writeFileSync(join(project, "data.bin"), bytes);
    const cmd = fileCmd("session.file.read", "wf-r1", { path: "data.bin", maxBytes: 1_048_576 });
    server.send(cmd);
    expect(await fileAck(cmd.id)).toEqual({ type: "ack", commandId: cmd.id, ok: true });
    expect(server.fileRequests).toEqual([
      {
        method: "PUT",
        url: `/api/v1/runtime/files/${cmd.id}`,
        authorization: `Bearer ${server.issued.at(-1)}`,
        contentLength: "70000",
        sha256: sha256Hex(bytes),
        bytes: 70_000,
      },
    ]);
  });

  it("an empty file moves as zero bytes", async () => {
    await fileDaemon();
    await activeSession("wf-r0");
    writeFileSync(join(project, "empty.txt"), "");
    const cmd = fileCmd("session.file.read", "wf-r0", { path: "empty.txt", maxBytes: 10 });
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    expect(server.fileRequests[0]).toMatchObject({ method: "PUT", contentLength: "0", bytes: 0 });
  });

  it("a server under a path prefix gets the prefix; a url key in the payload changes nothing (P3)", async () => {
    server.prefix = "/ocw";
    await fileDaemon({ serverUrl: `${server.url}/ocw` });
    await activeSession("wf-r2");
    const cmd = fileCmd("session.file.read", "wf-r2", {
      path: "README.md",
      maxBytes: 1024,
      url: "http://evil.test/x",
    });
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    expect(server.fileRequests.map((r) => r.url)).toEqual([`/ocw/api/v1/runtime/files/${cmd.id}`]);
  });

  it("maps the server's answers: 413 too_large, 410 expired, 500 transfer_failed; a 401 is retried once with a fresh JWT", async () => {
    await fileDaemon();
    await activeSession("wf-r3");
    for (const [status, code] of [
      [413, "too_large"],
      [410, "expired"],
      [500, "transfer_failed"],
    ] as const) {
      server.fileStatuses = [status];
      const cmd = fileCmd("session.file.read", "wf-r3", { path: "README.md", maxBytes: 1024 });
      server.send(cmd);
      expect(await fileAck(cmd.id), String(status)).toMatchObject({ ok: false, error: code });
    }
    server.fileRequests.length = 0;
    server.fileStatuses = [401];
    const cmd = fileCmd("session.file.read", "wf-r3", { path: "README.md", maxBytes: 1024 });
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    expect(server.fileRequests).toHaveLength(2);
    expect(server.fileRequests[1]!.authorization).toBe(`Bearer ${server.issued.at(-1)}`);
    expect(server.fileRequests[0]!.authorization).not.toBe(server.fileRequests[1]!.authorization);
  });

  it("503 busy (the transfer stays pending): retried at most twice", async () => {
    await fileDaemon();
    await activeSession("wf-r4");
    server.fileStatuses = [503];
    const ok = fileCmd("session.file.read", "wf-r4", { path: "README.md", maxBytes: 1024 });
    server.send(ok);
    expect(await fileAck(ok.id)).toMatchObject({ ok: true });
    expect(server.fileRequests).toHaveLength(2);
    server.fileRequests.length = 0;
    server.fileStatuses = [503, 503, 503];
    const busy = fileCmd("session.file.read", "wf-r4", { path: "README.md", maxBytes: 1024 });
    server.send(busy);
    expect(await fileAck(busy.id)).toMatchObject({ ok: false, error: "transfer_failed" });
    expect(server.fileRequests).toHaveLength(3);
  });

  it("refusals happen before any request: not_running, too_large with the size, not_a_file, not_found, path_not_allowed, invalid_path", async () => {
    await fileDaemon();
    await activeSession("wf-r5");
    mkdirSync(join(project, "docs"));
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["no-such-session", { path: "README.md", maxBytes: 1024 }, "not_running"],
      ["wf-r5", { path: "README.md", maxBytes: 2 }, "too_large: 6"],
      ["wf-r5", { path: "docs", maxBytes: 1024 }, "not_a_file"],
      ["wf-r5", { path: "missing.md", maxBytes: 1024 }, "not_found"],
      ["wf-r5", { path: ".git/config", maxBytes: 1024 }, "path_not_allowed"],
      ["wf-r5", { path: "../x", maxBytes: 1024 }, "invalid_path"],
      ["wf-r5", { path: `${project}/README.md`, maxBytes: 1024 }, "invalid_path"],
    ];
    for (const [sessionId, payload, error] of cases) {
      const cmd = fileCmd("session.file.read", sessionId, payload);
      server.send(cmd);
      expect(await fileAck(cmd.id), error).toMatchObject({ ok: false, error });
    }
    expect(server.fileRequests).toEqual([]);
  });

  it("a running turn of the same session does not delay a read (never in session order)", async () => {
    await fileDaemon();
    await activeSession("wf-r6");
    let release!: () => void;
    runtime.promptHold = new Promise<void>((r) => {
      release = r;
    });
    server.send({
      id: "wf-r6-p",
      kind: "prompt",
      sessionId: "wf-r6",
      payload: { promptId: "pp", text: "go" },
    });
    await server.frame("event", (f) => f.sessionId === "wf-r6" && f.event.type === "prompt.started");
    const cmd = fileCmd("session.file.read", "wf-r6", { path: "README.md", maxBytes: 1024 });
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    expect(server.allFrames.some((f) => f.type === "ack" && f.commandId === "wf-r6-p")).toBe(false);
    release();
    expect(await fileAck("wf-r6-p")).toMatchObject({ ok: true });
  });

  it("no ack error and no log line names the scratch directory; logs carry the command id and the code", async () => {
    const logger = captureLogger();
    await fileDaemon({ logger });
    await activeSession("wf-r7");
    mkdirSync(join(project, "docs"));
    server.fileStatuses = [500];
    const ids: string[] = [];
    for (const payload of [
      { path: "docs", maxBytes: 1024 },
      { path: "README.md", maxBytes: 1 },
      { path: "README.md", maxBytes: 1024 },
    ]) {
      const cmd = fileCmd("session.file.read", "wf-r7", payload);
      ids.push(cmd.id);
      server.send(cmd);
      expect(await fileAck(cmd.id)).toMatchObject({ ok: false });
    }
    expect(JSON.stringify(server.allFrames)).not.toContain(home);
    expect(logger.lines.join("\n")).not.toContain(home);
    for (const id of ids) expect(logger.lines.some((l) => l.includes(id))).toBe(true);
    expect(logger.lines.some((l) => l.includes('"code":"not_a_file"'))).toBe(true);
  });
});

describe("07.17.1.1 session.file.write: a file lands in an idle session's tree, verified, with no second writer", () => {
  function writePayload(path: string, bytes: Buffer, overwrite = false) {
    return { path, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes), overwrite };
  }

  it("GETs the transfer with the device JWT, writes exactly the bytes and acks ok", async () => {
    await fileDaemon();
    await activeSession("wf-w1");
    const bytes = randomBytes(40_000);
    server.fileBody = bytes;
    const cmd = fileCmd("session.file.write", "wf-w1", writePayload("notes/up.bin", bytes));
    server.send(cmd);
    expect(await fileAck(cmd.id)).toEqual({ type: "ack", commandId: cmd.id, ok: true });
    expect(server.fileRequests).toEqual([
      {
        method: "GET",
        url: `/api/v1/runtime/files/${cmd.id}`,
        authorization: `Bearer ${server.issued.at(-1)}`,
        contentLength: undefined,
        sha256: sha256Hex(""),
        bytes: 0,
      },
    ]);
    expect(sha256Hex(readFileSync(join(project, "notes", "up.bin")))).toBe(sha256Hex(bytes));
    expect(readdirSync(join(project, "notes"))).toEqual(["up.bin"]);
  });

  it("refused while a turn of the session runs (busy, no request); accepted once it completed", async () => {
    await fileDaemon();
    await activeSession("wf-w2");
    server.fileBody = Buffer.from("hello");
    // The test runtime's prompt starts a turn and returns without completing it.
    server.send({
      id: "wf-w2-p",
      kind: "prompt",
      sessionId: "wf-w2",
      payload: { promptId: "pw", text: "go" },
    });
    expect(await fileAck("wf-w2-p")).toMatchObject({ ok: true });
    const busy = fileCmd("session.file.write", "wf-w2", writePayload("a.txt", server.fileBody));
    server.send(busy);
    expect(await fileAck(busy.id)).toMatchObject({ ok: false, error: "busy" });
    expect(server.fileRequests).toEqual([]);
    runtime.emit("wf-w2", {
      type: "prompt.completed",
      promptId: "pw",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const ok = fileCmd("session.file.write", "wf-w2", writePayload("a.txt", server.fileBody));
    server.send(ok);
    expect(await fileAck(ok.id)).toMatchObject({ ok: true });
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("hello");
  });

  it("a session.state that is not running or waiting_approval also ends the turn", async () => {
    await fileDaemon();
    await activeSession("wf-w3");
    server.fileBody = Buffer.from("hello");
    runtime.emit("wf-w3", { type: "session.state", status: "waiting_approval" });
    const busy = fileCmd("session.file.write", "wf-w3", writePayload("b.txt", server.fileBody));
    server.send(busy);
    expect(await fileAck(busy.id)).toMatchObject({ ok: false, error: "busy" });
    runtime.emit("wf-w3", { type: "session.state", status: "idle" });
    const ok = fileCmd("session.file.write", "wf-w3", writePayload("b.txt", server.fileBody));
    server.send(ok);
    expect(await fileAck(ok.id)).toMatchObject({ ok: true });
  });

  it("not active → not_running; 410 → expired; wrong bytes → mismatch; a repeated id runs once", async () => {
    await fileDaemon();
    await activeSession("wf-w4");
    const bytes = Buffer.from("hello");
    server.fileBody = bytes;
    const gone = fileCmd("session.file.write", "no-such-session", writePayload("c.txt", bytes));
    server.send(gone);
    expect(await fileAck(gone.id)).toMatchObject({ ok: false, error: "not_running" });
    expect(server.fileRequests).toEqual([]);

    server.fileStatuses = [410];
    const expired = fileCmd("session.file.write", "wf-w4", writePayload("c.txt", bytes));
    server.send(expired);
    expect(await fileAck(expired.id)).toMatchObject({ ok: false, error: "expired" });
    expect(existsSync(join(project, "c.txt"))).toBe(false);

    server.fileBody = Buffer.from("jello");
    const wrong = fileCmd("session.file.write", "wf-w4", writePayload("c.txt", bytes));
    server.send(wrong);
    expect(await fileAck(wrong.id)).toMatchObject({ ok: false, error: "mismatch" });
    expect(existsSync(join(project, "c.txt"))).toBe(false);
    expect(readdirSync(project).filter((n) => n.startsWith(".ocw-upload-"))).toEqual([]);

    server.fileBody = bytes;
    server.fileRequests.length = 0;
    const once = fileCmd("session.file.write", "wf-w4", writePayload("c.txt", bytes));
    server.send(once);
    expect(await fileAck(once.id)).toMatchObject({ ok: true });
    server.send(once);
    await server.waitFor(() =>
      server.allFrames.filter((f) => f.type === "ack" && f.commandId === once.id).length === 2
        ? true
        : undefined,
    );
    expect(server.fileRequests).toHaveLength(1);
  });

  it("refusals before any request: exists, not_a_file, path_not_allowed (.ocw-worktrees, .claude), invalid_path", async () => {
    await fileDaemon();
    await activeSession("wf-w5");
    const bytes = Buffer.from("hello");
    server.fileBody = bytes;
    mkdirSync(join(project, "docs"));
    for (const [path, error, overwrite] of [
      ["README.md", "exists", false],
      ["docs", "not_a_file", true],
      [".ocw-worktrees/other/x.md", "path_not_allowed", false],
      [".claude/settings.json", "path_not_allowed", false],
      ["../x.md", "invalid_path", false],
    ] as const) {
      const cmd = fileCmd("session.file.write", "wf-w5", writePayload(path, bytes, overwrite));
      server.send(cmd);
      expect(await fileAck(cmd.id), path).toMatchObject({ ok: false, error });
    }
    expect(server.fileRequests).toEqual([]);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("hello\n");
  });

  it("a write and a prompt of the same session run one after the other (session order), never at once", async () => {
    await fileDaemon();
    await activeSession("wf-w6");
    const bytes = Buffer.from("hello");
    server.fileBody = bytes;
    let release!: () => void;
    runtime.promptHold = new Promise<void>((r) => {
      release = r;
    });
    server.send({
      id: "wf-w6-p",
      kind: "prompt",
      sessionId: "wf-w6",
      payload: { promptId: "po", text: "go" },
    });
    await server.frame("event", (f) => f.sessionId === "wf-w6" && f.event.type === "prompt.started");
    const cmd = fileCmd("session.file.write", "wf-w6", writePayload("d.txt", bytes));
    server.send(cmd);
    await sleep(200);
    expect(server.allFrames.some((f) => f.type === "ack" && f.commandId === cmd.id)).toBe(false);
    expect(server.fileRequests).toEqual([]);
    release();
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    const acks = server.allFrames.flatMap((f) => (f.type === "ack" ? [f.commandId] : []));
    expect(acks.indexOf("wf-w6-p")).toBeLessThan(acks.indexOf(cmd.id));
    expect(readFileSync(join(project, "d.txt"), "utf8")).toBe("hello");
  });

  it("a stopped session's turn is forgotten: a write after a restart of the session is not busy", async () => {
    await fileDaemon();
    await activeSession("wf-w7");
    server.fileBody = Buffer.from("hello");
    server.send({
      id: "wf-w7-p",
      kind: "prompt",
      sessionId: "wf-w7",
      payload: { promptId: "px", text: "go" },
    });
    expect(await fileAck("wf-w7-p")).toMatchObject({ ok: true });
    server.send({ id: "wf-w7-s", kind: "session.stop", sessionId: "wf-w7" });
    expect(await fileAck("wf-w7-s")).toMatchObject({ ok: true });
    const stopped = fileCmd("session.file.write", "wf-w7", writePayload("e.txt", server.fileBody));
    server.send(stopped);
    expect(await fileAck(stopped.id)).toMatchObject({ ok: false, error: "not_running" });
    const localId = daemon.registry.list()[0]!.localId;
    server.send({
      id: "wf-w7-r",
      kind: "session.start",
      sessionId: "wf-w7",
      payload: { projectLocalId: localId, permissionMode: "acceptEdits" },
    });
    expect(await fileAck("wf-w7-r")).toMatchObject({ ok: true });
    const ok = fileCmd("session.file.write", "wf-w7", writePayload("e.txt", server.fileBody));
    server.send(ok);
    expect(await fileAck(ok.id)).toMatchObject({ ok: true });
  });
});

describe("07.17.1.1 an upload lands only before the server's landing deadline (review WR-01)", () => {
  function writePayload(path: string, bytes: Buffer) {
    return { path, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes), overwrite: false };
  }

  it("bytes that arrive after the time the GET allowed land nothing and ack expired", async () => {
    await fileDaemon();
    await activeSession("wf-l1");
    const bytes = Buffer.from("too late");
    server.fileBody = bytes;
    server.fileHeaders = { [RUNTIME_FILE_LAND_WITHIN_HEADER]: "0" };
    const cmd = fileCmd("session.file.write", "wf-l1", writePayload("late.txt", bytes));
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: false, error: "expired" });
    expect(existsSync(join(project, "late.txt"))).toBe(false);
    expect(readdirSync(project).filter((n) => n.startsWith(".ocw-upload-"))).toEqual([]);
  });

  it("within the time, or from a server that names none, the file lands", async () => {
    await fileDaemon();
    await activeSession("wf-l2");
    const bytes = Buffer.from("in time");
    server.fileBody = bytes;
    server.fileHeaders = { [RUNTIME_FILE_LAND_WITHIN_HEADER]: "60000" };
    const ok = fileCmd("session.file.write", "wf-l2", writePayload("ok.txt", bytes));
    server.send(ok);
    expect(await fileAck(ok.id)).toMatchObject({ ok: true });
    server.fileHeaders = {};
    const old = fileCmd("session.file.write", "wf-l2", writePayload("old.txt", bytes));
    server.send(old);
    expect(await fileAck(old.id)).toMatchObject({ ok: true });
    expect(readFileSync(join(project, "old.txt"), "utf8")).toBe("in time");
  });
});

describe("07.17.1.1 a redelivered file command is answered with its real outcome (review CR-03)", () => {
  function writePayload(path: string, bytes: Buffer) {
    return { path, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes), overwrite: false };
  }
  const acksOf = (id: string) =>
    server.allFrames.filter((f): f is Extract<DeviceToServerFrame, { type: "ack" }> => {
      return f.type === "ack" && f.commandId === id;
    });

  it("a copy that arrives while the upload still streams is not acked; the only answer is the real one", async () => {
    await fileDaemon();
    await activeSession("wf-x1");
    const bytes = Buffer.from("hello");
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    server.onFileRequest = () => held;
    // The bytes the server will send do not match the payload: the write fails after its GET.
    server.fileBody = Buffer.from("jello");
    const cmd = fileCmd("session.file.write", "wf-x1", writePayload("x.txt", bytes));
    server.send(cmd);
    await server.waitFor(() => (server.fileRequests.length === 1 ? true : undefined));
    server.send(cmd); // the hub's redelivery after a link blip
    await sleep(200);
    expect(acksOf(cmd.id)).toEqual([]);
    release();
    expect(await fileAck(cmd.id)).toMatchObject({ ok: false, error: "mismatch" });
    await sleep(100);
    expect(acksOf(cmd.id)).toHaveLength(1);
    expect(existsSync(join(project, "x.txt"))).toBe(false);
    // Redelivered after it finished (its ack was lost): the same failure again, never a blind ok, never a second GET.
    server.send(cmd);
    await server.waitFor(() => (acksOf(cmd.id).length === 2 ? true : undefined));
    expect(acksOf(cmd.id)[1]).toMatchObject({ ok: false, error: "mismatch" });
    expect(server.fileRequests).toHaveLength(1);
  });

  it("a finished failure is answered again with its code; a finished success with ok", async () => {
    await fileDaemon();
    await activeSession("wf-x2");
    const bytes = Buffer.from("hello");
    server.fileBody = bytes;
    server.fileStatuses = [410];
    const expired = fileCmd("session.file.write", "wf-x2", writePayload("y.txt", bytes));
    server.send(expired);
    expect(await fileAck(expired.id)).toMatchObject({ ok: false, error: "expired" });
    server.send(expired);
    await server.waitFor(() => (acksOf(expired.id).length === 2 ? true : undefined));
    expect(acksOf(expired.id)[1]).toMatchObject({ ok: false, error: "expired" });

    const read = fileCmd("session.file.read", "wf-x2", { path: "README.md", maxBytes: 1 });
    server.send(read);
    expect(await fileAck(read.id)).toMatchObject({ ok: false, error: "too_large: 6" });
    server.send(read);
    await server.waitFor(() => (acksOf(read.id).length === 2 ? true : undefined));
    expect(acksOf(read.id)[1]).toMatchObject({ ok: false, error: "too_large: 6" });
  });

  it("a copy that arrives while a download's PUT streams waits for the PUT's answer", async () => {
    await fileDaemon();
    await activeSession("wf-x3");
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    server.onFileRequest = () => held;
    server.fileStatuses = [500];
    const cmd = fileCmd("session.file.read", "wf-x3", { path: "README.md", maxBytes: 1024 });
    server.send(cmd);
    await server.waitFor(() => (server.fileRequests.length === 1 ? true : undefined));
    server.send(cmd);
    await sleep(200);
    expect(acksOf(cmd.id)).toEqual([]);
    release();
    expect(await fileAck(cmd.id)).toMatchObject({ ok: false, error: "transfer_failed" });
    await sleep(100);
    expect(acksOf(cmd.id)).toHaveLength(1);
  });
});

describe("07.17.1.1 diff.result never closes the link (D-14, PD-19)", () => {
  it("a 400 KiB change answers a frame within the API's inbound limit, truncated", async () => {
    const localId = await addProject();
    const line = `${"y".repeat(99)}\n`;
    writeFileSync(join(project, "big.txt"), line.repeat(4096));
    await daemon.start();
    await server.frame("hello");
    server.send({
      id: "dbig",
      kind: "diff.request",
      sessionId: "ws-big",
      payload: { projectLocalId: localId },
    });
    const diff = await server.frame("diff.result", (f) => f.requestId === "dbig");
    expect(Buffer.byteLength(JSON.stringify(diff))).toBeLessThanOrEqual(256 * 1024 - 4096);
    expect(diff.truncated).toBe(true);
    expect(diff.files.map((f) => f.path).sort()).toEqual(["README.md", "big.txt"]);
    expect(diff.patch).toContain("b/big.txt");
    expect(diff.patch.endsWith("\n")).toBe(true);
    expect(await server.frame("ack", (f) => f.commandId === "dbig")).toMatchObject({ ok: true });
  });
});

describe("07.18 pool accounts on the device (D-02, D-07, PD-03, PD-04, PD-05)", () => {
  // Token-shaped values joined at runtime, so no credential literal lives in the repo.
  const POOL_TOKEN = ["sk", "ant", "oat01", "pooltokenAAAAAAAAAAAAAAAAAAAAAAAA"].join("-");
  const ACCOUNT_A = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const tokenAccount = (accountId = ACCOUNT_A, label = "Team A") => ({
    kind: "token",
    accountId,
    label,
    oauthToken: POOL_TOKEN,
  });

  async function startWith(account: unknown): Promise<{ id: string; sessionId: string }> {
    const localId = await addProject();
    await daemon.start();
    await server.frame("hello");
    const id = randomUUID();
    const sessionId = randomUUID();
    server.send({
      id,
      kind: "session.start",
      sessionId,
      payload: {
        projectLocalId: localId,
        permissionMode: "default",
        ...(account !== undefined ? { account } : {}),
      },
    });
    return { id, sessionId };
  }

  // 07.18-19 R1.8: a device that only has pool accounts still reports the Claude catalog.
  it("a signed-out Claude reports no catalog until a pool token is ready, then one", async () => {
    runtime.loggedIn = false;
    await daemon.start();
    expect((await server.frame("capabilities")).catalogs).toEqual([]);
    await daemon.stop();
    runtime.poolReady = true;
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
    await daemon.start();
    const caps = await server.frame("capabilities", (f) => f.catalogs.length > 0);
    expect(caps.catalogs.map((c) => c.runtime)).toEqual(["claude-code"]);
  });

  it("a pool session starting on a signed-out Claude sends the catalog it makes possible", async () => {
    runtime.loggedIn = false;
    const { id } = await startWith(tokenAccount());
    runtime.poolReady = true; // the adapter now holds the session's token
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    const caps = await server.frame("capabilities", (f) => f.catalogs.length > 0);
    expect(caps.catalogs.map((c) => c.runtime)).toEqual(["claude-code"]);
    expect(JSON.stringify(server.allFrames)).not.toContain(POOL_TOKEN);
  });

  it("a pool session on a signed-in Claude sends no extra capabilities", async () => {
    const { id } = await startWith(tokenAccount());
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    await sleep(30);
    expect(server.allFrames.filter((f) => f.type === "capabilities")).toHaveLength(1);
  });

  it("announces accountPool in the hello", async () => {
    await daemon.start();
    expect(await server.frame("hello")).toMatchObject({ accountPool: 1 });
  });

  it("a token account reaches the adapter as a RuntimeAccount; the token never leaves the device", async () => {
    const { id } = await startWith(tokenAccount());
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    expect(runtime.started[0]?.account).toEqual({
      kind: "token",
      ref: ACCOUNT_A,
      label: "Team A",
      oauthToken: POOL_TOKEN,
    });
    expect(typeof runtime.started[0]?.onAccountSignal).toBe("function");
    expect(JSON.stringify(server.allFrames)).not.toContain(POOL_TOKEN);
  });

  it("a start without an account passes none (as before 07.18)", async () => {
    const { id } = await startWith(undefined);
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    expect(runtime.started[0]?.account ?? null).toBeNull();
  });

  it("refuses a device_slot account whose slot is not on this device", async () => {
    const { id } = await startWith({
      kind: "device_slot",
      accountId: ACCOUNT_A,
      label: "ChatGPT A",
      slotId: randomUUID(),
    });
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({
      ok: false,
      error: "account slot not found on this device",
    });
    expect(runtime.started).toEqual([]);
  });

  it("refuses an account kind the adapter does not support, before start", async () => {
    runtime.supportsAccounts = [];
    const { id } = await startWith(tokenAccount());
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({
      ok: false,
      error: "claude-code cannot run a session on a token account",
    });
    expect(runtime.started).toEqual([]);
    expect(JSON.stringify(server.allFrames)).not.toContain(POOL_TOKEN);
  });

  it("an adapter's limit and usage signals become session.account_limited and account.usage frames", async () => {
    const { id, sessionId } = await startWith(tokenAccount());
    await server.frame("ack", (f) => f.commandId === id);
    const signal = runtime.started[0]?.onAccountSignal;
    if (!signal) throw new Error("no onAccountSignal");
    const resetsAt = "2026-11-24T18:00:00.000Z";
    signal({ kind: "limited", promptId: "p1", reason: "five_hour", resetsAt });
    expect(await server.frame("session.account_limited")).toEqual({
      type: "session.account_limited",
      sessionId,
      promptId: "p1",
      accountId: ACCOUNT_A,
      reason: "five_hour",
      resetsAt,
      at: expect.any(String),
    });
    const usage = { windows: [{ kind: "five_hour" as const, usedPercent: 42, resetsAt }], at: resetsAt };
    signal({ kind: "usage", usage });
    expect(await server.frame("account.usage")).toEqual({
      type: "account.usage",
      accountId: ACCOUNT_A,
      usage,
    });
    expect(JSON.stringify(server.allFrames)).not.toContain(POOL_TOKEN);
  });

  it("a prompt naming another account switches before the turn; absent or the same one changes nothing", async () => {
    const ACCOUNT_B = "1f0e0d0c-0b0a-4908-8706-050403020101";
    const { id, sessionId } = await startWith(tokenAccount());
    await server.frame("ack", (f) => f.commandId === id);
    const prompt = async (promptId: string, account?: unknown) => {
      const cid = randomUUID();
      server.send({
        id: cid,
        kind: "prompt",
        sessionId,
        payload: { promptId, text: "go", ...(account !== undefined ? { account } : {}) },
      });
      return server.frame("ack", (f) => f.commandId === cid);
    };
    expect(await prompt("p1")).toMatchObject({ ok: true });
    expect(await prompt("p2", tokenAccount())).toMatchObject({ ok: true });
    expect(runtime.accountSwitches).toEqual([]);
    expect(await prompt("p3", tokenAccount(ACCOUNT_B, "Team B"))).toMatchObject({ ok: true });
    expect(await prompt("p4", null)).toMatchObject({ ok: true });
    expect(runtime.calls).toEqual([
      "prompt:p1",
      "prompt:p2",
      `useAccount:${ACCOUNT_B}`,
      "prompt:p3",
      "useAccount:device",
      "prompt:p4",
    ]);
    expect(runtime.accountSwitches[0]?.account).toEqual({
      kind: "token",
      ref: ACCOUNT_B,
      label: "Team B",
      oauthToken: POOL_TOKEN,
    });
    // The stored ref follows: a limit now names the device's own login.
    runtime.started[0]?.onAccountSignal?.({
      kind: "limited",
      promptId: "p4",
      reason: "rate_limit",
      resetsAt: null,
    });
    expect(await server.frame("session.account_limited")).toMatchObject({ promptId: "p4", accountId: null });
    // A slot account in a prompt is refused before the turn, like at start.
    const slot = await prompt("p5", {
      kind: "device_slot",
      accountId: ACCOUNT_B,
      label: "C",
      slotId: randomUUID(),
    });
    expect(slot).toMatchObject({ ok: false, error: "account slot not found on this device" });
    expect(runtime.calls.at(-1)).toBe("prompt:p4");
    expect(JSON.stringify(server.allFrames)).not.toContain(POOL_TOKEN);
  });

  it("a limit on the device's own login names no account; its usage sends nothing", async () => {
    const { id, sessionId } = await startWith(null);
    await server.frame("ack", (f) => f.commandId === id);
    const signal = runtime.started[0]?.onAccountSignal;
    if (!signal) throw new Error("no onAccountSignal");
    signal({ kind: "usage", usage: { windows: [], at: new Date().toISOString() } });
    signal({ kind: "limited", promptId: null, reason: "usage_limit", resetsAt: null });
    expect(await server.frame("session.account_limited")).toMatchObject({
      sessionId,
      promptId: null,
      accountId: null,
      reason: "usage_limit",
      resetsAt: null,
    });
    expect(server.allFrames.some((f) => f.type === "account.usage")).toBe(false);
  });

  it("the handshake reports every Codex slot in accounts.sync, after capabilities, with no credential", async () => {
    const store = new CodexSlotStore(home, { CODEX_HOME: join(home, "codex-default") });
    const a = await store.create({ label: "ana@acme", origin: "server" });
    const b = await store.create({ label: "Codex account 2", origin: "cli" });
    writeFileSync(
      join(store.homeOf(a.slotId), "auth.json"),
      JSON.stringify({ tokens: { access_token: "AT" } }),
    );
    await store.setPlan(a.slotId, "plus");
    await daemon.start();
    const sync = await server.frame("accounts.sync");
    expect(sync).toEqual({
      type: "accounts.sync",
      codexSlots: [
        {
          slotId: a.slotId,
          label: "ana@acme",
          origin: "server",
          signedIn: true,
          planType: "plus",
          usage: null,
        },
        {
          slotId: b.slotId,
          label: "Codex account 2",
          origin: "cli",
          signedIn: false,
          planType: null,
          usage: null,
        },
      ],
    });
    const types = server.last.frames.map((f) => f.type);
    expect(types.indexOf("accounts.sync")).toBeGreaterThan(types.indexOf("capabilities"));
    // auth.json is never read: nothing of it, and no path, leaves the device.
    expect(JSON.stringify(server.allFrames)).not.toContain("access_token");
    expect(JSON.stringify(server.allFrames)).not.toContain(home);
  });

  it("a device_slot account of a known slot reaches the adapter with that slot's CODEX_HOME", async () => {
    runtime.supportsAccounts = ["token", "device_slot"];
    const store = new CodexSlotStore(home, { CODEX_HOME: join(home, "codex-default") });
    const slot = await store.create({ label: "ChatGPT A", origin: "server" });
    const { id } = await startWith({
      kind: "device_slot",
      accountId: ACCOUNT_A,
      label: "ChatGPT A",
      slotId: slot.slotId,
    });
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    expect(runtime.started[0]?.account).toEqual({
      kind: "device_slot",
      ref: ACCOUNT_A,
      label: "ChatGPT A",
      slotId: slot.slotId,
      codexHome: store.homeOf(slot.slotId),
    });
    // The slot's directory stays on the device.
    expect(JSON.stringify(server.allFrames)).not.toContain(store.homeOf(slot.slotId));
  });
});

// ---------------------------------------------------------------------------------------------
// 07.18-08 Task 2: `account.login` / `account.logout` (D-02, D-10, PD-10, A-08). A scripted in-memory app-server
// stands in for Codex: no real CLI, no real ChatGPT account, a scratch default Codex home.

/** The account methods of `codex app-server`, scripted per test; "signs in" by writing the slot's auth.json as Codex would. */
class ScriptedCodexAccounts {
  readonly spawned: Array<{ cwd: string; env: Record<string, string | undefined> }> = [];
  readonly methods: string[] = [];
  /** What the next sign-in does once the code was handed over (`hold` = the test calls `finish`). */
  outcome: "success" | "denied" | "unsupported" | "hold" = "success";
  private pending: Array<(ok: boolean, error: string | null) => void> = [];

  finish(ok: boolean, error: string | null = null): void {
    for (const f of this.pending.splice(0)) f(ok, error);
  }

  spawn = (opts: { cwd: string; env: Record<string, string | undefined> }) => {
    this.spawned.push(opts);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        if (!stdout.writableEnded) stdout.end();
        setImmediate(() => proc.emit("exit", 0));
      },
    });
    const send = (m: unknown) => {
      if (!stdout.writableEnded) stdout.write(`${JSON.stringify(m)}\n`);
    };
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c: string) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
        if (m.method) this.methods.push(m.method);
        if (m.id === undefined) continue;
        const slotHome = opts.env.CODEX_HOME ?? "";
        switch (m.method) {
          case "initialize":
            send({ id: m.id, result: {} });
            break;
          case "account/login/start":
            if (this.outcome === "unsupported") {
              send({ id: m.id, error: { code: -32600, message: "unknown variant `chatgptDeviceCode`" } });
              break;
            }
            send({
              id: m.id,
              result: {
                type: "chatgptDeviceCode",
                loginId: "L1",
                verificationUrl: "https://auth.openai.com/codex/device",
                userCode: "WXYZ-9876",
              },
            });
            this.pending.push((ok, error) => {
              if (ok)
                writeFileSync(
                  join(slotHome, "auth.json"),
                  JSON.stringify({ tokens: { refresh_token: "RT-1" } }),
                );
              send({ method: "account/login/completed", params: { loginId: "L1", success: ok, error } });
            });
            if (this.outcome === "success") setImmediate(() => this.finish(true));
            // A Codex error that echoes the code: the daemon must strip it.
            if (this.outcome === "denied")
              setImmediate(() => this.finish(false, "access_denied for WXYZ-9876"));
            break;
          case "account/read":
            send({
              id: m.id,
              result: {
                account: { type: "chatgpt", email: "ana@example.com", planType: "pro", workspaceName: null },
                requiresOpenaiAuth: true,
              },
            });
            break;
          case "account/logout":
            rmSync(join(slotHome, "auth.json"), { force: true });
            send({ id: m.id, result: {} });
            break;
          case "account/login/cancel":
            send({ id: m.id, result: { status: "canceled" } });
            break;
          default:
            send({ id: m.id, error: { code: -32601, message: "method not found" } });
        }
      }
    });
    return proc;
  };
}

describe("07.18-08 account.login / account.logout (D-02, D-10, PD-10)", () => {
  let codex: ScriptedCodexAccounts;
  const codexDefault = () => join(home, "codex-default");

  beforeEach(async () => {
    await daemon.stop();
    codex = new ScriptedCodexAccounts();
    daemon = await Daemon.create({
      home,
      env: { CODEX_HOME: codexDefault(), PATH: "/usr/bin", OPENAI_API_KEY: "sk-test-not-real" },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: [runtime],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
      codexAccounts: { spawn: codex.spawn },
    });
    await daemon.start();
    await server.frame("hello");
  });

  function login(slotId: string, label = "ops@acme"): string {
    const id = randomUUID();
    server.send({
      id,
      kind: "account.login",
      sessionId: id,
      payload: { provider: "chatgpt", slotId, label },
    });
    return id;
  }

  it("creates the slot, runs Codex's device-code login under its CODEX_HOME, sends code then completed, then accounts.sync, then the ack", async () => {
    const slotId = randomUUID();
    const id = login(slotId);
    const ack = await server.frame("ack", (f) => f.commandId === id);
    expect(ack).toMatchObject({ ok: true });
    const frames = server.last.frames;
    const code = frames.find((f) => f.type === "account.login" && f.phase === "code");
    expect(code).toEqual({
      type: "account.login",
      requestId: id,
      slotId,
      phase: "code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-9876",
      expiresAt: expect.any(String),
    });
    const completed = frames.find((f) => f.type === "account.login" && f.phase === "completed");
    expect(completed).toEqual({
      type: "account.login",
      requestId: id,
      slotId,
      phase: "completed",
      planType: "pro",
    });
    const syncIndex = frames.findIndex(
      (f) => f.type === "accounts.sync" && f.codexSlots.some((s) => s.slotId === slotId),
    );
    expect(frames.indexOf(code as DeviceToServerFrame)).toBeLessThan(
      frames.indexOf(completed as DeviceToServerFrame),
    );
    expect(frames.indexOf(completed as DeviceToServerFrame)).toBeLessThan(syncIndex);
    expect(syncIndex).toBeLessThan(frames.indexOf(ack));
    expect(frames[syncIndex]).toEqual({
      type: "accounts.sync",
      codexSlots: [
        { slotId, label: "ops@acme", origin: "server", signedIn: true, planType: "pro", usage: null },
      ],
    });
    // Codex ran under the slot, with API keys stripped; no e-mail, no token, no path left the device.
    const slotHome = daemon.codexSlots.homeOf(slotId);
    expect(codex.spawned.map((s) => [s.cwd, s.env.CODEX_HOME])).toContainEqual([slotHome, slotHome]);
    expect(codex.spawned.every((s) => s.env.OPENAI_API_KEY === undefined)).toBe(true);
    const wire = JSON.stringify(server.allFrames);
    expect(wire).not.toContain("ana@example.com");
    expect(wire).not.toContain("RT-1");
    expect(wire).not.toContain(home);
  });

  it("a declined sign-in sends failed (denied) without the user code, removes the slot and acks with an error", async () => {
    codex.outcome = "denied";
    const slotId = randomUUID();
    const id = login(slotId);
    const ack = await server.frame("ack", (f) => f.commandId === id);
    expect(ack).toMatchObject({ ok: false });
    const failed = await server.frame("account.login", (f) => f.phase === "failed");
    expect(failed).toMatchObject({ requestId: id, slotId, error: { code: "denied" } });
    expect(failed.error?.message).not.toContain("WXYZ-9876");
    expect(JSON.stringify(ack)).not.toContain("WXYZ-9876");
    expect(existsSync(daemon.codexSlots.homeOf(slotId))).toBe(false);
    expect(await daemon.codexSlots.list()).toEqual([]);
    // The shared history is still there.
    expect(existsSync(join(codexDefault(), "sessions"))).toBe(true);
  });

  it("a Codex without the device-code login fails unsupported with the update line (A-08)", async () => {
    codex.outcome = "unsupported";
    const slotId = randomUUID();
    const id = login(slotId);
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({
      ok: false,
      error: "Update Codex on this device and try again",
    });
    expect(await server.frame("account.login", (f) => f.phase === "failed")).toMatchObject({
      error: { code: "unsupported", message: "Update Codex on this device and try again" },
    });
    expect(await daemon.codexSlots.list()).toEqual([]);
  });

  it("a second login for the same slot while one runs is refused; an invalid payload is refused", async () => {
    codex.outcome = "hold";
    const slotId = randomUUID();
    const first = login(slotId);
    await server.frame("account.login", (f) => f.phase === "code" && f.requestId === first);
    const second = login(slotId);
    expect(await server.frame("ack", (f) => f.commandId === second)).toMatchObject({
      ok: false,
      error: "a sign-in is already running for this account slot",
    });
    codex.finish(true);
    expect(await server.frame("ack", (f) => f.commandId === first)).toMatchObject({ ok: true });

    const bad = randomUUID();
    server.send({
      id: bad,
      kind: "account.login",
      sessionId: bad,
      payload: { provider: "chatgpt", slotId },
    });
    expect(await server.frame("ack", (f) => f.commandId === bad)).toMatchObject({
      ok: false,
      error: "invalid payload",
    });
  });

  it("account.logout signs the slot out, removes it, re-sends accounts.sync and acks; an unknown slot acks ok", async () => {
    mkdirSync(join(codexDefault(), "sessions"), { recursive: true });
    writeFileSync(join(codexDefault(), "sessions", "rollout.jsonl"), "{}\n");
    const slotId = randomUUID();
    const loginId = login(slotId);
    await server.frame("ack", (f) => f.commandId === loginId);
    const id = randomUUID();
    server.send({ id, kind: "account.logout", sessionId: id, payload: { slotId } });
    expect(await server.frame("ack", (f) => f.commandId === id)).toMatchObject({ ok: true });
    expect(codex.methods).toContain("account/logout");
    expect(existsSync(daemon.codexSlots.homeOf(slotId))).toBe(false);
    expect(readFileSync(join(codexDefault(), "sessions", "rollout.jsonl"), "utf8")).toBe("{}\n");
    const lastSync = server.last.frames.filter((f) => f.type === "accounts.sync").at(-1);
    expect(lastSync).toEqual({ type: "accounts.sync", codexSlots: [] });

    const again = randomUUID();
    server.send({ id: again, kind: "account.logout", sessionId: again, payload: { slotId } });
    expect(await server.frame("ack", (f) => f.commandId === again)).toMatchObject({ ok: true });
  });
});

describe("07.18-08 reloadAccounts (PD-11): a slot the CLI added reaches the server at once", () => {
  it("the control command re-reads the slots and sends accounts.sync; it refuses any value", async () => {
    await daemon.start();
    await server.frame("hello");
    const store = new CodexSlotStore(home, { CODEX_HOME: join(home, "codex-default") });
    const slot = await store.create({ label: "Codex account 1", origin: "cli" });
    const res = await controlRequest(socketPath(), { cmd: "reloadAccounts" });
    expect(res).toEqual({ id: undefined, ok: true, result: { codexSlots: 1 } });
    expect(
      await server.frame("accounts.sync", (f) => f.codexSlots.some((s) => s.slotId === slot.slotId)),
    ).toMatchObject({ codexSlots: [{ slotId: slot.slotId, origin: "cli", signedIn: false }] });
    const forged = await controlRequest(socketPath(), {
      cmd: "reloadAccounts",
      slotId: slot.slotId,
    } as unknown as ControlRequest);
    expect(forged).toMatchObject({ ok: false, error: "invalid request" });
  });
});

// ---------------------------------------------------------------------------------------------
// 07.18-11 (D-02): a device whose own Codex login is signed out still reports a Codex catalog, collected under its
// first signed-in slot. A scripted in-memory app-server answers `model/list` only; no real Codex, no turn.

const CODEX_MODEL_LIST = JSON.parse(
  readFileSync(
    join(
      fileURLToPath(new URL(".", import.meta.url)),
      "codex",
      "__fixtures__",
      "codex-0.160.0.model-list.json",
    ),
    "utf8",
  ),
) as { data: unknown[] };

function modelListAppServer(spawned: Array<{ env: Record<string, string | undefined>; methods: string[] }>) {
  return ({ env }: { cwd: string; env: Record<string, string | undefined> }) => {
    const record = { env, methods: [] as string[] };
    spawned.push(record);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        if (!stdout.writableEnded) stdout.end();
        setImmediate(() => proc.emit("exit", 0));
      },
    });
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c: string) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { id?: number; method?: string };
        if (m.method) record.methods.push(m.method);
        if (m.id === undefined || stdout.writableEnded) continue;
        const result =
          m.method === "model/list"
            ? { data: CODEX_MODEL_LIST.data, nextCursor: null }
            : m.method === "initialize"
              ? {}
              : null;
        stdout.write(
          `${JSON.stringify(result ? { id: m.id, result } : { id: m.id, error: { code: -32601, message: "no" } })}\n`,
        );
      }
    });
    return proc;
  };
}

describe("07.18-11 the Codex catalog under a slot when the device's own login is signed out (D-02)", () => {
  const spawned: Array<{ env: Record<string, string | undefined>; methods: string[] }> = [];

  beforeEach(async () => {
    await daemon.stop();
    spawned.length = 0;
    daemon = await Daemon.create({
      home,
      env: { CODEX_HOME: join(home, "codex-default") },
      token: "device-token-123",
      config: { serverUrl: server.url },
      runtimes: (allowFullAccess, ctx) => [
        new CodexRuntime({
          allowFullAccess,
          detect: async () => ({ id: "codex", installed: true, version: "0.172.0", loggedIn: false }),
          catalogHome: ctx.codexCatalogHome,
          spawnAppServer: modelListAppServer(spawned),
        }),
      ],
      logger: silentLogger,
      controlSocket: socketPath(),
      link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    });
  });

  it("collects it with CODEX_HOME = the first signed-in slot, and sends no turn", async () => {
    await daemon.codexSlots.create({ label: "Signed out", origin: "server" });
    const b = await daemon.codexSlots.create({ label: "Signed in", origin: "server" });
    const c = await daemon.codexSlots.create({ label: "Also signed in", origin: "server" });
    for (const slot of [b, c]) writeFileSync(join(daemon.codexSlots.homeOf(slot.slotId), "auth.json"), "{}");
    await daemon.start();
    const caps = await server.frame("capabilities");
    expect(caps.catalogs.map((x) => x.runtime)).toEqual(["codex"]);
    expect(caps.catalogs[0]?.models.length).toBeGreaterThan(0);
    expect(spawned.map((x) => x.env.CODEX_HOME)).toEqual([daemon.codexSlots.homeOf(b.slotId)]);
    const methods = spawned.flatMap((x) => x.methods);
    expect(methods).toContain("model/list");
    expect(methods.filter((m) => m.startsWith("thread/") || m.startsWith("turn/"))).toEqual([]);
    // The slot's directory stays on the device.
    expect(JSON.stringify(server.allFrames)).not.toContain(home);
  });

  it("with no signed-in slot there is no Codex catalog and nothing is spawned", async () => {
    await daemon.codexSlots.create({ label: "Signed out", origin: "server" });
    await daemon.start();
    const caps = await server.frame("capabilities");
    expect(caps.catalogs).toEqual([]);
    expect(spawned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- 07.13 browser

const BROWSER_GRANT: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: "00000000-0000-4000-8000-000000000001",
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};

/** A child without a browser: `open` reports the URL's origin; every child it made is kept for the test. */
class ScriptedBrowserChild implements ManagedChild {
  state: ManagedChild["state"] = "running";
  readonly closed: Promise<void>;
  readonly ops: string[] = [];
  private done: () => void = () => {};
  constructor(private readonly o: ChildFactoryOptions) {
    this.closed = new Promise((r) => {
      this.done = r;
    });
  }
  async call(op: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.ops.push(op);
    if (op === "open") {
      const origin = originOf(String(input.url));
      if (origin) this.o.onEvent({ event: "navigated", origin });
      return { host: new URL(String(input.url)).host, secure: false, title: "T", signedIn: false };
    }
    if (op === "snapshot") return { host: "h", secure: false, title: "T", text: "x", truncated: false };
    return { closed: true };
  }
  async close(): Promise<void> {
    this.state = "closed";
    this.done();
  }
}

/** Replaces the default daemon with one whose browser opt-in is on and whose children are scripted. */
async function browserDaemon(
  over: { env?: NodeJS.ProcessEnv; idleMs?: number } = {},
): Promise<{ children: ScriptedBrowserChild[] }> {
  await daemon.stop();
  const children: ScriptedBrowserChild[] = [];
  daemon = await Daemon.create({
    home,
    env: { CODEX_HOME: join(home, "codex-default"), OCW_ALLOW_BROWSER: "1", ...over.env },
    token: "device-token-123",
    config: { serverUrl: server.url },
    runtimes: [runtime],
    logger: silentLogger,
    controlSocket: socketPath(),
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
    browser: {
      browsers: {
        installed: async () => ({ executable: "/scripted/chrome", version: "156.0.8078.47" }),
        install: async () => ({ executable: "/scripted/chrome", version: "156.0.8078.47" }),
      },
      createChild: (o) => {
        const c = new ScriptedBrowserChild(o);
        children.push(c);
        return c;
      },
      ...(over.idleMs !== undefined ? { idleMs: over.idleMs } : {}),
    },
  });
  return { children };
}

/** A started session with a running turn whose prompt carried `grant`. */
async function browserSession(grant: SessionBrowserGrant = BROWSER_GRANT): Promise<string> {
  const localId = await addProject();
  const sid = randomUUID();
  server.send({
    id: `start-${sid}`,
    kind: "session.start",
    sessionId: sid,
    payload: { projectLocalId: localId, permissionMode: "acceptEdits", browser: grant },
  });
  await server.frame("ack", (f) => f.commandId === `start-${sid}`);
  runtime.promptHold = new Promise(() => {});
  server.send({
    id: `prompt-${sid}`,
    kind: "prompt",
    sessionId: sid,
    payload: { promptId: "bp1", text: "browse", browser: grant },
  });
  await server.frame("event", (f) => f.sessionId === sid && f.event.type === "prompt.started");
  return sid;
}

describe("Work Zone browser: approvals through the daemon (07.13-12, Pitfall 7)", () => {
  it("hands the adapter the session's browser, available with the start's grant", async () => {
    await browserDaemon();
    await daemon.start();
    await server.frame("hello");
    const sid = await browserSession();
    const started = runtime.started.find((s) => s.sessionId === sid);
    expect(started?.browser?.available).toBe(true);
  });

  it("approval.resolve for a browser approval is answered by the broker; an unknown id still reaches the adapter", async () => {
    await browserDaemon();
    await daemon.start();
    await server.frame("hello");
    const sid = await browserSession();
    const call = daemon.browser.forSession(sid).call("open", { url: "https://github.com/" });
    const asked = await server.frame(
      "event",
      (f) => f.sessionId === sid && f.event.type === "approval.requested",
    );
    if (asked.event.type !== "approval.requested") throw new Error("unreachable");
    expect(asked.event.browser).toEqual({
      kind: "host",
      origin: "https://github.com:443",
      tool: "ocw_browser_open",
    });
    server.send({
      id: "ar1",
      kind: "approval.resolve",
      sessionId: sid,
      payload: { approvalId: asked.event.approvalId, decision: "once" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "ar1")).toMatchObject({ ok: true });
    expect((await call).summary).toBe("Opened github.com:443");
    expect(runtime.resolved).toEqual([]);
    // Answered twice: the broker no longer knows it and the adapter does not either.
    server.send({
      id: "ar2",
      kind: "approval.resolve",
      sessionId: sid,
      payload: { approvalId: asked.event.approvalId, decision: "once" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "ar2")).toMatchObject({ ok: false });
    server.send({
      id: "ar3",
      kind: "approval.resolve",
      sessionId: sid,
      payload: { approvalId: "ap1", decision: "deny" },
    });
    expect(await server.frame("ack", (f) => f.commandId === "ar3")).toMatchObject({ ok: true });
    expect(runtime.resolved).toEqual([["ap1", "deny"]]);
  });
});

describe("Work Zone browser: capability, lifecycle, server frames and the shim (07.13-12 Task 3)", () => {
  const browserEvents = (sid: string, kind: string) =>
    server.allFrames.filter((f) => f.type === "browser.event" && f.sessionId === sid && f.kind === kind);

  it("hello says browser { version: 1, optIn: false } by default and no appVersion", async () => {
    await daemon.start();
    const hello = await server.frame("hello");
    expect(hello.browser).toEqual({ version: 1, optIn: false });
    expect(hello.device.appVersion).toBeUndefined();
    expect((await server.frame("capabilities")).browser).toEqual({ version: 1, optIn: false });
    expect((await daemon.status()).browser).toMatchObject({ optIn: false, source: "default", openPages: 0 });
  });

  it("MD-01: every hello lists the open pages (browserPages), a reconnect included", async () => {
    await browserDaemon();
    await daemon.start();
    expect((await server.frame("hello")).browserPages).toEqual([]);
    const sid = await browserSession();
    await daemon.browser.forSession(sid).call("open", { url: "http://localhost:3000/" });
    server.last.ws.terminate();
    await server.waitFor(() => (daemon.isConnected ? undefined : true));
    const hello = await server.waitFor(() =>
      server.connections.length >= 2 ? server.last.frames.find((f) => f.type === "hello") : undefined,
    );
    expect(hello.type === "hello" ? hello.browserPages : null).toEqual([{ sessionId: sid, signedIn: false }]);
  });

  it("device.appVersion carries OCW_APP_VERSION only when it is a semver", async () => {
    await browserDaemon({ env: { OCW_APP_VERSION: "1.4.0" } });
    await daemon.start();
    expect((await server.frame("hello")).device.appVersion).toBe("1.4.0");
    await browserDaemon({ env: { OCW_APP_VERSION: "1.4.0; rm -rf /" } });
    await daemon.start();
    await server.waitFor(() => (server.connections.length >= 2 ? true : undefined));
    const hello = await server.waitFor(() =>
      server.connections.at(-1)?.frames.find((f) => f.type === "hello"),
    );
    expect(hello.type === "hello" ? hello.device.appVersion : "x").toBeUndefined();
  });

  it("turning the opt-in on and off: capabilities follow, open pages close and the next call is refused", async () => {
    await browserDaemon({ env: { OCW_ALLOW_BROWSER: "" } });
    await daemon.start();
    expect((await server.frame("hello")).browser).toEqual({ version: 1, optIn: false });
    await setBrowserOptIn(home, true);
    const on = await controlRequest(socketPath(), { cmd: "reloadConfig" });
    expect(on.result).toMatchObject({ browserOptIn: true, browserOptInSource: "config" });
    await server.frame("capabilities", (f) => f.browser?.optIn === true);
    const sid = await browserSession();
    const tools = daemon.browser.forSession(sid);
    expect((await tools.call("open", { url: "http://localhost:3000/" })).isError).toBe(false);
    await server.frame("browser.event", (f) => f.sessionId === sid && f.kind === "opened");
    await setBrowserOptIn(home, false);
    await controlRequest(socketPath(), { cmd: "reloadConfig" });
    await server.frame("capabilities", (f) => f.browser?.optIn === false);
    await server.frame("browser.event", (f) => f.sessionId === sid && f.kind === "closed");
    expect((await tools.call("open", { url: "http://localhost:3000/" })).summary).toBe(
      "Refused: The browser is not available in this session.",
    );
  });

  it("at start, run dirs of sessions that are not alive are removed", async () => {
    const stale = join(home, "browsers", "run", randomUUID());
    mkdirSync(join(stale, "profile"), { recursive: true });
    writeFileSync(join(stale, "profile", "Cookies"), "x");
    await daemon.start();
    await server.frame("hello");
    expect(existsSync(stale)).toBe(false);
  });

  it("session.stop closes the session's page; browser.close closes only its own session's", async () => {
    await browserDaemon();
    await daemon.start();
    await server.frame("hello");
    const a = await browserSession();
    runtime.promptHold = null;
    const b = await browserSession();
    await daemon.browser.forSession(a).call("open", { url: "http://localhost:3000/" });
    await daemon.browser.forSession(b).call("open", { url: "http://localhost:4000/" });
    server.push({ type: "browser.frames", sessionId: b, on: true });
    server.push({ type: "browser.close", sessionId: a, reason: "revoked" });
    await server.frame("browser.event", (f) => f.sessionId === a && f.kind === "closed");
    expect(browserEvents(b, "closed")).toEqual([]);
    server.send({ id: "stop-b", kind: "session.stop", sessionId: b });
    await server.frame("ack", (f) => f.commandId === "stop-b");
    await server.frame("browser.event", (f) => f.sessionId === b && f.kind === "closed");
    // No browser frame was queued as a command or acked.
    expect(server.allFrames.filter((f) => f.type === "ack" && f.commandId.startsWith("browser"))).toEqual([]);
  });

  it("browserCall: the session's token answers the tool result; another token, a missing file or an extra key are refused", async () => {
    await browserDaemon();
    await daemon.start();
    await server.frame("hello");
    const sid = await browserSession();
    const file = await daemon.browser.forSession(sid).shimTokenFile();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, "utf8").trim();
    const ok = await controlRequest(socketPath(), {
      cmd: "browserCall",
      session: sid,
      token,
      tool: "open",
      args: { url: "http://localhost:3000/" },
    });
    expect(ok).toMatchObject({ ok: true, result: { summary: "Opened localhost:3000", isError: false } });

    const other = await browserSession();
    const otherToken = readFileSync(await daemon.browser.forSession(other).shimTokenFile(), "utf8").trim();
    const wrong = await controlRequest(socketPath(), {
      cmd: "browserCall",
      session: sid,
      token: otherToken,
      tool: "snapshot",
      args: {},
    });
    expect(wrong).toMatchObject({ ok: false, error: "not allowed" });
    const extra = await controlRequest(socketPath(), {
      cmd: "browserCall",
      session: sid,
      token,
      tool: "snapshot",
      args: {},
      cwd: "/",
    } as unknown as ControlRequest);
    expect(extra).toMatchObject({ ok: false, error: "invalid request" });
    rmSync(file);
    const missing = await controlRequest(socketPath(), {
      cmd: "browserCall",
      session: sid,
      token,
      tool: "snapshot",
      args: {},
    });
    expect(missing).toMatchObject({ ok: false, error: "not allowed" });
    expect(JSON.stringify(server.allFrames)).not.toContain(token);
  });

  it("the browser's PUT goes only to a sign-in route with uuid ids, under the device JWT", async () => {
    expect(() => toBrowserApiUrl("https://ocw.example/x", "/api/v1/runtime/files/abc")).toThrow();
    expect(() =>
      toBrowserApiUrl("https://ocw.example", "/api/v1/runtime/browser-signins/uploads/../../devices/token"),
    ).toThrow();
    const id = randomUUID();
    expect(toBrowserApiUrl("https://ocw.example/x", `/api/v1/runtime/browser-signins/uploads/${id}`)).toBe(
      `https://ocw.example/x/api/v1/runtime/browser-signins/uploads/${id}`,
    );
    expect(toBrowserApiUrl("https://ocw.example", `/api/v1/runtime/browser-signins/${id}/state`)).toBe(
      `https://ocw.example/api/v1/runtime/browser-signins/${id}/state`,
    );
  });
});

// -------------------------------------------------------------------------------------------------
// ADR-0045: any file on a person's prompt lands in the working tree before the turn, with a note the runtime reads

describe("ADR-0045 prompt files: copied into the tree before the turn, listed in a note", () => {
  function promptCmd(sessionId: string, text: string, files: Array<{ path: string; bytes: Buffer }>) {
    const payloadFiles = files.map((f) => ({
      transferId: randomUUID(),
      path: f.path,
      sizeBytes: f.bytes.byteLength,
      sha256: sha256Hex(f.bytes),
    }));
    return {
      id: randomUUID(),
      kind: "prompt" as const,
      sessionId,
      payload: { promptId: randomUUID(), text, files: payloadFiles },
    };
  }

  it("announces promptFiles in the hello", async () => {
    await daemon.start();
    expect(await server.frame("hello")).toMatchObject({ promptFiles: 1 });
  });

  it("each file is fetched with the device JWT and lands before the runtime gets the prompt with the note", async () => {
    await fileDaemon();
    await activeSession("pf-1");
    const bytes = Buffer.from("%PDF-1.4 spec\n");
    server.fileBody = bytes;
    let landedBeforeTurn = false;
    const originalPrompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (sessionId, p) => {
      landedBeforeTurn = existsSync(join(project, ".ocw", "uploads", "spec.pdf"));
      return originalPrompt(sessionId, p);
    };
    const cmd = promptCmd("pf-1", "Summarise the spec", [{ path: ".ocw/uploads/spec.pdf", bytes }]);
    server.send(cmd);
    expect(await fileAck(cmd.id)).toEqual({ type: "ack", commandId: cmd.id, ok: true });
    expect(landedBeforeTurn).toBe(true);
    expect(readFileSync(join(project, ".ocw", "uploads", "spec.pdf")).equals(bytes)).toBe(true);
    expect(server.fileRequests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: `/api/v1/runtime/files/${cmd.payload.files[0]!.transferId}`,
        authorization: `Bearer ${server.issued.at(-1)}`,
      }),
    ]);
    const got = runtime.prompts.at(-1)!;
    expect(got.text).toBe(
      "Summarise the spec\n\nAttached files (in the working tree):\n- .ocw/uploads/spec.pdf",
    );
    expect(got.files).toBeUndefined();
    expect(readdirSync(join(project, ".ocw", "uploads"))).toEqual(["spec.pdf"]);
    // Kept out of the runtime's commits by the repository's own exclude file (never the tracked .gitignore).
    expect(readFileSync(join(project, ".git", "info", "exclude"), "utf8")).toContain("\n/.ocw/uploads/\n");
    expect(existsSync(join(project, ".gitignore"))).toBe(false);
  });

  it("never overwrites: a taken name, and the same name twice in one prompt, get name-N.ext", async () => {
    await fileDaemon();
    await activeSession("pf-2");
    mkdirSync(join(project, ".ocw", "uploads"), { recursive: true });
    writeFileSync(join(project, ".ocw", "uploads", "notes.md"), "mine\n");
    const bytes = Buffer.from("# Notes\n");
    server.fileBody = bytes;
    const cmd = promptCmd("pf-2", "Merge these notes", [
      { path: ".ocw/uploads/notes.md", bytes },
      { path: ".ocw/uploads/notes.md", bytes },
    ]);
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
    expect(readFileSync(join(project, ".ocw", "uploads", "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(project, ".ocw", "uploads", "notes-1.md")).equals(bytes)).toBe(true);
    expect(readFileSync(join(project, ".ocw", "uploads", "notes-2.md")).equals(bytes)).toBe(true);
    // One GET per file: a taken name is found before any byte is fetched.
    expect(server.fileRequests).toHaveLength(2);
    expect(runtime.prompts.at(-1)!.text).toBe(
      "Merge these notes\n\nAttached files (in the working tree):\n- .ocw/uploads/notes-1.md\n- .ocw/uploads/notes-2.md",
    );
  });

  it("a file that does not land fails the prompt with one sentence; nothing runs and earlier files are removed", async () => {
    await fileDaemon();
    await activeSession("pf-3");
    const bytes = Buffer.from("first\n");
    server.fileBody = bytes;
    server.fileStatuses = [200, 410];
    const cmd = promptCmd("pf-3", "Use both files", [
      { path: ".ocw/uploads/a.txt", bytes },
      { path: ".ocw/uploads/b.txt", bytes },
    ]);
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({
      ok: false,
      error: "Could not copy b.txt into the working tree (the transfer expired). The prompt was not run.",
    });
    expect(runtime.prompts).toEqual([]);
    expect(existsSync(join(project, ".ocw", "uploads", "a.txt"))).toBe(false);
    expect(readdirSync(join(project, ".ocw", "uploads"))).toEqual([]);
  });

  it("the deny list still decides on the device: a secret name is refused before any request", async () => {
    await fileDaemon();
    await activeSession("pf-4");
    server.fileBody = Buffer.from("x");
    const cmd = promptCmd("pf-4", "Here", [{ path: ".ocw/uploads/server.key", bytes: server.fileBody }]);
    server.send(cmd);
    expect(await fileAck(cmd.id)).toMatchObject({
      ok: false,
      error:
        "Could not copy server.key into the working tree (the name is not allowed). The prompt was not run.",
    });
    expect(server.fileRequests).toEqual([]);
    expect(runtime.prompts).toEqual([]);
  });

  for (const id of ["claude-code", "codex"] as const) {
    it(`the ${id} runtime reads the note and finds the file in its tree`, async () => {
      await daemon.stop();
      daemon = await Daemon.create({
        home,
        env: { CODEX_HOME: join(home, "codex-default") },
        token: "device-token-123",
        config: { serverUrl: server.url },
        runtimes: [new ScriptedRuntime(id, 1)],
        logger: silentLogger,
        controlSocket: false,
        link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
        fileRetryDelaysMs: [10, 20],
      });
      const localId = (await daemon.registry.add(project)).localId;
      await daemon.start();
      await server.frame("hello");
      server.send({
        id: `start-${id}`,
        kind: "session.start",
        sessionId: `pf-${id}`,
        payload: { projectLocalId: localId, permissionMode: "plan", runtime: id },
      });
      expect(await fileAck(`start-${id}`)).toMatchObject({ ok: true });
      const bytes = Buffer.from("col1,col2\n1,2\n");
      server.fileBody = bytes;
      const cmd = promptCmd(`pf-${id}`, "Chart this CSV", [{ path: ".ocw/uploads/data.csv", bytes }]);
      server.send(cmd);
      expect(await fileAck(cmd.id)).toMatchObject({ ok: true });
      const reply = await server.frame(
        "event",
        (f) =>
          f.sessionId === `pf-${id}` &&
          f.event.type === "assistant.message" &&
          f.event.text.includes("Mode:"),
      );
      const text = reply.event.type === "assistant.message" ? reply.event.text : "";
      expect(text).toContain(`Files: .ocw/uploads/data.csv (${bytes.byteLength} bytes)`);
    });
  }
});
