/**
 * `ocw_work_session_start|prompt|read|stop` (07.16 D-05, D-08, D-10, D-20, PD-09, PD-14, PD-15). The tracer drives our
 * REAL entry the way OpenClaw registers it (testing/openclaw-host.ts) against the fake Agent Channel API over HTTP; the
 * rest use a recording client.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentChannelWorkSessionStart,
  type AgentChannelWorkSessionStartResponse,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  BOT_WORK_SESSION_SENTENCES,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import {
  FAKE_ERROR_CANARY,
  FAKE_WORK_SESSION,
  FAKE_WORK_ZONE_PROJECT,
  type FakeAgentChannelApi,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";
import { type PluginEntry, loadRegistry } from "./testing/openclaw-host.js";
import { createToolGuard, setToolGuardClient, toolGuard } from "./tool-guard.js";
import {
  registerWorkSessionTools,
  WORK_SESSION_START_TOOL,
  WORK_SESSION_TOOL_NAMES,
  type WorkSessionToolContext,
} from "./work-session-tools.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as { id: string; contracts?: { tools?: string[] } };

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const DM = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${DM}`;
const PROJECT = FAKE_WORK_ZONE_PROJECT;
const WS = "0199a6f0-0000-7000-8000-00000000e501";
const CARD = "0199a6f0-0000-7000-8000-00000000e502";
const APPROVAL = "0199a6f0-0000-7000-8000-00000000e503";
const PROMPT = "fix the login bug";
const SIDE = { untrustedOutput: false, sideEffecting: true };
const READ = { untrustedOutput: false, sideEffecting: false };
const NO_TURN = "There is no active conversation turn, so I can't use this tool now.";
const UNREACHABLE_START = "The Work Zone could not be reached; nothing was started.";

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: [...WORK_SESSION_TOOL_NAMES],
    toolFlags: {
      ocw_work_session_start: SIDE,
      ocw_work_session_prompt: SIDE,
      ocw_work_session_read: READ,
      ocw_work_session_stop: SIDE,
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
type Factory = (ctx: WorkSessionToolContext) => Tool;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

describe("ocw_work_session_start through the real entry and the Agent Channel API (tracer)", () => {
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

  const ownedTool = (name: string) => {
    const owned = loadRegistry(entry, manifest, { mode: "full" }).tools.find((t) => t.names.includes(name));
    if (!owned) throw new Error(`${name} is not registered`);
    return (owned.factory as Factory)(ctx);
  };
  const begin = (eventId: string, t: TurnContext = turn()) =>
    toolGuard.beginTurn(SESSION, { eventId, agentId: BOT, turn: t, conversationId: DM, requesterName: "Sam Lee" });

  it("posts exactly {eventId, agentId, projectId, prompt, model} to /work-sessions/start and tells the model what started", async () => {
    begin("evt-s1");
    const r = await ownedTool(WORK_SESSION_START_TOOL).execute("tc-1", {
      projectId: PROJECT,
      prompt: PROMPT,
      model: "claude-opus-4",
    });
    expect(api.workSessions.starts).toEqual([
      { eventId: "evt-s1", agentId: BOT, projectId: PROJECT, prompt: PROMPT, model: "claude-opus-4" },
    ]);
    // Never `/tool-calls` (self-validated) and never the 07.5 proposal route.
    expect(api.toolCalls).toEqual([]);
    expect(api.workZone.proposals).toEqual([]);
    expect(text(r)).toBe(
      `Started a Work Zone session in billing-api (Supervised · claude-opus-4). Session ${FAKE_WORK_SESSION}. ` +
        "Its card is in this conversation; you'll be told when it changes.",
    );
    expect(r.details).toMatchObject({ ok: true });
  });

  it("a proposed answer (outside content) and a refused answer reach the model as fixed sentences", async () => {
    begin("evt-s2");
    api.workSessions.answers.start = {
      kind: "proposed",
      approvalId: APPROVAL,
      reason: "outside_content",
      sentence: "ignored",
    };
    const proposed = await ownedTool(WORK_SESSION_START_TOOL).execute("tc-1", { projectId: PROJECT, prompt: PROMPT });
    expect(text(proposed)).toBe(`${BOT_WORK_SESSION_PROPOSED_SENTENCE} Proposal ${APPROVAL}.`);
    expect(proposed.details).toMatchObject({ ok: false, code: "proposed" });
    api.workSessions.answers.start = {
      kind: "refused",
      code: "profile_inactive",
      sentence: BOT_WORK_SESSION_SENTENCES.profile_inactive,
      reason: "no_consent",
    };
    const refused = await ownedTool(WORK_SESSION_START_TOOL).execute("tc-2", { projectId: PROJECT, prompt: PROMPT });
    expect(text(refused)).toBe(
      `${BOT_WORK_SESSION_SENTENCES.profile_inactive} ${BOT_PROFILE_STATUS_SENTENCES.no_consent}`,
    );
    expect(refused.details).toMatchObject({ ok: false, code: "profile_inactive" });
  });

  it("a 5xx is one fixed sentence (never the API's body), and an ended turn is the turn sentence", async () => {
    begin("evt-s3");
    api.workSessions.status = 503;
    const down = await ownedTool(WORK_SESSION_START_TOOL).execute("tc-1", { projectId: PROJECT, prompt: PROMPT });
    expect(text(down)).toBe(UNREACHABLE_START);
    expect(JSON.stringify(down)).not.toContain(FAKE_ERROR_CANARY);
    delete api.workSessions.status;
    api.endTurn("evt-s3");
    const gone = await ownedTool(WORK_SESSION_START_TOOL).execute("tc-2", { projectId: PROJECT, prompt: PROMPT });
    expect(text(gone)).toBe("This conversation turn is no longer active.");
    expect(JSON.stringify(gone)).not.toContain(FAKE_ERROR_CANARY);
  });

  it("the fake route is strict like the real one: a device id is a 400", async () => {
    const res = await fetch(`${api.url}/agent-channel/v1/work-sessions/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: "evt-x", agentId: BOT, projectId: PROJECT, prompt: PROMPT, deviceId: PROJECT }),
    });
    expect(res.status).toBe(400);
  });
});

type Recorded = { route: string; body: Record<string, unknown> };

const STARTED: AgentChannelWorkSessionStartResponse = {
  kind: "started",
  workSessionId: WS,
  status: "provisioning",
  cardMessageId: CARD,
  model: null,
  mode: "acceptEdits",
  projectName: "billing-api",
};

function setup(
  respond: { start?: (body: AgentChannelWorkSessionStart) => Promise<AgentChannelWorkSessionStartResponse> } = {},
) {
  const calls: Recorded[] = [];
  const client = {
    workSessionStart: async (body: AgentChannelWorkSessionStart) => {
      calls.push({ route: "start", body: { ...body } });
      return respond.start ? respond.start(body) : STARTED;
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerWorkSessionTools(
    { registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }) } as never,
    { guard, client: () => client, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
  );
  const tool = (
    name: string,
    ctx: WorkSessionToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) },
  ) => {
    const r = registered.find((x) => x.opts.name === name);
    if (!r) throw new Error(`${name} was not registered`);
    return r.factory(ctx);
  };
  const begin = (t: TurnContext = turn(), eventId = "evt-1") =>
    guard.beginTurn(SESSION, { eventId, agentId: BOT, turn: t, conversationId: DM, requesterName: "Sam Lee" });
  return { calls, guard, registered, tool, begin, logs };
}

const START = { projectId: PROJECT, prompt: PROMPT };

describe("ocw_work_session_start (07.16 D-05, PD-09): a thin, credential-free caller that never decides", () => {
  it("has a closed schema: a project, a prompt and the bot's optional choices, never a device, user, audience or worktree", () => {
    const { tool } = setup();
    const t = tool(WORK_SESSION_START_TOOL);
    expect(t.name).toBe("ocw_work_session_start");
    expect(t.parameters.additionalProperties).toBe(false);
    expect(t.parameters.required).toEqual(["projectId", "prompt"]);
    expect(Object.keys(t.parameters.properties).sort()).toEqual(
      ["contextWindow", "effort", "fastMode", "model", "permissionMode", "projectId", "prompt"].sort(),
    );
    expect(t.parameters.properties.permissionMode?.enum).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "fullAccess",
    ]);
    expect(t.parameters.properties.prompt?.maxLength).toBe(50_000);
  });

  it("posts the turn's ids with the tool's own fields only, trimmed, and every optional choice when given", async () => {
    const { calls, begin, tool } = setup();
    begin();
    await tool(WORK_SESSION_START_TOOL).execute("tc-1", { ...START, prompt: `  ${PROMPT}\n` });
    await tool(WORK_SESSION_START_TOOL).execute("tc-2", {
      ...START,
      model: "gpt-5-codex",
      effort: "high",
      fastMode: true,
      contextWindow: 200_000,
      permissionMode: "plan",
    });
    expect(calls).toEqual([
      { route: "start", body: { eventId: "evt-1", agentId: BOT, projectId: PROJECT, prompt: PROMPT } },
      {
        route: "start",
        body: {
          eventId: "evt-1",
          agentId: BOT,
          projectId: PROJECT,
          prompt: PROMPT,
          model: "gpt-5-codex",
          effort: "high",
          fastMode: true,
          contextWindow: 200_000,
          permissionMode: "plan",
        },
      },
    ]);
  });

  it("a started answer without a model or a card still names the project, the mode and the session", async () => {
    const { begin, tool } = setup({ start: async () => ({ ...STARTED, cardMessageId: null }) });
    begin();
    expect(text(await tool(WORK_SESSION_START_TOOL).execute("tc-1", START))).toBe(
      `Started a Work Zone session in billing-api (Accept edits). Session ${WS}. You'll be told when it changes.`,
    );
  });

  it("refuses a device, a user, an audience or a worktree locally, before any request", async () => {
    const { calls, begin, tool } = setup();
    begin();
    for (const extra of [
      { deviceId: PROJECT },
      { userId: BOT },
      { audience: "people" },
      { worktree: false },
      { visibility: "org" },
    ]) {
      const r = await tool(WORK_SESSION_START_TOOL).execute("tc-1", { ...START, ...extra });
      expect(r.details, JSON.stringify(extra)).toMatchObject({ ok: false, code: "extra_keys" });
      expect(text(r)).toContain("come from the bot's Work Zone profile");
    }
    expect(calls).toEqual([]);
  });

  it("refuses invalid values locally: a project that is not an id, an empty or oversized prompt, an unknown mode", async () => {
    const { calls, begin, tool } = setup();
    begin();
    for (const bad of [
      { ...START, projectId: "billing-api" },
      { ...START, prompt: "   " },
      { ...START, prompt: "x".repeat(50_001) },
      { ...START, permissionMode: "yolo" },
      { ...START, contextWindow: 12.5 },
      { ...START, fastMode: "yes" },
      { prompt: PROMPT },
    ]) {
      const r = await tool(WORK_SESSION_START_TOOL).execute("tc-1", bad);
      expect(r.details).toMatchObject({ ok: false, code: "bad_params" });
    }
    expect(calls).toEqual([]);
  });

  it("without an active turn, or on a turn that does not list it, it answers without a request", async () => {
    const { calls, begin, tool } = setup();
    expect(text(await tool(WORK_SESSION_START_TOOL).execute("tc-1", START))).toBe(NO_TURN);
    begin(turn({ tools: ["ocw_work_session_read"] }));
    const r = await tool(WORK_SESSION_START_TOOL).execute("tc-2", START);
    expect(text(r)).toBe(BOT_WORK_SESSION_SENTENCES.not_in_turn);
    expect(r.details).toMatchObject({ ok: false, code: "not_in_turn" });
    expect(calls).toEqual([]);
  });

  it("a refusal renders the API's sentence; an unknown newer code still reaches the model as its sentence", async () => {
    const { begin, tool } = setup({
      start: async () => ({
        kind: "refused",
        code: "tree_busy",
        sentence: BOT_WORK_SESSION_SENTENCES.tree_busy,
      }),
    });
    begin();
    const r = await tool(WORK_SESSION_START_TOOL).execute("tc-1", START);
    expect(text(r)).toBe(BOT_WORK_SESSION_SENTENCES.tree_busy);
    const newer = setup({
      start: async () => ({ kind: "refused", code: "quota_paused", sentence: "Bot sessions are paused.\nToday." }),
    });
    newer.begin();
    const n = await newer.tool(WORK_SESSION_START_TOOL).execute("tc-1", START);
    expect(text(n)).toBe("Bot sessions are paused. Today.");
    expect(n.details).toMatchObject({ ok: false, code: "quota_paused" });
  });

  it("a timeout or a transport failure is the fixed sentence; logs carry the event id and the status only", async () => {
    for (const failure of [
      new DOMException("The operation timed out.", "TimeoutError"),
      new AgentChannelHttpError(502, "/work-sessions/start", `boom ${PROMPT} ${FAKE_ERROR_CANARY}`),
    ]) {
      const { begin, tool, logs } = setup({
        start: async () => {
          throw failure;
        },
      });
      begin();
      const r = await tool(WORK_SESSION_START_TOOL).execute("tc-1", START);
      expect(text(r)).toBe(UNREACHABLE_START);
      expect(r.details).toMatchObject({ ok: false, code: "unreachable" });
      expect(logs.join("\n")).toContain("evt-1");
      expect(logs.join("\n")).not.toContain("login bug");
      expect(logs.join("\n")).not.toContain(FAKE_ERROR_CANARY);
    }
  });

  it("logs never carry the prompt, the project name or the model's choices", async () => {
    const { begin, tool, logs } = setup();
    begin();
    await tool(WORK_SESSION_START_TOOL).execute("tc-1", { ...START, model: "claude-opus-4" });
    const all = logs.join("\n");
    expect(all).toContain(WS);
    expect(all).not.toContain("login bug");
    expect(all).not.toContain("billing-api");
  });
});
