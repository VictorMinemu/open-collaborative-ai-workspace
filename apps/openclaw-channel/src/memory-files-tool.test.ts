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
    expect(registered.map((r) => r.opts.name)).toEqual(["ocw_memory_read"]);
    for (const name of registered.map((r) => r.opts.name)) {
      const t = tool(name);
      expect(t.name).toBe(name);
      expect(t.parameters.type).toBe("object");
      expect(t.parameters.additionalProperties).toBe(false);
      // No parameter can name whose memory it is: the API binds the human to the delivered turn.
      expect(Object.keys(t.parameters.properties)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/user|owner/i)]),
      );
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
