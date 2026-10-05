import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
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
  /** Forces the sandbox the fake reports on thread/start (null = what the client asked for). */
  sandboxType: string | null = null;
  /** When the fake sends `thread/settings/updated` for turn/start overrides (A5 is what the fixture shows). */
  settingsUpdates: "none" | "before" | "after" = "none";
  /** Thread settings as the fake currently holds them (thread/start + sticky turn/start overrides). */
  threadSettings: Record<string, unknown> = {};
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

function loadFixture(name: string): RpcLine[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RpcLine);
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
