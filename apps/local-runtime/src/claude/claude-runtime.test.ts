import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  isSecretBasename,
  originOf,
  type PermissionMode,
  type RuntimeCatalog,
  type RuntimeInfo,
  type SessionBrowserGrant,
  type SessionEvent,
  WORK_BROWSER_REFUSAL_TEXT,
} from "@ocw/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import { BrowserManager, type ChildFactoryOptions, type ManagedChild } from "../browser/manager.js";
import { silentLogger } from "../logger.js";
import { type AccountSignal, RuntimeError, type StartSessionOptions } from "../runtime.js";
import { ClaudeCodeRuntime, childEnv, claudeImageInput, type QueryHandle } from "./claude-runtime.js";
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
  /** Reported by `mcpServerStatus()` (07.13 A-4). */
  mcpStatus: McpServerStatus[] = [];
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown> {
    this.calls.push({ method: "setMcpServers", arg: servers });
    this.log.push(`setMcpServers:${Object.keys(servers).join(",")}`);
    return Promise.resolve({ added: Object.keys(servers), removed: [], errors: {} });
  }
  mcpServerStatus(): Promise<McpServerStatus[]> {
    this.calls.push({ method: "mcpServerStatus", arg: undefined });
    return Promise.resolve(this.mcpStatus);
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

// 07.18: token-shaped values joined at runtime, so no credential literal lives in the repo.
const POOL_TOKEN_A = ["sk", "ant", "oat01", "poolAAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("-");
const POOL_TOKEN_B = ["sk", "ant", "oat01", "poolBBBBBBBBBBBBBBBBBBBBBBBBBBBB"].join("-");
const tokenAccount = (ref: string, oauthToken: string, label = `Account ${ref}`) => ({
  kind: "token" as const,
  ref,
  label,
  oauthToken,
});

/** 07.18-19 R1.5: variables CLI 2.1.331 reads that would take the session off the pool token. */
const R15_VARS = [
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_UNIX_SOCKET",
];

describe("ClaudeCodeRuntime — a pool token account (07.18 D-02, PD-03)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.OCW_DEVICE_TOKEN = "device-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "also-not";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "the-parent-one";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    // 07.18-19 R1.5: the other providers, gateways, credential descriptors and the socket of CLI 2.1.331.
    for (const k of R15_VARS) process.env[k] = k.endsWith("_SOCKET") ? "/tmp/not-anthropic.sock" : "1";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("strips the other providers, credential descriptors and the API socket (07.18-19 R1.5)", async () => {
    const { start } = setup();
    const q = await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    const env = q.params.options.env ?? {};
    for (const k of R15_VARS) expect(env[k], k).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_A);
  });

  it("runs on the pool token with every competing credential stripped, even with useApiKey", async () => {
    const { start } = setup({ useApiKey: true });
    const q = await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    const env = q.params.options.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_A);
    for (const k of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(Object.keys(env).filter((k) => k.startsWith("OCW_"))).toEqual([]);
  });

  it("without an account the env is exactly today's childEnv", async () => {
    const { start } = setup({ useApiKey: true });
    const q = await start();
    expect(q.params.options.env).toEqual(childEnv(process.env, true));
    const plain = await setup().start("default", { account: null });
    expect(plain.params.options.env).toEqual(childEnv(process.env, false));
  });

  it("reports token accounts as supported", () => {
    expect(setup().runtime.capabilities.supportsAccounts).toEqual(["token"]);
  });
});

describe("ClaudeCodeRuntime — the pool token cannot be redirected (07.18 D-13, A-06, E16)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const flagSettings = (q: FakeQuery) =>
    q.params.options.settings as { env?: Record<string, string>; permissions: Perms };

  it("pins the base URL, the API-key variables and the daemon's own proxy and CA in the flag settings", async () => {
    process.env.HTTPS_PROXY = "http://proxy.corp.example:3128";
    process.env.NODE_EXTRA_CA_CERTS = "/etc/corp-ca.pem";
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
    const { start } = setup();
    const plain = flagSettings(await setup().start());
    const q = await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    const settings = flagSettings(q);
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      HTTPS_PROXY: "http://proxy.corp.example:3128",
      HTTP_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    });
    for (const k of R15_VARS) expect(settings.env?.[k], k).toBe("");
    // The secret deny rules and the bypass lock are exactly those of a session without a token.
    expect(settings.permissions).toEqual(plain.permissions);
    expect(plain).toEqual({ permissions: plain.permissions });
    expect(JSON.stringify(settings)).not.toContain(POOL_TOKEN_A);
  });

  it("refuses a pool token for a project whose settings run their own apiKeyHelper", async () => {
    const { runtime, cwd, queries } = setup();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "./get-key.sh" }));
    await expect(
      runtime.start(
        { sessionId: "s1", cwd, permissionMode: "default", account: tokenAccount("a", POOL_TOKEN_A) },
        () => undefined,
      ),
    ).rejects.toThrow(
      "This project's Claude settings choose their own credentials; pool accounts are not used here",
    );
    expect(queries).toHaveLength(0);
    // The device's own login is not affected.
    await runtime.start({ sessionId: "s2", cwd, permissionMode: "default" }, () => undefined);
    expect(queries).toHaveLength(1);
  });

  it("reports an init whose credential came from the project instead of the pool token", async () => {
    const { start, events } = setup();
    const q = await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    q.emit({ ...init("default"), apiKeySource: "apiKeyHelper" });
    await settle();
    expect(events).toContainEqual({
      type: "session.error",
      message:
        "This project's Claude settings choose their own credentials; the pool account is not used here",
    });
    const ok = setup();
    const q2 = await ok.start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    q2.emit({ ...init("default"), apiKeySource: "oauth" });
    await settle();
    expect(ok.events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("leaves no trace of the token in the OCW home, the config dir or the project", async () => {
    const ocw = mkdtempSync(join(tmpdir(), "ocw-pool-home-"));
    const config = mkdtempSync(join(tmpdir(), "ocw-pool-cfg-"));
    process.env.OCW_HOME = ocw;
    process.env.CLAUDE_CONFIG_DIR = config;
    const { start, runtime, cwd, events } = setup();
    const q = await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    q.emit(init("default"));
    await runtime.prompt("s1", { promptId: "p1", text: "hi" });
    await settle();
    q.emit(result());
    await settle();
    await runtime.stop("s1");
    const contents = [ocw, config, cwd].flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .map((f) => join(dir, f))
        .filter((f) => statSync(f).isFile())
        .map((f) => readFileSync(f, "utf8")),
    );
    expect(contents.join("\n")).not.toContain(POOL_TOKEN_A);
    expect(JSON.stringify(events)).not.toContain(POOL_TOKEN_A);
  });
});

describe("ClaudeCodeRuntime — limits and usage of the session's account (07.18 D-07, D-09, PD-05, PD-24)", () => {
  it("reports one limit per turn, with the last known reset, before that turn's prompt.completed", async () => {
    const log: string[] = [];
    const signals: AccountSignal[] = [];
    const { runtime, events, start } = setup();
    const q = await start("default", {
      account: tokenAccount("a", POOL_TOKEN_A),
      onAccountSignal: (sig) => {
        signals.push(sig);
        log.push(`signal:${sig.kind}`);
      },
    });
    const watch = () => {
      for (const e of events.splice(0))
        if (e.type === "prompt.completed") log.push(`completed:${e.promptId}`);
    };
    q.emit(init("default"));
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    const reset = 1_795_000_000;
    q.emit({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.9,
        resetsAt: reset,
      },
    });
    q.emit({
      type: "assistant",
      parent_tool_use_id: null,
      error: "rate_limit",
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 3:45pm" }] },
    });
    q.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } });
    q.emit({ ...result(), subtype: "error_during_execution", is_error: true, errors: ["rate limited"] });
    await settle();
    watch();
    expect(signals).toEqual([
      {
        kind: "usage",
        usage: {
          windows: [{ kind: "five_hour", usedPercent: 90, resetsAt: new Date(reset * 1000).toISOString() }],
          at: expect.any(String),
        },
      },
      {
        kind: "limited",
        promptId: "p1",
        reason: "usage_limit",
        resetsAt: new Date(reset * 1000).toISOString(),
      },
    ]);
    expect(log).toEqual(["signal:usage", "signal:limited", "completed:p1"]);

    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    q.emit({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: reset + 60 },
    });
    q.emit({ ...result(), is_error: true, result: "You've hit your session limit · resets 4:45pm" });
    await settle();
    watch();
    expect(signals.at(-1)).toEqual({
      kind: "limited",
      promptId: "p2",
      reason: "five_hour",
      resetsAt: new Date((reset + 60) * 1000).toISOString(),
    });
    expect(signals.filter((s) => s.kind === "limited")).toHaveLength(2);
    expect(log.slice(-2)).toEqual(["signal:limited", "completed:p2"]);
  });
});

describe("ClaudeCodeRuntime — what is not an account limit (07.18-19 R1.1-R1.3)", () => {
  it("a rejected window served from overage, a per-minute 429 and reply text send only usage", async () => {
    const signals: AccountSignal[] = [];
    const { runtime, events, start } = setup();
    const q = await start("default", {
      account: tokenAccount("a", POOL_TOKEN_A),
      onAccountSignal: (sig) => signals.push(sig),
    });
    q.emit(init("default"));
    await runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    q.emit({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        overageStatus: "allowed",
        isUsingOverage: true,
      },
    });
    q.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "You've hit your limit of patience, I see." }] },
    });
    q.emit({
      type: "assistant",
      parent_tool_use_id: null,
      error: "rate_limit",
      message: { content: [{ type: "text", text: "API Error: Rate limit reached" }] },
    });
    q.emit(result());
    await settle();
    expect(signals.map((sig) => sig.kind)).toEqual(["usage"]);
    expect(events.some((e) => e.type === "prompt.completed")).toBe(true);
  });
});

describe("ClaudeCodeRuntime — switching account between turns (07.18 D-08, PD-03, A-01)", () => {
  const promptTexts = (q: FakeQuery) => q.prompts.map((p) => p.message.content);
  const sessionEnds = (events: SessionEvent[]) =>
    events.filter((e) => e.type === "session.state" && (e.status === "completed" || e.status === "failed"));
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function afterOneTurn(extra: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(extra);
    const first = await ctx.start("acceptEdits", { account: tokenAccount("a", POOL_TOKEN_A) });
    first.emit(init("acceptEdits"));
    await ctx.runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    first.emit(result());
    await settle();
    return { ...ctx, first };
  }

  it("the next turn runs on a new CLI resuming the same session under the new token", async () => {
    const { runtime, queries, events, first } = await afterOneTurn();
    await runtime.useAccount("s1", tokenAccount("b", POOL_TOKEN_B));
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(queries).toHaveLength(2);
    expect(first.closed).toBe(true);
    const next = queries[1] as FakeQuery;
    expect(next.params.options).toMatchObject({ resume: "rt-1", permissionMode: "acceptEdits" });
    expect(next.params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_B);
    expect(promptTexts(next)).toEqual(["two"]);
    next.emit(result());
    await settle();
    expect(sessionEnds(events)).toEqual([]);
    expect(events.filter((e) => e.type === "session.error")).toEqual([]);
    expect(events.filter((e) => e.type === "prompt.completed").map((e) => e.promptId)).toEqual(["p1", "p2"]);
  });

  it("the same account changes nothing", async () => {
    const { runtime, queries, first } = await afterOneTurn();
    await runtime.useAccount("s1", tokenAccount("a", POOL_TOKEN_A, "renamed"));
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(queries).toHaveLength(1);
    expect(promptTexts(first)).toEqual(["one", "two"]);
  });

  it("null moves the session to the device's own login, without the pool pin", async () => {
    const { runtime, queries } = await afterOneTurn();
    await runtime.useAccount("s1", null);
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    const next = queries[1] as FakeQuery;
    expect(next.params.options.resume).toBe("rt-1");
    expect(next.params.options.env).toEqual(childEnv(process.env, false));
    expect((next.params.options.settings as { env?: unknown }).env).toBeUndefined();
  });

  it("a switch asked during a turn applies before the next turn, never inside it", async () => {
    const ctx = setup();
    const first = await ctx.start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    first.emit(init("default"));
    await ctx.runtime.prompt("s1", { promptId: "p1", text: "one" });
    await settle();
    await ctx.runtime.useAccount("s1", tokenAccount("b", POOL_TOKEN_B));
    await ctx.runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(ctx.queries).toHaveLength(1);
    expect(first.closed).toBe(false);
    first.emit(result());
    await settle();
    expect(ctx.queries).toHaveLength(2);
    expect((ctx.queries[1] as FakeQuery).params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_B);
    expect(promptTexts(ctx.queries[1] as FakeQuery)).toEqual(["two"]);
  });

  it("a retired session wakes directly under the new account (one launch)", async () => {
    const { runtime, queries } = await afterOneTurn();
    await runtime.retireIdle();
    await runtime.useAccount("s1", tokenAccount("b", POOL_TOKEN_B));
    expect(queries).toHaveLength(1);
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(queries).toHaveLength(2);
    const woken = queries[1] as FakeQuery;
    expect(woken.params.options).toMatchObject({ resume: "rt-1" });
    expect(woken.params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_B);
    expect(promptTexts(woken)).toEqual(["two"]);
  });

  it("a resume that fails under the new account fails the turn and says so (no silent fresh start)", async () => {
    let launches = 0;
    const { runtime, queries, events } = await afterOneTurn({
      prepare: () => {
        launches++;
        if (launches === 2) throw new Error(`resume refused for ${POOL_TOKEN_B}`);
      },
    });
    await runtime.useAccount("s1", tokenAccount("b", POOL_TOKEN_B));
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    expect(queries).toHaveLength(1);
    expect(events).toContainEqual({
      type: "session.error",
      message: "This conversation could not continue on the next account. Start a new session.",
    });
    expect(events.filter((e) => e.type === "prompt.completed").at(-1)).toMatchObject({
      promptId: "p2",
      isError: true,
    });
    expect(JSON.stringify(events)).not.toContain(POOL_TOKEN_B);
  });

  it("a CLI that ends before its init after a switch reports the same failure", async () => {
    const { runtime, queries, events } = await afterOneTurn();
    await runtime.useAccount("s1", tokenAccount("b", POOL_TOKEN_B));
    await runtime.prompt("s1", { promptId: "p2", text: "two" });
    await settle();
    (queries[1] as FakeQuery).close();
    await settle();
    expect(events).toContainEqual({
      type: "session.error",
      message: "This conversation could not continue on the next account. Start a new session.",
    });
    expect(events.filter((e) => e.type === "prompt.completed").at(-1)).toMatchObject({
      promptId: "p2",
      isError: true,
    });
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

// 07.18-19 R1.8: a device whose own Claude CLI is signed out still has a catalog and titles through a pool token.
describe("ClaudeCodeRuntime — a device without its own Claude login (07.18-19 R1.8)", () => {
  const signedOut = () =>
    Promise.resolve({ id: "claude-code" as const, installed: true, version: "2.1.289", loggedIn: false });
  const titleQuery = (queries: FakeQuery[]) => queries.find((q) => Array.isArray(q.params.options.tools));
  const flagEnv = (q: FakeQuery | undefined) =>
    (q?.params.options.settings as { env?: Record<string, string> } | undefined)?.env;
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("no pool session: no catalog and no query, as before", async () => {
    const { runtime, queries } = setup({ detect: signedOut, prepare: prepareProbe });
    expect(runtime.catalogReadyWithoutLogin()).toBe(false);
    await expect(runtime.catalog()).resolves.toBeNull();
    expect(queries).toHaveLength(0);
  });

  it("collects the catalog with a live pool session's token, stripped and pinned like that session", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    const { runtime, queries, start } = setup({ detect: signedOut, prepare: prepareProbe });
    await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    expect(runtime.catalogReadyWithoutLogin()).toBe(true);
    const catalog = await runtime.catalog();
    expect(catalog?.models.length).toBeGreaterThan(0);
    const probe = queries.at(-1);
    expect(probe?.params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_A);
    expect(probe?.params.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(flagEnv(probe)).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_KEY: "",
    });
    expect(probe?.prompts).toEqual([]);
    await runtime.stop("s1");
    expect(runtime.catalogReadyWithoutLogin()).toBe(false);
  });

  it("a signed-in device keeps its own login for the catalog, even with a pool session", async () => {
    const { runtime, queries, start } = setup({ prepare: prepareProbe });
    await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    await runtime.catalog();
    const probe = queries.at(-1);
    expect(probe?.params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(flagEnv(probe)).toBeUndefined();
  });

  it("a pool session's title runs on that session's token, never the device's login", async () => {
    const { runtime, queries, start } = setup({ prepare: prepareProbe });
    await start("default", { account: tokenAccount("a", POOL_TOKEN_A) });
    await runtime
      .generateTitle({ sessionId: "s1", prompt: "fix the bug", model: "haiku", signal: signal() })
      .catch(() => undefined);
    const title = titleQuery(queries);
    expect(title?.params.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN_A);
    expect(flagEnv(title)).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    expect(JSON.stringify(title?.params.options.settings)).not.toContain(POOL_TOKEN_A);
  });

  it("a session on the device's own login keeps that login for its title", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "the-parent-one";
    const { runtime, queries, start } = setup({ prepare: prepareProbe });
    await start("default");
    await runtime
      .generateTitle({ sessionId: "s1", prompt: "fix the bug", model: "haiku", signal: signal() })
      .catch(() => undefined);
    const title = titleQuery(queries);
    expect(title?.params.options.env).toEqual(childEnv(process.env, false));
    expect(flagEnv(title)).toBeUndefined();
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

  it("07.17.1.1 (PD-09): the base-name rule is the shared contracts rule; the home folders still refuse", () => {
    for (const name of [
      ".env",
      ".ENV.local",
      ".env.example",
      ".env.Sample",
      "id_rsa.pub",
      "login.keychain",
      ".npmrc",
      "credentials.json",
      "device-token",
      "notes.md",
      "env.ts",
    ]) {
      expect(isSecretPath(`src/${name}`, cwd, home), name).toBe(isSecretBasename(name));
    }
    expect(isSecretPath("~/.ssh/config", cwd, home)).toBe(true);
    expect(isSecretPath("/Users/alice/.gnupg/pubring.kbx", cwd, home)).toBe(true);
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

// ------------------------------------------------------------------ 07.13-13: the Work Zone browser (PD-07, PD-23, A-4)

const BROWSER_ALLOW: SessionBrowserGrant = {
  allowed: true,
  reason: "ok",
  askerId: "00000000-0000-4000-8000-000000000001",
  askerIsBot: false,
  alwaysAsk: [],
  whenTainted: [],
  signinAllowed: false,
};
const BROWSER_DENY: SessionBrowserGrant = { ...BROWSER_ALLOW, allowed: false, reason: "off_policy" };

/** A child that answers like the agent without a real browser (the manager's rules are tested in 12). */
class ScriptedBrowserChild implements ManagedChild {
  state: ManagedChild["state"] = "running";
  readonly closed: Promise<void>;
  private done: () => void = () => {};
  constructor(private readonly o: ChildFactoryOptions) {
    this.closed = new Promise((r) => {
      this.done = r;
    });
  }
  async call(op: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (op === "open") {
      const url = new URL(String(input.url));
      const origin = originOf(url.href);
      if (origin) this.o.onEvent({ event: "navigated", origin });
      return { host: url.host, secure: false, title: "Scripted", signedIn: false };
    }
    if (op === "screenshot")
      return { mimeType: "image/jpeg", data: "/9j/2w==", width: 1, height: 1, masked: 0 };
    return { closed: true };
  }
  async close(): Promise<void> {
    this.state = "closed";
    this.done();
  }
}

function browserSetup(extra: { prepare?: (q: FakeQuery) => void } = {}) {
  const base = setup(extra.prepare ? { prepare: extra.prepare } : {});
  const root = mkdtempSync(join(tmpdir(), "ocw-claude-rt-browser-"));
  const manager = new BrowserManager({
    root,
    link: { send: () => undefined, sendBinary: () => false },
    api: { put: async () => 404 },
    optIn: () => true,
    sandbox: () => false,
    emit: () => undefined,
    browsers: {
      installed: async () => ({ executable: "/scripted/chrome", version: "156.0.8078.47" }),
      install: async () => ({ executable: "/scripted/chrome", version: "156.0.8078.47" }),
    },
    createChild: (o) => new ScriptedBrowserChild(o),
    log: silentLogger,
  });
  const sid = randomUUID();
  const tools = manager.forSession(sid);
  const imageInputs: boolean[] = [];
  const setImageInput = tools.setImageInput.bind(tools);
  tools.setImageInput = (on) => {
    imageInputs.push(on);
    setImageInput(on);
  };
  const start = async (more: Partial<Omit<StartSessionOptions, "sessionId" | "cwd">> = {}) => {
    await base.runtime.start(
      { sessionId: sid, cwd: base.cwd, permissionMode: "default", browser: tools, ...more },
      (e) => base.events.push(e),
    );
    const q = base.queries.at(-1);
    if (!q) throw new Error("query not created");
    return q;
  };
  const cleanup = async () => {
    await base.runtime.stopAll();
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  };
  return { ...base, manager, sid, tools, imageInputs, start, cleanup };
}

function serverOf(servers: Record<string, unknown> | undefined): McpSdkServerConfigWithInstance | undefined {
  const s = servers?.ocw_browser as McpSdkServerConfigWithInstance | undefined;
  return s?.type === "sdk" ? s : undefined;
}

async function mcpClient(server: McpSdkServerConfigWithInstance): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "claude-runtime-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("ClaudeCodeRuntime — the Work Zone browser (07.13-13 PD-07, PD-23, A-4)", () => {
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) await c();
    cleanups = [];
  });
  const harness = (extra: { prepare?: (q: FakeQuery) => void } = {}) => {
    const h = browserSetup(extra);
    cleanups.push(h.cleanup);
    return h;
  };

  it("browser: canUseTool allows mcp__ocw_browser__* without an approval; Bash and secret paths are unchanged", async () => {
    const h = harness();
    h.manager.onPrompt(h.sid, null, BROWSER_ALLOW);
    const q = await h.start();
    const canUseTool = q.params.options.canUseTool;
    await expect(
      canUseTool?.("mcp__ocw_browser__open", { url: "http://localhost:3000/" }, {
        signal: signal(),
        mcpServer: { name: "ocw_browser", source: "sdk" },
      } as never),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { url: "http://localhost:3000/" } });
    await expect(
      canUseTool?.("mcp__ocw_browser__snapshot", {}, { signal: signal() } as never),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);

    // Every other tool keeps the approval flow and the secret denies.
    void canUseTool?.("Bash", { command: "pnpm test" }, { signal: signal() } as never);
    await tick();
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    await expect(
      canUseTool?.("Read", { file_path: `${h.cwd}/.env` }, { signal: signal() } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("browser: a configured (non-sdk) ocw_browser tool is denied by canUseTool and by the PreToolUse hook", async () => {
    const h = harness();
    h.manager.onPrompt(h.sid, null, BROWSER_ALLOW);
    const q = await h.start();
    await expect(
      q.params.options.canUseTool?.("mcp__ocw_browser__open", { url: "http://x/" }, {
        signal: signal(),
        mcpServer: { name: "ocw_browser", source: "project" },
      } as never),
    ).resolves.toEqual({ behavior: "deny", message: WORK_BROWSER_REFUSAL_TEXT.not_allowed });
    const hook = q.params.options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const pre = (source: string) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "mcp__ocw_browser__open",
          tool_input: { url: "http://x/" },
          mcp_server: { name: "ocw_browser", source },
        } as never,
        undefined,
        { signal: signal() },
      );
    await expect(pre("project")).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(pre("sdk")).resolves.toEqual({});
  });

  it("browser: without an allowed grant no server; a later allowed grant registers it with setMcpServers, no relaunch", async () => {
    const h = harness();
    // A start-time effort goes through the same between-turn path (it also keeps the suite's flag-settings guard
    // meaningful when only the browser tests run).
    const q = await h.start({ effort: "high" });
    expect(q.params.options.mcpServers?.ocw_browser).toBeUndefined();
    // Not registered: any mcp__ocw_browser__ call is someone else's.
    await expect(
      q.params.options.canUseTool?.("mcp__ocw_browser__open", {}, { signal: signal() } as never),
    ).resolves.toMatchObject({ behavior: "deny" });

    h.manager.onPrompt(h.sid, "p1", BROWSER_ALLOW);
    await h.runtime.prompt(h.sid, { promptId: "p1", text: "look" });
    await settle();
    const calls = q.methodCalls("setMcpServers") as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    expect(serverOf(calls[0])?.name).toBe("ocw_browser");
    expect(q.log.indexOf("setMcpServers:ocw_browser")).toBeLessThan(q.log.indexOf("prompt:look"));
    expect(h.queries).toHaveLength(1);
    expect(q.methodCalls("mcpServerStatus")).toHaveLength(1);
    await expect(
      q.params.options.canUseTool?.("mcp__ocw_browser__open", {}, { signal: signal() } as never),
    ).resolves.toMatchObject({ behavior: "allow" });

    // A grant denied for a queued prompt withdraws the server before that turn, never inside the running one.
    h.manager.onPrompt(h.sid, "p2", BROWSER_DENY);
    await h.runtime.prompt(h.sid, { promptId: "p2", text: "again" });
    await settle();
    expect(q.methodCalls("setMcpServers")).toHaveLength(1);
    q.emit(result());
    await settle();
    expect(q.methodCalls("setMcpServers").at(-1)).toEqual({});
    expect(q.log.lastIndexOf("setMcpServers:")).toBeLessThan(q.log.indexOf("prompt:again"));
    expect(h.queries).toHaveLength(1);
  });

  it("browser: a configured ocw_browser reported by mcpServerStatus makes the browser unavailable (shadowed)", async () => {
    const h = harness({
      prepare: (q) => {
        q.mcpStatus = [
          { name: "ocw_browser", status: "connected", config: { type: "stdio", command: "node" } },
        ];
      },
    });
    h.manager.onPrompt(h.sid, null, BROWSER_ALLOW);
    const q = await h.start();
    expect(serverOf(q.params.options.mcpServers)).toBeDefined();
    q.emit(init("default"));
    await settle();
    expect(q.methodCalls("mcpServerStatus")).toHaveLength(1);
    expect(h.tools.available).toBe(false);
    h.manager.onPrompt(h.sid, "p1", BROWSER_ALLOW);
    h.manager.onTurnStarted(h.sid, "p1");
    const refused = await h.tools.call("open", { url: "http://localhost:3000/" });
    expect(refused.summary).toBe(`Refused: ${WORK_BROWSER_REFUSAL_TEXT.browser_unavailable}`);
    await expect(
      q.params.options.canUseTool?.("mcp__ocw_browser__open", {}, {
        signal: signal(),
        mcpServer: { name: "ocw_browser", source: "sdk" },
      } as never),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("browser: our own sdk server reported by mcpServerStatus keeps the browser available", async () => {
    const h = harness({
      prepare: (q) => {
        q.mcpStatus = [
          {
            name: "ocw_browser",
            status: "connected",
            source: "sdk",
            config: { type: "sdk", name: "ocw_browser" },
          },
        ];
      },
    });
    h.manager.onPrompt(h.sid, null, BROWSER_ALLOW);
    const q = await h.start();
    q.emit(init("default"));
    await settle();
    expect(q.methodCalls("mcpServerStatus")).toHaveLength(1);
    expect(h.tools.available).toBe(true);
  });

  it("browser: a screenshot is an image only for a model the catalog lists; otherwise image_model_required", async () => {
    const h = harness({ prepare: prepareProbe });
    // No catalog yet: unknown, no images.
    h.manager.onPrompt(h.sid, null, BROWSER_ALLOW);
    const q = await h.start({ model: "opus" });
    expect(h.imageInputs.at(-1)).toBe(false);
    // The catalog arrives: opus is listed, so it reads images.
    await h.runtime.catalog();
    expect(h.imageInputs.at(-1)).toBe(true);

    const server = serverOf(q.params.options.mcpServers);
    if (!server) throw new Error("no ocw_browser server");
    const client = await mcpClient(server);
    try {
      h.manager.onPrompt(h.sid, "p1", BROWSER_ALLOW);
      h.manager.onTurnStarted(h.sid, "p1");
      await client.callTool({ name: "open", arguments: { url: "http://localhost:3000/" } });
      const shot = await client.callTool({ name: "screenshot", arguments: {} });
      expect(shot.content).toContainEqual({ type: "image", data: "/9j/2w==", mimeType: "image/jpeg" });

      // A model the catalog does not list: unknown, so the tool answers the fixed sentence and no bytes.
      await h.runtime.configure(h.sid, { model: "claude-unknown-9" });
      expect(h.imageInputs.at(-1)).toBe(false);
      const text = await client.callTool({ name: "screenshot", arguments: {} });
      expect(text.isError).toBe(true);
      expect(text.content).toEqual([
        { type: "text", text: `Refused: ${WORK_BROWSER_REFUSAL_TEXT.image_model_required}` },
      ]);
    } finally {
      await client.close();
    }
  });

  it("browser: claudeImageInput — listed models read images unless the catalog says imageInput: false", () => {
    const catalog = {
      runtime: "claude-code",
      runtimeVersion: "2.1.332",
      collectedAt: new Date().toISOString(),
      permissionModes: ["default"],
      models: [
        { id: "opus", isDefault: true },
        { id: "text-only", isDefault: false, imageInput: false },
        { id: "vision", isDefault: false, imageInput: true },
      ],
    } as unknown as RuntimeCatalog;
    expect(claudeImageInput(catalog, null)).toBe(true);
    expect(claudeImageInput(catalog, "opus")).toBe(true);
    expect(claudeImageInput(catalog, "vision")).toBe(true);
    expect(claudeImageInput(catalog, "text-only")).toBe(false);
    expect(claudeImageInput(catalog, "missing")).toBe(false);
    expect(claudeImageInput(null, "opus")).toBe(false);
  });
});
