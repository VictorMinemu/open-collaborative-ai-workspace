import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, RuntimeInfo, SessionEvent } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import { RuntimeError, type StartSessionOptions } from "../runtime.js";
import { ClaudeCodeRuntime, childEnv, type QueryHandle } from "./claude-runtime.js";
import { commandTouchesSecrets, isSecretPath, secretDenyReason } from "./tool-policy.js";

/** Every control request a fake query received, in order, across the whole suite (T-03.2-02-01 assertion). */
const ALL_FLAG_SETTINGS: unknown[] = [];

class FakeQuery implements QueryHandle {
  readonly out = new AsyncQueue<SDKMessage>();
  readonly prompts: SDKUserMessage[] = [];
  /** Control requests and pushed prompts, in the order the runtime saw them. */
  readonly log: string[] = [];
  readonly calls: Array<{ method: string; arg: unknown }> = [];
  /** Next call of `method` rejects with this message. */
  readonly failNext = new Map<string, string>();
  /** Reported by `initializationResult()`. */
  models: ModelInfo[] = [];
  /** Model → maxTokens for `getContextUsage()`; a missing model rejects (the runtime refusing it). */
  windows: Record<string, number> = {};
  private model: string | undefined;
  interrupts = 0;
  closed = false;
  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    void (async () => {
      for await (const m of params.prompt) {
        this.prompts.push(m);
        this.log.push(`prompt:${String(m.message.content)}`);
      }
      this.out.close();
    })();
  }
  emit(m: Record<string, unknown>): void {
    this.out.push(m as unknown as SDKMessage);
  }
  interrupt(): Promise<unknown> {
    this.interrupts++;
    return Promise.resolve(undefined);
  }
  close(): void {
    this.closed = true;
    this.out.close();
  }
  private record(method: string, arg: unknown): Promise<void> {
    this.calls.push({ method, arg });
    this.log.push(`${method}:${JSON.stringify(arg) ?? "undefined"}`);
    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      return Promise.reject(new Error(failure));
    }
    return Promise.resolve();
  }
  setModel(model?: string): Promise<void> {
    this.model = model;
    return this.record("setModel", model);
  }
  setPermissionMode(mode: string): Promise<void> {
    return this.record("setPermissionMode", mode);
  }
  applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    ALL_FLAG_SETTINGS.push(settings);
    return this.record("applyFlagSettings", settings);
  }
  initializationResult(): Promise<{ models: ModelInfo[] }> {
    this.calls.push({ method: "initializationResult", arg: undefined });
    return Promise.resolve({ models: this.models });
  }
  getContextUsage(): Promise<{ maxTokens: number; model: string }> {
    this.calls.push({ method: "getContextUsage", arg: this.model });
    const max = this.model === undefined ? undefined : this.windows[this.model];
    if (max === undefined) return Promise.reject(new Error(`model not available: ${this.model}`));
    return Promise.resolve({ maxTokens: max, model: this.model ?? "" });
  }
  methodCalls(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.arg);
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await tick();
};

function setup(
  extra: {
    approvalTimeoutMs?: number;
    useApiKey?: boolean;
    claudePath?: string;
    prepare?: (q: FakeQuery) => void;
    detect?: () => Promise<RuntimeInfo>;
  } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-claude-rt-")));
  const queries: FakeQuery[] = [];
  const events: SessionEvent[] = [];
  const runtime = new ClaudeCodeRuntime({
    queryFn: (params) => {
      const q = new FakeQuery(params);
      extra.prepare?.(q);
      queries.push(q);
      return q;
    },
    claudePath: extra.claudePath ?? "/usr/local/bin/claude",
    detect:
      extra.detect ??
      (() => Promise.resolve({ id: "claude-code", installed: true, version: "2.1.289", loggedIn: true })),
    ...(extra.approvalTimeoutMs ? { approvalTimeoutMs: extra.approvalTimeoutMs } : {}),
    ...(extra.useApiKey !== undefined ? { useApiKey: extra.useApiKey } : {}),
  });
  let session: FakeQuery | null = null;
  const start = async (
    permissionMode: PermissionMode = "default",
    more: Partial<Omit<StartSessionOptions, "sessionId" | "cwd" | "permissionMode">> = {},
  ) => {
    await runtime.start({ sessionId: "s1", cwd, permissionMode, ...more }, (e) => events.push(e));
    session = queries.at(-1) ?? null;
    if (!session) throw new Error("query not created");
    return session as FakeQuery;
  };
  return { cwd, runtime, events, start, queries };
}

const signal = () => new AbortController().signal;
const result = (cost = 0.01) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: cost,
  usage: { input_tokens: 1, output_tokens: 2 },
});

describe("ClaudeCodeRuntime — SDK options (security + billing)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.OCW_DEVICE_TOKEN = "device-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "also-not";
    process.env.CLAUDECODE = "1";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("starts streaming-input mode with locked-down options and the installed CLI", async () => {
    const { start, cwd } = setup();
    const q = await start("acceptEdits");
    const o = q.params.options;
    expect(o.cwd).toBe(cwd);
    expect(o.permissionMode).toBe("acceptEdits");
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    expect(o.includePartialMessages).toBe(true);
    expect(o.settingSources).toEqual(["project"]);
    expect(o.disallowedTools).toContain("AskUserQuestion");
    expect(o.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    const perms = (o.settings as { permissions: { deny: string[]; disableBypassPermissionsMode: string } })
      .permissions;
    expect(perms.disableBypassPermissionsMode).toBe("disable");
    expect(perms.deny).toEqual(
      expect.arrayContaining(["Read(**/.env)", "Read(~/.ssh/**)", "Read(**/*.pem)"]),
    );
    expect(typeof o.canUseTool).toBe("function");
  });

  it("strips the device token, API keys and parent-session vars from the child env", async () => {
    const { start } = setup();
    const env = (await start()).params.options.env ?? {};
    expect(env.OCW_DEVICE_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("keeps the API key only when useApiKey is explicitly enabled", () => {
    expect(childEnv(process.env, true).ANTHROPIC_API_KEY).toBe("sk-ant-should-not-leak");
    expect(childEnv(process.env, true).OCW_DEVICE_TOKEN).toBeUndefined();
  });

  it("rejects bypassPermissions and other non-allowed modes", async () => {
    const { runtime, cwd } = setup();
    // `auto` and `fullAccess` are platform modes now, but outside this adapter's capabilities until Plans 02/06.
    for (const mode of ["bypassPermissions", "dontAsk", "auto", "fullAccess"]) {
      await expect(
        runtime.start(
          { sessionId: `s-${mode}`, cwd, permissionMode: mode as PermissionMode },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    }
  });

  it("aborts the session if the CLI reports bypassPermissions anyway", async () => {
    const { start, events } = setup();
    const q = await start();
    q.emit({ type: "system", subtype: "init", permissionMode: "bypassPermissions", session_id: "x" });
    await tick();
    await tick();
    expect(q.closed).toBe(true);
    expect(events.some((e) => e.type === "session.error")).toBe(true);
  });
});

describe("ClaudeCodeRuntime — approvals via canUseTool", () => {
  it("emits approval.requested and allows once", async () => {
    const { start, runtime, events, cwd } = setup();
    const q = await start();
    const pending = q.params.options.canUseTool?.("Edit", { file_path: `${cwd}/src/a.ts` }, {
      signal: signal(),
      toolUseID: "t1",
    } as never);
    await tick();
    const req = events.find((e) => e.type === "approval.requested") as Extract<
      SessionEvent,
      { type: "approval.requested" }
    >;
    expect(req).toMatchObject({ tool: "Edit", paths: [`${cwd}/src/a.ts`] });
    expect(events.at(-1)).toEqual({ type: "session.state", status: "waiting_approval" });
    expect(runtime.resolveApproval("s1", req.approvalId, "once")).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(events).toContainEqual({
      type: "approval.resolved",
      approvalId: req.approvalId,
      decision: "once",
    });
    expect(runtime.resolveApproval("s1", req.approvalId, "once")).toBe(false);
  });

  it("caches a 'session' decision for that tool", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    const first = q.params.options.canUseTool?.("Bash", { command: "pnpm test" }, {
      signal: signal(),
    } as never);
    await tick();
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string };
    runtime.resolveApproval("s1", req.approvalId, "session");
    await expect(first).resolves.toMatchObject({ behavior: "allow" });
    const before = events.length;
    await expect(
      q.params.options.canUseTool?.("Bash", { command: "pnpm lint" }, { signal: signal() } as never),
    ).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(events.slice(before).some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("denies with the reviewer comment", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    const p = q.params.options.canUseTool?.("Write", { file_path: "x.ts" }, { signal: signal() } as never);
    await tick();
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string };
    runtime.resolveApproval("s1", req.approvalId, "deny", "not now");
    await expect(p).resolves.toEqual({ behavior: "deny", message: "Denied by the workspace user: not now" });
  });

  it("expires to deny after the timeout", async () => {
    const { start, events } = setup({ approvalTimeoutMs: 20 });
    const q = await start();
    const res = await q.params.options.canUseTool?.("Write", { file_path: "x.ts" }, {
      signal: signal(),
    } as never);
    expect(res).toMatchObject({ behavior: "deny" });
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({ decision: "expired" });
  });

  it("denies secret paths without asking, in canUseTool and in the PreToolUse hook", async () => {
    const { start, events, cwd } = setup();
    const q = await start();
    const res = await q.params.options.canUseTool?.("Read", { file_path: `${cwd}/.env.local` }, {
      signal: signal(),
    } as never);
    expect(res).toMatchObject({ behavior: "deny" });
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);

    const hook = q.params.options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const hookInput = (tool_name: string, tool_input: unknown) =>
      ({
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input,
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "",
        cwd,
      }) as never;
    await expect(
      hook(hookInput("Bash", { command: "cat .env" }), "t", { signal: signal() }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      hook(hookInput("Read", { file_path: `${cwd}/src/a.ts` }), "t", { signal: signal() }),
    ).resolves.toEqual({});
  });
});

describe("ClaudeCodeRuntime — prompts, interrupt, stop", () => {
  it("runs prompts one at a time in order", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await tick();
    expect(q.prompts.map((p) => p.message.content)).toEqual(["one"]);
    q.emit(result(0.01));
    await tick();
    await tick();
    expect(q.prompts.map((p) => p.message.content)).toEqual(["one", "two"]);
    q.emit(result(0.03));
    await tick();
    await tick();
    const completed = events.filter((e) => e.type === "prompt.completed") as Array<{
      promptId: string;
      costUsd: number;
    }>;
    expect(completed.map((c) => [c.promptId, c.costUsd])).toEqual([
      ["p1", 0.01],
      ["p2", 0.02],
    ]);
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });
  });

  it("interrupt() calls the SDK, denies pending approvals and flags the prompt", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "long task" });
    const pending = q.params.options.canUseTool?.("Bash", { command: "sleep 100" }, {
      signal: signal(),
    } as never);
    await tick();
    await runtime.interrupt("s1");
    expect(q.interrupts).toBe(1);
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    q.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["interrupted"],
      total_cost_usd: 0,
      usage: {},
    });
    await tick();
    await tick();
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      interrupted: true,
    });
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("stop() closes the input stream and reports completed", async () => {
    const { start, runtime, events } = setup();
    await start();
    await runtime.stop("s1");
    expect(events.at(-1)).toEqual({ type: "session.state", status: "completed" });
    await expect(runtime.prompt("s1", { promptId: "x", text: "y" })).rejects.toBeInstanceOf(RuntimeError);
  });
});

const settingsEvents = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { type: "session.settings" }> => e.type === "session.settings");

describe("ClaudeCodeRuntime — settings between turns (D-07, D-14)", () => {
  it("applies a model change at once while idle and reports it", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.configure("s1", { model: "sonnet" });
    expect(q.methodCalls("setModel")).toEqual(["sonnet"]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ model: "sonnet", permissionMode: "default" });
  });

  it("holds a change made during a turn and applies it before the next prompt is pushed", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.configure("s1", { model: "sonnet" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(q.methodCalls("setModel")).toEqual([]);
    q.emit(result());
    await settle();
    expect(q.log).toEqual(["prompt:one", 'setModel:"sonnet"', "prompt:two"]);
  });

  it("merges several changes made during one turn into one application (last value wins)", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.configure("s1", { model: "sonnet" });
    await runtime.configure("s1", { model: "opus" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    q.emit(result());
    await settle();
    expect(q.methodCalls("setModel")).toEqual(["opus"]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ model: "opus" });
  });

  it("a failing setModel reports the error, rejects with settings_rejected and leaves the next prompt alone", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    q.failNext.set("setModel", "model not available for your account");
    await expect(runtime.configure("s1", { model: "nope" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    expect(events.some((e) => e.type === "session.error")).toBe(true);
    expect(settingsEvents(events)).toEqual([]);
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    expect(q.log).toEqual(['setModel:"nope"', "prompt:one"]);
  });

  it("a held change that fails at dispatch is dropped and the turn still runs", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.configure("s1", { model: "nope" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    q.failNext.set("setModel", "model not available");
    q.emit(result());
    await settle();
    expect(q.log).toEqual(["prompt:one", 'setModel:"nope"', "prompt:two"]);
    expect(events.filter((e) => e.type === "session.error")).toHaveLength(1);
    q.emit(result());
    await runtime.prompt("s1", { promptId: "p3", text: "three" });
    await settle();
    expect(q.methodCalls("setModel")).toEqual(["nope"]);
  });

  it("refuses a permission mode outside its capabilities", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await expect(runtime.configure("s1", { permissionMode: "fullAccess" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    expect(q.calls).toEqual([]);
  });
});

describe("tool policy", () => {
  const cwd = "/Users/alice/code/acme";
  const home = "/Users/alice";
  it.each([
    [".env", true],
    [".env.local", true],
    ["config/.env.production", true],
    [".env.example", false],
    ["certs/server.pem", true],
    ["/Users/alice/.ssh/id_ed25519", true],
    ["~/.aws/credentials", true],
    ["/Users/alice/Library/Keychains/login.keychain-db", true],
    ["/Users/alice/.ocw/device-token", true],
    ["src/env.ts", false],
  ])("isSecretPath(%s) = %s", (p, expected) => {
    expect(isSecretPath(p, cwd, home)).toBe(expected);
  });

  it.each([
    ["cat .env", true],
    ["grep KEY .env.local", true],
    ["cp .env.example .env", true],
    ["cat .env.example", false],
    ["ls ~/.ssh/", true],
    ["security find-generic-password -s x", true],
    ["printenv", true],
    ["pnpm test", false],
    ["node scripts/env-check.js", false],
  ])("commandTouchesSecrets(%s) = %s", (cmd, expected) => {
    expect(commandTouchesSecrets(cmd)).toBe(expected);
  });

  it("blocks Glob/Grep searches for .env files", () => {
    expect(secretDenyReason("Glob", { pattern: "**/.env*" }, cwd, home)).not.toBeNull();
    expect(secretDenyReason("Grep", { pattern: "TODO" }, cwd, home)).toBeNull();
  });
});
