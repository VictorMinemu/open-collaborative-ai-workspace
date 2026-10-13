import { describe, expect, it } from "vitest";
import type {
  AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import {
  CONNECTOR_TOOL_NAMES,
  type ConnectorToolContext,
  NOT_CONNECTED,
  registerConnectorTools,
} from "./connector-tools.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { createToolGuard } from "./tool-guard.js";

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const DM = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${DM}`;
const LIST = { untrustedOutput: false, sideEffecting: false };
const READ = { untrustedOutput: true, sideEffecting: false };
const CANARY = "canary-api-body-7f3a";

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["ocw_connector_list", "ocw_connector_call", "m1a2b3c4d__whoami"],
    toolFlags: { ocw_connector_list: LIST, ocw_connector_call: READ, m1a2b3c4d__whoami: READ },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};
type Registered = { factory: (ctx: ConnectorToolContext) => unknown; opts: { name: string } };

function setup(
  respond: (req: AgentChannelConnectorCall) => Promise<AgentChannelConnectorCallResponse> = async () => ({
    content: "whoami: sub_smoke",
    truncated: false,
    isError: false,
  }),
) {
  const calls: AgentChannelConnectorCall[] = [];
  const client = {
    callConnector: async (req: AgentChannelConnectorCall) => {
      calls.push(req);
      return respond(req);
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Registered[] = [];
  const api = {
    registerTool: (factory: Registered["factory"], opts: { name: string }) =>
      registered.push({ factory, opts }),
  };
  const logs: string[] = [];
  registerConnectorTools(api as never, {
    guard,
    client: () => client,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const tool = (
    name: string,
    ctx: ConnectorToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) },
  ) => {
    const r = registered.find((x) => x.opts.name === name);
    if (!r) throw new Error(`${name} was not registered`);
    return r.factory(ctx) as Tool;
  };
  // As the port begins it: the run's OpenClaw tools in `turn.tools`, the logical connector tools beside them.
  const begin = (t: TurnContext = turn(), eventId = "evt-1") =>
    guard.beginTurn(SESSION, {
      eventId,
      agentId: BOT,
      turn: { ...t, tools: t.tools.filter((x) => !x.includes("__")) },
      connectorTools: t.tools.filter((x) => x.includes("__")),
      conversationId: DM,
    });
  return { calls, guard, registered, tool, logs, begin };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");
const CALL = { connector: "m1a2b3c4d", tool: "whoami", arguments: {} };

describe("ocw_connector_call (07.4 D-07, C-01): a thin, credential-free caller of POST /connectors/call", () => {
  it("is registered under its fixed name with a closed parameter schema", () => {
    const { registered, tool } = setup();
    expect(CONNECTOR_TOOL_NAMES).toContain("ocw_connector_call");
    expect(registered.map((r) => r.opts.name)).toContain("ocw_connector_call");
    const t = tool("ocw_connector_call");
    expect(t.name).toBe("ocw_connector_call");
    expect(t.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["connector", "tool"],
    });
    expect(t.description).toMatch(/ocw_connector_list/);
  });

  it("posts exactly {eventId, agentId, connector, tool, arguments} and answers with the API's content", async () => {
    const { calls, begin, tool, logs } = setup();
    begin();
    const r = await tool("ocw_connector_call").execute("tc-1", {
      ...CALL,
      arguments: { q: "secret-arg" },
      userId: "someone-else",
    });
    expect(calls).toEqual([
      {
        eventId: "evt-1",
        agentId: BOT,
        connector: "m1a2b3c4d",
        tool: "whoami",
        arguments: { q: "secret-arg" },
      },
    ]);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual([
      "agentId",
      "arguments",
      "connector",
      "eventId",
      "tool",
    ]);
    expect(text(r)).toBe("whoami: sub_smoke");
    // Logs carry ids and codes only, never arguments or content.
    expect(logs.join("\n")).not.toMatch(/secret-arg|sub_smoke/);
  });

  it("without an active turn refuses locally and posts nothing", async () => {
    const { calls, tool } = setup();
    const r = await tool("ocw_connector_call").execute("tc-1", CALL);
    expect(calls).toEqual([]);
    expect(text(r)).toMatch(/no active conversation turn/i);
  });

  it("a logical tool the turn does not offer is refused locally (nothing posted)", async () => {
    const { calls, begin, tool } = setup();
    begin();
    const r = await tool("ocw_connector_call").execute("tc-1", { ...CALL, tool: "delete_all" });
    expect(calls).toEqual([]);
    expect(text(r)).toMatch(/not available/i);
    // The static tool itself not on the turn: refused too.
    begin(turn({ tools: ["m1a2b3c4d__whoami"] }), "evt-2");
    expect(text(await tool("ocw_connector_call").execute("tc-2", CALL))).toMatch(/not available/i);
    expect(calls).toEqual([]);
  });

  it("uses the turn's own spelling of the logical tool name", async () => {
    const { calls, begin, tool } = setup();
    begin(turn({ tools: ["ocw_connector_call", "m1a2b3c4d__getFile"], toolFlags: {} }));
    await tool("ocw_connector_call").execute("tc-1", { ...CALL, tool: "getfile" });
    expect(calls[0]?.tool).toBe("getFile");
  });

  it("refuses an invalid connector name or arguments locally", async () => {
    const { calls, begin, tool } = setup();
    begin();
    const t = tool("ocw_connector_call");
    expect(text(await t.execute("tc-1", { ...CALL, connector: "../etc" }))).toMatch(/connector/i);
    expect(text(await t.execute("tc-2", { ...CALL, arguments: [1, 2] }))).toMatch(/arguments/i);
    expect(text(await t.execute("tc-3", { connector: "m1a2b3c4d" }))).toMatch(/tool/i);
    expect(calls).toEqual([]);
  });

  it("a refusal is a fixed sentence, never the API body; not connected says a connect link was posted", async () => {
    const { begin, tool } = setup(async () => {
      throw new AgentChannelHttpError(409, "/connectors/call", `409 ${CANARY}`, "not_connected");
    });
    begin();
    const r = await tool("ocw_connector_call").execute("tc-1", CALL);
    expect(text(r)).toBe(NOT_CONNECTED);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});
