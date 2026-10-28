import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type PermissionMode, type SessionEvent, stripImageData } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeError } from "../runtime.js";
import {
  type AppServerProcess,
  CODEX_APP_SERVER_ARGS,
  CodexRuntime,
  codexChildEnv,
} from "./codex-runtime.js";
import { parseCodexLogin } from "./detect.js";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";
import type { UserInput } from "./generated/v2/UserInput.js";

type Msg = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/** In-memory stand-in for `codex app-server`, scripted per test. */
class FakeAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Msg[] = [];
  killed: string[] = [];
  /** Forces the sandbox the fake reports on thread/start (null = what the client asked for). */
  sandboxType: string | null = null;
  /** When the fake sends `thread/settings/updated` for turn/start overrides (A5 is what the fixture shows). */
  settingsUpdates: "none" | "before" | "after" = "none";
  /** Thread settings as the fake currently holds them (thread/start + sticky turn/start overrides). */
  threadSettings: Record<string, unknown> = {};
  compactError = false;
  private nextServerId = 1000;
  private readonly waiters = new Map<number, (m: Msg) => void>();
  onTurnStart: (params: Record<string, unknown>) => void = () => undefined;

  constructor(readonly env: Record<string, string | undefined>) {
    super();
    let buf = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (c: string) => {
      buf += c;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) this.handle(JSON.parse(line) as Msg);
        i = buf.indexOf("\n");
      }
    });
  }

  send(m: Msg): void {
    this.stdout.write(`${JSON.stringify(m)}\n`);
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params: params as Record<string, unknown> });
  }

  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.send({ id, method, params: params as Record<string, unknown> });
    });
  }

  sendSettings(over: Record<string, unknown> = {}): void {
    this.notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: {
        cwd: "/abs/cwd",
        modelProvider: "openai",
        summary: null,
        ...this.threadSettings,
        ...over,
      },
    });
  }

  completeTurn(): void {
    this.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null, items: [] },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.stdout.end();
    setImmediate(() => this.emit("exit", 0));
  }

  /** Subclasses answer extra methods here (return true when handled). */
  protected handleExtra(_m: Msg): boolean {
    return false;
  }

  private handle(m: Msg): unknown {
    this.received.push(m);
    if (m.id !== undefined && !m.method) {
      this.waiters.get(Number(m.id))?.(m);
      return;
    }
    if (this.handleExtra(m)) return;
    switch (m.method) {
      case "initialize":
        return this.send({
          id: m.id,
          result: { userAgent: "fake", codexHome: "/x", platformFamily: "unix", platformOs: "macos" },
        });
      case "thread/start":
      case "thread/resume": {
        const sandbox = this.sandboxType ?? SANDBOX_TYPES[String(m.params?.sandbox)] ?? "workspaceWrite";
        this.threadSettings = {
          model: (m.params?.model as string | undefined) ?? "gpt-test",
          effort: "medium",
          serviceTier: "default",
          approvalPolicy: m.params?.approvalPolicy,
          approvalsReviewer: m.params?.approvalsReviewer ?? "user",
          sandboxPolicy: sandbox === "readOnly" ? { type: sandbox, networkAccess: false } : { type: sandbox },
        };
        return this.send({
          id: m.id,
          result: {
            thread: { id: "thread-1" },
            model: this.threadSettings.model,
            serviceTier: "default",
            reasoningEffort: "medium",
            approvalPolicy: this.threadSettings.approvalPolicy,
            approvalsReviewer: this.threadSettings.approvalsReviewer,
            sandbox: this.threadSettings.sandboxPolicy,
          },
        });
      }
      case "turn/start": {
        const p = m.params ?? {};
        for (const k of [
          "model",
          "effort",
          "serviceTier",
          "approvalPolicy",
          "approvalsReviewer",
          "sandboxPolicy",
        ])
          if (p[k] !== undefined && p[k] !== null) this.threadSettings[k] = p[k];
        if (this.settingsUpdates === "before") this.sendSettings();
        this.send({
          id: m.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } },
        });
        if (this.settingsUpdates === "after") this.sendSettings();
        this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
        return this.onTurnStart(p);
      }
      case "thread/compact/start":
        if (this.compactError)
          return this.send({ id: m.id, error: { code: -32000, message: "cannot compact" } });
        return this.send({ id: m.id, result: {} });
      case "turn/interrupt":
        this.send({ id: m.id, result: {} });
        return this.notify("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
        });
      case "turn/steer":
        return this.send({ id: m.id, result: { turnId: "turn-1" } });
      default:
        if (m.id !== undefined) this.send({ id: m.id, result: {} });
    }
  }
}

const SANDBOX_TYPES: Record<string, string> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
};

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function setup(opts: { allowFullAccess?: () => boolean } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-rt-")));
  const servers: FakeAppServer[] = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({
    codexPath: "/usr/local/bin/codex",
    ...(opts.allowFullAccess ? { allowFullAccess: opts.allowFullAccess } : {}),
    spawnAppServer: ({ env }) => {
      const s = new FakeAppServer(env);
      servers.push(s);
      return s;
    },
  });
  const start = async (permissionMode: PermissionMode = "default") => {
    await runtime.start({ sessionId: "s1", cwd, permissionMode }, (e) => events.push(e));
    return servers[0] as FakeAppServer;
  };
  return { cwd, runtime, events, start, servers };
}

describe("CodexRuntime — handshake, sandbox and billing", () => {
  it("initializes and starts a Supervised thread: read-only sandbox, untrusted approvals, user reviewer", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.OCW_DEVICE_TOKEN = "device-secret";
    const { start, events, cwd } = setup();
    const server = await start();
    expect(server.received.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(server.received[2]?.params).toMatchObject({
      cwd,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(server.env.OPENAI_API_KEY).toBeUndefined();
    expect(server.env.OCW_DEVICE_TOKEN).toBeUndefined();
    expect(events).toEqual([
      {
        type: "session.started",
        runtime: "codex",
        runtimeSessionId: "thread-1",
        model: "gpt-test",
        permissionMode: "default",
      },
      {
        type: "session.settings",
        model: "gpt-test",
        effort: "medium",
        serviceTier: "default",
        fastMode: false,
        permissionMode: "default",
      },
      { type: "session.state", status: "idle" },
    ]);
  });

  it("starts acceptEdits on a workspace-write, on-request thread", async () => {
    const { start } = setup();
    const server = await start("acceptEdits");
    expect(server.received[2]?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
  });

  it("uses a read-only sandbox for plan mode and resumes by thread id", async () => {
    const { runtime, cwd, servers } = setup();
    await runtime.start(
      { sessionId: "s2", cwd, permissionMode: "plan", resumeRuntimeSessionId: "thread-old" },
      () => undefined,
    );
    const req = servers[0]?.received.find((m) => m.method === "thread/resume");
    expect(req?.params).toMatchObject({
      threadId: "thread-old",
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
  });

  it("fails closed when Codex reports a danger-full-access sandbox", async () => {
    const { runtime, cwd } = setup();
    const r = new CodexRuntime({
      spawnAppServer: ({ env }) => {
        const s = new FakeAppServer(env);
        s.sandboxType = "dangerFullAccess";
        return s;
      },
    });
    await expect(
      r.start({ sessionId: "s3", cwd, permissionMode: "default" }, () => undefined),
    ).rejects.toBeInstanceOf(RuntimeError);
    expect(runtime).toBeDefined();
  });

  it("rejects bypass-style permission modes", async () => {
    const { runtime, cwd } = setup();
    await expect(
      runtime.start(
        { sessionId: "s4", cwd, permissionMode: "bypassPermissions" as PermissionMode },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(RuntimeError);
  });

  it("refuses platform modes outside its capabilities (fullAccess) before spawning anything", async () => {
    const { runtime, cwd, servers } = setup();
    for (const mode of ["fullAccess"] as const) {
      await expect(
        runtime.start({ sessionId: `s5-${mode}`, cwd, permissionMode: mode }, () => undefined),
      ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    }
    expect(servers).toHaveLength(0);
  });

  it("keeps OPENAI_API_KEY only with useApiKey", () => {
    process.env.OPENAI_API_KEY = "k";
    expect(codexChildEnv(process.env).OPENAI_API_KEY).toBeUndefined();
    expect(codexChildEnv(process.env, true).OPENAI_API_KEY).toBe("k");
  });

  it("parses `codex login status`", () => {
    expect(parseCodexLogin("Logged in using ChatGPT")).toBe("chatgpt");
    expect(parseCodexLogin("Logged in using an API key - sk-***")).toBe("apikey");
    expect(parseCodexLogin("Not logged in")).toBeNull();
  });
});

describe("CodexRuntime — turns and approvals", () => {
  it("maps a turn with a command approval answered from approval.resolve", async () => {
    const { start, runtime, events, cwd } = setup();
    const server = await start();
    let approvalResponse: Promise<Msg> | null = null;
    server.onTurnStart = () => {
      const item = {
        type: "commandExecution",
        id: "c1",
        command: "pnpm test",
        cwd,
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
      };
      server.notify("item/started", { item, threadId: "thread-1", turnId: "turn-1", startedAtMs: 0 });
      approvalResponse = server.request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "c1",
        command: "pnpm test",
        cwd,
        reason: "run tests",
      });
    };
    await runtime.prompt("s1", { promptId: "p1", text: "run the tests" });
    await wait(20);
    const req = events.find((e) => e.type === "approval.requested") as Extract<
      SessionEvent,
      { type: "approval.requested" }
    >;
    expect(req).toMatchObject({ tool: "Bash", summary: "run tests\n$ pnpm test" });
    expect(runtime.resolveApproval("s1", req.approvalId, "session")).toBe(true);
    const resp = await (approvalResponse as unknown as Promise<Msg>);
    expect(resp.result).toEqual({ decision: "acceptForSession" });

    server.notify("item/completed", {
      item: {
        type: "commandExecution",
        id: "c1",
        command: "pnpm test",
        status: "completed",
        aggregatedOutput: "ok\n",
        exitCode: 0,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
    });
    server.notify("item/completed", {
      item: { type: "agentMessage", id: "m1", text: "Tests pass." },
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
    });
    server.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null, items: [] },
    });
    await wait(20);

    const turnStart = server.received.find((m) => m.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "run the tests" }],
    });
    const flow = events.map((e) => e.type);
    expect(flow).toEqual([
      "session.started",
      "session.settings",
      "session.state",
      "prompt.started",
      "session.state",
      "tool.started",
      "approval.requested",
      "session.state",
      "approval.resolved",
      "session.state",
      "tool.completed",
      "assistant.message",
      "prompt.completed",
      "session.state",
    ]);
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });
  });

  it("declines commands that touch secrets without asking", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    let response: Promise<Msg> | null = null;
    server.onTurnStart = () => {
      response = server.request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "c2",
        command: "cat .env",
      });
    };
    await runtime.prompt("s1", { promptId: "p1", text: "x" });
    await wait(20);
    expect((await (response as unknown as Promise<Msg>)).result).toEqual({ decision: "decline" });
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("answers unsupported server requests with a JSON-RPC error", async () => {
    const { start } = setup();
    const server = await start();
    const resp = await server.request("item/tool/requestUserInput", {});
    expect(resp.error).toMatchObject({ code: -32601 });
  });

  it("interrupts the running turn via turn/interrupt", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "long" });
    await wait(10);
    await runtime.interrupt("s1");
    await wait(10);
    expect(server.received.find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      interrupted: true,
    });
  });

  it("steers the running turn and queues otherwise", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    await runtime.steer("s1", { promptId: "p1", text: "first" }); // nothing running -> normal prompt
    await wait(10);
    await runtime.steer("s1", { promptId: "p2", text: "also do this" });
    await wait(10);
    expect(server.received.find((m) => m.method === "turn/steer")?.params).toMatchObject({
      expectedTurnId: "turn-1",
    });
    server.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null, items: [] },
    });
    await wait(10);
    expect(
      events.filter((e) => e.type === "prompt.completed").map((e) => (e as { promptId: string }).promptId),
    ).toEqual(["p1", "p2"]);
  });

  it("stop() kills the app-server and reports completed", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    await runtime.stop("s1");
    expect(server.killed).toContain("SIGTERM");
    expect(events.at(-1)).toEqual({ type: "session.state", status: "completed" });
  });

  it("reports failure when the app-server dies", async () => {
    const { start, events } = setup();
    const server = await start();
    server.stdout.end();
    await wait(10);
    expect(events.slice(-2)).toMatchObject([
      { type: "session.error" },
      { type: "session.state", status: "failed" },
    ]);
  });
});

const settingsEvents = (events: SessionEvent[]) =>
  events.filter(
    (e): e is Extract<SessionEvent, { type: "session.settings" }> => e.type === "session.settings",
  );
const turnStarts = (server: FakeAppServer) => server.received.filter((m) => m.method === "turn/start");

describe("CodexRuntime — settings ride on the next turn/start (D-07, D-14)", () => {
  it("configure() while idle sends nothing; the next turn/start carries the model and the Supervised policy", async () => {
    const { start, runtime, events } = setup();
    const server = await start("default");
    const before = server.received.length;
    await runtime.configure("s1", { model: "gpt-5.5" });
    await wait(10);
    expect(server.received).toHaveLength(before);

    await runtime.prompt("s1", { promptId: "p1", text: "hi" });
    await wait(10);
    expect(turnStarts(server)[0]?.params).toMatchObject({
      model: "gpt-5.5",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    // No experimental field is ever sent.
    for (const m of server.received) {
      expect(m.params ?? {}).not.toHaveProperty("collaborationMode");
      expect(m.params ?? {}).not.toHaveProperty("permissions");
      expect(m.params ?? {}).not.toHaveProperty("serviceTierForTurn");
      expect(["thread/settings/update", "turn/settings/update"]).not.toContain(m.method);
    }
    // Synthesized from the overrides (the fake sends no thread/settings/updated).
    expect(settingsEvents(events).at(-1)).toEqual({
      type: "session.settings",
      model: "gpt-5.5",
      effort: "medium",
      serviceTier: "default",
      fastMode: false,
      permissionMode: "default",
    });
  });

  it("a change made during a running turn is held and rides on the following turn/start; changes merge, last wins", async () => {
    const { start, runtime } = setup();
    const server = await start("acceptEdits");
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await wait(10);
    const during = server.received.length;
    await runtime.configure("s1", { model: "gpt-5.5", effort: "low" });
    await runtime.configure("s1", { model: "gpt-6", fastMode: true });
    await runtime.prompt("s1", { promptId: "p2", text: "two" }); // queued behind p1
    await wait(10);
    expect(server.received).toHaveLength(during);
    expect(turnStarts(server)[0]?.params).not.toHaveProperty("model");

    server.completeTurn();
    await wait(20);
    expect(turnStarts(server)).toHaveLength(2);
    expect(turnStarts(server)[1]?.params).toMatchObject({
      model: "gpt-6",
      effort: "low",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  it("emits session.settings once per applied change, from thread/settings/updated when Codex sends it", async () => {
    for (const when of ["before", "after"] as const) {
      const { start, runtime, events } = setup();
      const server = await start("default");
      server.settingsUpdates = when;
      const startCount = settingsEvents(events).length;
      await runtime.configure("s1", { model: "gpt-5.5" });
      await runtime.prompt("s1", { promptId: "p1", text: "hi" });
      await wait(20);
      const after = settingsEvents(events).slice(startCount);
      expect(after, when).toHaveLength(1);
      expect(after[0]).toMatchObject({ model: "gpt-5.5", permissionMode: "default" });

      // A turn without changes reports nothing new.
      server.completeTurn();
      await wait(10);
      await runtime.prompt("s1", { promptId: "p2", text: "again" });
      await wait(20);
      expect(settingsEvents(events).slice(startCount), when).toHaveLength(1);
    }
  });

  it("refuses a mode outside the adapter's capabilities and a selectable context window", async () => {
    const { start, runtime } = setup();
    await start();
    await expect(runtime.configure("s1", { permissionMode: "fullAccess" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    await expect(runtime.configure("s1", { contextWindow: 1_000_000 })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    await expect(runtime.configure("nope", { model: "x" })).rejects.toMatchObject({
      code: "unknown_session",
    });
  });

  it("a permission mode change sends the new policy on the next turn and reports it", async () => {
    const { start, runtime, events } = setup();
    const server = await start("default");
    await runtime.configure("s1", { permissionMode: "acceptEdits" });
    await runtime.prompt("s1", { promptId: "p1", text: "edit" });
    await wait(10);
    expect(turnStarts(server)[0]?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [expect.any(String)] },
    });
    expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "acceptEdits" });
  });
});

// ------------------------------------------------------------------------------------------------
// Replay of a turn recorded against the real codex app-server 0.160.0 (scripts/record-codex-fixture.ts).

interface RpcLine {
  dir: "in" | "out";
  msg: Msg;
}

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");
const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";

/** Only lines with `dir` are exchanged messages; a synthetic fixture's leading `{"note": …}` record is skipped. */
function loadFixture(name: string): RpcLine[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Partial<RpcLine>)
    .filter((l): l is RpcLine => l.dir === "in" || l.dir === "out");
}

/**
 * Plays the recorded app-server side back in order: every time the client writes a message, the recorded
 * server lines up to the next recorded client line are sent. Client request ids are deterministic (1, 2, …).
 */
class ReplayAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly sent: Msg[] = [];
  private i = 0;

  constructor(private readonly lines: RpcLine[]) {
    super();
    let buf = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (c: string) => {
      buf += c;
      let n = buf.indexOf("\n");
      while (n >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        if (line) this.onClient(JSON.parse(line) as Msg);
        n = buf.indexOf("\n");
      }
    });
    setImmediate(() => this.flush());
  }

  private onClient(m: Msg): void {
    this.sent.push(m);
    if (this.lines[this.i]?.dir === "out") this.i++;
    this.flush();
  }

  private flush(): void {
    while (this.i < this.lines.length && this.lines[this.i]?.dir === "in") {
      this.stdout.write(`${JSON.stringify(this.lines[this.i]?.msg)}\n`);
      this.i++;
    }
  }

  kill(): void {
    this.stdout.end();
    setImmediate(() => this.emit("exit", 0));
  }
}

describe("CodexRuntime — recorded Supervised write (codex-cli 0.160.0, read-only + untrusted)", () => {
  const lines = loadFixture("codex-0.160.0.supervised-write.rpc.jsonl");
  const out = (method: string) => lines.filter((l) => l.dir === "out" && l.msg.method === method);

  it("the recording asked for a read-only sandbox with untrusted approvals reviewed by the user", () => {
    expect(out("thread/start")[0]?.msg.params).toMatchObject({
      cwd: FIXTURE_ROOT,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
    expect(out("turn/start")[0]?.msg.params).toMatchObject({
      effort: "low",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(lines.filter((l) => l.msg.method === "turn/completed")).toHaveLength(1);
  });

  it("no file change completed with a write", () => {
    const writes = lines.filter(
      (l) =>
        l.msg.method === "item/completed" &&
        (l.msg.params as { item?: { type?: string; status?: string } }).item?.type === "fileChange" &&
        (l.msg.params as { item?: { status?: string } }).item?.status === "completed",
    );
    expect(writes).toEqual([]);
  });

  it("replays through the adapter: the same requests, an approval before any write, declined", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-replay-")));
    let server: ReplayAppServer | null = null;
    const events: SessionEvent[] = [];
    const runtime = new CodexRuntime({
      spawnAppServer: () => {
        server = new ReplayAppServer(lines);
        return server;
      },
    });
    const completed = new Promise<void>((resolve) => {
      void runtime
        .start({ sessionId: "fixture-session", cwd, permissionMode: "default" }, (ev) => {
          events.push(ev);
          if (ev.type === "approval.requested")
            runtime.resolveApproval("fixture-session", ev.approvalId, "deny");
          if (ev.type === "prompt.completed") resolve();
        })
        .then(() => runtime.configure("fixture-session", { effort: "low" }))
        .then(() =>
          runtime.prompt("fixture-session", {
            promptId: "prompt-1",
            text: "Create a file named note.txt containing the word hi.",
          }),
        );
    });
    await completed;
    const replay = server as unknown as ReplayAppServer;
    // The adapter sends the same client requests, in the same order, as the recording.
    const recordedMethods = lines.filter((l) => l.dir === "out" && l.msg.method).map((l) => l.msg.method);
    expect(replay.sent.filter((m) => m.method).map((m) => m.method)).toEqual(
      recordedMethods.filter((m) => m !== "turn/interrupt"),
    );
    expect(replay.sent.find((m) => m.method === "turn/start")?.params).toEqual({
      ...out("turn/start")[0]?.msg.params,
      sandboxPolicy: expect.any(Object),
    });

    const types = events.map((e) => e.type);
    const firstApproval = types.indexOf("approval.requested");
    expect(firstApproval).toBeGreaterThan(-1);
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({ decision: "deny" });
    const approvedWrites = events.filter(
      (e) => e.type === "tool.completed" && e.ok && e.summary.startsWith("Edited"),
    );
    expect(approvedWrites).toEqual([]);
    expect(events.at(-1)?.type === "prompt.completed" || types.includes("prompt.completed")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Prompt images at codex app-server 0.160.0 (06.1-03, D-05, D-07, P-07). No real Codex runs: the FakeAppServer
// records what the adapter sends, and the replay below is a SYNTHETIC fixture built from generated/ (not recorded).

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const imageInput = (mediaType: string, data: string) =>
  ({ type: "image", url: `data:${mediaType};base64,${data}` }) satisfies UserInput;
const textInput = (text: string) => ({ type: "text", text, text_elements: [] }) satisfies UserInput;
const IMAGES = [
  { mediaType: "image/png" as const, dataBase64: PNG },
  { mediaType: "image/webp" as const, dataBase64: WEBP },
];

/** Answers `turn/start` with a JSON-RPC error that echoes the request input, as a picky server might. */
class RejectingAppServer extends FakeAppServer {
  protected override handleExtra(m: Msg): boolean {
    if (m.method !== "turn/start") return false;
    this.send({
      id: m.id,
      error: {
        code: -32602,
        message: `invalid input: ${JSON.stringify((m.params as { input?: unknown }).input)}`,
      },
    });
    return true;
  }
}

describe("CodexRuntime — prompt images (06.1-03)", () => {
  it("says it can take images", () => {
    expect(setup().runtime.capabilities.supportsImages).toBe(true);
  });

  it("turn/start carries one data-URL image item per image, in order, before the text item", async () => {
    const { start, runtime } = setup();
    const server = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "what changed?", images: IMAGES });
    await wait(10);
    const params = turnStarts(server)[0]?.params as TurnStartParams | undefined;
    const input: UserInput[] = [
      imageInput("image/png", PNG),
      imageInput("image/webp", WEBP),
      textInput("what changed?"),
    ];
    expect(params?.input).toStrictEqual(input);
    expect(params?.threadId).toBe("thread-1");
    // Never the path-based variant: the daemon writes no image to disk (P-11, Pitfall 6).
    expect(JSON.stringify(server.received)).not.toContain("localImage");
    expect(JSON.stringify(params?.input)).not.toMatch(/"path"|"fileId"/);
  });

  it("a steered prompt with an image goes into turn/steer with the same item shapes and expectedTurnId (D-07, P-07)", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "start" });
    await wait(10);
    await runtime.steer("s1", { promptId: "p2", text: "and look at this", images: [IMAGES[0]!] });
    await wait(10);
    const steer = server.received.find((m) => m.method === "turn/steer")?.params;
    const expected: TurnSteerParams = {
      threadId: "thread-1",
      input: [imageInput("image/png", PNG), textInput("and look at this")],
      expectedTurnId: "turn-1",
    };
    expect(steer).toStrictEqual(expected);
    expect(server.received.filter((m) => m.method === "turn/start")).toHaveLength(1);
    expect(JSON.stringify(server.received)).not.toContain("localImage");
    server.completeTurn();
    await wait(10);
    expect(
      events.filter((e) => e.type === "prompt.completed").map((e) => (e as { promptId: string }).promptId),
    ).toEqual(["p1", "p2"]);
  });

  it("a turn/start error for an image prompt fails the prompt visibly; stripImageData leaves no base64 in it", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-img-")));
    const events: SessionEvent[] = [];
    const runtime = new CodexRuntime({
      codexPath: "/usr/local/bin/codex",
      spawnAppServer: ({ env }) => new RejectingAppServer(env),
    });
    await runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, (e) => events.push(e));
    await runtime.prompt("s1", { promptId: "p1", text: "look", images: IMAGES });
    await wait(10);
    const error = events.find((e) => e.type === "session.error");
    const message = error?.type === "session.error" ? error.message : "";
    expect(message).toMatch(/^turn\/start failed: invalid input/);
    // The adapter's raw error echoes the input; the daemon strips it before anything leaves the device (P-11).
    const stripped = stripImageData(message);
    expect(stripped).not.toContain(";base64,");
    expect(stripped).not.toContain(PNG.slice(0, 40));
    expect(stripped).not.toContain(WEBP.slice(0, 40));
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      isError: true,
    });
  });
});

describe("CodexRuntime — synthetic image turn (built from generated/ at codex-cli 0.160.0, not recorded)", () => {
  const FILE = "codex-0.160.0.image-turn.synthetic.rpc.jsonl";
  const lines = loadFixture(FILE);
  const out = (method: string) => lines.filter((l) => l.dir === "out" && l.msg.method === method);

  it("is marked synthetic on its first line, which loadFixture skips", () => {
    const first = readFileSync(join(FIXTURE_DIR, FILE), "utf8").split("\n", 1)[0] ?? "";
    expect(JSON.parse(first)).toMatchObject({ note: expect.stringContaining("synthetic") });
    expect(lines.every((l) => l.dir === "in" || l.dir === "out")).toBe(true);
  });

  it("its userMessage items echo the image input, shaped like the generated types", () => {
    const params = out("turn/start")[0]?.msg.params as TurnStartParams;
    const started = lines.find(
      (l) =>
        l.msg.method === "item/started" &&
        (l.msg.params as ItemStartedNotification).item.type === "userMessage",
    )?.msg.params as ItemStartedNotification;
    const item = started.item;
    expect(item.type).toBe("userMessage");
    if (item.type !== "userMessage") throw new Error("unreachable");
    expect(item.content).toStrictEqual(params.input);
    expect(params.input).toStrictEqual([
      imageInput("image/png", PNG),
      textInput("What does this screenshot show?"),
    ]);
  });

  it("replays through the adapter: the same requests, the reply and prompt.completed, and no image data in any event", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-img-replay-")));
    let server: ReplayAppServer | null = null;
    const events: SessionEvent[] = [];
    const runtime = new CodexRuntime({
      spawnAppServer: () => {
        server = new ReplayAppServer(lines);
        return server;
      },
    });
    const completed = new Promise<void>((resolve) => {
      void runtime
        .start({ sessionId: "img-session", cwd, permissionMode: "default" }, (ev) => {
          events.push(ev);
          if (ev.type === "prompt.completed") resolve();
        })
        .then(() =>
          runtime.prompt("img-session", {
            promptId: "prompt-img",
            text: "What does this screenshot show?",
            images: [{ mediaType: "image/png", dataBase64: PNG }],
          }),
        );
    });
    await completed;
    const replay = server as unknown as ReplayAppServer;
    expect(replay.sent.filter((m) => m.method).map((m) => m.method)).toEqual(
      lines.filter((l) => l.dir === "out" && l.msg.method).map((l) => l.msg.method),
    );
    expect(replay.sent.find((m) => m.method === "turn/start")?.params).toEqual({
      ...out("turn/start")[0]?.msg.params,
      sandboxPolicy: expect.any(Object),
    });
    expect(events.find((e) => e.type === "assistant.message")).toMatchObject({ text: "A single pixel." });
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({ promptId: "prompt-img" });
    expect(events.find((e) => e.type === "prompt.completed")).not.toHaveProperty("isError");
    const json = JSON.stringify(events);
    expect(json).not.toContain(";base64,");
    expect(json).not.toContain(PNG.slice(0, 40));
    expect(events.some((e) => e.type === "runtime.raw")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------

const MODEL_LIST = JSON.parse(readFileSync(join(FIXTURE_DIR, "codex-0.160.0.model-list.json"), "utf8")) as {
  data: unknown[];
};

/** Fake app-server for catalog collection: model/list served in pages of 3 from the recorded list. */
class CatalogAppServer extends FakeAppServer {
  failList = false;
  protected override handleExtra(m: Msg): boolean {
    if (m.method !== "model/list") return false;
    if (this.failList) {
      this.send({ id: m.id, error: { code: -32000, message: "not signed in" } });
      return true;
    }
    const start = Number((m.params?.cursor as string | undefined) ?? 0);
    const data = MODEL_LIST.data.slice(start, start + 3);
    const next = start + 3 < MODEL_LIST.data.length ? String(start + 3) : null;
    this.send({ id: m.id, result: { data, nextCursor: next } });
    return true;
  }
}

describe("CodexRuntime.catalog() — model/list without a thread (D-08)", () => {
  const make = (opts: { loggedIn?: boolean; fail?: boolean } = {}) => {
    const servers: CatalogAppServer[] = [];
    const runtime = new CodexRuntime({
      detect: async () => ({
        id: "codex",
        installed: true,
        version: "0.160.0",
        loggedIn: opts.loggedIn ?? true,
      }),
      spawnAppServer: ({ env }) => {
        const s = new CatalogAppServer(env);
        s.failList = opts.fail ?? false;
        servers.push(s);
        return s;
      },
    });
    return { runtime, servers };
  };

  it("spawns one app-server, sends initialize, initialized and every model/list page, never a thread or a turn", async () => {
    const { runtime, servers } = make();
    const catalog = await runtime.catalog();
    expect(servers).toHaveLength(1);
    const methods = servers[0]?.received.map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "model/list", "model/list", "model/list"]);
    expect(servers[0]?.received[0]?.params).toMatchObject({ capabilities: { experimentalApi: false } });
    expect(servers[0]?.killed).toContain("SIGTERM");
    expect(catalog?.models).toHaveLength(MODEL_LIST.data.length);
    expect(catalog).toMatchObject({ runtime: "codex", runtimeVersion: "0.160.0" });
    expect(catalog?.permissionModes).toEqual([...runtime.capabilities.supportsPermissionModes]);
  });

  it("caches the catalog for 10 minutes", async () => {
    const { runtime, servers } = make();
    await runtime.catalog();
    await runtime.catalog();
    expect(servers).toHaveLength(1);
  });

  it("a model/list error yields null and the process is still killed", async () => {
    const { runtime, servers } = make({ fail: true });
    expect(await runtime.catalog()).toBeNull();
    expect(servers[0]?.killed).toContain("SIGTERM");
  });

  it("null without spawning when Codex is not signed in with ChatGPT", async () => {
    const { runtime, servers } = make({ loggedIn: false });
    expect(await runtime.catalog()).toBeNull();
    expect(servers).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------

/** A runtime whose app-servers also answer model/list, with the catalog already collected. */
async function setupWithCatalog() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-rt-")));
  const servers: CatalogAppServer[] = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({
    detect: async () => ({ id: "codex", installed: true, version: "0.160.0", loggedIn: true }),
    spawnAppServer: ({ env }) => {
      const s = new CatalogAppServer(env);
      servers.push(s);
      return s;
    },
  });
  await runtime.catalog();
  await runtime.start({ sessionId: "s1", cwd, permissionMode: "acceptEdits" }, (e) => events.push(e));
  return { runtime, events, server: servers[1] as CatalogAppServer };
}

describe("CodexRuntime — auto review, fast tier, effort validation (D-09, D-11, D-12)", () => {
  it("offers plan, default, acceptEdits and auto; never fullAccess", () => {
    expect(new CodexRuntime().capabilities.supportsPermissionModes).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "auto",
    ]);
  });

  it("auto sends approvalsReviewer auto_review with a workspace-write sandbox", async () => {
    const { start, runtime } = setup();
    const server = await start("default");
    await runtime.configure("s1", { permissionMode: "auto" });
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await wait(10);
    expect(turnStarts(server)[0]?.params).toMatchObject({
      approvalsReviewer: "auto_review",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  it("starts an auto session directly", async () => {
    const { start } = setup();
    const server = await start("auto");
    expect(server.received[2]?.params).toMatchObject({
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
  });

  it("fast mode maps to the sticky serviceTier: priority on, default off", async () => {
    const { start, runtime } = setup();
    const server = await start();
    await runtime.configure("s1", { fastMode: true });
    await runtime.prompt("s1", { promptId: "p1", text: "a" });
    await wait(10);
    server.completeTurn();
    await wait(10);
    await runtime.configure("s1", { fastMode: false });
    await runtime.prompt("s1", { promptId: "p2", text: "b" });
    await wait(10);
    expect(turnStarts(server).map((m) => m.params?.serviceTier)).toEqual(["priority", "default"]);
    expect(turnStarts(server).every((m) => !("serviceTierForTurn" in (m.params ?? {})))).toBe(true);
  });

  it("refuses the ultra effort always (D-09)", async () => {
    const { start, runtime } = setup();
    await start();
    await expect(runtime.configure("s1", { effort: "ultra" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
  });

  it("validates model, effort and fast mode against the collected catalog (Pitfall 7)", async () => {
    const { runtime } = await setupWithCatalog();
    await expect(runtime.configure("s1", { effort: "turbo" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    await expect(runtime.configure("s1", { model: "gpt-unknown" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    await expect(
      runtime.configure("s1", { model: "gpt-daybreak-blue-latest", fastMode: true }),
    ).rejects.toMatchObject({ code: "settings_rejected" });
    await expect(runtime.configure("s1", { model: "gpt-6-luna", effort: "max" })).resolves.toBeUndefined();
  });

  it("'default' model and effort resolve to the runtime's defaults from the catalog", async () => {
    const { runtime, server } = await setupWithCatalog();
    await runtime.configure("s1", { model: "gpt-6-luna", effort: "max" });
    await runtime.prompt("s1", { promptId: "p1", text: "a" });
    await wait(10);
    server.completeTurn();
    await wait(10);
    await runtime.configure("s1", { model: null, effort: null });
    await runtime.prompt("s1", { promptId: "p2", text: "b" });
    await wait(10);
    expect(turnStarts(server).map((m) => [m.params?.model, m.params?.effort])).toEqual([
      ["gpt-6-luna", "max"],
      ["gpt-6.1-sol", "low"],
    ]);
  });
});

describe("CodexRuntime — per-turn cap (P-07)", () => {
  it("a prompt capped at plan runs read-only; the next uncapped turn returns to acceptEdits", async () => {
    const { start, runtime, events } = setup();
    const server = await start("acceptEdits");
    await runtime.prompt("s1", { promptId: "p1", text: "look", permissionMode: "plan" });
    await wait(10);
    server.completeTurn();
    await wait(10);
    await runtime.prompt("s1", { promptId: "p2", text: "edit" });
    await wait(10);
    const [capped, uncapped] = turnStarts(server);
    expect(capped?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(uncapped?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
    expect(settingsEvents(events).map((e) => e.permissionMode)).toEqual([
      "acceptEdits",
      "plan",
      "acceptEdits",
    ]);
  });

  it("a cap above the session mode never raises it", async () => {
    const { start, runtime } = setup();
    const server = await start("default");
    await runtime.prompt("s1", { promptId: "p1", text: "x", permissionMode: "auto" });
    await wait(10);
    expect(turnStarts(server)[0]?.params).toMatchObject({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  it("input capped below the running turn's mode is not steered into it; it waits for its own turn", async () => {
    const { start, runtime } = setup();
    const server = await start("acceptEdits");
    await runtime.prompt("s1", { promptId: "p1", text: "edit" });
    await wait(10);
    await runtime.steer("s1", { promptId: "p2", text: "and this", permissionMode: "plan" });
    await wait(10);
    expect(server.received.some((m) => m.method === "turn/steer")).toBe(false);
    server.completeTurn();
    await wait(10);
    expect(turnStarts(server)[1]?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  });
});

describe("CodexRuntime — slash commands (D-13, P-10)", () => {
  it("/compact sends thread/compact/start instead of a turn and completes through turn/completed", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "/compact" });
    await wait(10);
    expect(server.received.find((m) => m.method === "thread/compact/start")?.params).toEqual({
      threadId: "thread-1",
    });
    expect(turnStarts(server)).toHaveLength(0);
    expect(events.find((e) => e.type === "prompt.started")).toMatchObject({ promptId: "p1" });
    server.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    server.completeTurn();
    await wait(10);
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({ promptId: "p1" });
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });
  });

  it("a failed compaction completes the prompt with isError", async () => {
    const { start, runtime, events } = setup();
    const server = await start();
    server.compactError = true;
    await runtime.prompt("s1", { promptId: "p1", text: "/compact" });
    await wait(10);
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      isError: true,
    });
  });

  it("settings and unknown commands are refused before anything is sent", async () => {
    const { start, runtime } = setup();
    const server = await start();
    const before = server.received.length;
    for (const text of ["/model gpt-5.5", "/permissions full access", "/review", "/config"]) {
      await expect(runtime.prompt("s1", { promptId: "p", text })).rejects.toMatchObject({
        code: "slash_command_refused",
      });
      await expect(runtime.steer("s1", { promptId: "p", text })).rejects.toMatchObject({
        code: "slash_command_refused",
      });
    }
    await wait(10);
    expect(server.received).toHaveLength(before);
  });
});

describe("CodexRuntime — unrestricted readback guard (D-03 groundwork)", () => {
  for (const over of [{ sandboxPolicy: { type: "dangerFullAccess" } }, { approvalPolicy: "never" }]) {
    it(`aborts the running turn when Codex reports ${JSON.stringify(over)}`, async () => {
      const { start, runtime, events } = setup();
      const server = await start("acceptEdits");
      await runtime.prompt("s1", { promptId: "p1", text: "go" });
      await wait(10);
      server.sendSettings(over);
      await wait(20);
      expect(server.received.some((m) => m.method === "turn/interrupt")).toBe(true);
      expect(events).toContainEqual({
        type: "session.error",
        message: "Codex reported an unrestricted sandbox/approval policy; turn aborted",
      });
      // The report itself still reaches the server, as fullAccess, so it can fail closed too.
      expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "fullAccess" });
    });
  }
});

describe("CodexRuntime — Full access through ADR-0012 only (D-01, D-03, P-11)", () => {
  const FULL = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };

  it("an authorized fullAccess start asks for danger-full-access + never and accepts that report", async () => {
    const { start, events } = setup({ allowFullAccess: () => true });
    const server = await start("fullAccess");
    expect(server.received[2]?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(events.some((e) => e.type === "session.error")).toBe(false);
    expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "fullAccess" });
  });

  it("refuses fullAccess when the device gate is closed, before spawning anything", async () => {
    const { runtime, cwd, servers } = setup({ allowFullAccess: () => false });
    expect(runtime.capabilities.supportsPermissionModes).not.toContain("fullAccess");
    await expect(
      runtime.start({ sessionId: "s1", cwd, permissionMode: "fullAccess" }, () => undefined),
    ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    expect(servers).toHaveLength(0);
  });

  it("a non-fullAccess start still fails closed on an unrestricted report, even with the gate open", async () => {
    const { cwd } = setup();
    const r = new CodexRuntime({
      allowFullAccess: () => true,
      spawnAppServer: ({ env }) => {
        const s = new FakeAppServer(env);
        s.sandboxType = "dangerFullAccess";
        return s;
      },
    });
    await expect(
      r.start({ sessionId: "s3", cwd, permissionMode: "acceptEdits" }, () => undefined),
    ).rejects.toMatchObject({ code: "permission_mode_rejected" });
  });

  it("each fullAccess turn sends never + dangerFullAccess; a capped turn sends its own policy", async () => {
    const { start, runtime } = setup({ allowFullAccess: () => true });
    const server = await start("acceptEdits");
    await runtime.configure("s1", { permissionMode: "fullAccess" });
    await runtime.prompt("s1", { promptId: "p1", text: "full", permissionMode: "fullAccess" });
    await wait(10);
    expect(turnStarts(server)[0]?.params).toMatchObject(FULL);
    server.completeTurn();
    await wait(10);
    await runtime.prompt("s1", { promptId: "p2", text: "capped", permissionMode: "acceptEdits" });
    await wait(10);
    expect(turnStarts(server)[1]?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  it("an unrestricted readback during an authorized fullAccess turn is not aborted", async () => {
    const { start, runtime, events } = setup({ allowFullAccess: () => true });
    const server = await start("fullAccess");
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await wait(10);
    server.sendSettings(FULL);
    await wait(20);
    expect(server.received.some((m) => m.method === "turn/interrupt")).toBe(false);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("the same readback during a capped (non-fullAccess) turn of a fullAccess session aborts the turn", async () => {
    const { start, runtime, events } = setup({ allowFullAccess: () => true });
    const server = await start("fullAccess");
    await runtime.prompt("s1", { promptId: "p1", text: "go", permissionMode: "acceptEdits" });
    await wait(10);
    server.sendSettings(FULL);
    await wait(20);
    expect(server.received.some((m) => m.method === "turn/interrupt")).toBe(true);
    expect(events.some((e) => e.type === "session.error")).toBe(true);
  });

  it("a fullAccess turn after the gate closed fails without a turn/start", async () => {
    let allowed = true;
    const { start, runtime, events } = setup({ allowFullAccess: () => allowed });
    const server = await start("fullAccess");
    allowed = false;
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await wait(10);
    expect(turnStarts(server)).toHaveLength(0);
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      isError: true,
    });
  });
});

describe("CodexRuntime — retire idle and resume (07.11 D-03a)", () => {
  const sessionEnds = (events: SessionEvent[]) =>
    events.filter(
      (e) =>
        e.type === "session.error" ||
        (e.type === "session.state" && (e.status === "completed" || e.status === "failed")),
    );

  it("stops an idle session's app-server without finishing it and never touches one with a turn running", async () => {
    const { start, runtime, events, servers, cwd } = setup();
    const a = await start();
    const bEvents: SessionEvent[] = [];
    await runtime.start({ sessionId: "s2", cwd, permissionMode: "default" }, (e) => bEvents.push(e));
    const b = servers[1] as FakeAppServer;
    await runtime.prompt("s2", { promptId: "b1", text: "work" });
    await wait();

    expect(runtime.activeTurns()).toBe(1);
    const before = { a: events.length, b: bEvents.length };
    await expect(runtime.retireIdle()).resolves.toBe(1);
    expect(a.stdin.writableEnded).toBe(true);
    expect(a.killed).toEqual(["SIGTERM"]);
    expect(b.killed).toEqual([]);
    expect(b.stdin.writableEnded).toBe(false);
    await wait();
    expect(events.slice(before.a)).toEqual([]);
    expect(bEvents.slice(before.b)).toEqual([]);
    await expect(runtime.retireIdle()).resolves.toBe(0);

    b.completeTurn();
    await wait();
    expect(runtime.activeTurns()).toBe(0);
    expect(sessionEnds(bEvents)).toEqual([]);
    await runtime.stopAll();
  });

  it("counts a session with prompts queued once and never retires it", async () => {
    const { start, runtime } = setup();
    const server = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await wait();
    expect(runtime.activeTurns()).toBe(1);
    await expect(runtime.retireIdle()).resolves.toBe(0);
    expect(server.killed).toEqual([]);
    server.completeTurn();
    await wait();
    expect(runtime.activeTurns()).toBe(1);
    server.completeTurn();
    await wait();
    expect(runtime.activeTurns()).toBe(0);
  });

  it("the next prompt spawns a new app-server, resumes the thread with the start params, then starts the turn", async () => {
    const { start, runtime, events, servers } = setup();
    const first = await start("acceptEdits");
    const startParams = first.received.find((m) => m.method === "thread/start")?.params;
    await expect(runtime.retireIdle()).resolves.toBe(1);
    // A change made while dormant is held and rides on the wake-up turn/start (D-14), with no extra process.
    await runtime.configure("s1", { effort: "high" });
    expect(servers).toHaveLength(1);

    await runtime.prompt("s1", { promptId: "p1", text: "after the update" });
    await wait();
    expect(servers).toHaveLength(2);
    const woken = servers[1] as FakeAppServer;
    expect(woken.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
    expect(woken.received[2]?.params).toEqual({ ...startParams, threadId: "thread-1" });
    expect(woken.received[3]?.params).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      approvalPolicy: "on-request",
    });
    expect(first.received.filter((m) => m.method === "turn/start")).toEqual([]);
    expect(runtime.activeTurns()).toBe(1);

    woken.completeTurn();
    await wait();
    expect(runtime.activeTurns()).toBe(0);
    const completed = events.filter((e) => e.type === "prompt.completed");
    expect(completed).toEqual([expect.objectContaining({ promptId: "p1" })]);
    expect(completed[0]).not.toHaveProperty("isError");
    expect(sessionEnds(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });

    // The woken process is the session's process now: stop() ends it.
    await runtime.stop("s1");
    expect(woken.killed).toContain("SIGTERM");
    expect(sessionEnds(events)).toEqual([{ type: "session.state", status: "completed" }]);
  });

  it("a woken app-server that fails to resume leaves the session dormant and fails only that turn", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-rt-")));
    const servers: FakeAppServer[] = [];
    const next: Array<(env: Record<string, string | undefined>) => FakeAppServer> = [];
    const runtime = new CodexRuntime({
      codexPath: "/usr/local/bin/codex",
      spawnAppServer: ({ env }) => {
        const s = (next.shift() ?? ((e) => new FakeAppServer(e)))(env);
        servers.push(s);
        return s;
      },
    });
    const events: SessionEvent[] = [];
    await runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, (e) => events.push(e));
    await runtime.retireIdle();
    class NoThread extends FakeAppServer {
      protected override handleExtra(m: Msg): boolean {
        if (m.method !== "thread/resume") return false;
        this.send({ id: m.id, error: { code: -32000, message: "thread not found" } });
        return true;
      }
    }
    next.push((env) => new NoThread(env));
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await wait(20);
    const failing = servers[1] as FakeAppServer;
    expect(failing).toBeInstanceOf(NoThread);
    expect(failing.killed).toContain("SIGTERM");
    expect(failing.received.map((m) => m.method)).not.toContain("turn/start");
    expect(events.filter((e) => e.type === "prompt.completed")).toEqual([
      expect.objectContaining({ promptId: "p1", isError: true }),
    ]);
    expect(events.some((e) => e.type === "session.state" && e.status === "failed")).toBe(false);
    expect(runtime.activeTurns()).toBe(0);
    // The next prompt tries again on a fresh process.
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await wait();
    expect(servers).toHaveLength(3);
    expect(servers[2]?.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
    await runtime.stopAll();
  });

  it("stop() on a dormant session finishes cleanly with no process to kill", async () => {
    const { start, runtime, events, servers } = setup();
    const server = await start();
    await runtime.retireIdle();
    const before = events.length;
    await runtime.stop("s1");
    expect(events.slice(before)).toEqual([{ type: "session.state", status: "completed" }]);
    expect(server.killed).toEqual(["SIGTERM"]);
    expect(servers).toHaveLength(1);
    expect(runtime.activeTurns()).toBe(0);
  });

  it("every app-server it launches runs with the startup update check off (D-12, PD-14)", () => {
    expect(CODEX_APP_SERVER_ARGS).toEqual(["app-server", "-c", "check_for_update_on_startup=false"]);
  });

  it("the real spawn passes the update-check flag and refreshInstall() finds a newly installed CLI", async () => {
    const savedPath = process.env.PATH;
    const log = join(realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-log-"))), "args.log");
    const dirA = mkdtempSync(join(tmpdir(), "ocw-codex-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "ocw-codex-b-"));
    // A stand-in `codex` that records which copy ran and its arguments, then exits (start then fails).
    for (const [dir, tag] of [
      [dirA, "A"],
      [dirB, "B"],
    ] as const) {
      writeFileSync(
        join(dir, "codex"),
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tag)} + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
        { mode: 0o755 },
      );
    }
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-rt-")));
    try {
      process.env.PATH = dirA;
      const runtime = new CodexRuntime();
      await expect(
        runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, () => undefined),
      ).rejects.toBeInstanceOf(RuntimeError);
      process.env.PATH = dirB;
      runtime.refreshInstall();
      await expect(
        runtime.start({ sessionId: "s2", cwd, permissionMode: "default" }, () => undefined),
      ).rejects.toBeInstanceOf(RuntimeError);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "A app-server -c check_for_update_on_startup=false",
        "B app-server -c check_for_update_on_startup=false",
      ]);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("refreshInstall() drops the catalog cache", async () => {
    const servers: CatalogAppServer[] = [];
    const runtime = new CodexRuntime({
      codexPath: "/usr/local/bin/codex",
      detect: async () => ({ id: "codex", installed: true, version: "0.160.0", loggedIn: true }),
      spawnAppServer: ({ env }) => {
        const s = new CatalogAppServer(env);
        servers.push(s);
        return s;
      },
    });
    await runtime.catalog();
    await runtime.catalog();
    expect(servers).toHaveLength(1);
    runtime.refreshInstall();
    await runtime.catalog();
    expect(servers).toHaveLength(2);
  });
});
