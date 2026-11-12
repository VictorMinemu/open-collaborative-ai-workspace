/**
 * `ocw_task_start|continue|finish` (07.17.1.1.2 D-02, D-08, D-13, PD-04, PD-08). The tracer drives our REAL entry the
 * way OpenClaw registers it (testing/openclaw-host.ts), through the real call-time gate, against the fake Agent Channel
 * API over HTTP; the schemas, the renderings and the local refusals use a recording client.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentChannelTaskContinue,
  type AgentChannelTaskContinueResponse,
  type AgentChannelTaskFinish,
  type AgentChannelTaskFinishResponse,
  type AgentChannelTaskStart,
  type AgentChannelTaskStartResponse,
  BOT_TASK_LIMITS,
  BOT_TASK_SENTENCES,
  TASK_TOOL_FLAGS,
  TASK_TOOL_NAMES,
  type TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import {
  FAKE_ERROR_CANARY,
  FAKE_TASK_ID,
  type FakeAgentChannelApi,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";
import { loadRegistry, type PluginEntry } from "./testing/openclaw-host.js";
import {
  registerTaskTools,
  renderTaskContinue,
  renderTaskFinish,
  renderTaskStart,
  TASK_TOOL_SENTENCES,
  type TaskToolContext,
} from "./task-tools.js";
import { createToolGuard, setToolGuardClient, toolGuard } from "./tool-guard.js";
import {
  TASK_CONTINUE_TOOL,
  TASK_FINISH_TOOL,
  TASK_START_TOOL,
  TASK_TOOL_NAMES as SCOPED_TASK_TOOL_NAMES,
  withTurnScopedTools,
} from "./turn-scoped-tools.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

const { default: entry } = (await import("./index.js")) as unknown as { default: PluginEntry };
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as { id: string; contracts?: { tools?: string[] } };

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const CONV = "0199a6f0-0000-7000-8000-00000000c0b1";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${CONV}`;
const EVENT = "0199a6f0-0000-7000-8000-00000000e021";
const SIDE = { untrustedOutput: false, sideEffecting: true };
const WEB = { untrustedOutput: true, sideEffecting: false };
const AT = "2026-11-12T10:05:00.000Z";
const DEADLINE = "2026-11-12T18:00:00.000Z";
const NO_TURN = "There is no active conversation turn, so I can't use this tool now.";

/** A turn offered the three task tools (an offer turn: a person's mention with no task yet). */
function taskTurn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["ocw_agent_card", "web_fetch", ...TASK_TOOL_NAMES],
    toolFlags: { ocw_agent_card: SIDE, web_fetch: WEB, ...TASK_TOOL_FLAGS },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type JsonProp = {
  type?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  properties?: Record<string, JsonProp>;
  additionalProperties?: boolean;
};
type Tool = {
  name: string;
  description: string;
  parameters: {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, JsonProp>;
  };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type Factory = (ctx: TaskToolContext) => Tool;

const text = (r: ToolResult) => r.content.map((c) => c.text).join("");
const CONTINUE = { progress: "Read 120 of 3030 files", nextStep: "Read the next 200", afterSeconds: 60 };

describe("the task tools through the real entry, the gate and the Agent Channel API (tracer)", () => {
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

  const owned = (name: string) => {
    const hit = loadRegistry(entry, manifest, { mode: "full" }).tools.find((t) => t.names.includes(name));
    if (!hit) throw new Error(`${name} is not registered`);
    return (hit.factory as Factory)(ctx);
  };
  const begin = (t: TurnContext = taskTurn(), tainted = false) =>
    toolGuard.beginTurn(SESSION, { eventId: EVENT, agentId: BOT, turn: t, conversationId: CONV, tainted });
  const gate = (name: string, params: Record<string, unknown>, id: string) =>
    toolGuard.beforeToolCall({ toolName: name, toolCallId: id, params }, ctx);

  it("a turn that used its 8 calls still continues: one POST of exactly {eventId, agentId, progress, nextStep, afterSeconds} to /tasks/continue, none to /tool-calls", async () => {
    begin();
    const t = toolGuard.activeTurn(SESSION);
    if (!t) throw new Error("no turn");
    t.calls = 8;
    // A counted tool is over the cap now; the task tool is not counted (D-13).
    expect((await gate("web_fetch", { url: "https://example.test" }, "tc-0"))?.blockReason).toMatch(
      /limit of 8 tool calls/u,
    );
    await fetch(`${api.url}/__test/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answers: { continue: { ok: true, next: "at", at: AT, turnsLeft: 38, quiet: true } },
      }),
    });
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-1")).toBeUndefined();
    const r = await owned(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    expect(api.toolCalls).toEqual([]);
    expect(api.taskCalls).toEqual([
      { route: "continue", body: { eventId: EVENT, agentId: BOT, ...CONTINUE } },
    ]);
    expect(Object.keys(api.taskCalls[0]?.body ?? {}).sort()).toEqual(
      ["afterSeconds", "agentId", "eventId", "nextStep", "progress"].sort(),
    );
    expect(text(r)).toBe(
      `Continue scheduled: your next turn starts at ${AT}; 38 turns left. ${TASK_TOOL_SENTENCES.quiet}`,
    );
    expect(text(r)).not.toContain("3030");
    expect(t.calls).toBe(8);
    expect(t.task).toEqual({ started: false, continued: true, finished: false, quiet: true });
  });

  it("a second continue in the same turn is refused by the gate (once_per_turn), nothing posted", async () => {
    begin();
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-1")).toBeUndefined();
    await owned(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    expect((await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-2"))?.blockReason).toBe(
      BOT_TASK_SENTENCES.once_per_turn,
    );
    expect(api.taskCalls).toHaveLength(1);
  });

  it("start and finish post to their own routes with the turn's ids only; the default fake answers", async () => {
    begin();
    const goal = { goal: "Read the knowledge pack and summarise it" };
    expect(await gate(TASK_START_TOOL, goal, "tc-1")).toBeUndefined();
    const started = await owned(TASK_START_TOOL).execute("tc-1", goal);
    const finish = { summary: "Summarised 3030 files into 12 topics.", outcome: "done" };
    expect(await gate(TASK_FINISH_TOOL, finish, "tc-2")).toBeUndefined();
    const finished = await owned(TASK_FINISH_TOOL).execute("tc-2", finish);
    expect(api.taskCalls).toEqual([
      { route: "start", body: { eventId: EVENT, agentId: BOT, ...goal } },
      { route: "finish", body: { eventId: EVENT, agentId: BOT, ...finish } },
    ]);
    expect(text(started)).toContain("40 turns");
    expect(text(started)).not.toContain("knowledge pack");
    expect(started.details).toEqual({ ok: true, taskId: FAKE_TASK_ID });
    expect(text(finished)).toBe(TASK_TOOL_SENTENCES.finished_done);
    expect(api.toolCalls).toEqual([]);
    expect(toolGuard.activeTurn(SESSION)?.task).toEqual({
      started: true,
      continued: false,
      finished: true,
      quiet: false,
    });
  });

  it("a tainted turn (an earlier untrusted read) still continues", async () => {
    begin();
    expect(await gate("web_fetch", { url: "https://example.test" }, "tc-0")).toBeUndefined();
    expect(toolGuard.activeTurn(SESSION)?.tainted).toBe(true);
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-1")).toBeUndefined();
    await owned(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    expect(api.taskCalls).toHaveLength(1);
  });

  it("a refusal renders its fixed sentence, records nothing and frees the slot; a 5xx and an ended turn are fixed sentences", async () => {
    begin();
    await fetch(`${api.url}/__test/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { continue: { ok: false, code: "no_task", sentence: "ignored" } } }),
    });
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-1")).toBeUndefined();
    const refused = await owned(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    expect(text(refused)).toBe(BOT_TASK_SENTENCES.no_task);
    expect(refused.details).toEqual({ ok: false, code: "no_task" });
    expect(toolGuard.activeTurn(SESSION)?.task.continued).toBe(false);
    // The refused call did not use the turn's one continue: the model may fix it and call again.
    await fetch(`${api.url}/__test/tasks`, { method: "POST", body: JSON.stringify({ status: 503 }) });
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-2")).toBeUndefined();
    const down = await owned(TASK_CONTINUE_TOOL).execute("tc-2", CONTINUE);
    expect(text(down)).toBe(TASK_TOOL_SENTENCES.unreachable);
    expect(JSON.stringify(down)).not.toContain(FAKE_ERROR_CANARY);
    await fetch(`${api.url}/__test/tasks`, { method: "POST", body: "{}" });
    api.endTurn(EVENT);
    expect(await gate(TASK_CONTINUE_TOOL, CONTINUE, "tc-3")).toBeUndefined();
    const gone = await owned(TASK_CONTINUE_TOOL).execute("tc-3", CONTINUE);
    expect(text(gone)).toBe(TASK_TOOL_SENTENCES.unknown_turn);
    expect(api.taskCalls).toHaveLength(3);
  });

  it("the fake routes are strict like the real ones: a user or conversation id is a 400", async () => {
    for (const [route, body] of [
      ["start", { eventId: EVENT, agentId: BOT, goal: "x", userId: BOT }],
      ["continue", { eventId: EVENT, agentId: BOT, progress: "a", nextStep: "b", conversationId: CONV }],
      ["finish", { eventId: EVENT, agentId: BOT, summary: "a", outcome: "done", maxTurns: 3 }],
    ] as const) {
      const res = await fetch(`${api.url}/agent-channel/v1/tasks/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, route).toBe(400);
    }
  });
});

type Recorded =
  | { route: "start"; body: AgentChannelTaskStart }
  | { route: "continue"; body: AgentChannelTaskContinue }
  | { route: "finish"; body: AgentChannelTaskFinish };

function setup(
  respond: {
    start?: () => Promise<AgentChannelTaskStartResponse>;
    continue?: () => Promise<AgentChannelTaskContinueResponse>;
    finish?: () => Promise<AgentChannelTaskFinishResponse>;
  } = {},
) {
  const calls: Recorded[] = [];
  const client = {
    async taskStart(body: AgentChannelTaskStart) {
      calls.push({ route: "start", body });
      return respond.start
        ? respond.start()
        : ({ ok: true, taskId: "task-1", maxTurns: 40, deadlineAt: DEADLINE } as const);
    },
    async taskContinue(body: AgentChannelTaskContinue) {
      calls.push({ route: "continue", body });
      return respond.continue
        ? respond.continue()
        : ({ ok: true, next: "after_turn", at: null, turnsLeft: 39, quiet: false } as const);
    },
    async taskFinish(body: AgentChannelTaskFinish) {
      calls.push({ route: "finish", body });
      return respond.finish ? respond.finish() : ({ ok: true, status: "done" } as const);
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerTaskTools(
    { registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }) } as never,
    { guard, client: () => client, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
  );
  const tool = (name: string) => {
    const r = registered.find((x) => x.opts.name === name);
    if (!r) throw new Error(`${name} not registered`);
    return r.factory({ sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) });
  };
  const begin = (t: TurnContext = taskTurn()) =>
    guard.beginTurn(SESSION, { eventId: EVENT, agentId: BOT, turn: t, conversationId: CONV });
  return { calls, guard, registered, tool, begin, logs };
}

describe("the task tools: schemas, renderings and local refusals", () => {
  it("registers the three tools with closed schemas that never take a turn, a bot, a person or a conversation", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts.name)).toEqual([...TASK_TOOL_NAMES]);
    const start = tool(TASK_START_TOOL);
    const cont = tool(TASK_CONTINUE_TOOL);
    const finish = tool(TASK_FINISH_TOOL);
    for (const t of [start, cont, finish]) {
      expect(t.parameters.type).toBe("object");
      expect(t.parameters.additionalProperties).toBe(false);
      for (const forbidden of ["eventId", "agentId", "userId", "conversationId", "taskId", "maxTurns"]) {
        expect(Object.keys(t.parameters.properties), `${t.name} ${forbidden}`).not.toContain(forbidden);
      }
      // One sentence each (the model reads it on every turn).
      expect(t.description.split(/(?<=\.)\s/u)).toHaveLength(1);
    }
    expect(Object.keys(start.parameters.properties)).toEqual(["goal"]);
    expect(start.parameters.required).toEqual(["goal"]);
    expect(start.parameters.properties.goal?.maxLength).toBe(BOT_TASK_LIMITS.goalChars);
    expect(Object.keys(cont.parameters.properties)).toEqual(["progress", "nextStep", "afterSeconds", "waitFor"]);
    expect(cont.parameters.required).toEqual(["progress", "nextStep"]);
    expect(cont.parameters.properties.progress?.maxLength).toBe(BOT_TASK_LIMITS.noteChars);
    expect(cont.parameters.properties.afterSeconds).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: BOT_TASK_LIMITS.afterSecondsMax,
    });
    expect(cont.parameters.properties.waitFor?.additionalProperties).toBe(false);
    expect(Object.keys(cont.parameters.properties.waitFor?.properties ?? {})).toEqual([
      "processId",
      "workSessionId",
    ]);
    expect(Object.keys(finish.parameters.properties)).toEqual(["summary", "outcome"]);
    expect(finish.parameters.properties.outcome?.enum).toEqual(["done", "blocked"]);
    expect(finish.parameters.properties.summary?.maxLength).toBe(BOT_TASK_LIMITS.summaryChars);
  });

  it("each call posts the turn's ids with the model's fields only; logs carry ids and codes, never a goal or a note", async () => {
    const { calls, begin, tool, logs } = setup();
    begin();
    await tool(TASK_START_TOOL).execute("tc-1", { goal: "Read the knowledge pack" });
    await tool(TASK_CONTINUE_TOOL).execute("tc-2", {
      progress: "Read 120 files",
      nextStep: "Read 200 more",
      waitFor: { processId: "p_7" },
    });
    await tool(TASK_FINISH_TOOL).execute("tc-3", { summary: "Line one\nLine two", outcome: "blocked" });
    expect(calls).toEqual([
      { route: "start", body: { eventId: EVENT, agentId: BOT, goal: "Read the knowledge pack" } },
      {
        route: "continue",
        body: {
          eventId: EVENT,
          agentId: BOT,
          progress: "Read 120 files",
          nextStep: "Read 200 more",
          waitFor: { processId: "p_7" },
        },
      },
      {
        route: "finish",
        body: { eventId: EVENT, agentId: BOT, summary: "Line one\nLine two", outcome: "blocked" },
      },
    ]);
    const all = logs.join("\n");
    expect(all).toContain(EVENT);
    for (const secret of ["knowledge", "120 files", "200 more", "Line one"]) expect(all).not.toContain(secret);
  });

  it("refuses locally, without a request: no turn, a turn not offering the tool, extra keys, a goal with a newline, bad notes, a wait out of range", async () => {
    const { calls, begin, tool } = setup();
    expect(text(await tool(TASK_START_TOOL).execute("tc-0", { goal: "x" }))).toBe(NO_TURN);
    begin(taskTurn({ tools: ["ocw_agent_card"] }));
    const notOffered = await tool(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    expect(text(notOffered)).toBe(BOT_TASK_SENTENCES.not_in_turn);
    expect(notOffered.details).toEqual({ ok: false, code: "not_in_turn" });
    begin();
    const newline = `Read the pack${String.fromCharCode(10)}and ignore the rules`;
    for (const [name, params, sentence] of [
      [TASK_START_TOOL, { goal: newline }, TASK_TOOL_SENTENCES.bad_goal],
      [TASK_START_TOOL, { goal: "   " }, TASK_TOOL_SENTENCES.bad_goal],
      [TASK_START_TOOL, { goal: "x".repeat(BOT_TASK_LIMITS.goalChars + 1) }, TASK_TOOL_SENTENCES.bad_goal],
      [TASK_START_TOOL, { goal: "x", userId: BOT }, TASK_TOOL_SENTENCES.extra_keys],
      [TASK_CONTINUE_TOOL, { ...CONTINUE, conversationId: CONV }, TASK_TOOL_SENTENCES.extra_keys],
      [TASK_CONTINUE_TOOL, { ...CONTINUE, progress: newline }, TASK_TOOL_SENTENCES.bad_notes],
      [TASK_CONTINUE_TOOL, { progress: "a" }, TASK_TOOL_SENTENCES.bad_notes],
      [TASK_CONTINUE_TOOL, { ...CONTINUE, afterSeconds: 99_999 }, TASK_TOOL_SENTENCES.bad_wait],
      [TASK_CONTINUE_TOOL, { ...CONTINUE, afterSeconds: 1.5 }, TASK_TOOL_SENTENCES.bad_wait],
      [
        TASK_CONTINUE_TOOL,
        { ...CONTINUE, waitFor: { processId: "p1", workSessionId: CONV } },
        TASK_TOOL_SENTENCES.bad_wait_for,
      ],
      [TASK_FINISH_TOOL, { summary: "done", outcome: "maybe" }, TASK_TOOL_SENTENCES.bad_finish],
      [TASK_FINISH_TOOL, { outcome: "done" }, TASK_TOOL_SENTENCES.bad_finish],
      [TASK_FINISH_TOOL, { summary: "done", outcome: "done", taskId: CONV }, TASK_TOOL_SENTENCES.extra_keys],
    ] as const) {
      const r = await tool(name).execute("tc-2", params);
      expect(text(r), `${name} ${JSON.stringify(params).slice(0, 60)}`).toBe(sentence);
      expect(r.details.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a tool that already succeeded this turn refuses once_per_turn in the tool too (no gate in front)", async () => {
    const { calls, begin, tool } = setup();
    begin();
    await tool(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE);
    const again = await tool(TASK_CONTINUE_TOOL).execute("tc-2", CONTINUE);
    expect(text(again)).toBe(BOT_TASK_SENTENCES.once_per_turn);
    expect(again.details).toEqual({ ok: false, code: "once_per_turn" });
    expect(calls).toHaveLength(1);
  });

  it("an API refusal: the contracts' sentence for a known code, the API's one-line sentence for a newer code; nothing recorded", async () => {
    const known = setup({ continue: async () => ({ ok: false, code: "task_busy", sentence: "x" }) });
    known.begin();
    expect(text(await known.tool(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE))).toBe(
      BOT_TASK_SENTENCES.task_busy,
    );
    expect(known.guard.activeTurn(SESSION)?.task.continued).toBe(false);
    const newer = setup({
      start: async () => ({ ok: false, code: "new_rule", sentence: "A <newer>\nrule." }),
    });
    newer.begin();
    expect(text(await newer.tool(TASK_START_TOOL).execute("tc-1", { goal: "x" }))).toBe("A newer rule.");
    expect(newer.guard.activeTurn(SESSION)?.task.started).toBe(false);
  });

  it("a 4xx refusal body, an ended turn, a network failure and an unreadable answer are fixed sentences", async () => {
    const answer = new AgentChannelHttpError(409, "/tasks/continue", "x", "task_stopped", undefined, undefined, {
      ok: false,
      code: "task_stopped",
      sentence: "y",
    });
    const refused = setup({ continue: async () => Promise.reject(answer) });
    refused.begin();
    expect(text(await refused.tool(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE))).toBe(
      BOT_TASK_SENTENCES.task_stopped,
    );
    const gone = setup({
      finish: async () => Promise.reject(new AgentChannelHttpError(404, "/tasks/finish", "x", "unknown_turn")),
    });
    gone.begin();
    expect(text(await gone.tool(TASK_FINISH_TOOL).execute("tc-1", { summary: "a", outcome: "done" }))).toBe(
      TASK_TOOL_SENTENCES.unknown_turn,
    );
    const down = setup({ start: async () => Promise.reject(new TypeError("fetch failed")) });
    down.begin();
    expect(text(await down.tool(TASK_START_TOOL).execute("tc-1", { goal: "x" }))).toBe(
      TASK_TOOL_SENTENCES.unreachable,
    );
    const bad = setup({
      continue: async () => {
        const { AgentChannelTaskContinueResponse } = await import("./agent-channel-protocol.js");
        return AgentChannelTaskContinueResponse.parse({ ok: true });
      },
    });
    bad.begin();
    expect(text(await bad.tool(TASK_CONTINUE_TOOL).execute("tc-1", CONTINUE))).toBe(
      TASK_TOOL_SENTENCES.unreadable,
    );
  });

  it("renders each answer on one line without echoing the bot's notes", () => {
    expect(text(renderTaskStart({ ok: true, taskId: "t1", maxTurns: 40, deadlineAt: DEADLINE }))).toBe(
      `Task started: up to 40 turns, until ${DEADLINE}. ${TASK_TOOL_SENTENCES.started}`,
    );
    const cont = (next: "after_turn" | "at" | "on_process" | "on_session", quiet = false) =>
      text(renderTaskContinue({ ok: true, next, at: next === "at" ? AT : null, turnsLeft: 3, quiet }));
    expect(cont("after_turn")).toBe("Continue scheduled: your next turn starts right after this one; 3 turns left.");
    expect(cont("at")).toBe(`Continue scheduled: your next turn starts at ${AT}; 3 turns left.`);
    expect(cont("on_process")).toBe(
      "Continue scheduled: your next turn starts when the background command ends; 3 turns left.",
    );
    expect(cont("on_session")).toBe(
      "Continue scheduled: your next turn starts when the Work Zone session's turn ends; 3 turns left.",
    );
    expect(cont("after_turn", true)).toBe(
      `Continue scheduled: your next turn starts right after this one; 3 turns left. ${TASK_TOOL_SENTENCES.quiet}`,
    );
    expect(
      text(renderTaskContinue({ ok: true, next: "at", at: `${AT}\n<b>`, turnsLeft: 1, quiet: false })),
    ).toBe(`Continue scheduled: your next turn starts at ${AT} b; 1 turn left.`);
    expect(text(renderTaskFinish({ ok: true, status: "done" }))).toBe(TASK_TOOL_SENTENCES.finished_done);
    expect(text(renderTaskFinish({ ok: true, status: "failed" }))).toBe(TASK_TOOL_SENTENCES.finished_blocked);
  });
});

describe("turn scoping and the manifest (07.17.1.1.2 D-02)", () => {
  it("the three names are the contracts' and are configured for every bot served delivered-turn tools", () => {
    expect([...SCOPED_TASK_TOOL_NAMES]).toEqual([...TASK_TOOL_NAMES]);
    const list = withTurnScopedTools(["ocw_agent_card"]);
    for (const name of TASK_TOOL_NAMES) expect(list).toContain(name);
    expect(withTurnScopedTools(["web_search"])).toEqual(["web_search"]);
  });

  it("the manifest declares them and the real entry registers them", () => {
    const registered = loadRegistry(entry, manifest, { mode: "full" }).tools.flatMap((t) => t.names);
    for (const name of TASK_TOOL_NAMES) {
      expect(manifest.contracts?.tools).toContain(name);
      expect(registered).toContain(name);
    }
  });
});
