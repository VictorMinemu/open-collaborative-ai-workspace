import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentChannelSandboxExecResponse,
  SANDBOX_REFUSALS,
  SANDBOX_TIMEOUTS_MS,
  SANDBOX_TOOL_NAMES,
  type SandboxToolBodies,
  type SandboxToolName,
  type TurnContext,
} from "./agent-channel-protocol.js";
import {
  type AgentChannelClient,
  AgentChannelHttpError,
  confinedTimeoutMs,
  createAgentChannelClient,
} from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import {
  type ConfinedToolContext,
  NO_TURN,
  registerSandboxTools,
  renderExecResult,
  renderFileList,
  SANDBOX_REFUSAL_SENTENCE,
  SANDBOX_TOOL_ROUTES,
  UNREACHABLE,
} from "./sandbox-tools.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";
import { APPROVAL_SENTENCES, createToolGuard } from "./tool-guard.js";

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const DM = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${DM}`;
const CANARY = "canary-sandbox-api-body-41c9";
const EXEC = { untrustedOutput: true, sideEffecting: false };

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["ocw_sandbox_exec"],
    toolFlags: { ocw_sandbox_exec: EXEC },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Content[]; details?: { ok: boolean; code?: string } }>;
};
type Registered = { factory: (ctx: ConfinedToolContext) => unknown; opts: { name: string } };
type Call = { tool: SandboxToolName; body: Record<string, unknown> };

const EXITED: AgentChannelSandboxExecResponse = {
  status: "exited",
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  truncated: false,
  durationMs: 412,
};

function setup(respond: (call: Call) => Promise<unknown> = async () => EXITED, clientPresent = true) {
  const calls: Call[] = [];
  const client = {
    sandboxCall: async <T extends SandboxToolName>(tool: T, body: SandboxToolBodies[T]) => {
      calls.push({ tool, body: body as Record<string, unknown> });
      return respond({ tool, body: body as Record<string, unknown> });
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Registered[] = [];
  const logs: string[] = [];
  registerSandboxTools(
    {
      registerTool: (factory: Registered["factory"], opts: { name: string }) =>
        registered.push({ factory, opts }),
    } as never,
    {
      guard,
      client: () => (clientPresent ? client : null),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    },
  );
  const tool = (
    name: string,
    ctx: ConfinedToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) },
  ) => {
    const r = registered.find((x) => x.opts.name === name);
    if (!r) throw new Error(`${name} was not registered`);
    return r.factory(ctx) as Tool;
  };
  const begin = (t: TurnContext = turn(), eventId = "evt-1") =>
    guard.beginTurn(SESSION, {
      eventId,
      agentId: BOT,
      turn: t,
      conversationId: DM,
      requesterName: "Ana Pérez",
    });
  return { calls, guard, registered, tool, logs, begin };
}

const text = (r: { content: Content[] }) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

const httpError = (status: number, code?: string) =>
  new AgentChannelHttpError(status, "/sandbox/exec", `POST /sandbox/exec → ${status} ${CANARY}`, code);

describe("ocw_sandbox_exec (07.8 D-02 b, P-07): a thin, credential-free caller of POST /sandbox/exec", () => {
  it("is registered under its fixed name with an argv array schema and no command string", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts.name)).toContain("ocw_sandbox_exec");
    const t = tool("ocw_sandbox_exec");
    expect(t.name).toBe("ocw_sandbox_exec");
    expect(t.parameters).toMatchObject({ type: "object", additionalProperties: false, required: ["argv"] });
    expect(Object.keys(t.parameters.properties ?? {}).sort()).toEqual([
      "argv",
      "background",
      "cwd",
      "timeoutSeconds",
    ]);
    expect(t.parameters.properties?.argv).toMatchObject({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 64,
    });
    expect(t.parameters.properties).not.toHaveProperty("command");
  });

  it("posts exactly {eventId, agentId, argv} (and the optional fields when given) and renders the exit", async () => {
    const { calls, tool, begin } = setup();
    begin();
    const r = await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["sh", "-c", "echo hi"] });
    expect(calls).toEqual([
      { tool: "ocw_sandbox_exec", body: { eventId: "evt-1", agentId: BOT, argv: ["sh", "-c", "echo hi"] } },
    ]);
    expect(text(r)).toBe("exit 0 in 0.4 s\nstdout:\nhi\nstderr:\n(empty)");
    expect(r.details).toEqual({ ok: true });
    await tool("ocw_sandbox_exec").execute("tc-2", {
      argv: ["npm", "test"],
      cwd: "app",
      timeoutSeconds: 120,
      background: true,
      // Never forwarded: not in the contract (the API refuses unknown keys; the plugin never sends them).
      command: "rm -rf /",
      userId: "someone-else",
    });
    expect(calls[1]?.body).toEqual({
      eventId: "evt-1",
      agentId: BOT,
      argv: ["npm", "test"],
      cwd: "app",
      timeoutSeconds: 120,
      background: true,
    });
  });

  it("a command string instead of argv is refused locally, before any request", async () => {
    const { calls, tool, begin } = setup();
    begin();
    for (const params of [
      { command: "id" },
      { argv: "id" },
      { argv: [] },
      { argv: [""] },
      { argv: ["ls", 3] },
      { argv: Array.from({ length: 65 }, () => "x") },
      { argv: ["ls"], cwd: "/etc" },
      { argv: ["ls"], cwd: "../up" },
      { argv: ["ls"], timeoutSeconds: 601 },
      { argv: ["ls"], timeoutSeconds: 1.5 },
      { argv: ["ls"], background: "yes" },
    ]) {
      const r = await tool("ocw_sandbox_exec").execute("tc-1", params);
      expect(r.details, JSON.stringify(params)).toEqual({ ok: false, code: "bad_params" });
      expect(text(r)).not.toContain("rm -rf");
    }
    expect(calls).toEqual([]);
  });

  it("a running command names its process id and tells the model to poll with ocw_sandbox_process", async () => {
    const { tool, begin } = setup(async () => ({
      status: "running",
      processId: "p_7Kq2",
      stdout: "building…",
      stderr: "",
      truncated: false,
      durationMs: 25_000,
    }));
    begin();
    const t = text(await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["make"] }));
    expect(t).toContain("still running as process p_7Kq2 after 25.0 s");
    expect(t).toContain('ocw_sandbox_process with {"processId":"p_7Kq2","action":"poll"}');
    expect(t).toContain("building…");
  });

  it("renders the output tails and says when they were cut", () => {
    expect(
      renderExecResult({
        status: "exited",
        exitCode: 2,
        stdout: "",
        stderr: "boom",
        truncated: true,
        durationMs: 12_345,
      }),
    ).toBe("exit 2 in 12.3 s\nstdout:\n(empty)\nstderr:\nboom\n[output cut to its last 16 KB]");
  });

  it("a refusal is its fixed sentence (killed, budget, member data …), never the API's error body", async () => {
    for (const [status, code] of [
      [403, "killed"],
      [403, "budget_exhausted"],
      [403, "member_data"],
      [409, "disk_full"],
      [503, "service_unavailable"],
      [403, "no_trigger"],
    ] as const) {
      const { tool, begin } = setup(async () => {
        throw httpError(status, code);
      });
      begin();
      const r = await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] });
      expect(text(r), code).toBe(SANDBOX_REFUSAL_SENTENCE[code].replaceAll("{requester}", "Ana Pérez"));
      expect(r.details).toEqual({ ok: false, code });
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });

  it("an approval refusal is 07.5's approval sentence naming the tool", async () => {
    const { tool, begin } = setup(async () => {
      throw new AgentChannelHttpError(409, "/sandbox/exec", CANARY, "approval_required", {
        id: "0199a6f0-0000-7000-8000-0000000000a1",
        created: true,
        waitingFor: "Ana Pérez",
        requesterName: "Ana Pérez",
      });
    });
    begin();
    const r = await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["curl", "https://example.com"] });
    expect(text(r)).toBe(
      APPROVAL_SENTENCES.approval_required({
        tool: "ocw_sandbox_exec",
        waitingFor: "Ana Pérez",
        requesterName: "Ana Pérez",
      }),
    );
  });

  it("a network failure is the unreachable sentence; no turn or no client refuses locally", async () => {
    const down = setup(async () => {
      throw new TypeError("fetch failed");
    });
    down.begin();
    expect(text(await down.tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] }))).toBe(UNREACHABLE);

    const none = setup();
    const r = await none.tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] });
    expect(text(r)).toBe(NO_TURN);
    expect(none.calls).toEqual([]);

    const offline = setup(undefined, false);
    offline.begin();
    expect(text(await offline.tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] }))).toBe(UNREACHABLE);
  });

  it("refuses a turn that does not offer it", async () => {
    const { calls, tool, begin } = setup();
    begin(turn({ tools: ["web_search"], toolFlags: {} }));
    const r = await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] });
    expect(r.details).toEqual({ ok: false, code: "not_in_turn" });
    expect(calls).toEqual([]);
  });

  it("taints the turn: command output is untrusted (D-11 F-7)", async () => {
    const { tool, begin, guard } = setup();
    begin();
    await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["id"] });
    expect(guard.activeTurn(SESSION)?.tainted).toBe(true);
  });

  it("logs ids and codes only, never argv or output", async () => {
    const { tool, begin, logs } = setup();
    begin();
    await tool("ocw_sandbox_exec").execute("tc-1", { argv: ["echo", "secret-argv-9f"] });
    expect(logs.join("\n")).not.toContain("secret-argv-9f");
    expect(logs.join("\n")).not.toContain("hi");
  });
});

describe("sandbox refusal sentences: an exhaustive record over the contract enum", () => {
  it("covers exactly contracts SandboxRefusal, each a short fixed sentence", async () => {
    const contracts = (await import(
      new URL("../../../packages/contracts/src/sandbox.ts", import.meta.url).href
    )) as { SandboxRefusal: { options: string[] } };
    expect([...SANDBOX_REFUSALS]).toEqual(contracts.SandboxRefusal.options);
    expect(Object.keys(SANDBOX_REFUSAL_SENTENCE).sort()).toEqual([...SANDBOX_REFUSALS].sort());
    for (const sentence of Object.values(SANDBOX_REFUSAL_SENTENCE)) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence.length).toBeLessThan(220);
      expect(sentence).not.toMatch(/\{(?!requester\})/u);
    }
  });

  it("a shell still starting reads as a retry in a moment, never as an unreachable workspace", () => {
    expect(SANDBOX_REFUSAL_SENTENCE.starting).toMatch(/starting/u);
    expect(SANDBOX_REFUSAL_SENTENCE.starting).toMatch(/again/u);
    expect(SANDBOX_REFUSAL_SENTENCE.starting).not.toBe(UNREACHABLE);
  });
});

describe("sandbox call budgets (contracts SANDBOX_TIMEOUTS_MS, CI p142/p164/p178)", () => {
  it("every ocw_sandbox_* tool waits longer than the API's deadline of the call, under OpenClaw's 90 s", async () => {
    const contracts = (await import(
      new URL("../../../packages/contracts/src/sandbox.ts", import.meta.url).href
    )) as { SANDBOX_TIMEOUTS_MS: { apiCall: number; cellCall: number } };
    const t = contracts.SANDBOX_TIMEOUTS_MS;
    expect(SANDBOX_TIMEOUTS_MS.cellCall).toBe(t.cellCall);
    for (const tool of SANDBOX_TOOL_NAMES) {
      // A first call of any of them may start the bot's shell (35 s / 20 s before: the cold start outlived both).
      expect(confinedTimeoutMs(tool), tool).toBe(t.cellCall);
      expect(confinedTimeoutMs(tool), tool).toBeGreaterThan(t.apiCall);
      expect(confinedTimeoutMs(tool), tool).toBeLessThan(90_000);
    }
  });
});

describe("ocw_sandbox_exec over HTTP: the real client → the fake Agent Channel API", () => {
  let api: FakeAgentChannelApi;
  beforeEach(async () => {
    api = await startFakeAgentChannelApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("posts to /agent-channel/v1/sandbox/exec with the turn's ids and argv only, never /tool-calls", async () => {
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const guard = createToolGuard({ client: () => client });
    const registered: Registered[] = [];
    registerSandboxTools(
      {
        registerTool: (f: Registered["factory"], o: { name: string }) =>
          registered.push({ factory: f, opts: o }),
      } as never,
      { guard, client: () => client },
    );
    guard.beginTurn(SESSION, { eventId: "evt-h1", agentId: BOT, turn: turn(), conversationId: DM });
    const exec = registered
      .find((r) => r.opts.name === "ocw_sandbox_exec")
      ?.factory({ sessionKey: SESSION }) as Tool;
    api.sandbox.exec = {
      status: "exited",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      durationMs: 5,
    };
    const r = await exec.execute("tc-1", { argv: ["sh", "-c", "echo hi"] });
    expect(text(r)).toBe("exit 0 in 0.0 s\nstdout:\nhi\nstderr:\n(empty)");
    expect(api.sandbox.calls).toEqual([
      { route: "exec", body: { eventId: "evt-h1", agentId: BOT, argv: ["sh", "-c", "echo hi"] } },
    ]);
    expect(api.toolCalls).toEqual([]);

    api.sandbox.refusal = "killed";
    const refused = await exec.execute("tc-2", { argv: ["id"] });
    expect(text(refused)).toBe(SANDBOX_REFUSAL_SENTENCE.killed);
    expect(JSON.stringify(refused)).not.toContain("fake-api-error-body-canary");
  });
});

const ALL_SANDBOX_TURN = (): TurnContext =>
  turn({ tools: [...SANDBOX_TOOL_NAMES], toolFlags: {}, maxSandboxCalls: 40 });
const ATTACHMENT = "0199a6f0-0000-7000-8000-0000000000aa";

describe("the other seven sandbox tools (07.8 P-07): each posts only its contract body and renders its answer", () => {
  const CASES: Array<{
    tool: SandboxToolName;
    params: Record<string, unknown>;
    body: Record<string, unknown>;
    result: unknown;
    rendered: string;
    tainted: boolean;
  }> = [
    {
      tool: "ocw_sandbox_process",
      params: { processId: "p_7Kq2", action: "poll", pid: 1 },
      body: { processId: "p_7Kq2", action: "poll" },
      result: {
        status: "exited",
        exitCode: 1,
        stdout: "",
        stderr: "fail",
        truncated: false,
        durationMs: 30_000,
      },
      rendered: "exit 1 in 30.0 s\nstdout:\n(empty)\nstderr:\nfail",
      tainted: true,
    },
    {
      tool: "ocw_sandbox_read",
      params: { path: "notes/todo.md", offset: 0, limit: 100 },
      body: { path: "notes/todo.md", offset: 0, limit: 100 },
      result: { path: "notes/todo.md", content: "- ship it", encoding: "utf8", size: 9, truncated: false },
      rendered: "- ship it",
      tainted: true,
    },
    {
      tool: "ocw_sandbox_write",
      params: { path: "notes/todo.md", content: "- ship it", mode: "append" },
      body: { path: "notes/todo.md", content: "- ship it", mode: "append" },
      result: { path: "notes/todo.md", size: 9 },
      rendered: "Wrote notes/todo.md (9 bytes now).",
      tainted: false,
    },
    {
      tool: "ocw_sandbox_list",
      params: {},
      body: { path: "" },
      result: {
        path: "",
        entries: [
          {
            path: "app",
            name: "app",
            kind: "dir",
            size: null,
            modifiedAt: "2026-10-15T09:00:00.000Z",
            hidden: false,
          },
          {
            path: "notes.txt",
            name: "notes.txt",
            kind: "file",
            size: 23,
            modifiedAt: "2026-10-15T09:00:00.000Z",
            hidden: false,
          },
        ],
        more: 0,
      },
      rendered: "/workspace:\n- app/\n- notes.txt (23 bytes)",
      tainted: true,
    },
    {
      tool: "ocw_sandbox_delete",
      params: { path: "build", recursive: true },
      body: { path: "build", recursive: true },
      result: { path: "build", deleted: 14 },
      rendered: "Deleted build (14 items).",
      tainted: false,
    },
    {
      tool: "ocw_sandbox_share",
      params: { path: "out/report.pdf" },
      body: { path: "out/report.pdf" },
      result: { attachmentId: ATTACHMENT, name: "report.pdf", size: 2048 },
      rendered: "Shared report.pdf (2048 bytes) as an attachment in this conversation.",
      tainted: false,
    },
    {
      tool: "ocw_sandbox_import",
      params: { attachmentId: ATTACHMENT },
      body: { attachmentId: ATTACHMENT },
      result: { path: "downloads/data.csv", size: 512 },
      rendered: "Imported the attachment to /workspace/downloads/data.csv (512 bytes).",
      tainted: false,
    },
  ];

  it.each(CASES)("$tool", async (c) => {
    const { calls, tool, begin, guard } = setup(async () => c.result);
    begin(ALL_SANDBOX_TURN());
    const r = await tool(c.tool).execute("tc-1", c.params);
    expect(calls).toEqual([{ tool: c.tool, body: { eventId: "evt-1", agentId: BOT, ...c.body } }]);
    expect(text(r)).toBe(c.rendered);
    expect(guard.activeTurn(SESSION)?.tainted).toBe(c.tainted);
  });

  it("every sandbox tool has its own route and a closed parameter schema", () => {
    const { tool } = setup();
    for (const name of SANDBOX_TOOL_NAMES) {
      expect(SANDBOX_TOOL_ROUTES[name]).toBe(`/sandbox/${name.slice("ocw_sandbox_".length)}`);
      expect(tool(name).parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("invalid params are refused locally with a fixed sentence, before any request", async () => {
    const { calls, tool, begin } = setup();
    begin(ALL_SANDBOX_TURN());
    for (const [name, params] of [
      ["ocw_sandbox_process", { processId: "../1", action: "poll" }],
      ["ocw_sandbox_process", { processId: "p1", action: "signal" }],
      ["ocw_sandbox_read", { path: "/etc/passwd" }],
      ["ocw_sandbox_read", { path: "" }],
      ["ocw_sandbox_read", { path: "a/../../b" }],
      ["ocw_sandbox_read", { path: "a", limit: 262_145 }],
      ["ocw_sandbox_write", { path: "a", content: 3 }],
      ["ocw_sandbox_write", { path: "a", content: "x".repeat(1_048_577) }],
      ["ocw_sandbox_write", { path: "a", content: "x", mode: "truncate" }],
      ["ocw_sandbox_list", { path: "/" }],
      ["ocw_sandbox_delete", { path: "" }],
      ["ocw_sandbox_share", { path: "a\\b" }],
      ["ocw_sandbox_import", { attachmentId: "not-an-id" }],
      ["ocw_sandbox_import", { attachmentId: ATTACHMENT, path: "/tmp/x" }],
    ] as const) {
      const r = await tool(name).execute("tc-1", params);
      expect(r.details, `${name} ${JSON.stringify(params).slice(0, 80)}`).toEqual({
        ok: false,
        code: "bad_params",
      });
    }
    expect(calls).toEqual([]);
  });

  it("write defaults to overwrite; a base64 read says it is binary", async () => {
    const { calls, tool, begin } = setup(async (c) =>
      c.tool === "ocw_sandbox_read"
        ? { path: "logo.png", content: "iVBORw0K", encoding: "base64", size: 6, truncated: false }
        : { path: "a.txt", size: 1 },
    );
    begin(ALL_SANDBOX_TURN());
    await tool("ocw_sandbox_write").execute("tc-1", { path: "a.txt", content: "x" });
    expect(calls[0]?.body.mode).toBe("overwrite");
    expect(text(await tool("ocw_sandbox_read").execute("tc-2", { path: "logo.png" }))).toBe(
      "logo.png is a binary file (6 bytes). Its content as base64:\niVBORw0K",
    );
  });

  it("renders a cut listing and a cut read", async () => {
    expect(renderFileList({ path: "app", entries: [], more: 0 })).toBe("/workspace/app: (empty folder)");
    expect(
      renderFileList({
        path: "",
        entries: [
          {
            path: "a\nb",
            name: "a\nb",
            kind: "file",
            size: 1,
            modifiedAt: "2026-10-15T09:00:00.000Z",
            hidden: false,
          },
        ],
        more: 501,
      }),
    ).toBe("/workspace:\n- a b (1 bytes)\n… and 501 more");
    const { tool, begin } = setup(async () => ({
      path: "big.log",
      content: "tail",
      encoding: "utf8",
      size: 300_000,
      truncated: true,
    }));
    begin(ALL_SANDBOX_TURN());
    expect(text(await tool("ocw_sandbox_read").execute("tc-1", { path: "big.log" }))).toBe(
      "tail\n[showing 4 of 300000 bytes; read more with offset]",
    );
  });

  it("a member_data refusal on a team bot's write is its sentence (P-11), audience_narrower on import too", async () => {
    for (const [name, params, code] of [
      ["ocw_sandbox_write", { path: "a", content: "x" }, "member_data"],
      ["ocw_sandbox_import", { attachmentId: ATTACHMENT }, "audience_narrower"],
    ] as const) {
      const { tool, begin } = setup(async () => {
        throw new AgentChannelHttpError(403, "/sandbox/x", CANARY, code);
      });
      begin(ALL_SANDBOX_TURN());
      const r = await tool(name).execute("tc-1", params);
      expect(text(r)).toBe(SANDBOX_REFUSAL_SENTENCE[code].replaceAll("{requester}", "Ana Pérez"));
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });
});
