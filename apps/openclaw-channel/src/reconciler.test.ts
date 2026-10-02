import { describe, expect, it } from "vitest";
import type { CellAgent, CellProvider } from "./agent-channel-protocol.js";
import {
  applyPlanToDraft,
  DENIED_TOOLS,
  desiredAgentEntry,
  desiredProviderEntry,
  envRef,
  type MutableConfig,
  planReconcile,
  providerKeyEnvName,
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
