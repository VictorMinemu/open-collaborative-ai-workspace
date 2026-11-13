/**
 * Quick 261113-id6: how the cell summarizes long bot conversations, and what happens when a summary fails.
 *
 * - The reconciler owns `agents.defaults.compaction.{mode, qualityGuard.enabled, identifierPolicy, keepRecentTokens,
 *   memoryFlush.enabled}` from the snapshot's `conversations` (absent = the lenient defaults), and rewrites nothing when
 *   they already match.
 * - The port starts a fresh OpenClaw session by deleting the turn's session entry (`deleteSessionEntry`, transcript
 *   archived), scoped to the turn's agent and session key.
 * - The bridge, when OpenClaw answers with its compaction-failure text and `freshSessionOnFailure` is on, drops that text,
 *   starts a fresh session and dispatches the same turn once more (a new inbound id); a second failure posts one clear
 *   sentence. Off, the text passes through unchanged.
 *
 * Driven against the fake Agent Channel API over HTTP, with OpenClaw replaced by fakes (no real OpenClaw).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellAgent, CellConversations, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { createAgentChannelClient } from "./api-client.js";
import {
  COMPACTION_RESET_FAILED_REPLY,
  COMPACTION_RETRY_FAILED_REPLY,
  createBridge,
  FAILURE_REPLY,
  isOpenClawCompactionFailure,
  type OpenClawPort,
  type TurnRun,
} from "./bridge.js";
import type { MappedMention } from "./mention-mapper.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";
import { applyPlanToDraft, desiredCompaction, type MutableConfig, planReconcile } from "./reconciler.js";
import { type FakeAgentChannelApi, startFakeAgentChannelApi } from "./testing/fake-agent-channel-api.js";

/** OpenClaw 2026.9.7's texts (commentary-progress-owner-*.mjs:103, agent-runner.runtime-*.mjs:937). */
const CONTEXT_TOO_LARGE =
  "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.";
const COMPACTION_TIMED_OUT =
  "⚠️ Context is too large and auto-compaction timed out before it could finish. Try again, use /compact, or use /new to start a fresh session.";
const AUTO_COMPACTION =
  "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.";

const DEFAULTS: CellConversations = {
  strictSummaries: false,
  keepIdentifiers: false,
  keepRecentTokens: 20_000,
  freshSessionOnFailure: true,
};

const snapshot = (over: Partial<CellSnapshot> = {}): CellSnapshot => ({
  protocolVersion: 1,
  cellId: "c",
  organizationId: "c",
  topic: "cell:c",
  lastSeq: 0,
  agents: [],
  providers: [],
  ...over,
});

describe("the compaction failure text", () => {
  it("recognizes OpenClaw's three compaction failures and nothing else", () => {
    for (const text of [CONTEXT_TOO_LARGE, COMPACTION_TIMED_OUT, AUTO_COMPACTION, `  ${CONTEXT_TOO_LARGE}`]) {
      expect(isOpenClawCompactionFailure(text), text).toBe(true);
    }
    for (const text of [
      "The context of this ERP order is too large to paste.",
      "Something went wrong while processing your request.",
      "Here is the summary you asked for.",
      "",
    ]) {
      expect(isOpenClawCompactionFailure(text), text).toBe(false);
    }
  });
});

describe("reconciler: agents.defaults.compaction from the snapshot's conversations", () => {
  it("absent conversations read the lenient defaults: safeguard, quality guard off, identifiers off, 20 000 tokens", () => {
    expect(desiredCompaction(undefined)).toEqual({
      mode: "safeguard",
      qualityGuard: { enabled: false },
      identifierPolicy: "off",
      keepRecentTokens: 20_000,
      memoryFlush: { enabled: false },
    });
    expect(desiredCompaction(DEFAULTS)).toEqual(desiredCompaction(undefined));
    expect(
      desiredCompaction({
        strictSummaries: true,
        keepIdentifiers: true,
        keepRecentTokens: 8_000,
        freshSessionOnFailure: false,
      }),
    ).toEqual({
      mode: "safeguard",
      qualityGuard: { enabled: true },
      identifierPolicy: "strict",
      keepRecentTokens: 8_000,
      memoryFlush: { enabled: false },
    });
  });

  it("writes the owned keys when they differ, keeping OpenClaw's other compaction keys", () => {
    const current = {
      mode: "safeguard",
      memoryFlush: { enabled: false, softThresholdTokens: 4000 },
      timeoutSeconds: 180,
    };
    const plan = planReconcile({ compaction: current }, snapshot());
    expect(plan.changed).toBe(true);
    expect(plan.compaction).toEqual(desiredCompaction(undefined));

    const draft: MutableConfig = { agents: { defaults: { userTimezone: "UTC", compaction: current } } };
    applyPlanToDraft(draft, plan);
    expect((draft.agents as { defaults: Record<string, unknown> }).defaults).toEqual({
      userTimezone: "UTC",
      compaction: {
        mode: "safeguard",
        qualityGuard: { enabled: false },
        identifierPolicy: "off",
        keepRecentTokens: 20_000,
        memoryFlush: { enabled: false, softThresholdTokens: 4000 },
        timeoutSeconds: 180,
      },
    });
  });

  it("rewrites nothing when the owned keys already match (other keys ignored)", () => {
    const current = {
      ...desiredCompaction(DEFAULTS),
      timeoutSeconds: 180,
      qualityGuard: { enabled: false, maxRetries: 1 },
    };
    const plan = planReconcile(
      { compaction: current },
      snapshot({ conversations: DEFAULTS } as Partial<CellSnapshot>),
    );
    expect(plan.compaction).toBeNull();
    expect(plan.changed).toBe(false);
  });

  it("an admin's change (strict summaries, 8 000 tokens) is written; the fresh-session switch alone writes nothing", () => {
    const current = desiredCompaction(DEFAULTS);
    const strict = planReconcile(
      { compaction: current },
      snapshot({ conversations: { ...DEFAULTS, strictSummaries: true, keepRecentTokens: 8_000 } }),
    );
    expect(strict.compaction).toMatchObject({ qualityGuard: { enabled: true }, keepRecentTokens: 8_000 });
    expect(strict.changed).toBe(true);
    const freshOff = planReconcile(
      { compaction: current },
      snapshot({ conversations: { ...DEFAULTS, freshSessionOnFailure: false } }),
    );
    expect(freshOff.changed).toBe(false);
  });

  it("an empty compaction block (none rendered) is written; a caller that does not pass it leaves compaction alone", () => {
    expect(planReconcile({ compaction: null }, snapshot()).compaction).toEqual(desiredCompaction(undefined));
    const legacy = planReconcile({}, snapshot());
    expect(legacy.compaction).toBeNull();
    expect(legacy.changed).toBe(false);
  });
});

describe("real port: reconcile writes compaction; resetSession deletes the turn's session entry", () => {
  const BOT: CellAgent = {
    id: "agent-astra",
    handle: "astra",
    displayName: "Astra",
    avatarUrl: null,
    description: null,
    instructions: "",
    status: "ready",
    modelRef: "fake/mock-1",
    model: { provider: "mock", providerId: "fake", id: "mock-1" },
    capabilities: { tools: [] },
  };

  function runtimeWith(config: Record<string, unknown>) {
    let writes = 0;
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async (p: { mutate: (d: Record<string, unknown>) => void }) => {
          writes++;
          p.mutate(config);
        },
      },
      channel: {
        routing: {
          buildAgentSessionKey: (p: { agentId: string; peer?: { id: string } | null }) =>
            `agent:${p.agentId}:ocw:channel:${p.peer?.id ?? "none"}`,
        },
      },
    } as unknown as PluginRuntimeLike;
    return { runtime, writes: () => writes };
  }

  it("writes agents.defaults.compaction once, then nothing while it matches", async () => {
    const config: Record<string, unknown> = {
      agents: { defaults: { compaction: { mode: "safeguard", memoryFlush: { enabled: false } } } },
    };
    const { runtime, writes } = runtimeWith(config);
    const p = createOpenClawPort({ runtime, accountId: "default", cfg: {} });
    const cell = snapshot({ conversations: { ...DEFAULTS, keepIdentifiers: true } });
    expect((await p.reconcile(cell)).changed).toBe(true);
    expect((config.agents as { defaults: { compaction: unknown } }).defaults.compaction).toEqual({
      mode: "safeguard",
      qualityGuard: { enabled: false },
      identifierPolicy: "strict",
      keepRecentTokens: 20_000,
      memoryFlush: { enabled: false },
    });
    expect((await p.reconcile(cell)).changed).toBe(false);
    expect(writes()).toBe(1);
  });

  const mention = (over: Partial<MappedMention> = {}) =>
    ({
      eventId: "evt-1",
      ocwAgentId: BOT.id,
      openClawAgentId: "ocw-agent-astra",
      conversationId: "conv-1",
      sessionThreadId: null,
      ...over,
    }) as MappedMention;

  it("deletes the entry of the turn's session (thread or conversation), archiving its transcript", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const { runtime } = runtimeWith({});
    const p = createOpenClawPort({
      runtime,
      accountId: "default",
      cfg: {},
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      sessionStore: async () => ({
        deleteSessionEntry: async (params: Record<string, unknown>) => {
          calls.push(params);
          return true;
        },
      }),
    });
    expect(await p.resetSession?.(mention())).toBe(true);
    expect(await p.resetSession?.(mention({ sessionThreadId: "MSG-Root-1" }))).toBe(true);
    expect(calls).toEqual([
      {
        sessionKey: "agent:ocw-agent-astra:ocw:channel:conv-1",
        agentId: "ocw-agent-astra",
        archiveTranscript: true,
      },
      {
        sessionKey: "agent:ocw-agent-astra:ocw:channel:conv-1:thread:msg-root-1",
        agentId: "ocw-agent-astra",
        archiveTranscript: true,
      },
    ]);
    // The session key is logged (ids only).
    expect(logs.some((l) => l.includes("agent:ocw-agent-astra:ocw:channel:conv-1"))).toBe(true);
  });

  it("answers false (and logs) when the store refuses or throws; never throws itself", async () => {
    const logs: string[] = [];
    const { runtime } = runtimeWith({});
    let answer: () => Promise<boolean> = async () => false;
    const p = createOpenClawPort({
      runtime,
      accountId: "default",
      cfg: {},
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      sessionStore: async () => ({ deleteSessionEntry: () => answer() }),
    });
    expect(await p.resetSession?.(mention())).toBe(false);
    answer = async () => {
      throw new Error("store locked");
    };
    expect(await p.resetSession?.(mention())).toBe(false);
    expect(logs.join("\n")).toContain("store locked");
  });
});

// ---------------------------------------------------------------- the bridge's recovery

const ASTRA: CellAgent = {
  id: "agent-astra",
  handle: "astra",
  displayName: "Astra",
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

const mentionEvent = (n: number) => ({
  type: "agent.mention.v1",
  eventId: `evt-${n}`,
  seq: n,
  organizationId: "cell-1",
  cellId: "cell-1",
  agent: { id: ASTRA.id, handle: "astra", displayName: "Astra" },
  conversation: { id: "conv-dm", kind: "dm", name: null },
  thread: { rootMessageId: `msg-${n}` },
  message: {
    id: `msg-${n}`,
    text: "@astra what is the status of order 4711?",
    createdAt: "2026-11-13T10:30:00.000Z",
    author: ANA,
    mentions: [{ kind: "agent", id: ASTRA.id }],
  },
  threadHistory: [],
  roster: [{ ...ANA, role: "member" }],
  turn: {
    tools: ["ocw_agent_card"],
    toolFlags: { ocw_agent_card: { untrustedOutput: false, sideEffecting: false } },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
  },
});

type Attempt = { texts: string[]; ran?: boolean };
type ScriptedPort = OpenClawPort & {
  dispatched: MappedMention[];
  resets: MappedMention[];
  script: Attempt[];
  resetAnswer: boolean;
};

function scriptedPort(withReset = true): ScriptedPort {
  const port: ScriptedPort = {
    dispatched: [],
    resets: [],
    script: [],
    resetAnswer: true,
    async dispatchMention(m, deliver): Promise<TurnRun> {
      port.dispatched.push(m);
      const attempt = port.script.shift() ?? { texts: ["On it."] };
      for (const text of attempt.texts) await deliver(text);
      return { task: null, ...(attempt.ran !== undefined ? { ran: attempt.ran } : {}) };
    },
    async reconcile(cell: CellSnapshot) {
      const plan = planReconcile({}, cell);
      return { changed: plan.changed, results: plan.results };
    },
  };
  if (withReset) {
    port.resetSession = async (m) => {
      port.resets.push(m);
      return port.resetAnswer;
    };
  }
  return port;
}

let api: FakeAgentChannelApi;
let logs: string[];

async function bridgeWith(port: OpenClawPort) {
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

describe("bridge: a failed summary starts a fresh session once", () => {
  beforeEach(() => {
    logs = [];
  });
  afterEach(async () => {
    await api.close();
  });

  it("drops OpenClaw's text, resets the session and dispatches the same turn again with a new inbound id", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.script = [{ texts: [CONTEXT_TOO_LARGE] }, { texts: ["Order 4711 shipped yesterday."] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });

    expect(port.dispatched.map((m) => m.inboundMessageId)).toEqual(["evt-1", "evt-1:2"]);
    expect(port.resets.map((m) => m.eventId)).toEqual(["evt-1"]);
    expect(api.messages.map((m) => m.text)).toEqual(["Order 4711 shipped yesterday."]);
    expect(logs.join("\n")).toContain("fresh session");
    // Ids only: never the reply text.
    expect(logs.join("\n")).not.toContain("4711");
  });

  it("recovers even when the turn already used its retry budget on the first attempt (dispatchAttempts 1)", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.script = [{ texts: [AUTO_COMPACTION] }, { texts: ["Back on track."] }];
    const client = createAgentChannelClient({
      apiUrl: api.url,
      token: () => api.token,
      backoff: { baseMs: 5, maxMs: 20 },
    });
    const b = createBridge({
      client,
      port,
      signal: new AbortController().signal,
      retryDelayMs: 5,
      dispatchAttempts: 1,
    });
    await b.refreshCell();
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    expect(port.dispatched).toHaveLength(2);
    expect(api.messages.map((m) => m.text)).toEqual(["Back on track."]);
  });

  it("recovers once per turn: a second failure posts one clear sentence, no third dispatch", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.script = [{ texts: [CONTEXT_TOO_LARGE] }, { texts: [COMPACTION_TIMED_OUT] }, { texts: ["never"] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });

    expect(port.dispatched).toHaveLength(2);
    expect(port.resets).toHaveLength(1);
    expect(api.messages.map((m) => m.text)).toEqual([COMPACTION_RETRY_FAILED_REPLY]);
    expect(COMPACTION_RETRY_FAILED_REPLY).toBe(
      "This conversation got too long for me to summarize, so I started over with only its recent messages, and that failed too. Try again in a new thread.",
    );
  });

  it("each new turn may recover once again (the limit is per turn)", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.script = [
      { texts: [CONTEXT_TOO_LARGE] },
      { texts: ["First answer."] },
      { texts: [CONTEXT_TOO_LARGE] },
      { texts: ["Second answer."] },
    ];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    await b.handleFrame({ seq: 2, type: "agent.mention.v1", data: mentionEvent(2) });
    expect(port.resets.map((m) => m.eventId)).toEqual(["evt-1", "evt-2"]);
    expect(api.messages.map((m) => m.text)).toEqual(["First answer.", "Second answer."]);
  });

  it("off (freshSessionOnFailure false): OpenClaw's text passes through unchanged, no reset, no retry", async () => {
    api = await startFakeAgentChannelApi({
      agents: [structuredClone(ASTRA)],
      providers: [FAKE],
      conversations: { ...DEFAULTS, freshSessionOnFailure: false },
    });
    const port = scriptedPort();
    port.script = [{ texts: [CONTEXT_TOO_LARGE] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    expect(port.dispatched).toHaveLength(1);
    expect(port.resets).toEqual([]);
    expect(api.messages.map((m) => m.text)).toEqual([CONTEXT_TOO_LARGE]);
  });

  it("a port that cannot reset sessions passes the text through, as before", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort(false);
    port.script = [{ texts: [CONTEXT_TOO_LARGE] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    expect(port.dispatched).toHaveLength(1);
    expect(api.messages.map((m) => m.text)).toEqual([CONTEXT_TOO_LARGE]);
  });

  it("a reset that fails posts a short sentence instead of a retry", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.resetAnswer = false;
    port.script = [{ texts: [CONTEXT_TOO_LARGE] }, { texts: ["never"] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    expect(port.dispatched).toHaveLength(1);
    expect(port.resets).toHaveLength(1);
    expect(api.messages.map((m) => m.text)).toEqual([COMPACTION_RESET_FAILED_REPLY]);
    expect(COMPACTION_RESET_FAILED_REPLY).not.toBe(FAILURE_REPLY);
  });

  it("a run whose model already ran (a tool call) is never dispatched again: the text passes through", async () => {
    api = await startFakeAgentChannelApi({ agents: [structuredClone(ASTRA)], providers: [FAKE] });
    const port = scriptedPort();
    port.script = [{ texts: [AUTO_COMPACTION], ran: true }, { texts: ["never"] }];
    const b = await bridgeWith(port);
    await b.handleFrame({ seq: 1, type: "agent.mention.v1", data: mentionEvent(1) });
    expect(port.dispatched).toHaveLength(1);
    expect(port.resets).toEqual([]);
    expect(api.messages.map((m) => m.text)).toEqual([AUTO_COMPACTION]);
  });
});
