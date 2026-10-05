import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { PermissionMode, SessionEvent } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeError } from "../runtime.js";
import { type AppServerProcess, CodexRuntime, codexChildEnv } from "./codex-runtime.js";
import { parseCodexLogin } from "./detect.js";

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
  sandboxType = "workspaceWrite";
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

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.stdout.end();
    setImmediate(() => this.emit("exit", 0));
  }

  private handle(m: Msg): unknown {
    this.received.push(m);
    if (m.id !== undefined && !m.method) {
      this.waiters.get(Number(m.id))?.(m);
      return;
    }
    switch (m.method) {
      case "initialize":
        return this.send({
          id: m.id,
          result: { userAgent: "fake", codexHome: "/x", platformFamily: "unix", platformOs: "macos" },
        });
      case "thread/start":
      case "thread/resume":
        return this.send({
          id: m.id,
          result: {
            thread: { id: "thread-1" },
            model: "gpt-test",
            approvalPolicy: m.params?.approvalPolicy,
            sandbox: { type: this.sandboxType },
          },
        });
      case "turn/start":
        this.send({
          id: m.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } },
        });
        this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
        return this.onTurnStart(m.params ?? {});
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

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function setup() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-codex-rt-")));
  const servers: FakeAppServer[] = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({
    codexPath: "/usr/local/bin/codex",
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
  it("initializes and starts a workspace-write, on-request thread", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.OCW_DEVICE_TOKEN = "device-secret";
    const { start, events, cwd } = setup();
    const server = await start();
    expect(server.received.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(server.received[2]?.params).toMatchObject({
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
      { type: "session.state", status: "idle" },
    ]);
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

  it("refuses platform modes outside its capabilities (auto, fullAccess) before spawning anything", async () => {
    const { runtime, cwd } = setup();
    for (const mode of ["auto", "fullAccess"] as const) {
      await expect(
        runtime.start({ sessionId: `s5-${mode}`, cwd, permissionMode: mode }, () => undefined),
      ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    }
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
