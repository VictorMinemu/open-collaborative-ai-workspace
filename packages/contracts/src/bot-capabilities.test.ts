import { describe, expect, it } from "vitest";
import {
  AgentChannelEventTypes,
  AgentChannelMemorySave,
  AgentChannelToolCallRequest,
  AgentMentionEvent,
  AgentTaskEvent,
  ATTACHMENT_READ_FLAGS,
  ATTACHMENT_READ_LIMITS,
  BotCapabilities,
  BotCapabilityView,
  BotPolicy,
  BROWSER_TOOL_NAMES,
  BUILTIN_TOOLS,
  CellAgent,
  CellConfigChangedEvent,
  CellSnapshot,
  CONFINED_TOOL_FLAGS,
  CONVERSATION_OPEN_FLAGS,
  DANGEROUS_TOOL_NAMES,
  DEFAULT_BOT_POLICY,
  DEFAULT_CAPABILITIES,
  isApprovableTool,
  isDangerousToolName,
  MAX_SANDBOX_CALLS_PER_TURN,
  SANDBOX_REFUSED_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
  TASK_TOOL_FLAGS,
  TASK_TOOL_NAMES,
  ToolPattern,
  TURN_ATTACHMENT_NOTES,
  TURN_TOOLS_MAX,
  TurnAttachment,
  TurnContext,
  UpdateBotCapabilitiesRequest,
  UpdateBotPolicyRequest,
  WORK_SESSION_FILE_TOOL_FLAGS,
  WORK_SESSION_FILE_TOOL_NAMES,
  WORK_SESSION_TOOL_FLAGS,
  WORK_SESSION_TOOL_NAMES,
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
      sandbox: false,
      browser: false,
    });
    expect(DEFAULT_CAPABILITIES.team).toEqual({
      internet: false,
      memory: false,
      dateTime: true,
      replyMode: "mentions",
      dailyLimit: 100,
      sandbox: false,
      browser: false,
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
    expect(TurnContext.safeParse({ ...turn, tools: Array(TURN_TOOLS_MAX + 1).fill("x") }).success).toBe(
      false,
    );
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

describe("Work Zone proposal tools (07.5 D-03)", () => {
  it("the two Work Zone tools are built-ins, never dangerous", () => {
    expect(BUILTIN_TOOLS).toMatchObject({
      workZoneProjects: "ocw_work_zone_projects",
      startWorkZone: "ocw_start_work_zone",
    });
    for (const t of ["ocw_work_zone_projects", "ocw_start_work_zone"]) {
      expect(isDangerousToolName(t), t).toBe(false);
    }
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

describe("confined sandbox and browser tools (07.8 D-02, D-03, D-11, D-13)", () => {
  const SANDBOX = [
    "ocw_sandbox_exec",
    "ocw_sandbox_process",
    "ocw_sandbox_read",
    "ocw_sandbox_write",
    "ocw_sandbox_list",
    "ocw_sandbox_delete",
    "ocw_sandbox_share",
    "ocw_sandbox_import",
  ];
  const BROWSER = [
    "ocw_browser_open",
    "ocw_browser_snapshot",
    "ocw_browser_act",
    "ocw_browser_screenshot",
    "ocw_browser_wait",
    "ocw_browser_signin",
    "ocw_browser_close",
  ];

  it("the 15 confined tools are built-ins, never dangerous, and the two tuples list exactly them", () => {
    expect([...SANDBOX_TOOL_NAMES]).toEqual(SANDBOX);
    expect([...BROWSER_TOOL_NAMES]).toEqual(BROWSER);
    expect(BUILTIN_TOOLS).toMatchObject({
      sandboxExec: "ocw_sandbox_exec",
      sandboxProcess: "ocw_sandbox_process",
      sandboxRead: "ocw_sandbox_read",
      sandboxWrite: "ocw_sandbox_write",
      sandboxList: "ocw_sandbox_list",
      sandboxDelete: "ocw_sandbox_delete",
      sandboxShare: "ocw_sandbox_share",
      sandboxImport: "ocw_sandbox_import",
      browserOpen: "ocw_browser_open",
      browserSnapshot: "ocw_browser_snapshot",
      browserAct: "ocw_browser_act",
      browserScreenshot: "ocw_browser_screenshot",
      browserWait: "ocw_browser_wait",
      browserSignIn: "ocw_browser_signin",
      browserClose: "ocw_browser_close",
    });
    const builtins = Object.values(BUILTIN_TOOLS) as string[];
    for (const t of [...SANDBOX, ...BROWSER]) {
      expect(builtins, t).toContain(t);
      expect(isDangerousToolName(t), t).toBe(false);
      expect(isDangerousToolName(t, "sandbox"), t).toBe(false);
    }
  });

  it("the cell keeps refusing shell, file and browser names (default host unchanged)", () => {
    for (const t of ["exec", "browser", "bash_run", "write_file", "puppeteer_click", "playwright_open"]) {
      expect(isDangerousToolName(t), t).toBe(true);
      expect(isDangerousToolName(t, "cell"), t).toBe(true);
    }
  });

  it("a sandbox-hosted tool may use shell, file and browser words but never administration or messaging (D-03)", () => {
    for (const t of [
      "exec",
      "bash_run",
      "write_file",
      "puppeteer_click",
      "playwright_open",
      "process",
      "read",
      "ls",
    ]) {
      expect(isDangerousToolName(t, "sandbox"), t).toBe(false);
    }
    for (const t of [
      "gateway",
      "nodes",
      "openclaw",
      "sessions_yield",
      "session_status",
      "group:nodes",
      "group:sessions",
      "group:runtime",
      "tool_call",
      "message",
      "send_sms",
      "update_config",
      "code_execution",
      "canvas",
      "presence",
      "x_search",
    ]) {
      expect(isDangerousToolName(t, "sandbox"), t).toBe(true);
    }
    for (const t of SANDBOX_REFUSED_TOOL_NAMES) {
      expect(isDangerousToolName(t, "sandbox"), t).toBe(true);
      expect(DANGEROUS_TOOL_NAMES, t).toContain(t);
    }
    expect(SANDBOX_REFUSED_TOOL_NAMES).not.toContain("exec");
    expect(SANDBOX_REFUSED_TOOL_NAMES).not.toContain("browser");
  });

  it("flags: share leaves the sandbox; open and act need the requester across sites, exec while egress is open", () => {
    expect(Object.keys(CONFINED_TOOL_FLAGS).sort()).toEqual([...SANDBOX, ...BROWSER].sort());
    for (const [tool, flags] of Object.entries(CONFINED_TOOL_FLAGS)) {
      expect(flags.sideEffecting, tool).toBe(tool === "ocw_sandbox_share");
      expect(flags.approval, tool).toBeUndefined();
    }
    const memberData = Object.fromEntries(
      Object.entries(CONFINED_TOOL_FLAGS).map(([t, f]) => [t, f.memberData]),
    );
    expect(memberData.ocw_sandbox_exec).toBe("egress_exec");
    expect(memberData.ocw_browser_open).toBe("cross_site");
    expect(memberData.ocw_browser_act).toBe("cross_site");
    expect(Object.values(memberData).filter((r) => r === "none")).toHaveLength(12);
    const untrusted = Object.entries(CONFINED_TOOL_FLAGS)
      .filter(([, f]) => f.untrustedOutput)
      .map(([t]) => t)
      .sort();
    expect(untrusted).toEqual(
      [
        "ocw_sandbox_exec",
        "ocw_sandbox_process",
        "ocw_sandbox_read",
        "ocw_sandbox_list",
        "ocw_browser_open",
        "ocw_browser_act",
        "ocw_browser_snapshot",
        "ocw_browser_screenshot",
        "ocw_browser_wait",
      ].sort(),
    );
  });

  it("the confined budget is 40 and older turns without it parse", () => {
    expect(MAX_SANDBOX_CALLS_PER_TURN).toBe(40);
    expect(TurnContext.parse(turn).maxSandboxCalls).toBeUndefined();
    expect(TurnContext.parse({ ...turn, maxSandboxCalls: 40 }).maxSandboxCalls).toBe(40);
  });

  it("per-bot switches default off; a stored object without them parses as off; a patch never resets them", () => {
    const stored = BotCapabilities.parse({
      internet: false,
      memory: true,
      dateTime: true,
      replyMode: "mentions",
      dailyLimit: 30,
    });
    expect(stored.sandbox).toBe(false);
    expect(stored.browser).toBe(false);
    expect(DEFAULT_CAPABILITIES.team.sandbox).toBe(false);
    expect(DEFAULT_CAPABILITIES.team.browser).toBe(false);
    expect(DEFAULT_CAPABILITIES.personal.sandbox).toBe(false);
    const patch = UpdateBotCapabilitiesRequest.parse({ internet: true });
    expect("sandbox" in patch).toBe(false);
    expect("browser" in patch).toBe(false);
    expect(UpdateBotCapabilitiesRequest.parse({ sandbox: true }).sandbox).toBe(true);
  });

  it("the capability view may carry the confined rows; older views without them parse", () => {
    const off = { enabled: false, effective: false, reason: null };
    const view = {
      agentId: ID,
      scope: "team",
      capabilities: DEFAULT_CAPABILITIES.team,
      effective: { internet: off, memory: off, dateTime: off, replyModeAll: off },
      tools: [],
      usage: { today: 0, limit: 100, resetsAt: NOW },
      dailyLimitMax: 10_000,
      viewerCan: [],
    };
    expect(BotCapabilityView.parse(view).confined).toBeUndefined();
    const confined = {
      sandbox: { enabled: true, available: false, reason: "org_off" },
      browser: { enabled: false, available: true, reason: null },
    };
    expect(BotCapabilityView.parse({ ...view, confined }).confined).toEqual(confined);
    expect(
      BotCapabilityView.safeParse({
        ...view,
        confined: { ...confined, browser: { ...confined.browser, reason: "x" } },
      }).success,
    ).toBe(false);
  });
});

describe("agent-to-agent consults (07.7 D-02, D-04, D-09, C-01)", () => {
  const target = { id: ID2, handle: "purchasing", displayName: "Purchasing", description: null };

  it("ocw_consult_agent is a built-in that the dangerous-name filter never refuses", () => {
    expect(BUILTIN_TOOLS.consultAgent).toBe("ocw_consult_agent");
    expect(isDangerousToolName(BUILTIN_TOOLS.consultAgent)).toBe(false);
    expect(isDangerousToolName(BUILTIN_TOOLS.consultAgent, "sandbox")).toBe(false);
  });

  it("OpenClaw's in-cell agent-to-agent tools are refused on both hosts (C-01)", () => {
    for (const name of [
      "subagents",
      "conversations_turn",
      "conversations_list",
      "conversations_send",
      "agents_list",
      "agents_wait",
      "Agents_List",
      "sessions_send",
      "sessions_spawn",
    ]) {
      expect(isDangerousToolName(name), name).toBe(true);
      expect(isDangerousToolName(name, "cell"), name).toBe(true);
      expect(isDangerousToolName(name, "sandbox"), name).toBe(true);
    }
    for (const name of [
      "ocw_consult_agent",
      "web_search",
      "ocw_agent_card",
      "ocw_automation_propose",
      "lookup_agent",
      "m3f9a12c4__list_conversations",
    ]) {
      expect(isDangerousToolName(name), name).toBe(false);
    }
  });

  it("the exact dangerous list is unchanged, so the render-config and reconciler parity stays valid", () => {
    expect(DANGEROUS_TOOL_NAMES).toEqual([
      "apply_patch",
      "edit",
      "exec",
      "ls",
      "openclaw",
      "process",
      "read",
      "write",
      "sessions_yield",
      "tool_call",
      "tool_describe",
      "tool_search",
      "presence",
      "session_status",
      "browser",
      "canvas",
      "message",
      "gateway",
      "nodes",
      "x_search",
      "code_execution",
      "group:runtime",
      "group:fs",
      "group:ui",
      "group:automation",
      "group:nodes",
      "group:sessions",
      "group:messaging",
      "group:media",
    ]);
  });

  it("turns parse with and without consult targets and an initial taint (D-09)", () => {
    expect(TurnContext.parse(turn).consult).toBeUndefined();
    expect(TurnContext.parse(turn).tainted).toBeUndefined();
    const withConsult = {
      ...turn,
      maxSandboxCalls: 40,
      tainted: true,
      consult: { chainId: null, depth: 0, targets: [target] },
    };
    expect(TurnContext.parse(withConsult)).toEqual(withConsult);
    expect(AgentMentionEvent.parse({ ...mentionEvent, turn: withConsult }).turn).toEqual(withConsult);
    expect(TurnContext.safeParse({ ...turn, tainted: "yes" }).success).toBe(false);
    expect(
      TurnContext.safeParse({ ...turn, consult: { chainId: null, depth: 2, targets: [target] } }).success,
    ).toBe(false);
    expect(
      TurnContext.safeParse({ ...turn, consult: { chainId: null, depth: 0, targets: [] } }).success,
    ).toBe(false);
  });
});

describe("turn attachments (07.15 D-02, D-04, D-05, PD-03, PD-04)", () => {
  const MSG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
  const image = {
    id: ID,
    messageId: MSG,
    name: "photo.png",
    mediaType: "image/png",
    size: 182_044,
    kind: "image",
    access: "read",
  };
  const archive = {
    id: ID2,
    messageId: MSG,
    name: "data.zip",
    mediaType: "application/zip",
    size: 9_001,
    kind: "other",
    access: "import",
    note: TURN_ATTACHMENT_NOTES.cannotReadImport,
  };
  const withFiles = {
    ...turn,
    attachments: [image, archive],
    attachmentsMore: 3,
    maxAttachmentReads: 20,
    maxAttachmentChars: 200_000,
  };

  it("a turn that lists attachments with its read budget parses, alone and inside a mention", () => {
    expect(TurnContext.parse(withFiles)).toEqual(withFiles);
    expect(AgentMentionEvent.parse({ ...mentionEvent, turn: withFiles }).turn).toEqual(withFiles);
  });

  it("a 07.14 turn (no attachment fields) parses unchanged", () => {
    const parsed = TurnContext.parse(turn);
    expect(parsed).toEqual(turn);
    expect(parsed.attachments).toBeUndefined();
    expect(parsed.attachmentsMore).toBeUndefined();
    expect(parsed.maxAttachmentReads).toBeUndefined();
    expect(parsed.maxAttachmentChars).toBeUndefined();
  });

  it("at most 20 listed; bounded note, closed kind and access, non-negative size", () => {
    const twenty = Array.from({ length: ATTACHMENT_READ_LIMITS.listPerTurn }, () => image);
    expect(TurnContext.safeParse({ ...turn, attachments: twenty }).success).toBe(true);
    const over = TurnContext.safeParse({ ...turn, attachments: [...twenty, image] });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path).toEqual(["attachments"]);
    for (const bad of [
      { ...archive, note: "x".repeat(201) },
      { ...image, kind: "video" },
      { ...image, access: "write" },
      { ...image, size: -1 },
      { ...image, size: 1.5 },
      { ...image, id: "not-a-uuid" },
      { ...image, name: "x".repeat(256) },
      { ...image, mediaType: "x".repeat(128) },
    ]) {
      expect(TurnAttachment.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
      expect(TurnContext.safeParse({ ...turn, attachments: [bad] }).success).toBe(false);
    }
    expect(TurnAttachment.safeParse({ ...archive, note: "x".repeat(200) }).success).toBe(true);
    expect(TurnContext.safeParse({ ...turn, attachmentsMore: -1 }).success).toBe(false);
  });

  it("the turn carries metadata only: no URL, key, path or content field survives the parse", () => {
    const parsed = TurnAttachment.parse({
      ...image,
      url: "https://garage.example/bucket/key",
      key: "org/conv/att",
      path: "/Users/x/photo.png",
      content: "secret",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "access",
      "id",
      "kind",
      "mediaType",
      "messageId",
      "name",
      "size",
    ]);
  });

  it("the six fixed notes, each at most 200 characters", () => {
    expect(TURN_ATTACHMENT_NOTES).toEqual({
      modelNoImages: "This bot's model can't see images.",
      cannotReadImport: "Can't be read as text; copy it into the sandbox with ocw_sandbox_import.",
      cannotReadNoSandbox: "Can't be read as text, and this bot has no sandbox here.",
      cannotReadNarrower:
        "Can't be read as text, and this bot's sandbox is shared more widely than this conversation, so it can't be copied there.",
      tooLarge: "Too large to read.",
      // 07.15 IN-01: a turn with no slot left for ocw_attachment_read.
      readNotOffered: "Can't be read on this turn: it already has the most tools a turn can offer.",
    });
    for (const note of Object.values(TURN_ATTACHMENT_NOTES)) {
      expect(note.length).toBeLessThanOrEqual(200);
      expect(TurnAttachment.safeParse({ ...archive, note }).success).toBe(true);
    }
  });

  it("ocw_attachment_read is a built-in with untrusted, non-side-effecting flags and the hub's limits", () => {
    expect(BUILTIN_TOOLS.attachmentRead).toBe("ocw_attachment_read");
    expect(ATTACHMENT_READ_FLAGS).toEqual({ untrustedOutput: true, sideEffecting: false });
    expect(ATTACHMENT_READ_LIMITS).toEqual({
      listPerTurn: 20,
      readsPerTurn: 20,
      charsPerTurn: 200_000,
      charsPerFile: 64_000,
    });
  });

  it("ocw_attachment_read is never approvable and never a dangerous name, on either host (D-08, PD-08)", () => {
    expect(isApprovableTool(BUILTIN_TOOLS.attachmentRead)).toBe(false);
    expect(isApprovableTool("OCW_ATTACHMENT_READ")).toBe(false);
    expect(ToolPattern.safeParse(BUILTIN_TOOLS.attachmentRead).success).toBe(false);
    expect(isDangerousToolName(BUILTIN_TOOLS.attachmentRead)).toBe(false);
    expect(isDangerousToolName(BUILTIN_TOOLS.attachmentRead, "sandbox")).toBe(false);
    // The 07.8 import keeps its own flags (what the sandbox tools read later taints).
    expect(CONFINED_TOOL_FLAGS.ocw_sandbox_import).toEqual({
      untrustedOutput: false,
      sideEffecting: false,
      memberData: "none",
    });
  });
});

describe("bot Work Zone tools and turn offer (07.16 D-05, PD-09, PD-17)", () => {
  const P1 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61";
  const P2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62";
  const workZone = {
    runtime: "claude-code",
    device: { id: ID, name: "build-server", online: true },
    projects: [
      { id: P1, name: "billing-api" },
      { id: P2, name: "web" },
    ],
    projectsMore: 0,
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    defaultModel: "claude-sonnet-4-5",
    efforts: ["low", "high"],
    fastMode: "allowed",
    defaultMode: "default",
    maxMode: "fullAccess",
    outsideContent: false,
    sessions: [{ id: ID2, status: "running", projectName: "billing-api" }],
  };

  it("the six names are built-ins with the hub's flags (07.17.1.1 D-01: the four, then upload and download)", () => {
    expect(BUILTIN_TOOLS.workSessionStart).toBe("ocw_work_session_start");
    expect(BUILTIN_TOOLS.workSessionPrompt).toBe("ocw_work_session_prompt");
    expect(BUILTIN_TOOLS.workSessionRead).toBe("ocw_work_session_read");
    expect(BUILTIN_TOOLS.workSessionStop).toBe("ocw_work_session_stop");
    expect([...WORK_SESSION_TOOL_NAMES]).toEqual([
      "ocw_work_session_start",
      "ocw_work_session_prompt",
      "ocw_work_session_read",
      "ocw_work_session_stop",
      "ocw_work_session_upload",
      "ocw_work_session_download",
    ]);
    expect(WORK_SESSION_TOOL_FLAGS).toEqual({
      ocw_work_session_start: { untrustedOutput: false, sideEffecting: true },
      ocw_work_session_prompt: { untrustedOutput: false, sideEffecting: true },
      ocw_work_session_read: { untrustedOutput: false, sideEffecting: false },
      ocw_work_session_stop: { untrustedOutput: false, sideEffecting: true },
      ocw_work_session_upload: { untrustedOutput: false, sideEffecting: true },
      ocw_work_session_download: { untrustedOutput: false, sideEffecting: true },
    });
  });

  it("never approvable and never a dangerous name, on either host (PD-09)", () => {
    for (const name of WORK_SESSION_TOOL_NAMES) {
      expect(isApprovableTool(name), name).toBe(false);
      expect(isApprovableTool(name.toUpperCase()), name).toBe(false);
      expect(ToolPattern.safeParse(name).success, name).toBe(false);
      expect(isDangerousToolName(name), name).toBe(false);
      expect(isDangerousToolName(name, "sandbox"), name).toBe(false);
    }
  });

  it("a turn carries the bot's Work Zone offer; a 07.15 turn parses unchanged", () => {
    const offered = {
      ...turn,
      tools: [...turn.tools, ...WORK_SESSION_TOOL_NAMES],
      toolFlags: { ...turn.toolFlags, ...WORK_SESSION_TOOL_FLAGS },
      workZone,
    };
    expect(TurnContext.parse(offered)).toEqual(offered);
    const legacy = TurnContext.parse(turn);
    expect(legacy).toEqual(turn);
    expect("workZone" in legacy).toBe(false);
    expect(AgentMentionEvent.parse({ ...mentionEvent, turn: offered }).turn).toEqual(offered);
  });

  it("an offer over 20 projects is refused at workZone.projects", () => {
    const projects = Array.from({ length: 21 }, () => ({ id: P1, name: "p" }));
    const parsed = TurnContext.safeParse({ ...turn, workZone: { ...workZone, projects } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["workZone", "projects"]);
  });
});

describe("the fan-out open tool (07.17 D-02, PD-07)", () => {
  it("is a built-in, side-effecting, never untrusted output", () => {
    expect(BUILTIN_TOOLS.conversationOpen).toBe("ocw_conversation_open");
    expect(CONVERSATION_OPEN_FLAGS).toEqual({ untrustedOutput: false, sideEffecting: true });
  });

  it("is never approvable and never a dangerous name, on either host", () => {
    const name = BUILTIN_TOOLS.conversationOpen;
    expect(isApprovableTool(name)).toBe(false);
    expect(isApprovableTool(name.toUpperCase())).toBe(false);
    expect(ToolPattern.safeParse(name).success).toBe(false);
    expect(isDangerousToolName(name)).toBe(false);
    expect(isDangerousToolName(name, "sandbox")).toBe(false);
  });

  it("a turn can offer it with its flags", () => {
    const offered = {
      ...turn,
      tools: [...turn.tools, BUILTIN_TOOLS.conversationOpen],
      toolFlags: { ...turn.toolFlags, [BUILTIN_TOOLS.conversationOpen]: CONVERSATION_OPEN_FLAGS },
    };
    expect(TurnContext.parse(offered)).toEqual(offered);
  });
});

describe("the two Work Zone file tools (07.17.1.1 D-01, PD-04, PD-26)", () => {
  it("are built-ins, side-effecting with trusted output, declared apart from the four 07.16 tools", () => {
    expect(BUILTIN_TOOLS.workSessionUpload).toBe("ocw_work_session_upload");
    expect(BUILTIN_TOOLS.workSessionDownload).toBe("ocw_work_session_download");
    expect([...WORK_SESSION_FILE_TOOL_NAMES]).toEqual([
      "ocw_work_session_upload",
      "ocw_work_session_download",
    ]);
    expect(WORK_SESSION_FILE_TOOL_FLAGS).toEqual({
      ocw_work_session_upload: { untrustedOutput: false, sideEffecting: true },
      ocw_work_session_download: { untrustedOutput: false, sideEffecting: true },
    });
    // 07.17.1.1-10: the offer is six, all or none; the file tools close the list with their flags.
    expect(WORK_SESSION_TOOL_NAMES).toHaveLength(6);
    expect(WORK_SESSION_TOOL_NAMES.slice(-2)).toEqual([...WORK_SESSION_FILE_TOOL_NAMES]);
    expect(Object.keys(WORK_SESSION_TOOL_FLAGS)).toHaveLength(6);
    for (const name of WORK_SESSION_FILE_TOOL_NAMES) {
      expect(WORK_SESSION_TOOL_FLAGS[name]).toEqual(WORK_SESSION_FILE_TOOL_FLAGS[name]);
    }
  });

  it("are never approvable and never a dangerous name, on either host", () => {
    for (const name of WORK_SESSION_FILE_TOOL_NAMES) {
      expect(isApprovableTool(name), name).toBe(false);
      expect(isApprovableTool(name.toUpperCase()), name).toBe(false);
      expect(ToolPattern.safeParse(name).success, name).toBe(false);
      expect(isDangerousToolName(name), name).toBe(false);
      expect(isDangerousToolName(name, "sandbox"), name).toBe(false);
    }
  });
});

describe("07.17.1.1.2 tasks: the three task tools, the turn's task and agent.task.v1 (D-02, D-08, D-13, PD-21)", () => {
  const TASK = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a71";
  const LATER = "2026-10-05T18:00:00.000Z";
  const exited = { processId: "p1", status: "exited", exitCode: 0, durationMs: 1200 };
  const task = {
    taskId: TASK,
    status: "waiting",
    goal: "Read the knowledge pack and summarise it",
    progress: "Read 400 of 3030 files",
    nextStep: "Read the next 400",
    turnsUsed: 7,
    maxTurns: 40,
    startedAt: NOW,
    deadlineAt: LATER,
    requesterId: ID,
    waiting: { kind: "process", ref: "p1", until: LATER },
    finishedProcesses: [exited, { processId: "p2", status: "timed_out", exitCode: null, durationMs: 600000 }],
  };

  it("are built-ins, neither side-effecting nor untrusted output", () => {
    expect(BUILTIN_TOOLS.taskStart).toBe("ocw_task_start");
    expect(BUILTIN_TOOLS.taskContinue).toBe("ocw_task_continue");
    expect(BUILTIN_TOOLS.taskFinish).toBe("ocw_task_finish");
    expect([...TASK_TOOL_NAMES]).toEqual(["ocw_task_start", "ocw_task_continue", "ocw_task_finish"]);
    expect(TASK_TOOL_FLAGS).toEqual({
      ocw_task_start: { untrustedOutput: false, sideEffecting: false },
      ocw_task_continue: { untrustedOutput: false, sideEffecting: false },
      ocw_task_finish: { untrustedOutput: false, sideEffecting: false },
    });
  });

  it("are never approvable and never a dangerous name, on either host", () => {
    for (const name of TASK_TOOL_NAMES) {
      expect(isApprovableTool(name), name).toBe(false);
      expect(isApprovableTool(name.toUpperCase()), name).toBe(false);
      expect(ToolPattern.safeParse(name).success, name).toBe(false);
      expect(isDangerousToolName(name), name).toBe(false);
      expect(isDangerousToolName(name, "sandbox"), name).toBe(false);
    }
  });

  it("a turn carries the task; a 07.17.1.1 turn parses unchanged; eleven finished processes are refused", () => {
    const offered = {
      ...turn,
      tools: [...turn.tools, ...TASK_TOOL_NAMES],
      toolFlags: { ...turn.toolFlags, ...TASK_TOOL_FLAGS },
      task,
    };
    expect(TurnContext.parse(offered)).toEqual(offered);
    const legacy = TurnContext.parse(turn);
    expect(legacy).toEqual(turn);
    expect("task" in legacy).toBe(false);
    expect(AgentMentionEvent.parse({ ...mentionEvent, turn: offered }).turn).toEqual(offered);
    const tooMany = TurnContext.safeParse({ ...turn, task: { ...task, finishedProcesses: Array(11).fill(exited) } });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.path).toEqual(["task", "finishedProcesses"]);
  });

  it("agent.task.v1 is a mention-shaped continuation with the task, its reason and an optional process", () => {
    expect(AgentChannelEventTypes.task).toBe("agent.task.v1");
    const event = {
      ...mentionEvent,
      type: "agent.task.v1",
      message: { ...mentionEvent.message, text: "A background command of your task ended." },
      turn: { ...turn, task: { ...task, status: "running", waiting: null } },
      task: { taskId: TASK, reason: "process", process: exited },
    };
    expect(AgentTaskEvent.parse(event)).toEqual(event);
    for (const reason of ["continue", "timer", "nudge"]) {
      const plain = { ...event, task: { taskId: TASK, reason } };
      expect(AgentTaskEvent.parse(plain)).toEqual(plain);
    }
    expect(AgentTaskEvent.safeParse({ ...event, task: { taskId: TASK, reason: "session" } }).success).toBe(false);
    expect(AgentTaskEvent.safeParse({ ...event, type: "agent.mention.v1" }).success).toBe(false);
    expect(AgentTaskEvent.safeParse({ ...event, task: undefined }).success).toBe(false);
    // An older consumer's mention schema refuses it only on its type, so the bridge skips it (PD-21).
    const asMention = AgentMentionEvent.safeParse(event);
    expect(asMention.success).toBe(false);
    expect(asMention.error?.issues.map((i) => i.path.join("."))).toEqual(["type"]);
  });
});
