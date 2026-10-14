import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CellAgent, CellMcpServer, CellProvider, CellSubscription } from "./agent-channel-protocol.js";
import {
  agentStateDirFor,
  allowedAgentTools,
  applyPlanToDraft,
  DANGEROUS_TOOLS,
  desiredAgentEntry,
  desiredMcpServerEntry,
  desiredProviderEntry,
  envRef,
  type McpServerEntry,
  type MutableConfig,
  planReconcile,
  providerKeyEnvName,
  RENAMED_OPENAI_PROVIDER,
  SUBSCRIPTION_NOT_SIGNED_IN,
} from "./reconciler.js";

const agent = (id: string, over: Partial<CellAgent> = {}): CellAgent => ({
  id,
  handle: `bot${id}`,
  displayName: `Bot ${id}`,
  avatarUrl: null,
  description: null,
  instructions: "",
  status: "provisioning",
  modelRef: "anthropic/claude-sonnet-5-5",
  model: { provider: "anthropic", providerId: "anthropic", id: "claude-sonnet-5-5" },
  ...over,
});

const ANTHROPIC: CellProvider = {
  id: "anthropic",
  kind: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-SECRET",
  models: ["claude-sonnet-5-5"],
};
const FAKE: CellProvider = {
  id: "fake",
  kind: "mock",
  api: "openai-completions",
  baseUrl: "http://fake-model:18999/v1",
  apiKey: "mock-key-not-secret",
  models: ["mock-1"],
};

describe("planReconcile", () => {
  it("creates one locked-down agent per bot and its provider, with the key only in env", () => {
    const plan = planReconcile({}, { agents: [agent("a")], providers: [ANTHROPIC] });
    expect(plan.changed).toBe(true);
    expect(plan.upsertAgents["ocw-a"]).toEqual(desiredAgentEntry(agent("a")));
    expect(plan.upsertAgents["ocw-a"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
    expect(plan.upsertAgents["ocw-a"]?.model).toEqual({
      primary: "anthropic/claude-sonnet-5-5",
      fallbacks: [],
    });
    expect(plan.upsertProviders.anthropic).toEqual({
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: envRef("OCW_PROVIDER_KEY_ANTHROPIC"),
      models: [{ id: "claude-sonnet-5-5", name: "claude-sonnet-5-5" }],
    });
    expect(JSON.stringify(plan.upsertProviders)).not.toContain("SECRET");
    expect(plan.env).toEqual({ OCW_PROVIDER_KEY_ANTHROPIC: "sk-ant-SECRET" });
    expect(plan.results).toEqual([{ agentId: "a", status: "ready" }]);
  });

  it("reports error (no agent entry) when the bot's provider is not configured", () => {
    const plan = planReconcile({}, { agents: [agent("a")], providers: [FAKE] });
    expect(plan.upsertAgents).toEqual({});
    expect(plan.results[0]).toMatchObject({ agentId: "a", status: "error" });
    expect(plan.results[0]?.detail).toContain('"anthropic"');
  });

  it("is a no-op when OpenClaw already matches, including resolved env refs in the runtime view", () => {
    const current = {
      agents: { "ocw-a": { ...desiredAgentEntry(agent("a")), workspace: "/state/ws" } },
      // runtime snapshot: ${ENV} already substituted with the real key
      providers: { anthropic: { ...desiredProviderEntry(ANTHROPIC), apiKey: "sk-ant-SECRET" } },
    };
    const plan = planReconcile(current, { agents: [agent("a")], providers: [ANTHROPIC] });
    expect(plan.changed).toBe(false);
  });

  it("follows model changes and declares the model id on the provider", () => {
    const plan = planReconcile(
      { agents: { "ocw-a": desiredAgentEntry(agent("a")) } },
      { agents: [agent("a", { modelRef: "fake/mock-2" })], providers: [FAKE] },
    );
    expect(plan.upsertAgents["ocw-a"]?.model).toEqual({ primary: "fake/mock-2", fallbacks: [] });
    expect(plan.upsertProviders.fake?.models).toEqual([
      { id: "mock-1", name: "mock-1" },
      { id: "mock-2", name: "mock-2" },
    ]);
  });

  it("removes owned entries for deleted or disabled bots and never touches foreign agents", () => {
    const current = {
      agents: {
        "ocw-a": desiredAgentEntry(agent("a")),
        "ocw-gone": desiredAgentEntry(agent("gone")),
        main: { workspace: "/x" },
      },
    };
    const plan = planReconcile(current, {
      agents: [agent("a", { status: "disabled" })],
      providers: [ANTHROPIC],
    });
    expect(plan.removeAgents.sort()).toEqual(["ocw-a", "ocw-gone"]);
    expect(plan.results).toEqual([]);
  });

  it("names env vars safely", () => {
    expect(providerKeyEnvName("openai-compatible")).toBe("OCW_PROVIDER_KEY_OPENAI_COMPATIBLE");
  });
});

const CODEX: CellSubscription = {
  id: "openai-codex",
  kind: "openai-codex",
  runtimeProvider: "openai",
  models: ["gpt-6-astra"],
  account: { email: "owner@example.test" },
};
const OPENAI_KEY: CellProvider = {
  id: "openai",
  kind: "openai",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-openai-SECRET",
  models: ["gpt-5"],
};
const codexBot = (id: string) =>
  agent(id, {
    modelRef: "openai-codex/gpt-6-astra",
    model: { provider: "openai-codex", providerId: "openai-codex", id: "gpt-6-astra" },
  });
const openaiBot = (id: string) =>
  agent(id, { modelRef: "openai/gpt-5", model: { provider: "openai", providerId: "openai", id: "gpt-5" } });

describe("planReconcile: ChatGPT subscription", () => {
  it("maps subscription bots to OpenClaw's openai provider, pinned to the embedded runtime, no provider entry", () => {
    const plan = planReconcile(
      {},
      { agents: [codexBot("c")], providers: [], subscriptions: [CODEX] },
      { readySubscriptions: new Set(["openai-codex"]) },
    );
    expect(plan.upsertAgents["ocw-c"]?.model).toEqual({ primary: "openai/gpt-6-astra", fallbacks: [] });
    expect(plan.upsertAgents["ocw-c"]?.models).toEqual({
      "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } },
    });
    expect(plan.upsertAgents["ocw-c"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
    expect(plan.upsertProviders).toEqual({});
    expect(plan.env).toEqual({});
    expect(plan.results).toEqual([{ agentId: "c", status: "ready" }]);
  });

  it("reports bots on a subscription the cell is not signed in to as error", () => {
    const plan = planReconcile({}, { agents: [codexBot("c")], providers: [], subscriptions: [CODEX] });
    expect(plan.upsertAgents).toEqual({});
    expect(plan.results).toEqual([{ agentId: "c", status: "error", detail: SUBSCRIPTION_NOT_SIGNED_IN }]);
    // A bot on a subscription that is not connected at all: provider not configured.
    const none = planReconcile({}, { agents: [codexBot("c")], providers: [] });
    expect(none.results[0]?.detail).toContain('"openai-codex"');
  });

  it("moves the API-key OpenAI provider to its own id while a subscription is connected, and back", () => {
    const withBoth = planReconcile(
      { providers: { openai: desiredProviderEntry(OPENAI_KEY) } },
      { agents: [openaiBot("k"), codexBot("c")], providers: [OPENAI_KEY], subscriptions: [CODEX] },
      { readySubscriptions: new Set(["openai-codex"]) },
    );
    expect(withBoth.upsertAgents["ocw-k"]?.model).toEqual({
      primary: `${RENAMED_OPENAI_PROVIDER}/gpt-5`,
      fallbacks: [],
    });
    expect(withBoth.upsertAgents["ocw-c"]?.model).toEqual({ primary: "openai/gpt-6-astra", fallbacks: [] });
    expect(Object.keys(withBoth.upsertProviders)).toEqual([RENAMED_OPENAI_PROVIDER]);
    expect(withBoth.upsertProviders[RENAMED_OPENAI_PROVIDER]?.apiKey).toBe(
      envRef("OCW_PROVIDER_KEY_OCW_OPENAI"),
    );
    expect(withBoth.env).toEqual({ OCW_PROVIDER_KEY_OCW_OPENAI: "sk-openai-SECRET" });
    expect(withBoth.removeProviders).toEqual(["openai"]);

    const draft: MutableConfig = { models: { providers: { openai: desiredProviderEntry(OPENAI_KEY) } } };
    applyPlanToDraft(draft, withBoth);
    expect(Object.keys(draft.models?.providers ?? {})).toEqual([RENAMED_OPENAI_PROVIDER]);

    const keyOnly = planReconcile(
      { providers: draft.models?.providers },
      { agents: [openaiBot("k")], providers: [OPENAI_KEY], subscriptions: [] },
    );
    expect(keyOnly.upsertAgents["ocw-k"]?.model).toEqual({ primary: "openai/gpt-5", fallbacks: [] });
    expect(keyOnly.removeProviders).toEqual([RENAMED_OPENAI_PROVIDER]);
  });

  it("a bot moved off the subscription loses its runtime pin; API-key bots never get one", () => {
    const draft: MutableConfig = { agents: { entries: {} } };
    applyPlanToDraft(
      draft,
      planReconcile(
        {},
        { agents: [codexBot("c")], providers: [], subscriptions: [CODEX] },
        {
          readySubscriptions: new Set(["openai-codex"]),
        },
      ),
    );
    expect(draft.agents?.entries?.["ocw-c"]?.models).toBeDefined();
    const moved = planReconcile(
      { agents: draft.agents?.entries },
      { agents: [agent("c")], providers: [ANTHROPIC], subscriptions: [CODEX] },
    );
    applyPlanToDraft(draft, moved);
    expect("models" in (draft.agents?.entries?.["ocw-c"] ?? {})).toBe(false);
    expect(draft.agents?.entries?.["ocw-c"]?.model).toEqual({
      primary: "anthropic/claude-sonnet-5-5",
      fallbacks: [],
    });
    // Steady state: nothing to do.
    expect(
      planReconcile(
        { agents: draft.agents?.entries, providers: draft.models?.providers },
        { agents: [agent("c")], providers: [ANTHROPIC], subscriptions: [CODEX] },
      ).changed,
    ).toBe(false);
  });
});

describe("capabilities in the cell (D-08 layer 1, D-09)", () => {
  it("each bot is minimal + alsoAllow <its tools> + the dangerous denies; no alsoAllow key when it has none", () => {
    const plan = planReconcile(
      {},
      {
        agents: [
          agent("w", { capabilities: { tools: ["web_search", "web_fetch"] } }),
          agent("q", { capabilities: { tools: [] } }),
          agent("o"),
        ],
        providers: [ANTHROPIC],
      },
    );
    expect(plan.upsertAgents["ocw-w"]?.tools).toEqual({
      profile: "minimal",
      alsoAllow: ["web_search", "web_fetch"],
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
    expect(plan.upsertAgents["ocw-q"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
    expect(plan.upsertAgents["ocw-o"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
  });

  it("a bot served delivered-turn tools (ocw_agent_card) also configures ocw_board_card and the two Work Zone tools; a bot with none does not (07.1-13, 07.5-10)", () => {
    const plan = planReconcile(
      {},
      {
        agents: [
          agent("c", { capabilities: { tools: ["web_search", "ocw_agent_card"] } }),
          agent("w", { capabilities: { tools: ["web_search"] } }),
          agent("q", { capabilities: { tools: [] } }),
        ],
        providers: [ANTHROPIC],
      },
    );
    expect(plan.upsertAgents["ocw-c"]?.tools).toMatchObject({
      alsoAllow: [
        "web_search",
        "ocw_agent_card",
        "ocw_board_card",
        "ocw_work_zone_projects",
        "ocw_start_work_zone",
      ],
    });
    expect(plan.upsertAgents["ocw-w"]?.tools).toMatchObject({ alsoAllow: ["web_search"] });
    expect(plan.upsertAgents["ocw-q"]?.tools).not.toHaveProperty("alsoAllow");
  });

  it("Code Mode is off for every bot: it hides tools behind `exec`, which the gate always refuses", () => {
    const plan = planReconcile(
      {},
      {
        agents: [agent("w", { capabilities: { tools: ["web_search", "ocw_memory_save"] } })],
        providers: [ANTHROPIC],
      },
    );
    expect(plan.upsertAgents["ocw-w"]?.tools).toMatchObject({ codeMode: false });
  });

  it("never configures a dangerous tool even if the snapshot lists one", () => {
    const plan = planReconcile(
      {},
      {
        agents: [agent("x", { capabilities: { tools: ["web_search", "exec", "group:fs"] } })],
        providers: [ANTHROPIC],
      },
    );
    expect(plan.upsertAgents["ocw-x"]?.tools).toMatchObject({ alsoAllow: ["web_search"] });
  });

  it("losing a tool re-provisions the agent without it", () => {
    const before = desiredAgentEntry(agent("w", { capabilities: { tools: ["web_search", "web_fetch"] } }));
    const plan = planReconcile(
      { agents: { "ocw-w": before } },
      { agents: [agent("w", { capabilities: { tools: [] } })], providers: [ANTHROPIC] },
    );
    expect(plan.upsertAgents["ocw-w"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
    const draft: MutableConfig = { agents: { entries: { "ocw-w": before } } };
    applyPlanToDraft(draft, plan);
    expect(draft.agents?.entries?.["ocw-w"]?.tools).toEqual({
      profile: "minimal",
      deny: [...DANGEROUS_TOOLS],
      codeMode: false,
    });
  });

  it("the snapshot's webSearch.provider becomes tools.web.search.provider when that plugin is loaded", () => {
    const cell = { agents: [], providers: [], webSearch: { provider: "searxng" } };
    const plan = planReconcile({ webSearchProvider: "duckduckgo" }, cell, {
      searchProviders: new Set(["duckduckgo", "searxng"]),
    });
    expect(plan.webSearchProvider).toBe("searxng");
    expect(plan.changed).toBe(true);
    const draft: MutableConfig = {
      tools: { profile: "minimal", web: { search: { enabled: true, provider: "duckduckgo" } } },
    };
    applyPlanToDraft(draft, plan);
    expect(draft).toMatchObject({
      tools: { profile: "minimal", web: { search: { enabled: true, provider: "searxng" } } },
    });

    // Already set → nothing to do; provider plugin not loaded in this cell → keep the current one.
    expect(
      planReconcile({ webSearchProvider: "searxng" }, cell, { searchProviders: new Set(["searxng"]) })
        .changed,
    ).toBe(false);
    const missing = planReconcile({ webSearchProvider: "duckduckgo" }, cell, {
      searchProviders: new Set(["duckduckgo"]),
    });
    expect(missing.webSearchProvider).toBeNull();
    expect(missing.changed).toBe(false);
  });
});

describe("MCP servers in the cell (D-13, BOT-08)", () => {
  const SAFE = "m0a1b2c3d";
  const TOKEN = "Bearer mcp-SECRET-token";
  const mcp = (over: Partial<CellMcpServer> = {}): CellMcpServer => ({
    id: "srv-1",
    safeName: SAFE,
    transport: "streamable-http",
    url: "http://fake-model:18999/mcp",
    headers: [{ name: "Authorization", envName: `OCW_MCP_${SAFE.toUpperCase()}_0`, value: TOKEN }],
    tools: ["echo"],
    ...over,
  });
  /** The rendered entry of a server the test knows is renderable. */
  const rendered = (s: CellMcpServer): McpServerEntry => {
    const entry = desiredMcpServerEntry(s);
    if (!entry) throw new Error("not renderable");
    return entry;
  };
  const cell = (servers: CellMcpServer[], tools: string[] = [`${SAFE}__echo`]) => ({
    agents: [agent("a", { modelRef: "fake/mock-1", capabilities: { tools } })],
    providers: [FAKE],
    mcpServers: servers,
  });

  it("renders a server with tools: url, transport, env-var header refs, toolFilter.include; the value only in env", () => {
    const plan = planReconcile({}, cell([mcp()]));
    expect(plan.changed).toBe(true);
    expect(plan.upsertMcpServers).toEqual({
      [SAFE]: {
        url: "http://fake-model:18999/mcp",
        transport: "streamable-http",
        headers: { Authorization: envRef(`OCW_MCP_${SAFE.toUpperCase()}_0`) },
        toolFilter: { include: ["echo"] },
      },
    });
    expect(plan.env[`OCW_MCP_${SAFE.toUpperCase()}_0`]).toBe(TOKEN);
    const draft: MutableConfig = { mcp: { sessionIdleTtlMs: 600_000 } };
    applyPlanToDraft(draft, plan);
    expect(draft.mcp).toEqual({ sessionIdleTtlMs: 600_000, servers: plan.upsertMcpServers });
    // The serialized config never holds the credential.
    expect(JSON.stringify(draft)).not.toContain("mcp-SECRET-token");
    // Agents keep exact MCP tool names in alsoAllow.
    expect(plan.upsertAgents["ocw-a"]?.tools).toMatchObject({ alsoAllow: [`${SAFE}__echo`] });
  });

  it("an SSE server says so explicitly; a server without headers renders none", () => {
    const plan = planReconcile({}, cell([mcp({ transport: "sse", url: "http://h:1/sse", headers: [] })]));
    expect(plan.upsertMcpServers[SAFE]).toEqual({
      url: "http://h:1/sse",
      transport: "sse",
      toolFilter: { include: ["echo"] },
    });
  });

  it("a server with no enabled tool is never rendered, and removed when it was", () => {
    expect(planReconcile({}, cell([mcp({ tools: [] })])).upsertMcpServers).toEqual({});
    const current = { mcpServers: { [SAFE]: rendered(mcp()), operatorOwned: { url: "x" } } };
    const plan = planReconcile(current, cell([mcp({ tools: [] })]));
    expect(plan.removeMcpServers).toEqual([SAFE]);
    expect(plan.changed).toBe(true);
    const draft: MutableConfig = { mcp: { servers: { ...current.mcpServers } } };
    applyPlanToDraft(draft, plan);
    // Only plugin-owned m<8hex> entries are ever removed.
    expect(Object.keys(draft.mcp?.servers ?? {})).toEqual(["operatorOwned"]);
  });

  it("a server that left the snapshot is removed; a foreign entry never is", () => {
    const current = { mcpServers: { [SAFE]: rendered(mcp()), mdeadbeef0: { url: "y" } } };
    const plan = planReconcile(current, cell([]));
    expect(plan.removeMcpServers.sort()).toEqual([SAFE]);
  });

  it("is a no-op when OpenClaw already has it, including the resolved header value in the runtime view", () => {
    const resolved = { ...rendered(mcp()), headers: { Authorization: TOKEN } };
    const first = planReconcile({}, cell([mcp()]));
    const agents = first.upsertAgents;
    const providers = { fake: { ...desiredProviderEntry(FAKE, ["mock-1"]), apiKey: "mock-key-not-secret" } };
    const plan = planReconcile({ agents, providers, mcpServers: { [SAFE]: resolved } }, cell([mcp()]));
    expect(plan.upsertMcpServers).toEqual({});
    expect(plan.changed).toBe(false);
    // The env still carries the value (a restarted gateway process needs it before the next write).
    expect(plan.env[`OCW_MCP_${SAFE.toUpperCase()}_0`]).toBe(TOKEN);
  });

  it("a newly enabled tool or a rotated credential re-renders the server", () => {
    const current = { mcpServers: { [SAFE]: rendered(mcp()) } };
    expect(
      planReconcile(current, cell([mcp({ tools: ["echo", "write_note"] })])).upsertMcpServers[SAFE],
    ).toMatchObject({
      toolFilter: { include: ["echo", "write_note"] },
    });
    const resolved = {
      [SAFE]: { ...rendered(mcp()), headers: { Authorization: "Bearer old" } },
    };
    expect(Object.keys(planReconcile({ mcpServers: resolved }, cell([mcp()])).upsertMcpServers)).toEqual([
      SAFE,
    ]);
  });

  it("a rotated credential re-renders even when the runtime view shows the unresolved env ref", () => {
    const current = { mcpServers: { [SAFE]: rendered(mcp()) } };
    const envName = `OCW_MCP_${SAFE.toUpperCase()}_0`;
    // The gateway env still holds the value OpenClaw resolved at its last config load.
    expect(planReconcile(current, cell([mcp()]), { env: { [envName]: TOKEN } }).upsertMcpServers).toEqual({});
    const rotated = mcp({ headers: [{ name: "Authorization", envName, value: "Bearer rotated-SECRET" }] });
    const plan = planReconcile(current, cell([rotated]), { env: { [envName]: TOKEN } });
    expect(Object.keys(plan.upsertMcpServers)).toEqual([SAFE]);
    expect(plan.env[envName]).toBe("Bearer rotated-SECRET");
  });

  it("refuses snapshot entries it cannot render safely: foreign names, bad env names or header names", () => {
    const plan = planReconcile(
      {},
      cell([
        mcp({ safeName: "docs" }),
        mcp({
          id: "s2",
          safeName: "m11111111",
          headers: [{ name: "Authorization", envName: "PATH", value: "x" }],
        }),
        mcp({
          id: "s3",
          safeName: "m22222222",
          headers: [{ name: "Bad Header", envName: "OCW_MCP_M22222222_0", value: "x" }],
        }),
        mcp({ id: "s4", safeName: "m33333333", tools: ["*", "ok"] }),
        mcp({ id: "s5", safeName: "m44444444", url: "file:///etc/passwd" }),
      ]),
    );
    expect(Object.keys(plan.upsertMcpServers)).toEqual(["m33333333"]);
    // Tool filter entries are exact names: no globs.
    expect(plan.upsertMcpServers.m33333333?.toolFilter).toEqual({ include: ["ok"] });
    expect(plan.env.PATH).toBeUndefined();
  });

  it("agent alsoAllow never carries a whole-MCP or whole-plugin grant", () => {
    expect(allowedAgentTools(["bundle-mcp", "bundle-lsp", `${SAFE}__*`, `${SAFE}__echo`])).toEqual([
      `${SAFE}__echo`,
    ]);
  });
});

describe("applyPlanToDraft", () => {
  it("writes agents and providers, deletes removed agents, keeps foreign entries", () => {
    const draft: MutableConfig = {
      agents: { entries: { "ocw-old": { name: "x" }, main: { workspace: "/w" } } },
    };
    const plan = planReconcile(
      { agents: draft.agents?.entries },
      { agents: [agent("n", { modelRef: "fake/mock-1" })], providers: [FAKE] },
    );
    applyPlanToDraft(draft, plan);
    expect(Object.keys(draft.agents?.entries ?? {}).sort()).toEqual(["main", "ocw-n"]);
    expect(draft.models?.providers?.fake?.baseUrl).toBe("http://fake-model:18999/v1");
  });
});

describe("dangerous-tool parity (contracts ↔ render-config ↔ reconciler)", () => {
  // Non-literal specifiers: these files live outside this package (and are not type-checked from here).
  const renderConfigPath = new URL("../../../infra/openclaw/render-config.mjs", import.meta.url).href;
  const contractsPath = new URL("../../../packages/contracts/src/bot-capabilities.ts", import.meta.url).href;

  it("the three lists are identical, with no wildcard and no built-in tool", async () => {
    const render = (await import(renderConfigPath)) as { DANGEROUS_TOOLS: string[] };
    const contracts = (await import(contractsPath)) as {
      DANGEROUS_TOOL_NAMES: readonly string[];
      BUILTIN_TOOLS: Record<string, string>;
      isDangerousToolName: (n: string) => boolean;
    };
    const sorted = (xs: readonly string[]) => [...xs].sort();
    expect(sorted(render.DANGEROUS_TOOLS)).toEqual(sorted(contracts.DANGEROUS_TOOL_NAMES));
    expect(sorted(DANGEROUS_TOOLS)).toEqual(sorted(contracts.DANGEROUS_TOOL_NAMES));
    const builtins = Object.values(contracts.BUILTIN_TOOLS);
    for (const list of [render.DANGEROUS_TOOLS, [...DANGEROUS_TOOLS], [...contracts.DANGEROUS_TOOL_NAMES]]) {
      expect(list.some((t) => t.includes("*"))).toBe(false);
      for (const b of builtins) expect(list).not.toContain(b);
    }
    for (const t of DANGEROUS_TOOLS) expect(contracts.isDangerousToolName(t)).toBe(true);
  });
});

describe("transcript purge path (Pitfall 12)", () => {
  const STATE = "/home/node/.openclaw";

  it("is <stateDir>/agents/<id> for plugin-owned ocw-* agents", () => {
    expect(agentStateDirFor(STATE, "ocw-0199a6f0-0000-7000-8000-00000000a001")).toBe(
      path.join(STATE, "agents", "ocw-0199a6f0-0000-7000-8000-00000000a001"),
    );
  });

  it("is null for foreign agents, traversal attempts and odd ids; never outside the state dir", () => {
    for (const id of [
      "main",
      "work",
      "ocw-",
      "ocw-../../etc",
      "ocw-a/b",
      "../ocw-a",
      "OCW-A",
      "ocw-a b",
      "",
    ]) {
      expect(agentStateDirFor(STATE, id)).toBeNull();
    }
    expect(agentStateDirFor("", "ocw-a")).toBeNull();
    expect(agentStateDirFor("relative/state", "ocw-a")).toBeNull();
    const dir = agentStateDirFor(STATE, "ocw-a1");
    expect(dir?.startsWith(`${STATE}${path.sep}agents${path.sep}`)).toBe(true);
  });
});
