/**
 * `ocw_memory_list|read|write|propose` (07.2-07, MEM-04, D-02, D-08). The tracer drives our REAL entry the way OpenClaw
 * registers it (testing/openclaw-host.ts) against the fake Agent Channel API over HTTP; the rest use a recording client.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnContext } from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import {
  MEMORY_FILE_TOOLS,
  type MemoryFileToolContext,
  registerMemoryFileTools,
} from "./memory-files-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";
import { createTurnHookRunner, loadRegistry, type PluginEntry } from "./testing/openclaw-host.js";
import { createToolGuard, setToolGuardClient, toolGuard } from "./tool-guard.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as { id: string; contracts?: { tools?: string[] } };

const READ_FLAGS = { untrustedOutput: false, sideEffecting: false };
const WRITE_FLAGS = { untrustedOutput: false, sideEffecting: true };
const PROPOSE_FLAGS = { untrustedOutput: false, sideEffecting: false };
const WEB = { untrustedOutput: true, sideEffecting: false };
const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const DM = "0199a6f0-0000-7000-8000-00000000c002";
const TEAM_SCOPE = "0199a6f0-0000-7000-8000-0000000005c1";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${DM}`;

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", ...MEMORY_FILE_TOOLS],
    toolFlags: {
      web_search: WEB,
      ocw_memory_list: READ_FLAGS,
      ocw_memory_read: READ_FLAGS,
      ocw_memory_write: WRITE_FLAGS,
      ocw_memory_propose: PROPOSE_FLAGS,
    },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, { type?: string; enum?: string[]; maxLength?: number }>;
  };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type Factory = (ctx: MemoryFileToolContext) => Tool;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

describe("ocw_memory_read through the real entry and the Agent Channel API (tracer)", () => {
  let api: FakeAgentChannelApi;
  const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) };

  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
    setToolGuardClient(createAgentChannelClient({ apiUrl: api.url, token: () => api.token }));
  });

  afterEach(async () => {
    toolGuard.endTurn(SESSION);
    setToolGuardClient(null);
    await api.close();
  });

  const readTool = () => {
    const owned = loadRegistry(entry, manifest, { mode: "full" }).tools.find((t) =>
      t.names.includes("ocw_memory_read"),
    );
    if (!owned) throw new Error("ocw_memory_read is not registered");
    return (owned.factory as Factory)(ctx);
  };

  it("the gate asks /tool-calls, the tool posts exactly {eventId, agentId, scope, path} and returns the file", async () => {
    api.memoryFileStore.push({
      scope: "personal",
      path: "MEMORY.md",
      version: 3,
      content: "# Memory\n- likes tea\n",
    });
    toolGuard.beginTurn(SESSION, { eventId: "evt-r1", agentId: BOT, turn: turn(), conversationId: DM });
    const runner = createTurnHookRunner(loadRegistry(entry, manifest, { activate: false }));
    const params = { scope: "personal", path: "MEMORY.md" };
    expect(
      await runner.runBeforeToolCall({ toolName: "ocw_memory_read", params, toolCallId: "tc-1" }, ctx),
    ).toEqual({ blocked: false });
    const r = await readTool().execute("tc-1", params);
    expect(api.toolCalls.map(({ tool, params: p, allowed }) => ({ tool, p, allowed }))).toEqual([
      { tool: "ocw_memory_read", p: {}, allowed: true },
    ]);
    expect(api.memoryCalls).toEqual([
      { route: "read", body: { eventId: "evt-r1", agentId: BOT, scope: "personal", path: "MEMORY.md" } },
    ]);
    expect(text(r)).toContain("MEMORY.md (version 3)");
    expect(text(r)).toContain("- likes tea");
    expect(r.details).toMatchObject({ ok: true });
  });

  it("an API refusal ({refused}) becomes a fixed sentence", async () => {
    toolGuard.beginTurn(SESSION, { eventId: "evt-r2", agentId: BOT, turn: turn(), conversationId: DM });
    const r = await readTool().execute("tc-1", { scope: "personal", path: "notes/missing.md" });
    expect(api.memoryCalls).toHaveLength(1);
    expect(text(r)).toBe("Not read: that file or scope does not exist, or you may not see it.");
  });
});

type Recorded = { route: string; body: Record<string, unknown> };

function setup(
  respond: Partial<
    Record<"list" | "read" | "write" | "propose", (body: Record<string, unknown>) => Promise<unknown>>
  > = {},
) {
  const calls: Recorded[] = [];
  const handler = (route: "list" | "read" | "write" | "propose") => async (body: Record<string, unknown>) => {
    calls.push({ route, body });
    const fn = respond[route];
    if (fn) return fn(body);
    throw new Error(`no response scripted for ${route}`);
  };
  const client = {
    memoryList: handler("list"),
    memoryRead: handler("read"),
    memoryWrite: handler("write"),
    memoryPropose: handler("propose"),
    authorizeToolCall: async () => ({ callId: "call-1", allowed: true, reason: null }),
    reportToolCallResult: async () => {},
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerMemoryFileTools(
    {
      registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }),
    } as never,
    { guard, client: () => client, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
  );
  const tool = (
    name: string,
    ctx: MemoryFileToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) },
  ) => {
    const r = registered.find((x) => x.opts.name === name);
    if (!r) throw new Error(`${name} is not registered`);
    return r.factory(ctx);
  };
  const begin = (over: Partial<TurnContext> = {}, eventId = "evt-1") =>
    guard.beginTurn(SESSION, { eventId, agentId: BOT, turn: turn(over), conversationId: DM });
  return { calls, guard, registered, tool, begin, logs };
}

describe("registration", () => {
  it("registers the four tools by name, each with a strict JSON schema and a model-facing description", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts.name)).toEqual([...MEMORY_FILE_TOOLS]);
    for (const name of MEMORY_FILE_TOOLS) {
      const t = tool(name);
      expect(t.name).toBe(name);
      expect(t.parameters.type).toBe("object");
      expect(t.parameters.additionalProperties).toBe(false);
      // No parameter can name whose memory it is: the API binds the human to the delivered turn.
      expect(Object.keys(t.parameters.properties)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/user|owner/i)]),
      );
    }
    expect(tool("ocw_memory_list").parameters.required ?? []).toEqual([]);
    expect(tool("ocw_memory_write").parameters.required).toEqual(["scope", "path", "mode", "content"]);
    expect(tool("ocw_memory_write").parameters.properties.scope?.enum).toEqual(["personal", "agent"]);
    expect(tool("ocw_memory_propose").parameters.required).toEqual(["scope", "path", "op", "content"]);
    expect(tool("ocw_memory_propose").parameters.properties.reason?.maxLength).toBe(280);
    expect(tool("ocw_memory_write").description).toMatch(/ocw_memory_propose/);
    expect(tool("ocw_memory_propose").description).toMatch(/approv/i);
    for (const name of ["ocw_memory_write", "ocw_memory_propose"]) {
      expect(tool(name).description).toMatch(/secret/i);
    }
    const read = tool("ocw_memory_read");
    expect(read.parameters.required).toEqual(["scope", "path"]);
    expect(read.description).toMatch(/memory/i);
    expect(read.description).toMatch(/private/i);
    expect(read.description).toMatch(/workspace/i);
  });
});

describe("ocw_memory_read", () => {
  it("posts {eventId, agentId, scope, path} only, even when the model adds other keys", async () => {
    const { calls, tool, begin } = setup({
      read: async () => ({ file: { path: "MEMORY.md", version: 3, content: "- likes tea" } }),
    });
    begin();
    const r = await tool("ocw_memory_read").execute("tc-1", {
      scope: "personal",
      path: "MEMORY.md",
      userId: "0199a6f0-0000-7000-8000-0000000000u9",
    });
    expect(calls).toEqual([
      { route: "read", body: { eventId: "evt-1", agentId: BOT, scope: "personal", path: "MEMORY.md" } },
    ]);
    expect(text(r).split("\n")[0]).toBe("MEMORY.md (version 3)");
  });

  it("refuses locally, without an API call, when there is no turn or the turn does not offer it", async () => {
    const { calls, tool, begin } = setup({ read: async () => ({ refused: "denied" }) });
    const params = { scope: "personal", path: "MEMORY.md" };
    expect(text(await tool("ocw_memory_read").execute("tc-1", params))).toMatch(
      /^Not read: there is no active/,
    );
    begin({ tools: ["web_search"] });
    expect(text(await tool("ocw_memory_read").execute("tc-2", params))).toBe(
      "Not read: memory is not available here.",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a path the mirrored parser rejects, with the parser's reason", async () => {
    const { calls, tool, begin } = setup({ read: async () => ({ refused: "denied" }) });
    begin();
    const t = tool("ocw_memory_read");
    expect(text(await t.execute("tc-1", { scope: "personal", path: "../x.md" }))).toBe(
      "Not read: the path is not valid (dot_segment).",
    );
    expect(text(await t.execute("tc-2", { scope: "personal", path: "a/b.txt" }))).toBe(
      "Not read: the path is not valid (extension).",
    );
    expect(text(await t.execute("tc-3", { scope: "team-x", path: "MEMORY.md" }))).toMatch(
      /^Not read: unknown scope\. Use ocw_memory_list/,
    );
    expect(text(await t.execute("tc-4", { path: "MEMORY.md" }))).toMatch(/^Not read: unknown scope/);
    expect(calls).toEqual([]);
  });

  it("a 404 / 409 / 400 / network failure maps to a fixed sentence, never the API's body; logs carry codes only", async () => {
    const secret = 'POST /memory/read → 409 {"error":{"code":"tainted","message":"secret detail"}}';
    const errors = [
      new AgentChannelHttpError(404, "/memory/read", secret),
      new AgentChannelHttpError(409, "/memory/read", secret),
      new AgentChannelHttpError(400, "/memory/read", secret),
      new Error(secret),
    ];
    let i = 0;
    const { tool, begin, logs } = setup({
      read: async () => {
        throw errors[i++];
      },
    });
    begin();
    const t = tool("ocw_memory_read");
    const out: string[] = [];
    for (let n = 0; n < errors.length; n++) {
      out.push(text(await t.execute(`tc-${n}`, { scope: "personal", path: "MEMORY.md" })));
    }
    expect(out).toEqual([
      "Not read: this conversation turn is no longer active.",
      "Not read: memory is not available on this turn.",
      "Not read: the request was not accepted.",
      "Not read: the workspace could not be reached. Try again later.",
    ]);
    for (const s of [...out, ...logs]) {
      expect(s).not.toContain("secret detail");
      expect(s).not.toContain("{");
    }
    expect(logs.join("\n")).not.toContain("MEMORY.md");
  });

  it("an error code the API names as a refusal uses that refusal's sentence", async () => {
    const { tool, begin } = setup({
      read: async () => {
        throw new AgentChannelHttpError(409, "/memory/read", "x", "audience_too_wide");
      },
    });
    begin();
    expect(
      text(await tool("ocw_memory_read").execute("tc-1", { scope: TEAM_SCOPE, path: "MEMORY.md" })),
    ).toBe("Not read: someone in this conversation may not read that memory, so it cannot be shown here.");
  });
});

const SCOPES = [
  {
    id: "0199a6f0-0000-7000-8000-0000000005a1",
    kind: "personal",
    label: "Víctor and Archie",
    viewerCan: ["read", "write"],
  },
  { id: TEAM_SCOPE, kind: "unit", label: "Sales team", viewerCan: ["read"] },
];

describe("ocw_memory_list", () => {
  it("without a scope lists the scopes with their ids and labels", async () => {
    const { calls, tool, begin } = setup({ list: async () => ({ scopes: SCOPES }) });
    begin();
    const r = text(await tool("ocw_memory_list").execute("tc-1", {}));
    expect(calls).toEqual([{ route: "list", body: { eventId: "evt-1", agentId: BOT } }]);
    expect(r).toContain(`Sales team (unit) — scope: ${TEAM_SCOPE}`);
    expect(r).toContain("Víctor and Archie (personal) — scope: 0199a6f0-0000-7000-8000-0000000005a1");
  });

  it("with a scope and a folder lists the files with their paths and versions", async () => {
    const { calls, tool, begin } = setup({
      list: async () => ({
        files: [
          { path: "clients/acme.md", version: 2, bytes: 120 },
          { path: "clients/zeta.md", version: 1, bytes: 30 },
        ],
      }),
    });
    begin();
    const r = text(await tool("ocw_memory_list").execute("tc-1", { scope: TEAM_SCOPE, folder: "clients/" }));
    expect(calls).toEqual([
      { route: "list", body: { eventId: "evt-1", agentId: BOT, scope: TEAM_SCOPE, folder: "clients/" } },
    ]);
    expect(r).toContain("clients/acme.md (version 2)");
    expect(r).toContain("clients/zeta.md (version 1)");
  });

  it("refuses locally a folder without its trailing slash and an unknown scope", async () => {
    const { calls, tool, begin } = setup({ list: async () => ({ files: [] }) });
    begin();
    expect(
      text(await tool("ocw_memory_list").execute("tc-1", { scope: "personal", folder: "clients" })),
    ).toBe('Not listed: the folder is not valid (missing_slash). A folder ends with "/", like "clients/".');
    expect(text(await tool("ocw_memory_list").execute("tc-2", { scope: "sales" }))).toMatch(
      /^Not listed: unknown scope/,
    );
    expect(calls).toEqual([]);
  });

  it("an empty listing says so", async () => {
    const { tool, begin } = setup({ list: async () => ({ files: [] }) });
    begin();
    expect(text(await tool("ocw_memory_list").execute("tc-1", { scope: "agent" }))).toBe(
      "No files in this scope.",
    );
  });
});

describe("ocw_memory_write (own scopes only; D-08: refused after untrusted content)", () => {
  it("appends to the personal MEMORY.md with exactly the turn's ids and the parameters, once", async () => {
    const { calls, tool, begin } = setup({ write: async () => ({ fileId: "f1", version: 5 }) });
    begin();
    const r = await tool("ocw_memory_write").execute("tc-1", {
      scope: "personal",
      path: "MEMORY.md",
      mode: "append",
      content: "- likes tea",
      ownerUserId: "someone-else",
    });
    expect(calls).toEqual([
      {
        route: "write",
        body: {
          eventId: "evt-1",
          agentId: BOT,
          scope: "personal",
          path: "MEMORY.md",
          mode: "append",
          content: "- likes tea",
        },
      },
    ]);
    expect(text(r)).toBe("Saved. MEMORY.md is now version 5.");
    expect(r.details).toMatchObject({ ok: true });
  });

  it("replace sends the version it read; without one it is refused locally", async () => {
    const { calls, tool, begin } = setup({ write: async () => ({ fileId: "f1", version: 4 }) });
    begin();
    const t = tool("ocw_memory_write");
    expect(
      text(
        await t.execute("tc-1", { scope: "agent", path: "MEMORY.md", mode: "replace", content: "# Memory" }),
      ),
    ).toBe(
      "Not saved: replacing a file needs expectedVersion, the version you read with ocw_memory_read. To add to a file or create one, use mode append.",
    );
    expect(calls).toEqual([]);
    await t.execute("tc-2", {
      scope: "agent",
      path: "MEMORY.md",
      mode: "replace",
      content: "# Memory",
      expectedVersion: 3,
    });
    expect(calls[0]?.body).toMatchObject({ mode: "replace", expectedVersion: 3 });
  });

  it("refuses locally a shared scope, an invalid path or mode, and content over 256 KiB", async () => {
    const { calls, tool, begin } = setup({ write: async () => ({ fileId: "f1", version: 1 }) });
    begin();
    const t = tool("ocw_memory_write");
    const base = { scope: "personal", path: "MEMORY.md", mode: "append", content: "x" };
    expect(text(await t.execute("tc-1", { ...base, scope: TEAM_SCOPE }))).toBe(
      "Not saved: this is not your own memory. Shared memory needs ocw_memory_propose.",
    );
    expect(text(await t.execute("tc-2", { ...base, path: "../MEMORY.md" }))).toBe(
      "Not saved: the path is not valid (dot_segment).",
    );
    expect(text(await t.execute("tc-3", { ...base, mode: "move" }))).toMatch(/^Not saved: mode must be/);
    // 262,145 UTF-8 bytes in fewer characters: the limit counts bytes.
    expect(text(await t.execute("tc-4", { ...base, content: `${"é".repeat(131_072)}x` }))).toBe(
      "Not saved: the content is over 256 KiB.",
    );
    expect(text(await t.execute("tc-5", { ...base, content: 42 }))).toMatch(
      /^Not saved: the content is missing/,
    );
    expect(calls).toEqual([]);
  });

  it("on a tainted turn the gate blocks it before any API call, and the tool refuses too", async () => {
    const { calls, guard, tool, begin } = setup({ write: async () => ({ fileId: "f1", version: 1 }) });
    begin();
    const c = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) };
    expect(await guard.beforeToolCall({ toolName: "web_search", params: { query: "x" } }, c)).toBeUndefined();
    const blocked = await guard.beforeToolCall({ toolName: "ocw_memory_write", params: {} }, c);
    expect(blocked?.blockReason).toMatch(/read-only after untrusted content/);
    const r = await tool("ocw_memory_write").execute("tc-1", {
      scope: "personal",
      path: "MEMORY.md",
      mode: "append",
      content: "- from the web",
    });
    expect(text(r)).toMatch(/^Not saved: this turn read web or tool content.*ocw_memory_propose/);
    expect(calls).toEqual([]);
  });

  it("API refusals map to their fixed sentences", async () => {
    const answers = ["version_conflict", "secret_detected", "dm_only", "brand_new_reason"];
    let i = 0;
    const { tool, begin } = setup({ write: async () => ({ refused: answers[i++] }) });
    begin();
    const t = tool("ocw_memory_write");
    const out: string[] = [];
    for (let n = 0; n < answers.length; n++) {
      out.push(
        text(await t.execute(`tc-${n}`, { scope: "personal", path: "a.md", mode: "append", content: "x" })),
      );
    }
    expect(out).toEqual([
      "Not saved: the file changed since you read it. Read it again, then retry.",
      "Not saved: it contains a secret. Remove it and try again.",
      "Not saved: this works only in a private conversation with one person.",
      "Not saved: the workspace refused it.",
    ]);
  });
});

describe("ocw_memory_propose (shared scopes; a person approves, the server applies)", () => {
  const FINDINGS = [
    { kind: "email", severity: "warn", source: "builtin", count: 2, samples: ["a•••@acme.com"], lines: [3] },
    { kind: "phone", severity: "warn", source: "builtin", count: 1, samples: [], lines: [4] },
  ];

  it("posts {eventId, agentId, scope, path, op, content, baseVersion, reason} and says a person must approve it", async () => {
    const { calls, tool, begin } = setup({
      propose: async () => ({ approvalId: "ap-1", findings: FINDINGS, readerCount: 12 }),
    });
    begin();
    const r = text(
      await tool("ocw_memory_propose").execute("tc-1", {
        scope: TEAM_SCOPE,
        path: "clients/acme.md",
        op: "replace",
        content: "# Acme\n- contact: ana@acme.com",
        baseVersion: 2,
        reason: "  New contact from today's call ",
        userId: "x",
      }),
    );
    expect(calls).toEqual([
      {
        route: "propose",
        body: {
          eventId: "evt-1",
          agentId: BOT,
          scope: TEAM_SCOPE,
          path: "clients/acme.md",
          op: "replace",
          content: "# Acme\n- contact: ana@acme.com",
          baseVersion: 2,
          reason: "New contact from today's call",
        },
      },
    ]);
    expect(r).toMatch(/^Proposed\. A person must approve it before it is saved\./);
    expect(r).toContain("Found: email (2), phone (1).");
    expect(r).toContain("12 people could read it once approved.");
    expect(r).not.toContain("a•••@acme.com");
  });

  it("is still allowed after untrusted content (not side-effecting): the gate lets it through and the API decides", async () => {
    const { calls, guard, tool, begin } = setup({
      propose: async () => ({ approvalId: "ap-1", findings: [], readerCount: 1 }),
    });
    begin();
    const c = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) };
    expect(await guard.beforeToolCall({ toolName: "web_search", params: { query: "x" } }, c)).toBeUndefined();
    expect(await guard.beforeToolCall({ toolName: "ocw_memory_propose", params: {} }, c)).toBeUndefined();
    const r = text(
      await tool("ocw_memory_propose").execute("tc-1", {
        scope: "personal",
        path: "MEMORY.md",
        op: "append",
        content: "- read on the web: likes tea",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(r).toMatch(/^Proposed\./);
    expect(r).toContain("No sensitive data found.");
    expect(r).toContain("1 person could read it once approved.");
  });

  it("secret_detected and other refusals become fixed sentences", async () => {
    const { tool, begin } = setup({ propose: async () => ({ refused: "secret_detected" }) });
    begin();
    expect(
      text(
        await tool("ocw_memory_propose").execute("tc-1", {
          scope: TEAM_SCOPE,
          path: "a.md",
          op: "create",
          content: "token sk-abcdefghijklmnopqrstuvwxyz",
        }),
      ),
    ).toBe("Not proposed: it contains a secret. Remove it and try again.");
  });

  it("refuses locally an invalid op, path, scope, base version, a reason over 280 characters and content over 256 KiB", async () => {
    const { calls, tool, begin } = setup({
      propose: async () => ({ approvalId: "ap-1", findings: [], readerCount: 1 }),
    });
    begin();
    const t = tool("ocw_memory_propose");
    const base = { scope: TEAM_SCOPE, path: "a.md", op: "create", content: "x" };
    expect(text(await t.execute("tc-1", { ...base, op: "delete" }))).toMatch(/^Not proposed: op must be/);
    expect(text(await t.execute("tc-2", { ...base, path: "a.txt" }))).toBe(
      "Not proposed: the path is not valid (extension).",
    );
    expect(text(await t.execute("tc-3", { ...base, scope: "team" }))).toMatch(/^Not proposed: unknown scope/);
    expect(text(await t.execute("tc-4", { ...base, baseVersion: 0 }))).toMatch(/^Not proposed: baseVersion/);
    expect(text(await t.execute("tc-5", { ...base, reason: "r".repeat(281) }))).toBe(
      "Not proposed: the reason can be at most 280 characters.",
    );
    expect(text(await t.execute("tc-6", { ...base, content: "x".repeat(262_145) }))).toBe(
      "Not proposed: the content is over 256 KiB.",
    );
    expect(calls).toEqual([]);
    // An empty reason is simply left out.
    await t.execute("tc-7", { ...base, reason: "   " });
    expect(calls[0]?.body).not.toHaveProperty("reason");
  });
});

describe("list, write and propose through the fake Agent Channel API (HTTP)", () => {
  let api: FakeAgentChannelApi;
  beforeEach(async () => {
    api = await startFakeAgentChannelApi({ agents: [], providers: [] });
  });
  afterEach(async () => {
    await api.close();
  });

  function http() {
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const guard = createToolGuard({ client: () => client });
    const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
    registerMemoryFileTools(
      {
        registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }),
      } as never,
      { guard, client: () => client },
    );
    guard.beginTurn(SESSION, { eventId: "evt-h1", agentId: BOT, turn: turn(), conversationId: DM });
    return (name: string) => {
      const r = registered.find((x) => x.opts.name === name);
      if (!r) throw new Error(name);
      return r.factory({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) });
    };
  }

  it("write then list then read: the fake store round-trips; propose answers an approval; strict bodies only", async () => {
    api.memoryScopes.push(...SCOPES);
    const tool = http();
    expect(
      text(
        await tool("ocw_memory_write").execute("tc-1", {
          scope: "personal",
          path: "MEMORY.md",
          mode: "append",
          content: "- likes tea",
        }),
      ),
    ).toBe("Saved. MEMORY.md is now version 1.");
    expect(text(await tool("ocw_memory_list").execute("tc-2", {}))).toContain("Sales team (unit)");
    expect(text(await tool("ocw_memory_list").execute("tc-3", { scope: "personal" }))).toContain(
      "MEMORY.md (version 1)",
    );
    expect(
      text(await tool("ocw_memory_read").execute("tc-4", { scope: "personal", path: "memory.md" })),
    ).toBe("MEMORY.md (version 1)\n\n- likes tea");
    const proposed = text(
      await tool("ocw_memory_propose").execute("tc-5", {
        scope: TEAM_SCOPE,
        path: "clients/acme.md",
        op: "create",
        content: "# Acme\nana@acme.com",
      }),
    );
    expect(proposed).toContain("Found: email (1).");
    expect(
      text(
        await tool("ocw_memory_propose").execute("tc-6", {
          scope: TEAM_SCOPE,
          path: "clients/acme.md",
          op: "create",
          content: "key sk-abcdefghijklmnopqrstuvwxyz",
        }),
      ),
    ).toBe("Not proposed: it contains a secret. Remove it and try again.");
    expect(api.memoryCalls.map((c) => c.route)).toEqual([
      "write",
      "list",
      "list",
      "read",
      "propose",
      "propose",
    ]);
    for (const c of api.memoryCalls) {
      expect(c.body.eventId).toBe("evt-h1");
      expect(c.body.agentId).toBe(BOT);
      expect(Object.keys(c.body).filter((k) => /user|owner/i.test(k))).toEqual([]);
    }
  });
});
