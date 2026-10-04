import { describe, expect, it } from "vitest";
import type { CellAgent, CellProvider, CellSubscription } from "./agent-channel-protocol.js";
import {
  applyPlanToDraft,
  DENIED_TOOLS,
  desiredAgentEntry,
  desiredProviderEntry,
  envRef,
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
    expect(plan.upsertAgents["ocw-a"]?.tools).toEqual({ profile: "minimal", deny: [...DENIED_TOOLS] });
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
    expect(plan.upsertAgents["ocw-c"]?.tools).toEqual({ profile: "minimal", deny: [...DENIED_TOOLS] });
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
