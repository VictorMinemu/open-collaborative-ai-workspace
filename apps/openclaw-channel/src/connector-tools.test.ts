import { describe, expect, it } from "vitest";
import {
  AGENT_CHANNEL_TOOL_REFUSALS,
  type AgentChannelConnectorCall,
  type AgentChannelConnectorCallResponse,
  type AgentChannelConnectorList,
  type AgentChannelConnectorListResponse,
  type AgentChannelHttpRequest,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import {
  CONNECTOR_TOOL_NAMES,
  type ConnectorToolContext,
  MEMBER_ACCOUNT,
  NEEDS_RECONNECT,
  NOT_CONNECTED,
  REFUSAL_SENTENCE,
  registerConnectorTools,
  UNREACHABLE,
} from "./connector-tools.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { APPROVAL_SENTENCES, createToolGuard } from "./tool-guard.js";

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

describe("ocw_connector_list and ocw_http_request (07.4 D-07, CONN-05)", () => {
  const KEYS_TURN = turn({
    tools: ["ocw_connector_list", "ocw_connector_call", "ocw_http_request", "m1a2b3c4d__whoami"],
    toolFlags: {
      ocw_connector_list: LIST,
      ocw_connector_call: READ,
      ocw_http_request: READ,
      m1a2b3c4d__whoami: READ,
    },
  });
  const LISTED: AgentChannelConnectorListResponse = {
    connectors: [
      {
        connector: "m1a2b3c4d",
        name: "Acme CRM",
        status: "connected",
        tools: [
          {
            name: "whoami",
            description: "Returns the signed-in user.",
            inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } },
          },
        ],
      },
      { connector: "m0000beef", name: "Tickets", status: "not_connected", tools: [] },
    ],
    keys: [{ handle: "k_abcdefgh23", name: "Billing API", allowedHosts: ["api.example.com"] }],
  };

  function setup2(over: Partial<Record<"list" | "http", (req: never) => Promise<unknown>>> = {}) {
    const lists: AgentChannelConnectorList[] = [];
    const requests: AgentChannelHttpRequest[] = [];
    const client = {
      listConnectors: async (req: AgentChannelConnectorList) => {
        lists.push(req);
        return over.list ? over.list(req as never) : LISTED;
      },
      httpRequest: async (req: AgentChannelHttpRequest) => {
        requests.push(req);
        return over.http
          ? over.http(req as never)
          : {
              status: 200,
              contentType: "application/json",
              body: '{"login":"vic"}',
              truncated: false,
              redirectHost: null,
            };
      },
    } as unknown as AgentChannelClient;
    const guard = createToolGuard({ client: () => client });
    const registered: Registered[] = [];
    registerConnectorTools(
      {
        registerTool: (factory: Registered["factory"], opts: { name: string }) =>
          registered.push({ factory, opts }),
      } as never,
      { guard, client: () => client },
    );
    const tool = (name: string) => {
      const r = registered.find((x) => x.opts.name === name);
      if (!r) throw new Error(`${name} was not registered`);
      return r.factory({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) }) as Tool;
    };
    const begin = (t: TurnContext = KEYS_TURN) =>
      guard.beginTurn(SESSION, {
        eventId: "evt-1",
        agentId: BOT,
        turn: { ...t, tools: t.tools.filter((x) => !x.includes("__")) },
        connectorTools: t.tools.filter((x) => x.includes("__")),
        conversationId: DM,
      });
    return { lists, requests, guard, registered, tool, begin };
  }

  it("registers the three fixed tools, in order", () => {
    const { registered } = setup2();
    expect(registered.map((r) => r.opts.name)).toEqual([...CONNECTOR_TOOL_NAMES]);
    expect(CONNECTOR_TOOL_NAMES).toEqual(["ocw_connector_list", "ocw_connector_call", "ocw_http_request"]);
  });

  it("ocw_connector_list posts {eventId, agentId} and renders connectors, tools with their schemas, and key handles", async () => {
    const { lists, begin, tool, guard } = setup2();
    begin();
    const r = text(await tool("ocw_connector_list").execute("tc-1", {}));
    expect(lists).toEqual([{ eventId: "evt-1", agentId: BOT }]);
    expect(r).toContain("Acme CRM [m1a2b3c4d] — connected");
    expect(r).toContain("whoami: Returns the signed-in user.");
    expect(r).toContain('{"type":"object","properties":{"verbose":{"type":"boolean"}}}');
    expect(r).toMatch(/Tickets \[m0000beef\] — not connected/);
    expect(r).toContain("Billing API [k_abcdefgh23] — hosts: api.example.com");
    // Listing reads the workspace's own catalog: it does not taint the turn.
    expect(guard.activeTurn(SESSION)?.tainted).toBe(false);
  });

  it("a list the turn carries as untrusted (per-member connectors) taints the turn (WINDOWS #192)", async () => {
    const { begin, tool, guard } = setup2();
    begin({
      ...KEYS_TURN,
      toolFlags: {
        ...KEYS_TURN.toolFlags,
        ocw_connector_list: { untrustedOutput: true, sideEffecting: false },
      },
    });
    await tool("ocw_connector_list").execute("tc-1", {});
    expect(guard.activeTurn(SESSION)?.tainted).toBe(true);
  });

  it("an empty list says so", async () => {
    const { begin, tool } = setup2({ list: async () => ({ connectors: [], keys: [] }) });
    begin();
    expect(text(await tool("ocw_connector_list").execute("tc-1", {}))).toMatch(/No connectors or keys/);
  });

  it("ocw_http_request posts exactly {eventId, agentId, handle, method, url, headers?, body?} and renders the response", async () => {
    const { requests, begin, tool, guard } = setup2();
    begin();
    const r = await tool("ocw_http_request").execute("tc-1", {
      handle: "k_abcdefgh23",
      method: "get",
      url: "https://api.example.com/v1/me",
      userId: "someone-else",
    });
    expect(requests).toEqual([
      {
        eventId: "evt-1",
        agentId: BOT,
        handle: "k_abcdefgh23",
        method: "GET",
        url: "https://api.example.com/v1/me",
      },
    ]);
    expect(text(r)).toBe('HTTP 200 (application/json)\n{"login":"vic"}');
    // The response is untrusted: the turn is read-only from here on.
    expect(guard.activeTurn(SESSION)?.tainted).toBe(true);
    await tool("ocw_http_request").execute("tc-2", {
      handle: "k_abcdefgh23",
      method: "POST",
      url: "https://api.example.com/v1/notes",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(requests[1]).toEqual({
      eventId: "evt-1",
      agentId: BOT,
      handle: "k_abcdefgh23",
      method: "POST",
      url: "https://api.example.com/v1/notes",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("a redirect is named by host and never followed; a truncated body says so", async () => {
    const { begin, tool } = setup2({
      http: async () => ({
        status: 302,
        contentType: null,
        body: "",
        truncated: true,
        redirectHost: "login.example.org",
      }),
    });
    begin();
    const r = text(
      await tool("ocw_http_request").execute("tc-1", {
        handle: "k_abcdefgh23",
        method: "GET",
        url: "https://api.example.com/",
      }),
    );
    expect(r).toContain("HTTP 302");
    expect(r).toContain("Redirected to login.example.org (not followed)");
    expect(r).toContain("truncated");
  });

  it("refuses invalid handles, methods, URLs, headers and bodies locally", async () => {
    const { requests, begin, tool } = setup2();
    begin();
    const t = tool("ocw_http_request");
    const base = { handle: "k_abcdefgh23", method: "GET", url: "https://api.example.com/" };
    expect(text(await t.execute("1", { ...base, handle: "sk-live-123" }))).toMatch(/handle/);
    expect(text(await t.execute("2", { ...base, method: "TRACE" }))).toMatch(/method/);
    expect(text(await t.execute("3", { ...base, url: "file:///etc/passwd" }))).toMatch(/url/i);
    expect(text(await t.execute("4", { ...base, headers: { "bad header": "x" } }))).toMatch(/header/);
    expect(text(await t.execute("5", { ...base, headers: { a: "x\r\ny: z" } }))).toMatch(/header/);
    expect(text(await t.execute("6", { ...base, body: "x".repeat(64 * 1024 + 1) }))).toMatch(/body/);
    expect(requests).toEqual([]);
  });

  it("a tool the turn does not offer is refused locally", async () => {
    const { requests, lists, begin, tool } = setup2();
    begin(turn({ tools: ["ocw_connector_call"] }));
    expect(text(await tool("ocw_connector_list").execute("1", {}))).toMatch(/not available/);
    expect(
      text(
        await tool("ocw_http_request").execute("2", {
          handle: "k_abcdefgh23",
          method: "GET",
          url: "https://api.example.com/",
        }),
      ),
    ).toMatch(/not available/);
    expect([...requests, ...lists]).toEqual([]);
  });
});

/** 07.5-04: the refusals a person's approval answers (each a fixed sentence naming the logical tool). */
const APPROVAL_CODES = [
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "arguments_too_large",
  "arguments_invalid",
  "too_many_pending",
] as const;

describe("refusals are fixed sentences (CONN-04, D-03, T-07.4-09-04)", () => {
  // Every refusal code the API sends has a case (WINDOWS #191 added unit_audience).
  const CASES: Array<[number, keyof typeof REFUSAL_SENTENCE]> = [
    [404, "unknown_turn"],
    [409, "not_in_turn"],
    [409, "policy_changed"],
    [409, "cap_reached"],
    [409, "tainted"],
    [409, "member_account"],
    [409, "unit_audience"],
    [409, "not_connected"],
    [409, "needs_reconnect"],
    [409, "handle_not_allowed"],
    [409, "host_not_allowed"],
    [502, "egress_refused"],
    [502, "upstream_error"],
    [502, "timeout"],
  ];

  it("covers every refusal code of the protocol (07.5's approval codes have their own sentences, below)", () => {
    expect([...CASES.map(([, code]) => code), ...APPROVAL_CODES].sort()).toEqual(
      [...AGENT_CHANNEL_TOOL_REFUSALS].sort(),
    );
  });

  it.each(CASES)("%i %s → one fixed sentence, never the API body", async (status, code) => {
    const fail = async () => {
      throw new AgentChannelHttpError(status, "/x", `${status} ${CANARY}`, code);
    };
    const { begin, tool } = setup(fail);
    begin(
      turn({
        tools: ["ocw_connector_call", "m1a2b3c4d__whoami"],
        toolFlags: { m1a2b3c4d__whoami: READ },
      }),
    );
    const r = await tool("ocw_connector_call").execute("tc-1", CALL);
    expect(text(r)).toBe(REFUSAL_SENTENCE[code]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("the connect and member-account sentences are the UI contract's", () => {
    expect(REFUSAL_SENTENCE.not_connected).toBe(NOT_CONNECTED);
    // 07.4-14 (WINDOWS #198): a sign-in that stopped working asks to reconnect, not to connect.
    expect(REFUSAL_SENTENCE.needs_reconnect).toBe(NEEDS_RECONNECT);
    expect(NOT_CONNECTED).toBe(
      "You haven't connected your account for this connector yet. I posted a link so you can connect it, then ask me again.",
    );
    expect(NEEDS_RECONNECT).toBe(
      "Your sign-in for this connector stopped working. I posted a link so you can reconnect it, then ask me again.",
    );
    expect(MEMBER_ACCOUNT).toBe(
      "This uses your own account, so I can only do it in our private chat, or after you allow it for this conversation in Settings › Connections.",
    );
    expect(REFUSAL_SENTENCE.member_account).toBe(MEMBER_ACCOUNT);
    // One distinct sentence per code.
    const others = Object.entries(REFUSAL_SENTENCE);
    expect(new Set(others.map(([, s]) => s)).size).toBe(others.length);
  });

  it("a thrown network error (or an unknown code) is the unreachable sentence, never its message", async () => {
    const { begin, tool } = setup(async () => {
      throw new Error(`socket hang up ${CANARY}`);
    });
    begin();
    const r = await tool("ocw_connector_call").execute("tc-1", CALL);
    expect(text(r)).toBe(UNREACHABLE);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("a refusal recognised across module instances by the shared brand (07.2-15), not the class identity", async () => {
    const foreign = Object.assign(new Error(`409 ${CANARY}`), {
      [Symbol.for("ocw.openclaw-channel.agent-channel-http-error")]: true,
      status: 409,
      path: "/connectors/call",
      code: "member_account",
    });
    const { begin, tool } = setup(async () => {
      throw foreign;
    });
    begin();
    expect(text(await tool("ocw_connector_call").execute("tc-1", CALL))).toBe(MEMBER_ACCOUNT);
  });

  it("a successful call taints the turn (untrusted output), a refusal does not", async () => {
    const { begin, tool, guard } = setup();
    begin();
    await tool("ocw_connector_call").execute("tc-1", CALL);
    expect(guard.activeTurn(SESSION)?.tainted).toBe(true);
    const refused = setup(async () => {
      throw new AgentChannelHttpError(409, "/x", "409", "not_connected");
    });
    refused.begin();
    await refused.tool("ocw_connector_call").execute("tc-1", CALL);
    expect(refused.guard.activeTurn(SESSION)?.tainted).toBe(false);
  });
});

describe("approval-aware connector tools (07.5-04, D-04)", () => {
  const INVOICE = "m1a2b3c4d__create_invoice";
  const FLAGGED = { untrustedOutput: true, sideEffecting: true, approval: "when_tainted" as const };
  const WRITE = { untrustedOutput: true, sideEffecting: true };
  const APPROVAL = {
    id: "0199a6f0-0000-7000-8000-0000000000a1",
    created: true,
    waitingFor: "a lead of Sales",
    requesterName: "Ana Pérez",
  };
  const CREATE = { connector: "m1a2b3c4d", tool: "create_invoice", arguments: { amount: 10 } };
  const POST = { handle: "k_abcdefgh23", method: "POST", url: "https://erp.example/invoices", body: "{}" };

  /** The gate and the three tools over one fake client, as OpenClaw runs them: before_tool_call, then execute. */
  function approvalSetup(opts: { flagged: boolean; fail?: () => never }) {
    const calls: AgentChannelConnectorCall[] = [];
    const requests: AgentChannelHttpRequest[] = [];
    const client = {
      callConnector: async (req: AgentChannelConnectorCall) => {
        calls.push(req);
        if (opts.fail && req.tool !== "whoami") opts.fail();
        return { content: `${req.tool}: ok`, truncated: false, isError: false };
      },
      httpRequest: async (req: AgentChannelHttpRequest) => {
        requests.push(req);
        if (opts.fail) opts.fail();
        return { status: 201, contentType: null, body: "created", truncated: false, redirectHost: null };
      },
    } as unknown as AgentChannelClient;
    const guard = createToolGuard({ client: () => client });
    const registered: Registered[] = [];
    registerConnectorTools(
      {
        registerTool: (factory: Registered["factory"], o: { name: string }) =>
          registered.push({ factory, opts: o }),
      } as never,
      { guard, client: () => client },
    );
    const ctx = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) };
    const tool = (name: string) => registered.find((r) => r.opts.name === name)?.factory(ctx) as Tool;
    guard.beginTurn(SESSION, {
      eventId: "evt-ap",
      agentId: BOT,
      conversationId: DM,
      requesterName: "Ana Pérez",
      turn: {
        ...turn(),
        tools: ["ocw_connector_list", "ocw_connector_call", "ocw_http_request"],
        toolFlags: {
          m1a2b3c4d__whoami: READ,
          [INVOICE]: opts.flagged ? FLAGGED : WRITE,
          ocw_http_request: opts.flagged ? FLAGGED : WRITE,
        },
      },
      connectorTools: ["m1a2b3c4d__whoami", INVOICE],
    });
    let n = 0;
    /** before_tool_call, then (when not blocked) the tool's execute. */
    const run = async (name: string, params: Record<string, unknown>) => {
      const id = `tc-${++n}`;
      const gate = await guard.beforeToolCall({ toolName: name, params, toolCallId: id }, ctx);
      if (gate) return { blocked: gate.blockReason };
      return { text: text(await tool(name).execute(id, params)) };
    };
    return { calls, requests, guard, run };
  }

  it("after taint a flagged logical tool is posted to /connectors/call (the API decides); unflagged it is refused locally", async () => {
    const flagged = approvalSetup({ flagged: true });
    expect(await flagged.run("ocw_connector_call", { ...CALL })).toEqual({ text: "whoami: ok" });
    expect(flagged.guard.activeTurn(SESSION)?.tainted).toBe(true);
    expect(await flagged.run("ocw_connector_call", CREATE)).toEqual({ text: "create_invoice: ok" });
    expect(flagged.calls.map((c) => c.tool)).toEqual(["whoami", "create_invoice"]);
    expect(flagged.calls[1]?.arguments).toEqual({ amount: 10 });

    const plain = approvalSetup({ flagged: false });
    await plain.run("ocw_connector_call", { ...CALL });
    expect((await plain.run("ocw_connector_call", CREATE)).blocked).toContain(
      "read-only after untrusted content",
    );
    expect(plain.calls.map((c) => c.tool)).toEqual(["whoami"]);
  });

  it("ocw_http_request with approval on its own flags behaves the same with /http-requests", async () => {
    const flagged = approvalSetup({ flagged: true });
    await flagged.run("ocw_connector_call", { ...CALL });
    expect(await flagged.run("ocw_http_request", POST)).toEqual({ text: "HTTP 201\ncreated" });
    expect(flagged.requests).toHaveLength(1);
    const plain = approvalSetup({ flagged: false });
    await plain.run("ocw_connector_call", { ...CALL });
    expect((await plain.run("ocw_http_request", POST)).blocked).toContain(
      "read-only after untrusted content",
    );
    expect(plain.requests).toHaveLength(0);
  });

  it("a 409 approval_required with details is the approval sentence naming the logical tool, never the body", async () => {
    const { run } = approvalSetup({
      flagged: true,
      fail: () => {
        throw new AgentChannelHttpError(
          409,
          "/connectors/call",
          `409 ${CANARY}`,
          "approval_required",
          APPROVAL,
        );
      },
    });
    const r = await run("ocw_connector_call", CREATE);
    expect(r).toEqual({
      text: "This action needs approval. I posted a card and asked a lead of Sales. Tell Ana Pérez in one short sentence that you are waiting for that approval, without repeating the values. Don't call m1a2b3c4d__create_invoice again now: when it is approved you will get a new message with the exact arguments.",
    });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it.each(APPROVAL_CODES)(
    "%s from /connectors/call and /http-requests → its approval sentence",
    async (code) => {
      const approval = code === "approval_pending" ? APPROVAL : undefined;
      const { run } = approvalSetup({
        flagged: true,
        fail: () => {
          throw new AgentChannelHttpError(409, "/x", `409 ${CANARY}`, code, approval);
        },
      });
      const viaConnector = await run("ocw_connector_call", CREATE);
      expect(viaConnector).toEqual({
        text: APPROVAL_SENTENCES[code]({
          tool: INVOICE,
          waitingFor: approval?.waitingFor,
          requesterName: "Ana Pérez",
        }),
      });
      const viaHttp = await run("ocw_http_request", POST);
      expect(viaHttp).toEqual({
        text: APPROVAL_SENTENCES[code]({
          tool: "ocw_http_request",
          waitingFor: approval?.waitingFor,
          requesterName: "Ana Pérez",
        }),
      });
      expect(JSON.stringify([viaConnector, viaHttp])).not.toContain(CANARY);
    },
  );

  it("07.5-11: a 409 approval_denied with details names the decider and their note, never the body", async () => {
    const { run } = approvalSetup({
      flagged: true,
      fail: () => {
        throw new AgentChannelHttpError(
          409,
          "/connectors/call",
          `409 ${CANARY}`,
          "approval_denied",
          undefined,
          {
            deciderName: "Marta Gil",
            note: "Duplicate invoice",
          },
        );
      },
    });
    const r = await run("ocw_connector_call", CREATE);
    expect(r).toEqual({
      text: "Marta Gil denied this exact action. Their note: “Duplicate invoice”. Don't retry it. Tell Ana Pérez it was denied and ask what to change.",
    });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("the approval sentences are the UI contract's", () => {
    const p = { tool: INVOICE, waitingFor: "a lead of Sales", requesterName: "Ana Pérez" };
    expect(APPROVAL_SENTENCES.approval_pending(p)).toBe(
      "This exact action is already waiting for approval in a card. Don't ask again; tell Ana Pérez it is still waiting.",
    );
    expect(APPROVAL_SENTENCES.approval_denied(p)).toBe(
      "A lead of Sales denied this exact action. Don't retry it. Tell Ana Pérez it was denied and ask what to change.",
    );
    expect(APPROVAL_SENTENCES.too_many_pending(p)).toBe(
      "Ana Pérez already has 5 actions waiting for approval from you. Wait for those first.",
    );
  });
});
