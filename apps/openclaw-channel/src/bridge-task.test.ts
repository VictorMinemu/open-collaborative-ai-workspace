/**
 * 07.17.1.1.2 (D-02, D-14, PD-16, PD-17, E23, E25): the bridge side of long tasks. `agent.task.v1` is a turn event
 * (mapped like a Work Zone wake on the task card's thread); a turn whose continue answered `quiet: true` posts nothing; a
 * task turn that continued or finished without text is not a failure (never re-dispatched, no failure reply); every turn
 * that lists a task tool, and every task event, reports `POST /turns/:eventId/done`. Driven against the fake Agent
 * Channel API over HTTP, with OpenClaw replaced by a scripted port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellAgent, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { createAgentChannelClient } from "./api-client.js";
import { createBridge, FAILURE_REPLY, type OpenClawPort, type TurnRun } from "./bridge.js";
import type { MappedMention } from "./mention-mapper.js";
import { planReconcile } from "./reconciler.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";
import type { TaskTurnOutcome } from "./tool-guard.js";

const GERTRU: CellAgent = {
  id: "agent-gertru",
  handle: "gertru",
  displayName: "Gertru",
  avatarUrl: null,
  description: null,
  instructions: "",
  status: "ready",
  modelRef: "fake/mock-1",
  model: { provider: "mock", providerId: "fake", id: "mock-1" },
  capabilities: { tools: ["ocw_agent_card"] },
};
const FAKE: CellProvider = {
  id: "fake",
  kind: "mock",
  api: "openai-completions",
  baseUrl: "http://fake-model:18999/v1",
  apiKey: "mock-key-not-secret",
  models: ["mock-1"],
};

const ANA = { kind: "user" as const, id: "u-ana", displayName: "Ana" };
const TASK_ID = "task-0001";
const CARD_MESSAGE_ID = "msg-task-card";
const THREAD_ROOT_ID = "msg-root-1";
const NONE = { untrustedOutput: false, sideEffecting: false };
const TASK_TOOLS = ["ocw_task_start", "ocw_task_continue", "ocw_task_finish"];

const TURN_TASK = {
  taskId: TASK_ID,
  status: "running",
  goal: "Read the knowledge pack and summarise it",
  progress: "Read 400 of 3030 files",
  nextStep: "Read the next 400",
  turnsUsed: 8,
  maxTurns: 40,
  startedAt: "2026-11-12T10:00:00.000Z",
  deadlineAt: "2026-11-12T18:00:00.000Z",
  requesterId: ANA.id,
  waiting: null,
  finishedProcesses: [],
};

function turn(tools: string[], over: Record<string, unknown> = {}) {
  return {
    tools: ["ocw_agent_card", ...tools],
    toolFlags: Object.fromEntries(tools.map((t) => [t, NONE])),
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

const base = (n: number, eventId: string, messageId: string, text: string) => ({
  eventId,
  seq: n,
  organizationId: "cell-1",
  cellId: "cell-1",
  agent: { id: GERTRU.id, handle: "gertru", displayName: "Gertru" },
  conversation: { id: "conv-1", kind: "channel", name: "knowledge" },
  thread: { rootMessageId: THREAD_ROOT_ID },
  message: {
    id: messageId,
    text,
    createdAt: "2026-11-12T10:30:00.000Z",
    author: ANA,
    mentions: [{ kind: "agent", id: GERTRU.id }],
  },
  threadHistory: [],
  roster: [{ ...ANA, role: "member" }],
});

/** A continuation of the bot's own task: a mention on the task card, `turn.task`, continue and finish. */
function taskEvent(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base(n, `evt-task-${n}`, CARD_MESSAGE_ID, "Continue your task (turn 8 of 40)."),
    type: "agent.task.v1",
    turn: turn(TASK_TOOLS.slice(1), { task: TURN_TASK }),
    task: { taskId: TASK_ID, reason: "continue" },
    ...over,
  };
}

/** A person's mention; `tools` decides whether it may start a task. */
function mentionEvent(n: number, tools: string[]): Record<string, unknown> {
  return {
    ...base(n, `evt-mention-${n}`, `msg-${n}`, "@gertru read the whole knowledge pack"),
    type: "agent.mention.v1",
    turn: turn(tools),
  };
}

type Attempt = { texts: string[]; task: TaskTurnOutcome | null };
const outcome = (over: Partial<TaskTurnOutcome> = {}): TaskTurnOutcome => ({
  started: false,
  continued: false,
  finished: false,
  quiet: false,
  ...over,
});

type ScriptedPort = OpenClawPort & { dispatched: MappedMention[]; script: Attempt[] };

function scriptedPort(): ScriptedPort {
  const port: ScriptedPort = {
    dispatched: [],
    script: [],
    async dispatchMention(m, deliver): Promise<TurnRun> {
      port.dispatched.push(m);
      const attempt = port.script.shift() ?? { texts: ["On it."], task: null };
      for (const text of attempt.texts) await deliver(text);
      return { task: attempt.task };
    },
    async reconcile(cell: CellSnapshot) {
      const plan = planReconcile({}, cell);
      return { changed: plan.changed, results: plan.results };
    },
  };
  return port;
}

let api: FakeAgentChannelApi;
let port: ScriptedPort;
let logs: string[];

async function bridge() {
  const client = createAgentChannelClient({
    apiUrl: api.url,
    token: () => api.token,
    backoff: { baseMs: 5, maxMs: 20 },
  });
  const b = createBridge({
    client,
    port,
    signal: new AbortController().signal,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    typingIntervalMs: 50,
    retryDelayMs: 5,
    dispatchAttempts: 2,
  });
  await b.refreshCell();
  return b;
}

beforeEach(async () => {
  api = await startFakeAgentChannelApi({ agents: [structuredClone(GERTRU)], providers: [FAKE] });
  port = scriptedPort();
  logs = [];
});

afterEach(async () => {
  await api.close();
});

describe("OpenClaw's inbound id is unique per delivery and attempt (CI p289: `skipped:duplicate`)", () => {
  it("two continuations on the same card message, and each retry, reach OpenClaw with distinct inbound ids; replies still anchor on the card", async () => {
    const b = await bridge();
    // Attempt 1 of the second event produces nothing (a failed attempt), attempt 2 answers.
    port.script = [
      { texts: ["Turn one."], task: null },
      { texts: [], task: null },
      { texts: ["Turn two."], task: null },
    ];
    await b.handleFrame({ seq: 1, type: "agent.task.v1", data: taskEvent(1) });
    await b.handleFrame({ seq: 2, type: "agent.task.v1", data: taskEvent(2) });
    const ids = port.dispatched.map((m) => m.inboundMessageId);
    expect(ids).toEqual(["evt-task-1", "evt-task-2", "evt-task-2:2"]);
    expect(new Set(ids).size).toBe(3);
    // The chat anchor (reply target) stays the real message.
    expect(port.dispatched.every((m) => m.messageId === CARD_MESSAGE_ID)).toBe(true);
  });
});

describe("agent.task.v1 (07.17.1.1.2 D-02, D-14, PD-17): a continuation is the bot's turn in its task card's thread", () => {
  it("is a turn event dispatched once into the card's thread session; a quiet continue drops the text, no failure reply, done replied (tracer)", async () => {
    const b = await bridge();
    port.script.push({ texts: ["Read 200 more files."], task: outcome({ continued: true, quiet: true }) });
    await b.handleFrame({ seq: 1, type: "agent.task.v1", data: taskEvent(1) });

    expect(port.dispatched).toHaveLength(1);
    const m = port.dispatched[0] as MappedMention;
    expect(m.eventId).toBe("evt-task-1");
    expect(m.sessionThreadId).toBe(THREAD_ROOT_ID);
    expect(m.messageId).toBe(CARD_MESSAGE_ID);
    expect(m.body).toBe("Continue your task (turn 8 of 40).");
    expect(m.contextBlocks.find((x) => x.type === "task")?.label).toBe("Your task (your own notes)");
    expect(m.personaPrompt).toContain("You are working on your task (see 'Your task').");
    expect(api.messages).toEqual([]);
    expect(api.turnsDone).toEqual([
      { eventId: "evt-task-1", agentId: GERTRU.id, outcome: "replied", status: 204 },
    ]);
    // Ids only in the logs, never the dropped text.
    expect(logs.join("\n")).not.toContain("200 more");
  });

  it("a continue that is not quiet posts the text once, in the card's thread, and reports done replied", async () => {
    const b = await bridge();
    port.script.push({ texts: ["Halfway: 1500 of 3030 read."], task: outcome({ continued: true }) });
    await b.handleFrame({ seq: 1, type: "agent.task.v1", data: taskEvent(1) });

    expect(api.messages).toHaveLength(1);
    expect(api.messages[0]).toMatchObject({
      agentId: GERTRU.id,
      conversationId: "conv-1",
      threadRootMessageId: THREAD_ROOT_ID,
      inReplyToMessageId: CARD_MESSAGE_ID,
      eventId: "evt-task-1",
      text: "Halfway: 1500 of 3030 read.",
    });
    expect(api.turnsDone.map((d) => d.outcome)).toEqual(["replied"]);
  });

  it("a task turn that continued or finished without text is not a failure: dispatched once, nothing posted, done replied", async () => {
    const b = await bridge();
    port.script.push({ texts: [], task: outcome({ continued: true }) });
    await b.handleFrame({ seq: 1, type: "agent.task.v1", data: taskEvent(1) });
    port.script.push({ texts: [], task: outcome({ finished: true }) });
    await b.handleFrame({ seq: 2, type: "agent.task.v1", data: taskEvent(2) });

    expect(port.dispatched.map((m) => m.eventId)).toEqual(["evt-task-1", "evt-task-2"]);
    expect(api.messages).toEqual([]);
    expect(api.turnsDone.map((d) => [d.eventId, d.outcome])).toEqual([
      ["evt-task-1", "replied"],
      ["evt-task-2", "replied"],
    ]);
  });

  it("a task turn with no text that called neither keeps the failure path: one retry, the failure reply, done failed", async () => {
    const b = await bridge();
    port.script.push({ texts: [], task: outcome() }, { texts: [], task: outcome() });
    await b.handleFrame({ seq: 1, type: "agent.task.v1", data: taskEvent(1) });

    expect(port.dispatched).toHaveLength(2);
    expect(api.messages.map((x) => x.text)).toEqual([FAILURE_REPLY]);
    expect(api.turnsDone.map((d) => d.outcome)).toEqual(["failed"]);
  });

  it("an invalid agent.task.v1 is skipped with the seq and field path only, and reports failed; an unknown type is still ignored", async () => {
    const b = await bridge();
    await b.handleFrame({
      seq: 4,
      type: "agent.task.v1",
      data: taskEvent(4, { task: { taskId: TASK_ID, reason: "SECRET-REASON" } }),
    });
    await b.handleFrame({ seq: 5, type: "agent.future.v1", data: taskEvent(5, { type: "agent.future.v1" }) });

    expect(port.dispatched).toEqual([]);
    expect(api.messages).toEqual([]);
    const warning = logs.find((l) => l.includes("seq=4"));
    expect(warning).toContain("task.reason");
    expect(logs.join("\n")).not.toContain("SECRET");
    expect(logs.some((l) => l.includes("seq=5: ignoring unknown event type agent.future.v1"))).toBe(true);
    expect(api.turnsDone).toEqual([
      { eventId: "evt-task-4", agentId: GERTRU.id, outcome: "failed", status: 204 },
    ]);
  });
});

describe("done reporting and replies for turns offered task tools (07.17.1.1.2 PD-17, P5)", () => {
  it("a person's mention listing ocw_task_start reports done; one without task tools outside any chain does not", async () => {
    const b = await bridge();
    port.script.push(
      { texts: ["Starting: I will read it in batches."], task: outcome({ started: true, continued: true }) },
      { texts: ["Hello."], task: null },
    );
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1, TASK_TOOLS) });
    await b.handleFrame({ seq: 2, type: "agent.mention.v1", data: mentionEvent(2, []) });

    expect(api.messages.map((m) => [m.eventId, m.text])).toEqual([
      ["evt-mention-1", "Starting: I will read it in batches."],
      ["evt-mention-2", "Hello."],
    ]);
    expect(api.turnsDone).toEqual([
      { eventId: "evt-mention-1", agentId: GERTRU.id, outcome: "replied", status: 204 },
    ]);
  });

  it("a start turn that started and continued without text is not a failure either", async () => {
    const b = await bridge();
    port.script.push({ texts: [], task: outcome({ started: true, continued: true }) });
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1, TASK_TOOLS) });

    expect(port.dispatched).toHaveLength(1);
    expect(api.messages).toEqual([]);
    expect(api.turnsDone.map((d) => d.outcome)).toEqual(["replied"]);
  });

  it("a port that returns nothing (an older port) behaves as before: silence is a failure, a reply posts", async () => {
    const legacy: OpenClawPort = {
      ...port,
      async dispatchMention(m, deliver) {
        port.dispatched.push(m);
        if (m.eventId === "evt-mention-2") await deliver("Hi.");
      },
    };
    const b2 = createBridge({
      client: createAgentChannelClient({ apiUrl: api.url, token: () => api.token }),
      port: legacy,
      signal: new AbortController().signal,
      typingIntervalMs: 50,
      retryDelayMs: 5,
      dispatchAttempts: 1,
    });
    await b2.refreshCell();
    await b2.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1, []) });
    await b2.handleFrame({ seq: 2, type: "agent.mention.v1", data: mentionEvent(2, []) });
    expect(api.messages.map((m) => m.text)).toEqual([FAILURE_REPLY, "Hi."]);
    expect(api.turnsDone).toEqual([]);
  });
});
