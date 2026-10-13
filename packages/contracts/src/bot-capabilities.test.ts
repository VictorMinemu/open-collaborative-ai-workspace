import { describe, expect, it } from "vitest";
import {
  AgentChannelMemorySave,
  AgentChannelToolCallRequest,
  AgentMentionEvent,
  BotPolicy,
  BUILTIN_TOOLS,
  CellAgent,
  CellConfigChangedEvent,
  CellSnapshot,
  DANGEROUS_TOOL_NAMES,
  DEFAULT_BOT_POLICY,
  DEFAULT_CAPABILITIES,
  isDangerousToolName,
  TurnContext,
  UpdateBotCapabilitiesRequest,
  UpdateBotPolicyRequest,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-05T10:00:00.000Z";

const mentionEvent = {
  eventId: ID,
  seq: 1,
  type: "agent.mention.v1",
  organizationId: ID,
  cellId: ID,
  agent: { id: ID2, handle: "sams-assistant", displayName: "Sam's assistant" },
  conversation: { id: ID, kind: "dm", name: null },
  thread: { rootMessageId: ID },
  message: {
    id: ID,
    text: "hello",
    createdAt: NOW,
    author: { kind: "user", id: ID, displayName: "Sam" },
    mentions: [],
  },
  threadHistory: [],
  roster: [],
};

const turn = {
  tools: ["web_search", "web_fetch", "ocw_memory_save"],
  toolFlags: {
    web_search: { untrustedOutput: true, sideEffecting: false },
    ocw_memory_save: { untrustedOutput: false, sideEffecting: true },
  },
  memory: [{ id: ID, text: "Prefers short answers", createdAt: NOW }],
  now: { iso: NOW, timeZone: "Europe/Madrid", local: "Monday 5 October 2026 at 12:00" },
  maxToolCalls: 8,
  maxWebCalls: 5,
};

describe("capability defaults (D-06)", () => {
  it("personal bots remember by default, team bots do not", () => {
    expect(DEFAULT_CAPABILITIES.personal.memory).toBe(true);
    expect(DEFAULT_CAPABILITIES.team.memory).toBe(false);
    expect(DEFAULT_CAPABILITIES.personal).toEqual({
      internet: false,
      memory: true,
      dateTime: true,
      replyMode: "mentions",
      dailyLimit: 30,
    });
    expect(DEFAULT_CAPABILITIES.team).toEqual({
      internet: false,
      memory: false,
      dateTime: true,
      replyMode: "mentions",
      dailyLimit: 100,
    });
  });

  it("the default org policy allows everything with DuckDuckGo, 3 personal bots and 100 turns", () => {
    expect(DEFAULT_BOT_POLICY.searchProvider).toBe("duckduckgo");
    expect(DEFAULT_BOT_POLICY.maxPersonalBotsPerUser).toBe(3);
    expect(DEFAULT_BOT_POLICY.personalDailyLimitMax).toBe(100);
    expect(DEFAULT_BOT_POLICY.personalAllowedModels).toEqual([]);
    for (const entry of Object.values(DEFAULT_BOT_POLICY.capabilities)) {
      expect(entry).toEqual({ orgWide: true, personal: true });
    }
    expect(BotPolicy.parse({ ...DEFAULT_BOT_POLICY, updatedAt: null }).updatedAt).toBeNull();
  });
});

describe("update requests", () => {
  it("rejects a daily limit of 0 and accepts a partial update with tool grants", () => {
    expect(UpdateBotCapabilitiesRequest.safeParse({ dailyLimit: 0 }).success).toBe(false);
    expect(UpdateBotCapabilitiesRequest.safeParse({ dailyLimit: 10_001 }).success).toBe(false);
    const ok = UpdateBotCapabilitiesRequest.parse({
      internet: true,
      tools: [{ sourceKind: "mcp", sourceId: ID, tool: "m3f9a12c4__echo" }],
    });
    expect(ok.tools).toHaveLength(1);
    expect(UpdateBotCapabilitiesRequest.safeParse({ replyMode: "sometimes" }).success).toBe(false);
  });

  it("policy updates are partial and bounded", () => {
    expect(UpdateBotPolicyRequest.parse({}).searchProvider).toBeUndefined();
    expect(UpdateBotPolicyRequest.safeParse({ maxPersonalBotsPerUser: 21 }).success).toBe(false);
    expect(UpdateBotPolicyRequest.safeParse({ searchProvider: "brave" }).success).toBe(false);
  });
});

describe("dangerous tool names (D-08, Pitfall 3)", () => {
  it.each([
    "exec",
    "process",
    "write",
    "edit",
    "apply_patch",
    "browser",
    "canvas",
    "gateway",
    "nodes",
    "message",
    "x_search",
    "code_execution",
    "run_shell",
    "computer_use",
    "fs_write",
    "delete_file",
    "sessions_send",
    "group:runtime",
    "m3f9a12c4__exec",
    "runShell",
    "move_file",
    "send_email",
  ])("%s is dangerous", (name) => {
    expect(isDangerousToolName(name)).toBe(true);
  });

  it.each([
    "web_search",
    "web_fetch",
    "ocw_memory_save",
    "m3f9a12c4__echo",
    "m3f9a12c4__search",
    "m3f9a12c4__write_note",
    "lookup_customer",
  ])("%s is not dangerous", (name) => {
    expect(isDangerousToolName(name)).toBe(false);
  });

  it("the exact list never contains a wildcard or a built-in tool, and every built-in is safe", () => {
    expect(DANGEROUS_TOOL_NAMES).not.toContain("*");
    for (const t of Object.values(BUILTIN_TOOLS)) {
      expect(DANGEROUS_TOOL_NAMES).not.toContain(t);
      expect(isDangerousToolName(t)).toBe(false);
    }
    for (const name of DANGEROUS_TOOL_NAMES) expect(isDangerousToolName(name)).toBe(true);
  });
});

describe("agent channel additions are backward compatible", () => {
  it("a mention event without `turn` still parses", () => {
    const parsed = AgentMentionEvent.parse(mentionEvent);
    expect(parsed.turn).toBeUndefined();
  });

  it("a mention event with `turn` round-trips", () => {
    const parsed = AgentMentionEvent.parse({ ...mentionEvent, turn });
    expect(parsed.turn).toEqual(turn);
    expect(AgentMentionEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(TurnContext.safeParse({ ...turn, tools: Array(65).fill("x") }).success).toBe(false);
  });

  it("cell agents default to no tools and the snapshot to DuckDuckGo", () => {
    const agent = CellAgent.parse({
      id: ID,
      handle: "bot",
      displayName: "Bot",
      avatarUrl: null,
      description: null,
      instructions: "x",
      status: "ready",
      modelRef: "fake/mock-1",
      model: { provider: "mock", providerId: "fake", id: "mock-1" },
      updatedAt: NOW,
    });
    expect(agent.capabilities).toEqual({ tools: [] });
    const snap = CellSnapshot.parse({
      protocolVersion: 1,
      cellId: ID,
      organizationId: ID,
      topic: `cell:${ID}`,
      lastSeq: 0,
      agents: [],
      providers: [],
    });
    expect(snap.webSearch).toEqual({ provider: "duckduckgo" });
  });

  it("config changes carry the new capability reasons", () => {
    for (const reason of ["policy.updated", "agent.capabilities_updated", "tools.updated"]) {
      expect(
        CellConfigChangedEvent.safeParse({
          type: "cell.config.changed",
          organizationId: ID,
          cellId: ID,
          reason,
          agentId: null,
          seq: 3,
        }).success,
      ).toBe(true);
    }
  });

  it("tool-call and memory requests are bounded", () => {
    expect(
      AgentChannelToolCallRequest.parse({ eventId: ID, agentId: ID2, tool: "web_search" }).params,
    ).toEqual({});
    expect(
      AgentChannelToolCallRequest.safeParse({
        eventId: ID,
        agentId: ID2,
        tool: "web_search",
        params: { query: "x".repeat(501) },
      }).success,
    ).toBe(false);
    expect(AgentChannelMemorySave.safeParse({ eventId: ID, agentId: ID2, text: "   " }).success).toBe(false);
    expect(AgentChannelMemorySave.parse({ eventId: ID, agentId: ID2, text: "  likes tea  " }).text).toBe(
      "likes tea",
    );
  });
});

describe("per-member connector turns (07.4 D-03, D-07, R7)", () => {
  it("the three static connector and keychain tools are built-ins, never dangerous", () => {
    expect(BUILTIN_TOOLS).toMatchObject({
      connectorList: "ocw_connector_list",
      connectorCall: "ocw_connector_call",
      httpRequest: "ocw_http_request",
    });
    for (const t of ["ocw_connector_list", "ocw_connector_call", "ocw_http_request"]) {
      expect(isDangerousToolName(t), t).toBe(false);
    }
  });

  it("a turn withholds a member-account tool and names the account so the persona can link the share", () => {
    const withheld = {
      ...turn,
      tools: ["ocw_connector_call", "m1a2b3c4d__whoami"],
      withheld: [
        {
          tool: "m1a2b3c4d__whoami",
          reason: "member_account",
          resource: { kind: "connector", id: ID, name: "Acme CRM" },
        },
        {
          tool: "ocw_http_request",
          reason: "member_account",
          resource: { kind: "vault_item", id: ID2, name: "ERP" },
        },
        { tool: "m1a2b3c4d__search", reason: "denied_for_you" },
      ],
    };
    expect(TurnContext.parse(withheld)).toEqual(withheld);
    const bad = (resource: unknown) =>
      TurnContext.safeParse({ ...turn, withheld: [{ tool: "x", reason: "member_account", resource }] })
        .success;
    expect(bad({ kind: "agent", id: ID, name: "x" })).toBe(false);
    expect(bad({ kind: "connector", id: "nope", name: "x" })).toBe(false);
    expect(bad({ kind: "connector", id: ID, name: "x".repeat(81) })).toBe(false);
  });

  it("a Phase 6 turn parses unchanged", () => {
    const phase6 = { ...turn, withheld: [{ tool: "web_search", reason: "shared_with_group" }] };
    expect(TurnContext.parse(phase6)).toEqual(phase6);
    expect(TurnContext.parse(turn)).toEqual(turn);
  });
});
