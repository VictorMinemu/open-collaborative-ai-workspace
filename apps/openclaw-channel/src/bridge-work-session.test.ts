/**
 * 07.16 (D-09, PD-16): a session a bot started changed state; the API publishes `agent.work_session.v1` on the cell
 * stream and the plugin turns it into the bot's turn in the thread of the session's card, like a consult reply. Driven
 * through the fake Agent Channel API's publish and the real event stream, with OpenClaw replaced by a recording port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentMentionEvent,
  type CellAgent,
  type CellProvider,
  type CellSnapshot,
} from "./agent-channel-protocol.js";
import { createAgentChannelClient } from "./api-client.js";
import { createBridge, type OpenClawPort } from "./bridge.js";
import { createMemoryCursorStore } from "./cursor-store.js";
import { runEventStream } from "./event-stream.js";
import { type MappedMention, mapMention } from "./mention-mapper.js";
import { planReconcile } from "./reconciler.js";
import {
  type FakeAgentChannelApi,
  type MentionInput,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";
import { WORK_SESSION_TOOL_NAMES } from "./turn-scoped-tools.js";

const ATLAS: CellAgent = {
  id: "agent-atlas",
  handle: "atlas",
  displayName: "Atlas",
  avatarUrl: null,
  description: null,
  instructions: "Be brief.",
  status: "provisioning",
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
const SESSION_ID = "ws-0001";
const CARD_MESSAGE_ID = "msg-card-1";
const THREAD_ROOT_ID = "msg-root-1";

const WORK_ZONE = {
  runtime: "claude-code",
  device: { id: "dev-1", name: "billing-server", online: true },
  projects: [{ id: "proj-1", name: "billing-api" }],
  projectsMore: 0,
  models: ["claude-opus-4"],
  defaultModel: "claude-opus-4",
  efforts: ["low", "high"],
  fastMode: "allowed",
  defaultMode: "default",
  maxMode: "fullAccess",
  outsideContent: false,
  sessions: [{ id: SESSION_ID, status: "idle", projectName: "billing-api" }],
};

/** Contracts `WORK_SESSION_TOOL_FLAGS` (the API sends them with the four tools). */
const WORK_SESSION_TOOL_FLAGS: Record<string, { untrustedOutput: boolean; sideEffecting: boolean }> = {
  ocw_work_session_start: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_prompt: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_read: { untrustedOutput: false, sideEffecting: false },
  ocw_work_session_stop: { untrustedOutput: false, sideEffecting: true },
};

/** The turn the API computed for the wake (as for a mention): the four tools, their flags, taint and the Work Zone. */
const WAKE_TURN = {
  tools: ["ocw_agent_card", ...WORK_SESSION_TOOL_NAMES],
  toolFlags: Object.fromEntries(WORK_SESSION_TOOL_NAMES.map((t) => [t, WORK_SESSION_TOOL_FLAGS[t]])),
  memory: [],
  now: null,
  maxToolCalls: 8,
  maxWebCalls: 5,
  tainted: true,
  workZone: WORK_ZONE,
};

/** The mention part of a wake: the requester's turn on the card message, in the card's thread. */
function wakeMention(n: number): MentionInput {
  return {
    eventId: `evt-wake-${n}`,
    agent: { id: ATLAS.id, handle: "atlas", displayName: "Atlas" },
    conversation: { id: "conv-1", kind: "channel", name: "eng" },
    thread: { rootMessageId: THREAD_ROOT_ID },
    message: {
      id: CARD_MESSAGE_ID,
      text: "The session in billing-api finished turn 2. 3 files changed.",
      createdAt: "2026-11-09T18:00:00.000Z",
      author: ANA,
      mentions: [{ kind: "agent", id: ATLAS.id }],
    },
    threadHistory: [],
    roster: [{ ...ANA, role: "member" }],
    turn: WAKE_TURN as unknown as MentionInput["turn"],
  };
}

function wake(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...wakeMention(n),
    workSession: {
      workSessionId: SESSION_ID,
      transition: "turn_done",
      status: "idle",
      summary: "The session in billing-api finished turn 2. 3 files changed.",
      pendingApprovals: 0,
      deciders: [],
      ...over,
    },
  };
}

type RecordingPort = OpenClawPort & { dispatched: MappedMention[] };

function recordingPort(): RecordingPort {
  const port: RecordingPort = {
    dispatched: [],
    async dispatchMention(m, deliver) {
      port.dispatched.push(m);
      await deliver("On it.");
    },
    async reconcile(cell: CellSnapshot) {
      const plan = planReconcile({}, cell);
      return { changed: plan.changed, results: plan.results };
    },
  };
  return port;
}

let api: FakeAgentChannelApi;
let port: RecordingPort;
let abort: AbortController;
let running: Promise<void> | undefined;
let logs: string[];

function startPlugin() {
  abort = new AbortController();
  const cursor = createMemoryCursorStore(null);
  const client = createAgentChannelClient({
    apiUrl: api.url,
    token: () => api.token,
    backoff: { baseMs: 5, maxMs: 20 },
  });
  const bridge = createBridge({
    client,
    port,
    signal: abort.signal,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    typingIntervalMs: 50,
    retryDelayMs: 10,
  });
  running = (async () => {
    const cell = await bridge.refreshCell();
    await runEventStream({
      wsUrl: () => client.wsUrl(),
      authHeader: () => client.authHeader(),
      topic: cell.topic,
      cursor,
      baseline: async () => (await bridge.refreshCell()).lastSeq,
      onEvent: (f) => bridge.handleFrame(f),
      signal: abort.signal,
      backoff: { baseMs: 10, maxMs: 40 },
      heartbeatMs: 1_000,
    });
  })().catch(() => undefined);
}

beforeEach(async () => {
  api = await startFakeAgentChannelApi({ agents: [structuredClone(ATLAS)], providers: [FAKE] });
  port = recordingPort();
  logs = [];
});

afterEach(async () => {
  abort?.abort();
  await running;
  await api.close();
});

describe("agent.work_session.v1 (07.16 D-09, PD-16): a wake-up becomes the bot's turn in its card's thread", () => {
  it("a turn_done wake runs the bot once, replying to the card message in the event's thread, with the update block (tracer)", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0 && api.subscriptions.length > 0);
    api.publish("agent.work_session.v1", wake(1));
    await api.waitFor(() => api.messages.length === 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(port.dispatched).toHaveLength(1);
    expect(api.messages[0]).toMatchObject({
      agentId: ATLAS.id,
      conversationId: "conv-1",
      threadRootMessageId: THREAD_ROOT_ID,
      inReplyToMessageId: CARD_MESSAGE_ID,
      eventId: "evt-wake-1",
      idempotencyKey: "evt:evt-wake-1",
      text: "On it.",
    });
    const m = port.dispatched[0] as MappedMention;
    const update = m.contextBlocks.find((b) => b.type === "work_session");
    expect(update?.label).toBe("Work Zone session update");
    expect(JSON.stringify(update?.payload)).toContain("finished a turn and nothing is queued");
    expect(JSON.stringify(update?.payload)).toContain(SESSION_ID);
  });

  it("the wake's turn context (tools, flags, taint, workZone) is applied exactly as for a mention", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0 && api.subscriptions.length > 0);
    api.publish("agent.work_session.v1", wake(2));
    await api.waitFor(() => port.dispatched.length === 1);

    const m = port.dispatched[0] as MappedMention;
    const asMention = mapMention(
      AgentMentionEvent.parse({
        ...wakeMention(2),
        type: "agent.mention.v1",
        seq: 1,
        organizationId: api.cellId,
        cellId: api.cellId,
      }),
      { ...ATLAS, status: "ready" },
    );
    expect(m.turn).toEqual(asMention.turn);
    expect(m.allowedTools).toEqual(asMention.allowedTools);
    expect(m.connectorTools).toEqual(asMention.connectorTools);
    expect(m.startsTainted).toBe(true);
    expect(asMention.startsTainted).toBe(true);
    // The bot has a delivered-turn tool, so the four turn-scoped session tools reach the run (PD-17).
    expect(m.allowedTools).toEqual(expect.arrayContaining([...WORK_SESSION_TOOL_NAMES]));
    expect(m.turn.workZone).toEqual(WORK_ZONE);
    expect(m.sender).toEqual({ id: ANA.id, name: "Ana", isBot: false });
    expect(m.messageId).toBe(CARD_MESSAGE_ID);
    expect(m.threadRootId).toBe(THREAD_ROOT_ID);
  });

  it("a wake with an unknown transition is skipped with a warning naming only the seq and the field path; the next mention is delivered", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0 && api.subscriptions.length > 0);
    const bad = api.publish("agent.work_session.v1", wake(3, { transition: "SECRET-TRANSITION" }));
    api.publishMention({
      ...wakeMention(4),
      eventId: "evt-mention-4",
      message: { ...wakeMention(4).message, id: "msg-4" },
    });
    await api.waitFor(() => api.messages.length === 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(port.dispatched.map((m) => m.eventId)).toEqual(["evt-mention-4"]);
    expect(api.messages.map((m) => m.eventId)).toEqual(["evt-mention-4"]);
    const warning = logs.find((l) => l.includes("agent.work_session.v1"));
    expect(warning).toContain(`seq=${bad.seq}`);
    expect(warning).toContain("workSession.transition");
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});
