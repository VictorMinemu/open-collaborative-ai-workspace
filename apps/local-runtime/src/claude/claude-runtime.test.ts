import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { PermissionMode, RuntimeInfo, SessionEvent } from "@ocw/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import { RuntimeError, type StartSessionOptions } from "../runtime.js";
import { ClaudeCodeRuntime, childEnv, type QueryHandle } from "./claude-runtime.js";
import { commandTouchesSecrets, isSecretPath, secretDenyReason, secretDenyRules } from "./tool-policy.js";

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
    allowFullAccess?: () => boolean;
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
    catalogCwd: cwd,
    detect:
      extra.detect ??
      (() => Promise.resolve({ id: "claude-code", installed: true, version: "2.1.289", loggedIn: true })),
    ...(extra.approvalTimeoutMs ? { approvalTimeoutMs: extra.approvalTimeoutMs } : {}),
    ...(extra.useApiKey !== undefined ? { useApiKey: extra.useApiKey } : {}),
    ...(extra.allowFullAccess ? { allowFullAccess: extra.allowFullAccess } : {}),
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
    // `fullAccess` is a platform mode, outside this adapter's capabilities while the device gate is closed.
    for (const mode of ["bypassPermissions", "dontAsk", "fullAccess"]) {
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
  events.filter(
    (e): e is Extract<SessionEvent, { type: "session.settings" }> => e.type === "session.settings",
  );

describe("ClaudeCodeRuntime — prompt images at Agent SDK 0.3.282 (06.1-03, D-05)", () => {
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

  it("says it can take images", () => {
    expect(setup().runtime.capabilities.supportsImages).toBe(true);
  });

  it("pushes one SDKUserMessage with base64 image blocks before the text, in order, with no filename", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", {
      promptId: "p1",
      text: "what changed in these screenshots?",
      images: [
        { mediaType: "image/png", dataBase64: PNG },
        { mediaType: "image/webp", dataBase64: WEBP },
      ],
    });
    await tick();
    // Typed against the installed SDK: a shape change in SDKUserMessage / ImageBlockParam fails typecheck here.
    const png = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG },
    } satisfies ImageBlockParam;
    const webp = {
      type: "image",
      source: { type: "base64", media_type: "image/webp", data: WEBP },
    } satisfies ImageBlockParam;
    const text = { type: "text", text: "what changed in these screenshots?" } satisfies TextBlockParam;
    const expected: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [png, webp, text] },
      parent_tool_use_id: null,
    };
    expect(q.prompts).toHaveLength(1);
    expect(q.prompts[0]).toStrictEqual(expected);
    expect(JSON.stringify(q.prompts[0])).not.toMatch(/name|path|"url"|file/i);
  });

  it("a prompt without images still pushes plain string content", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "just text" });
    await runtime.prompt("s1", { promptId: "p2", text: "empty list", images: [] });
    await tick();
    expect(q.prompts[0]).toStrictEqual({
      type: "user",
      message: { role: "user", content: "just text" },
      parent_tool_use_id: null,
    });
    q.emit(result());
    await settle();
    expect(q.prompts[1]?.message.content).toBe("empty list");
  });
});

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

const PROBE_MODELS: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "Opus 5.5" },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Older", supportsEffort: true },
  { value: "haiku", displayName: "Haiku", description: "Fast" },
];

const prepareProbe = (q: FakeQuery) => {
  q.models = PROBE_MODELS;
  q.windows = {
    opus: 1_000_000,
    "opus[1m]": 1_000_000,
    "claude-opus-4-6": 200_000,
    "claude-opus-4-6[1m]": 1_000_000,
    haiku: 200_000,
  };
};

describe("ClaudeCodeRuntime — catalog() (no turn, D-08 … D-11)", () => {
  it("opens one throw-away query, reads the models, probes the windows, closes it and sends no prompt", async () => {
    const { runtime, queries } = setup({ prepare: prepareProbe });
    const catalog = await runtime.catalog();
    expect(queries).toHaveLength(1);
    const q = queries[0] as FakeQuery;
    await settle();
    expect(q.prompts).toEqual([]);
    expect(q.closed).toBe(true);
    expect(q.methodCalls("initializationResult")).toHaveLength(1);
    expect(q.methodCalls("setModel")).toEqual([
      "opus",
      "opus[1m]",
      "claude-opus-4-6",
      "claude-opus-4-6[1m]",
      "haiku",
      "haiku[1m]",
    ]);
    expect(q.methodCalls("getContextUsage")).toHaveLength(6);
    // Same locked-down options as a session.
    const o = q.params.options;
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    // Not plan: plan mode runs Haiku as Sonnet and the probe would read the wrong window (2.1.289).
    expect(o.permissionMode).toBe("default");
    await expect(
      o.canUseTool?.("Read", { file_path: "a" }, { signal: signal() } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(o.settingSources).toEqual(["project"]);
    const perms = (o.settings as { permissions: { deny: string[]; disableBypassPermissionsMode: string } })
      .permissions;
    expect(perms.disableBypassPermissionsMode).toBe("disable");
    expect(perms.deny).toEqual(expect.arrayContaining(["Read(**/.env)"]));
    expect(o.env?.OCW_DEVICE_TOKEN).toBeUndefined();

    expect(catalog?.runtimeVersion).toBe("2.1.289");
    expect(catalog?.permissionModes).toEqual(runtime.capabilities.supportsPermissionModes);
    const byId = new Map(catalog?.models.map((m) => [m.id, m]));
    expect(byId.get("opus")).toMatchObject({
      isDefault: true,
      contextWindows: [],
      defaultContextWindow: 1_000_000,
    });
    expect(byId.get("claude-opus-4-6")).toMatchObject({
      legacy: true,
      contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000,
    });
    expect(byId.get("haiku")).toMatchObject({ contextWindows: [], defaultContextWindow: 200_000 });
    // 06.1 (P-08): the SDK's ModelInfo has no modality field, so image input stays unknown (allowed).
    for (const m of catalog?.models ?? []) expect(m).not.toHaveProperty("imageInput");
  });

  it("a failing probe yields a catalog without context windows instead of failing", async () => {
    const { runtime } = setup({
      prepare: (q) => {
        q.models = PROBE_MODELS;
        q.windows = {};
      },
    });
    const catalog = await runtime.catalog();
    expect(catalog?.models.length).toBe(3);
    for (const m of catalog?.models ?? []) {
      expect(m.contextWindows).toEqual([]);
      expect(m.defaultContextWindow).toBeNull();
    }
  });

  it("is cached, and null when the CLI is missing or signed out", async () => {
    const { runtime, queries } = setup({ prepare: prepareProbe });
    await runtime.catalog();
    await runtime.catalog();
    expect(queries).toHaveLength(1);
    const signedOut = setup({
      detect: () =>
        Promise.resolve({ id: "claude-code", installed: true, version: "2.1.289", loggedIn: false }),
    });
    await expect(signedOut.runtime.catalog()).resolves.toBeNull();
    expect(signedOut.queries).toHaveLength(0);
  });
});

describe("ClaudeCodeRuntime — effort, fast mode, context window, modes (D-09 … D-12)", () => {
  it("effort and fast mode go through applyFlagSettings with only the changed scalar keys", async () => {
    const { start, runtime, events } = setup();
    const q = await start();
    await runtime.configure("s1", { effort: "high" });
    await runtime.configure("s1", { effort: null });
    await runtime.configure("s1", { fastMode: true });
    expect(q.methodCalls("applyFlagSettings")).toEqual([
      { effortLevel: "high" },
      { effortLevel: null },
      { fastMode: true },
    ]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ effort: null, fastMode: true });
  });

  it("start-time effort / fast mode are applied before the first turn", async () => {
    const { start, runtime } = setup();
    const q = await start("default", { effort: "low", fastMode: true });
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    expect(q.log).toEqual(['applyFlagSettings:{"effortLevel":"low","fastMode":true}', "prompt:one"]);
    // fastMode false at start is the default: no control request.
    const other = setup();
    const q2 = await other.start("default", { fastMode: false });
    await other.runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    expect(q2.log).toEqual(["prompt:one"]);
  });

  it("the context window re-selects the model with or without [1m] where the catalog offers both", async () => {
    const { start, runtime, events } = setup({ prepare: prepareProbe });
    const q = await start("default", { model: "claude-opus-4-6" });
    await runtime.configure("s1", { contextWindow: 1_000_000 });
    expect(settingsEvents(events).at(-1)).toMatchObject({
      model: "claude-opus-4-6",
      contextWindow: 1_000_000,
    });
    await runtime.configure("s1", { contextWindow: 200_000 });
    expect(q.methodCalls("setModel")).toEqual(["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ contextWindow: 200_000 });
    // A model change reports the new model's base window from the catalog.
    await runtime.configure("s1", { model: "opus" });
    expect(settingsEvents(events).at(-1)).toMatchObject({ model: "opus", contextWindow: 1_000_000 });
  });

  it("refuses a context window the model does not offer", async () => {
    const { start, runtime } = setup({ prepare: prepareProbe });
    const q = await start("default", { model: "opus" });
    await expect(runtime.configure("s1", { contextWindow: 200_000 })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    expect(q.methodCalls("setModel")).toEqual([]);
  });

  it("permission modes plan / default / acceptEdits / auto go through setPermissionMode", async () => {
    const { start, runtime, events } = setup();
    const q = await start("plan");
    await runtime.configure("s1", { permissionMode: "auto" });
    await runtime.configure("s1", { permissionMode: "plan" });
    await runtime.configure("s1", { permissionMode: "acceptEdits" });
    expect(q.methodCalls("setPermissionMode")).toEqual(["auto", "plan", "acceptEdits"]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "acceptEdits" });
    expect(runtime.capabilities.supportsPermissionModes).toEqual(["default", "acceptEdits", "plan", "auto"]);
  });

  it("starts in auto mode (confirmed by the 2.1.289 settings fixture)", async () => {
    const { start } = setup();
    const q = await start("auto");
    expect(q.params.options.permissionMode).toBe("auto");
  });
});

describe("ClaudeCodeRuntime — per-turn mode cap (P-07)", () => {
  it("lowers the mode before a capped turn and restores it before the next uncapped one", async () => {
    const { start, runtime } = setup();
    const q = await start("acceptEdits");
    await runtime.prompt("s1", { promptId: "p1", text: "capped", permissionMode: "default" });
    await runtime.prompt("s1", { promptId: "p2", text: "free" });
    await settle();
    q.emit(result());
    await settle();
    expect(q.log).toEqual([
      'setPermissionMode:"default"',
      "prompt:capped",
      'setPermissionMode:"acceptEdits"',
      "prompt:free",
    ]);
  });

  it("a cap above the configured mode changes nothing", async () => {
    const { start, runtime } = setup();
    const q = await start("plan");
    await runtime.prompt("s1", { promptId: "p1", text: "one", permissionMode: "acceptEdits" });
    await settle();
    expect(q.log).toEqual(["prompt:one"]);
  });

  it("fails the turn without pushing it when the mode cannot be lowered", async () => {
    const { start, runtime, events } = setup();
    const q = await start("acceptEdits");
    q.failNext.set("setPermissionMode", "control request failed");
    await runtime.prompt("s1", { promptId: "p1", text: "capped", permissionMode: "plan" });
    await runtime.prompt("s1", { promptId: "p2", text: "next" });
    await settle();
    expect(q.prompts.map((p) => p.message.content)).toEqual(["next"]);
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      isError: true,
    });
    expect(events.some((e) => e.type === "session.error")).toBe(true);
  });
});

type Perms = { deny?: string[]; disableBypassPermissionsMode?: string };
const perms = (q: FakeQuery) => (q.params.options.settings as { permissions: Perms }).permissions;
const init = (permissionMode: string, session_id = "rt-1") => ({
  type: "system",
  subtype: "init",
  permissionMode,
  session_id,
  model: "claude-opus-5-5",
});

describe("ClaudeCodeRuntime — Full access through ADR-0012 only (D-01, D-03, D-04, P-11)", () => {
  it("an authorized fullAccess start runs bypassPermissions with the secret deny rules and hooks kept", async () => {
    const { start } = setup({ allowFullAccess: () => true });
    const q = await start("fullAccess");
    const o = q.params.options;
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(perms(q).deny).toEqual(secretDenyRules());
    expect(perms(q).disableBypassPermissionsMode).toBeUndefined();
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(typeof o.canUseTool).toBe("function");
    expect(o.settingSources).toEqual(["project"]);
  });

  it("refuses fullAccess when the device gate is closed", async () => {
    const { runtime, cwd, queries } = setup({ allowFullAccess: () => false });
    expect(runtime.capabilities.supportsPermissionModes).not.toContain("fullAccess");
    await expect(
      runtime.start({ sessionId: "s1", cwd, permissionMode: "fullAccess" }, () => undefined),
    ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    expect(queries).toHaveLength(0);
  });

  it("with the gate open, any other mode still starts locked down (no bypass availability)", async () => {
    const { start, runtime } = setup({ allowFullAccess: () => true });
    expect(runtime.capabilities.supportsPermissionModes).toContain("fullAccess");
    const q = await start("acceptEdits");
    expect(q.params.options.allowDangerouslySkipPermissions).toBe(false);
    expect(perms(q).disableBypassPermissionsMode).toBe("disable");
  });

  it("entering fullAccess relaunches between turns with resume and the bypass options", async () => {
    const { start, runtime, events, queries } = setup({ allowFullAccess: () => true });
    const first = await start("acceptEdits", { model: "sonnet" });
    first.emit(init("acceptEdits"));
    await settle();
    await runtime.configure("s1", { effort: "high" });
    await runtime.configure("s1", { permissionMode: "fullAccess" });
    expect(first.closed).toBe(true);
    expect(queries).toHaveLength(2);
    const second = queries[1] as FakeQuery;
    expect(second.params.options).toMatchObject({
      resume: "rt-1",
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(perms(second).deny).toEqual(secretDenyRules());
    // The effort set on the first process is carried over (scalar flag settings only).
    expect(second.methodCalls("applyFlagSettings")).toEqual([{ effortLevel: "high" }]);
    expect(events.some((e) => e.type === "session.state" && e.status === "completed")).toBe(false);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
    expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "fullAccess" });
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await settle();
    expect(first.prompts).toHaveLength(0);
    expect(second.prompts.map((p) => p.message.content)).toEqual(["go"]);
    // The authorized bypass init is accepted (not an abort).
    second.emit(init("bypassPermissions"));
    await settle();
    expect(second.closed).toBe(false);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("leaving fullAccess relaunches again without bypass", async () => {
    const { start, runtime, queries } = setup({ allowFullAccess: () => true });
    const first = await start("fullAccess");
    first.emit(init("bypassPermissions"));
    await settle();
    await runtime.configure("s1", { permissionMode: "acceptEdits" });
    expect(first.closed).toBe(true);
    const second = queries[1] as FakeQuery;
    expect(second.params.options).toMatchObject({
      resume: "rt-1",
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: false,
    });
    expect(perms(second).disableBypassPermissionsMode).toBe("disable");
  });

  it("a prompt capped below fullAccess relaunches to the capped mode before that turn, and back after", async () => {
    const { start, runtime, queries } = setup({ allowFullAccess: () => true });
    const first = await start("fullAccess");
    first.emit(init("bypassPermissions"));
    await settle();
    await runtime.prompt("s1", { promptId: "p1", text: "capped", permissionMode: "acceptEdits" });
    await settle();
    expect(first.closed).toBe(true);
    const capped = queries[1] as FakeQuery;
    expect(capped.params.options).toMatchObject({
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: false,
    });
    expect(capped.prompts.map((p) => p.message.content)).toEqual(["capped"]);
    capped.emit(result());
    await settle();
    await runtime.prompt("s1", { promptId: "p2", text: "full" });
    await settle();
    const full = queries[2] as FakeQuery;
    expect(full.params.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(full.prompts.map((p) => p.message.content)).toEqual(["full"]);
  });

  it("a fullAccess turn after the gate closed fails without pushing anything", async () => {
    let allowed = true;
    const { start, runtime, events, queries } = setup({ allowFullAccess: () => allowed });
    const q = await start("fullAccess");
    allowed = false;
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await settle();
    expect(queries.flatMap((x) => x.prompts)).toEqual([]);
    expect(q.prompts).toEqual([]);
    expect(events.find((e) => e.type === "prompt.completed")).toMatchObject({
      promptId: "p1",
      isError: true,
    });
  });

  it("an init reporting bypassPermissions in an authorized session that is NOT in fullAccess still aborts", async () => {
    const { start, events } = setup({ allowFullAccess: () => true });
    const q = await start("acceptEdits");
    q.emit(init("bypassPermissions"));
    await settle();
    expect(q.closed).toBe(true);
    expect(events.some((e) => e.type === "session.error")).toBe(true);
  });
});

describe("ClaudeCodeRuntime — slash command backstop (D-13, P-10)", () => {
  it.each(["/model x", "/config", "/permissions full access", "/mcp", "/effort max", "/fast on"])(
    "refuses %s before anything is queued",
    async (text) => {
      const { start, runtime } = setup();
      const q = await start();
      await expect(runtime.prompt("s1", { promptId: "p1", text })).rejects.toMatchObject({
        code: "slash_command_refused",
      });
      await settle();
      expect(q.prompts).toEqual([]);
      expect(q.calls).toEqual([]);
    },
  );

  it("refuses a queued settings command too (not only when idle)", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await expect(runtime.prompt("s1", { promptId: "p2", text: "/model opus" })).rejects.toMatchObject({
      code: "slash_command_refused",
    });
    q.emit(result());
    await settle();
    expect(q.prompts.map((p) => p.message.content)).toEqual(["one"]);
  });

  it("passes /compact through as a normal user message", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "/compact" });
    await settle();
    expect(q.prompts.map((p) => p.message.content)).toEqual(["/compact"]);
  });
});

afterAll(() => {
  // T-03.2-02-01: across the whole suite, applyFlagSettings never carried anything but scalar keys.
  expect(ALL_FLAG_SETTINGS.length).toBeGreaterThan(0);
  for (const arg of ALL_FLAG_SETTINGS) {
    for (const key of Object.keys(arg as object)) expect(["effortLevel", "fastMode"]).toContain(key);
    expect(arg).not.toHaveProperty("permissions");
  }
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

describe("ClaudeCodeRuntime — retire idle and resume (07.11 D-03a)", () => {
  const promptTexts = (q: FakeQuery) => q.prompts.map((p) => p.message.content);
  const sessionEnds = (events: SessionEvent[]) =>
    events.filter(
      (e) =>
        e.type === "session.error" ||
        (e.type === "session.state" && (e.status === "completed" || e.status === "failed")),
    );

  it("closes an idle session's CLI without ending it and never touches one with a turn in flight", async () => {
    const { start, runtime, events, queries, cwd } = setup();
    const a = await start("acceptEdits");
    a.emit(init("acceptEdits"));
    await settle();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    a.emit(result());
    await settle();

    const bEvents: SessionEvent[] = [];
    await runtime.start({ sessionId: "s2", cwd, permissionMode: "default" }, (e) => bEvents.push(e));
    const b = queries.at(-1) as FakeQuery;
    await runtime.prompt("s2", { promptId: "q1", text: "edit it" });
    await settle();
    const approval = b.params.options.canUseTool?.("Edit", { file_path: `${cwd}/src/a.ts` }, {
      signal: signal(),
      toolUseID: "t1",
    } as never);
    await tick();

    expect(runtime.activeTurns()).toBe(1);
    const before = { a: events.length, b: bEvents.length };
    await expect(runtime.retireIdle()).resolves.toBe(1);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(events.slice(before.a)).toEqual([]);
    expect(bEvents.slice(before.b)).toEqual([]);
    // Nothing more to retire: A is already dormant, B is still busy.
    await expect(runtime.retireIdle()).resolves.toBe(0);

    const req = bEvents.find((e) => e.type === "approval.requested") as { approvalId: string };
    expect(runtime.resolveApproval("s2", req.approvalId, "once")).toBe(true);
    await expect(approval).resolves.toMatchObject({ behavior: "allow" });
    expect(runtime.activeTurns()).toBe(1);
    b.emit(result());
    await settle();
    expect(runtime.activeTurns()).toBe(0);
    expect(sessionEnds(bEvents)).toEqual([]);
    await runtime.stopAll();
  });

  it("counts a session with prompts queued once and never retires it", async () => {
    const { start, runtime } = setup();
    const q = await start();
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(runtime.activeTurns()).toBe(1);
    await expect(runtime.retireIdle()).resolves.toBe(0);
    expect(q.closed).toBe(false);
    q.emit(result());
    await settle();
    expect(promptTexts(q)).toEqual(["one", "two"]);
    expect(runtime.activeTurns()).toBe(1);
    q.emit(result());
    await settle();
    expect(runtime.activeTurns()).toBe(0);
  });

  it("the next prompt relaunches with resume, the applied mode and the flag settings, and the turn runs", async () => {
    const { start, runtime, events, queries } = setup();
    const first = await start("acceptEdits", { model: "sonnet" });
    first.emit(init("acceptEdits"));
    await settle();
    await runtime.configure("s1", { effort: "high", fastMode: true });
    await expect(runtime.retireIdle()).resolves.toBe(1);
    expect(queries).toHaveLength(1);

    await runtime.prompt("s1", { promptId: "p1", text: "after the update" });
    await settle();
    expect(queries).toHaveLength(2);
    const woken = queries[1] as FakeQuery;
    expect(woken.params.options).toMatchObject({
      resume: "rt-1",
      model: "sonnet",
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: false,
    });
    expect(perms(woken).disableBypassPermissionsMode).toBe("disable");
    expect(woken.methodCalls("applyFlagSettings")).toEqual([{ effortLevel: "high", fastMode: true }]);
    expect(woken.methodCalls("setPermissionMode")).toEqual([]);
    expect(first.prompts).toHaveLength(0);
    expect(promptTexts(woken)).toEqual(["after the update"]);
    expect(runtime.activeTurns()).toBe(1);

    woken.emit(result());
    await settle();
    expect(runtime.activeTurns()).toBe(0);
    const completed = events.filter((e) => e.type === "prompt.completed");
    expect(completed).toEqual([expect.objectContaining({ promptId: "p1" })]);
    expect(completed[0]).not.toHaveProperty("isError");
    expect(sessionEnds(events)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });
  });

  it("a capped turn wakes the CLI directly in the capped mode", async () => {
    const { start, runtime, queries } = setup();
    const first = await start("acceptEdits");
    first.emit(init("acceptEdits"));
    await settle();
    await runtime.retireIdle();
    await runtime.prompt("s1", { promptId: "p1", text: "read only", permissionMode: "plan" });
    await settle();
    const woken = queries[1] as FakeQuery;
    expect(woken.params.options).toMatchObject({ resume: "rt-1", permissionMode: "plan" });
    expect(woken.methodCalls("setPermissionMode")).toEqual([]);
    woken.emit(result());
    await settle();
    await runtime.prompt("s1", { promptId: "p2", text: "uncapped" });
    await settle();
    expect(queries).toHaveLength(2);
    expect(woken.methodCalls("setPermissionMode")).toEqual(["acceptEdits"]);
  });

  it("configure() on a dormant session wakes it once, in the new mode, and applies the change on that launch", async () => {
    const { start, runtime, events, queries } = setup();
    const first = await start("default");
    first.emit(init("default"));
    await settle();
    await runtime.retireIdle();
    await runtime.configure("s1", { permissionMode: "acceptEdits", effort: "high" });
    expect(queries).toHaveLength(2);
    const woken = queries[1] as FakeQuery;
    expect(woken.params.options).toMatchObject({ resume: "rt-1", permissionMode: "acceptEdits" });
    expect(woken.methodCalls("setPermissionMode")).toEqual([]);
    expect(woken.methodCalls("applyFlagSettings")).toEqual([{ effortLevel: "high" }]);
    expect(settingsEvents(events).at(-1)).toMatchObject({ permissionMode: "acceptEdits", effort: "high" });
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await settle();
    expect(queries).toHaveLength(2);
    expect(promptTexts(woken)).toEqual(["go"]);
    expect(sessionEnds(events)).toEqual([]);
  });

  it("stop() on a dormant session ends it cleanly without a process to close", async () => {
    const { start, runtime, events, queries } = setup();
    const first = await start();
    first.emit(init("default"));
    await settle();
    await runtime.retireIdle();
    const before = events.length;
    await runtime.stop("s1");
    expect(events.slice(before)).toEqual([{ type: "session.state", status: "completed" }]);
    expect(queries).toHaveLength(1);
    expect(runtime.hasSession("s1")).toBe(false);
    expect(runtime.activeTurns()).toBe(0);
  });

  it("every CLI process it launches gets DISABLE_AUTOUPDATER=1 (D-12, PD-14)", async () => {
    const { start, runtime, queries } = setup({ prepare: prepareProbe, allowFullAccess: () => true });
    await runtime.catalog(); // catalog query
    const first = await start("acceptEdits"); // session start
    first.emit(init("acceptEdits"));
    await settle();
    await runtime.configure("s1", { permissionMode: "fullAccess" }); // relaunch (P-11)
    await runtime.retireIdle();
    await runtime.prompt("s1", { promptId: "p1", text: "go" }); // wake-up
    await settle();
    await runtime
      .generateTitle({ prompt: "fix the bug", model: "haiku", signal: signal() })
      .catch(() => undefined);
    const launches = queries.map((q) => ({
      kind: Array.isArray(q.params.options.tools) ? "title" : q.params.options.resume ? "resume" : "other",
      autoUpdater: q.params.options.env?.DISABLE_AUTOUPDATER,
    }));
    expect(launches.filter((l) => l.kind === "title")).toHaveLength(1);
    expect(launches.filter((l) => l.kind === "resume")).toHaveLength(2);
    expect(launches.length).toBeGreaterThanOrEqual(5);
    expect(launches.every((l) => l.autoUpdater === "1")).toBe(true);
    // One place for it: a parent value cannot switch the updater back on.
    expect(childEnv({ PATH: "/bin", DISABLE_AUTOUPDATER: "0" }).DISABLE_AUTOUPDATER).toBe("1");
    expect(childEnv({ PATH: "/bin" }, true).DISABLE_AUTOUPDATER).toBe("1");
    await runtime.stopAll();
  });

  it("refreshInstall() re-resolves the CLI path for the next launch and drops the catalog cache", async () => {
    const savedPath = process.env.PATH;
    const dirA = mkdtempSync(join(tmpdir(), "ocw-claude-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "ocw-claude-b-"));
    for (const dir of [dirA, dirB])
      writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ocw-claude-rt-")));
    const queries: FakeQuery[] = [];
    try {
      process.env.PATH = dirA;
      const runtime = new ClaudeCodeRuntime({
        queryFn: (params) => {
          const q = new FakeQuery(params);
          prepareProbe(q);
          queries.push(q);
          return q;
        },
        catalogCwd: cwd,
        detect: () =>
          Promise.resolve({ id: "claude-code", installed: true, version: "2.1.289", loggedIn: true }),
      });
      await runtime.catalog();
      await runtime.catalog();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.params.options.pathToClaudeCodeExecutable).toBe(join(dirA, "claude"));
      await runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, () => undefined);
      const session = queries.at(-1) as FakeQuery;
      session.emit(init("default"));
      await settle();
      expect(session.params.options.pathToClaudeCodeExecutable).toBe(join(dirA, "claude"));

      process.env.PATH = dirB;
      runtime.refreshInstall();
      await runtime.retireIdle();
      await runtime.prompt("s1", { promptId: "p1", text: "go" });
      await settle();
      const woken = queries.at(-1) as FakeQuery;
      expect(woken).not.toBe(session);
      expect(woken.params.options.pathToClaudeCodeExecutable).toBe(join(dirB, "claude"));
      const count = queries.length;
      await runtime.catalog();
      expect(queries).toHaveLength(count + 1);
      expect(queries.at(-1)?.params.options.pathToClaudeCodeExecutable).toBe(join(dirB, "claude"));
      await runtime.stopAll();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("refreshInstall() keeps an explicitly configured CLI path", async () => {
    const { start, runtime, queries } = setup({ claudePath: "/opt/claude/bin/claude" });
    const first = await start();
    first.emit(init("default"));
    await settle();
    runtime.refreshInstall();
    await runtime.retireIdle();
    await runtime.prompt("s1", { promptId: "p1", text: "go" });
    await settle();
    expect(queries.at(-1)?.params.options.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
  });
});
