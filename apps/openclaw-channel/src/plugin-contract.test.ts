/**
 * Contract tests: the plugin core (event stream + bridge + HTTP client) against a fake Agent
 * Channel API v1 server speaking the canonical contract, with OpenClaw replaced by a recording fake
 * port.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellAgent, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import { AUTH_FAILURE_REPLY, createBridge, FAILURE_REPLY, type OpenClawPort } from "./bridge.js";
import { createMemoryCursorStore } from "./cursor-store.js";
import { CommitTracker, runEventStream } from "./event-stream.js";
import { type MappedMention, mapMention } from "./mention-mapper.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";
import { planReconcile } from "./reconciler.js";
import {
  type FakeAgentChannelApi,
  type MentionInput,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";
import { createToolGuard } from "./tool-guard.js";

const ARCHIE: CellAgent = {
  id: "agent-archie",
  handle: "archie",
  displayName: "Archie",
  avatarUrl: null,
  description: null,
  instructions: "Be brief.",
  status: "provisioning",
  modelRef: "fake/mock-1",
  model: { provider: "mock", providerId: "fake", id: "mock-1" },
};
const FAKE: CellProvider = {
  id: "fake",
  kind: "mock",
  api: "openai-completions",
  baseUrl: "http://fake-model:18999/v1",
  apiKey: "mock-key-not-secret",
  models: ["mock-1"],
};

function mention(n: number, over: Partial<MentionInput> = {}): MentionInput {
  return {
    eventId: `evt-${n}`,
    agent: { id: ARCHIE.id, handle: "archie", displayName: "Archie" },
    conversation: { id: "conv-1", kind: "channel", name: "architecture" },
    thread: { rootMessageId: "root-1" },
    message: {
      id: `msg-${n}`,
      text: `@archie question ${n}`,
      createdAt: "2026-10-02T18:00:00.000Z",
      author: { kind: "user", id: "u-victor", displayName: "Víctor" },
      mentions: [{ kind: "agent", id: ARCHIE.id }],
    },
    threadHistory: [],
    roster: [
      { kind: "user", id: "u-victor", displayName: "Víctor", role: "owner" },
      { kind: "user", id: "u-alex", displayName: "Alex", role: "member" },
    ],
    ...over,
  };
}

type FakePort = OpenClawPort & {
  dispatched: MappedMention[];
  reconciled: CellSnapshot[];
  reply: (m: MappedMention) => string[] | Promise<string[]>;
};

function fakePort(): FakePort {
  const port: FakePort = {
    dispatched: [],
    reconciled: [],
    reply: (m) => [`Hi ${m.sender.name}!`],
    async dispatchMention(m, deliver) {
      port.dispatched.push(m);
      for (const text of await port.reply(m)) await deliver(text);
    },
    async reconcile(cell) {
      port.reconciled.push(structuredClone(cell));
      const plan = planReconcile({}, cell);
      return { changed: plan.changed, results: plan.results };
    },
  };
  return port;
}

let api: FakeAgentChannelApi;
let port: FakePort;
let abort: AbortController;
let cursor: ReturnType<typeof createMemoryCursorStore>;
let running: Promise<void> | undefined;

function startPlugin(opts: { token?: string; initialCursor?: number } = {}) {
  abort = new AbortController();
  cursor = createMemoryCursorStore(
    opts.initialCursor === undefined ? null : { topic: api.topic, seq: opts.initialCursor },
  );
  const client = createAgentChannelClient({
    apiUrl: api.url,
    token: () => opts.token ?? api.token,
    backoff: { baseMs: 5, maxMs: 20 },
  });
  const bridge = createBridge({ client, port, signal: abort.signal, typingIntervalMs: 50, retryDelayMs: 10 });
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
  return { client, bridge };
}

beforeEach(async () => {
  api = await startFakeAgentChannelApi({ agents: [structuredClone(ARCHIE)], providers: [FAKE] });
  port = fakePort();
});

afterEach(async () => {
  abort?.abort();
  await running;
  await api.close();
});

describe("provisioning", () => {
  it("reconciles on start and acks each provisioned bot as ready (flips the UI chip)", async () => {
    startPlugin();
    await api.waitFor(() => api.statusReports.length === 1);
    expect(api.statusReports[0]).toEqual({ agentId: ARCHIE.id, status: "ready" });
    expect(port.reconciled[0]?.providers[0]?.id).toBe("fake");
  });

  it("reports error with a human detail when the bot's provider is missing", async () => {
    api.agents = [{ ...structuredClone(ARCHIE), modelRef: "anthropic/claude-sonnet-5-5" }];
    startPlugin();
    await api.waitFor(() => api.statusReports.length === 1);
    expect(api.statusReports[0]).toMatchObject({ agentId: ARCHIE.id, status: "error" });
    expect(api.statusReports[0]?.detail).toContain("anthropic");
  });

  it("re-reconciles on cell.config.changed (model change → provisioning → ready again)", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.updateCell({
      agents: [{ ...structuredClone(ARCHIE), status: "provisioning", modelRef: "fake/mock-2" }],
    });
    await api.waitFor(() => port.reconciled.at(-1)?.agents[0]?.modelRef === "fake/mock-2");
    await api.waitFor(() => api.statusReports.length === 2);
    expect(api.statusReports[1]).toEqual({ agentId: ARCHIE.id, status: "ready" });
  });
});

describe("mention → dispatch → reply", () => {
  it("posts the reply into the event's thread with the recommended idempotency key", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(1));
    await api.waitFor(() => api.messages.length === 1);

    expect(api.messages[0]).toMatchObject({
      agentId: ARCHIE.id,
      conversationId: "conv-1",
      threadRootMessageId: "root-1",
      inReplyToMessageId: "msg-1",
      text: "Hi Víctor!",
      idempotencyKey: "evt:evt-1",
    });
    // Structured identity reached the OpenClaw side, never as a text prefix.
    expect(port.dispatched[0]?.sender).toEqual({ id: "u-victor", name: "Víctor", isBot: false });
    expect(port.dispatched[0]?.groupMembers).toBe("Víctor <u-victor>, Alex <u-alex>");
    expect(port.dispatched[0]?.body).toBe("@archie question 1");
    await api.waitFor(() => api.typing.some((t) => t.typing === false));
    expect(api.typing[0]).toEqual({
      agentId: ARCHIE.id,
      conversationId: "conv-1",
      threadRootMessageId: "root-1",
      typing: true,
    });
    expect(api.typing.at(-1)?.typing).toBe(false);
  });

  it("a DM mention is answered flat: reply and typing carry threadRootMessageId null (D-04)", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(
      mention(2, {
        conversation: { id: "dm-1", kind: "dm", name: null },
        thread: { rootMessageId: "msg-2" },
        message: {
          id: "msg-2",
          text: "hello there",
          createdAt: "2026-10-02T18:00:00.000Z",
          author: { kind: "user", id: "u-victor", displayName: "Víctor" },
          mentions: [{ kind: "agent", id: ARCHIE.id }],
        },
        roster: [
          { kind: "user", id: "u-victor", displayName: "Víctor", role: "owner" },
          { kind: "agent", id: ARCHIE.id, displayName: "Archie", handle: "archie" },
        ],
      }),
    );
    await api.waitFor(() => api.messages.length === 1);
    expect(api.messages[0]).toMatchObject({
      agentId: ARCHIE.id,
      conversationId: "dm-1",
      threadRootMessageId: null,
      inReplyToMessageId: "msg-2",
      text: "Hi Víctor!",
      idempotencyKey: "evt:evt-2",
    });
    expect(port.dispatched[0]).toMatchObject({
      conversationKind: "dm",
      threadRootId: null,
      target: "conv:dm-1",
    });
    await api.waitFor(() => api.typing.some((t) => t.typing === false));
    expect(api.typing[0]).toEqual({
      agentId: ARCHIE.id,
      conversationId: "dm-1",
      threadRootMessageId: null,
      typing: true,
    });
  });

  it("posts multi-part replies in order with distinct keys", async () => {
    port.reply = () => ["part one", "part two"];
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(3));
    await api.waitFor(() => api.messages.length === 2);
    expect(api.messages.map((m) => [m.idempotencyKey, m.text])).toEqual([
      ["evt:evt-3", "part one"],
      ["evt:evt-3:1", "part two"],
    ]);
  });

  it("retries a failed POST and the server dedupes it (exactly one stored reply)", async () => {
    api.failNextPosts(2, 503);
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(4));
    await api.waitFor(() => api.messages.length === 1);
    expect(api.messageAttempts.length).toBe(3);
    expect(new Set(api.messageAttempts.map((m) => m.idempotencyKey))).toEqual(new Set(["evt:evt-4"]));
  });

  it("retries a transiently failing turn (agent not yet published) and replies once", async () => {
    let calls = 0;
    port.reply = (m) => {
      calls++;
      if (calls === 1) throw new Error("prepared reply dispatch runtime owner was not published");
      return [`Hi ${m.sender.name}!`];
    };
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(8));
    await api.waitFor(() => api.messages.length === 1);
    expect(calls).toBe(2);
    expect(api.messages[0]?.text).toBe("Hi Víctor!");
  });

  it("never forwards OpenClaw's generic failure text: retries the turn and replies once", async () => {
    let calls = 0;
    port.reply = (m) => {
      calls++;
      if (calls === 1)
        return ["⚠️ Something went wrong while processing your request. Please try again, or use /new."];
      return [`Hi ${m.sender.name}!`];
    };
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(9));
    await api.waitFor(() => api.messages.length === 1);
    expect(calls).toBe(2);
    expect(api.messages.map((x) => x.text)).toEqual(["Hi Víctor!"]);
  });

  it("a turn that ends silently (no delivery, no error) is retried, then the asker gets a notice", async () => {
    let calls = 0;
    port.reply = () => {
      calls++;
      return [];
    };
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(11));
    await api.waitFor(() => api.messages.length === 1);
    expect(calls).toBeGreaterThan(1);
    expect(api.messages[0]).toMatchObject({ text: FAILURE_REPLY, idempotencyKey: "evt:evt-11:failed" });
  });

  it("posts a short failure notice once when the agent turn keeps failing", async () => {
    port.reply = () => {
      throw new Error("model unavailable");
    };
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(5));
    await api.waitFor(() => api.messages.length === 1);
    expect(api.messages[0]).toMatchObject({
      text: FAILURE_REPLY,
      idempotencyKey: "evt:evt-5:failed",
      threadRootMessageId: "root-1",
    });
  });

  it("a provider auth failure (401, e.g. an expired ChatGPT sign-in) is not retried and says how to fix it", async () => {
    let calls = 0;
    port.reply = () => {
      calls++;
      return [
        "⚠️ Authentication failed (provider returned HTTP 401). Your provider token may have expired — try the request again in a moment.",
      ];
    };
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(11));
    await api.waitFor(() => api.messages.length === 1);
    expect(calls).toBe(1);
    expect(api.messages[0]).toMatchObject({ text: AUTH_FAILURE_REPLY, idempotencyKey: "evt:evt-11:failed" });
  });

  it("skips mentions for unknown (after refresh) or disabled agents", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    const before = port.reconciled.length;
    api.publishMention(mention(6, { agent: { id: "agent-ghost", handle: "ghost", displayName: "Ghost" } }));
    await api.waitFor(() => port.reconciled.length > before);
    api.updateCell({ agents: [{ ...structuredClone(ARCHIE), status: "disabled" }] }, "agent.disabled");
    await api.waitFor(() => port.reconciled.at(-1)?.agents[0]?.status === "disabled");
    api.publishMention(mention(7));
    await new Promise((r) => setTimeout(r, 150));
    expect(api.messages).toHaveLength(0);
    expect(port.dispatched).toHaveLength(0);
  });
});

describe("subscription, cursor replay and reconnect", () => {
  it("starts LIVE from the snapshot lastSeq when no cursor exists (never re-answers old mentions)", async () => {
    api.publishMention(mention(9)); // happened before this cell ever ran
    startPlugin();
    await api.waitFor(() => api.subscriptions.length === 1);
    expect(api.subscriptions[0]).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.messages).toHaveLength(0);
  });

  it("replays events published while disconnected from the persisted cursor, without duplicates", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publishMention(mention(10));
    await api.waitFor(() => api.messages.length === 1);
    await api.waitFor(() => cursor.current() === 1);

    api.dropConnections();
    api.publishMention(mention(11)); // published while the socket is down
    await api.waitFor(() => api.messages.length === 2);
    await api.waitFor(() => api.subscriptions.length >= 2);
    expect(api.subscriptions.at(-1)).toBe(1); // resumed after the committed seq
    expect(port.dispatched.map((m) => m.messageId)).toEqual(["msg-10", "msg-11"]);
    await api.waitFor(() => cursor.current() === 2);
  });

  it("resumes from a cursor persisted by a previous process (no re-processing)", async () => {
    api.publishMention(mention(20));
    api.publishMention(mention(21));
    startPlugin({ initialCursor: 1 });
    await api.waitFor(() => api.messages.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.messages.map((m) => m.inReplyToMessageId)).toEqual(["msg-21"]);
    expect(api.subscriptions[0]).toBe(1);
  });

  it("on resync re-baselines from GET /cell and resubscribes", async () => {
    startPlugin({ initialCursor: 0 });
    await api.waitFor(() => api.openSockets() === 1);
    api.publish("cell.config.changed", { reason: "agent.updated", agentId: null }); // seq 1
    await api.waitFor(() => cursor.current() === 1);
    api.sendResync();
    await api.waitFor(() => api.subscriptions.length === 2);
    expect(api.subscriptions[1]).toBe(1);
  });

  it("keeps retrying with backoff when the token is rejected (no crash, no events)", async () => {
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => "wrong", maxAttempts: 1 });
    await expect(client.getCell()).rejects.toBeInstanceOf(AgentChannelHttpError);
    abort = new AbortController();
    running = runEventStream({
      wsUrl: () => client.wsUrl(),
      authHeader: () => client.authHeader(),
      topic: api.topic,
      cursor: createMemoryCursorStore({ topic: api.topic, seq: 0 }),
      baseline: async () => 0,
      onEvent: async () => undefined,
      signal: abort.signal,
      backoff: { baseMs: 5, maxMs: 10 },
    });
    await api.waitFor(() => api.authFailures >= 4);
    expect(api.openSockets()).toBe(0);
  });
});

describe("CommitTracker", () => {
  it("never commits past an unfinished event when completions are out of order", () => {
    const t = new CommitTracker(0);
    t.begin(1);
    t.begin(2);
    t.begin(3);
    expect(t.complete(2)).toBe(0);
    expect(t.complete(3)).toBe(0);
    expect(t.complete(1)).toBe(3);
    expect(t.isKnown(3)).toBe(true);
    expect(t.isKnown(4)).toBe(false);
  });
});

describe("real port dispatch: per-turn tool cap and active turn (D-08)", () => {
  const WEB = { untrustedOutput: true, sideEffecting: false };
  const TURN = {
    tools: ["web_search", "web_fetch"],
    toolFlags: { web_search: WEB, web_fetch: WEB },
    memory: [],
    now: { iso: "2026-10-05T10:00:00.000Z", timeZone: "UTC", local: "Monday 5 October 2026 at 10:00" },
    maxToolCalls: 8,
    maxWebCalls: 5,
  };

  function fakeRuntime(onDispatch?: (params: Record<string, unknown>) => Promise<void> | void) {
    const dispatches: Array<Record<string, unknown>> = [];
    const runtime: PluginRuntimeLike = {
      config: { current: () => ({}), mutateConfigFile: async () => undefined },
      channel: {
        routing: {
          buildAgentSessionKey: (p) => `agent:${p.agentId}:ocw:channel:${p.peer?.id ?? "none"}`,
        },
        inbound: {
          ingress: { resolveStable: async () => ({ ingress: { admission: "dispatch" } }) },
          buildContext: (params) => params,
          dispatch: async (params) => {
            dispatches.push(params);
            await onDispatch?.(params);
            const delivery = params.delivery as { deliver: (p: { text: string }) => Promise<void> };
            await delivery.deliver({ text: "ok" });
          },
        },
      },
    };
    return { runtime, dispatches };
  }

  const event = (over: Partial<MentionInput> & { turn?: unknown } = {}) =>
    ({
      ...mention(1),
      seq: 1,
      type: "agent.mention.v1",
      organizationId: "o",
      cellId: "c",
      ...over,
    }) as Parameters<typeof mapMention>[0];

  it("an event without turn dispatches with toolsAllow [] and disableTools true", async () => {
    const guard = createToolGuard({ client: () => null });
    const { runtime, dispatches } = fakeRuntime();
    const p = createOpenClawPort({ runtime, accountId: "default", cfg: {}, guard });
    await p.dispatchMention(
      mapMention(event(), { ...ARCHIE, capabilities: { tools: ["web_search"] } }),
      async () => {},
      new AbortController().signal,
    );
    expect(dispatches[0]?.toolsAllow).toEqual([]);
    expect(dispatches[0]?.replyOptions).toMatchObject({ disableTools: true });
  });

  it("turn [web_search, web_fetch] ∩ snapshot [web_fetch] → toolsAllow [web_fetch], tools enabled, turn active only while dispatching", async () => {
    const guard = createToolGuard({ client: () => null });
    let activeDuring: string[] | undefined;
    const { runtime, dispatches } = fakeRuntime((params) => {
      const route = params.route as { sessionKey: string };
      activeDuring = guard.activeTurn(route.sessionKey)?.turn.tools;
    });
    const p = createOpenClawPort({ runtime, accountId: "default", cfg: {}, guard });
    const m = mapMention(event({ turn: TURN } as never), {
      ...ARCHIE,
      capabilities: { tools: ["web_fetch"] },
    });
    await p.dispatchMention(m, async () => {}, new AbortController().signal);
    expect(dispatches[0]?.toolsAllow).toEqual(["web_fetch"]);
    expect(dispatches[0]?.replyOptions).toMatchObject({ disableTools: false });
    expect(activeDuring).toEqual(["web_fetch"]);
    const first = dispatches[0] as Record<string, unknown>;
    const sessionKey = (first.route as { sessionKey: string }).sessionKey;
    expect(guard.activeTurn(sessionKey)).toBeUndefined();
    // turn.now reached the dispatch context as a structured block.
    const extra = (first.ctxPayload as { extra: { ChannelStructuredContext: Array<{ label: string }> } })
      .extra;
    expect(extra.ChannelStructuredContext.map((b) => b.label)).toContain("Current time for Víctor");
  });

  it("serialises two turns of the same session; the turn ends even when the dispatch throws", async () => {
    const guard = createToolGuard({ client: () => null });
    let running = 0;
    let maxRunning = 0;
    let fail = true;
    const { runtime } = fakeRuntime(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
    });
    const p = createOpenClawPort({ runtime, accountId: "default", cfg: {}, guard });
    const m = mapMention(event({ turn: TURN } as never), {
      ...ARCHIE,
      capabilities: { tools: ["web_search"] },
    });
    const signal = new AbortController().signal;
    const results = await Promise.allSettled([
      p.dispatchMention(m, async () => {}, signal),
      p.dispatchMention(m, async () => {}, signal),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect(maxRunning).toBe(1);
    expect(guard.activeTurn("agent:ocw-agent-archie:ocw:channel:conv-1:thread:root-1")).toBeUndefined();
  });
});

describe("tool gate against the fake Agent Channel API (HTTP)", () => {
  const WEB = { untrustedOutput: true, sideEffecting: false };
  const TURN = {
    tools: ["web_search", "web_fetch"],
    toolFlags: { web_search: WEB, web_fetch: WEB },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
  };

  it("records the authorization and the outcome; a denied tool is blocked with the API's reason", async () => {
    api.denyTools.add("web_fetch");
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const guard = createToolGuard({ client: () => client });
    guard.beginTurn("s1", { eventId: "evt-9", agentId: ARCHIE.id, turn: TURN });
    expect(
      await guard.beforeToolCall(
        { toolName: "web_search", params: { query: "ocw" }, toolCallId: "tc-1" },
        { sessionKey: "s1" },
      ),
    ).toBeUndefined();
    await guard.afterToolCall(
      {
        toolName: "web_search",
        toolCallId: "tc-1",
        result: { details: { count: 1, provider: "searxng" } },
        durationMs: 7,
      },
      { sessionKey: "s1" },
    );
    expect(api.toolCalls).toEqual([
      expect.objectContaining({
        eventId: "evt-9",
        agentId: ARCHIE.id,
        tool: "web_search",
        params: { query: "ocw" },
        allowed: true,
      }),
    ]);
    expect(api.toolResults).toEqual([
      { callId: api.toolCalls[0]?.callId, status: "ok", resultCount: 1, provider: "searxng", durationMs: 7 },
    ]);
    const denied = await guard.beforeToolCall(
      { toolName: "web_fetch", params: { url: "https://x.example/" }, toolCallId: "tc-2" },
      { sessionKey: "s1" },
    );
    expect(denied?.blockReason).toContain("denied_by_test");
  });

  it("the snapshot carries the bot's tools and the search provider", async () => {
    api.agents = [{ ...structuredClone(ARCHIE), capabilities: { tools: ["web_search"] } }];
    api.webSearchProvider = "searxng";
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const cell = await client.getCell();
    expect(cell.agents[0]?.capabilities).toEqual({ tools: ["web_search"] });
    expect(cell.webSearch).toEqual({ provider: "searxng" });
  });
});

describe("real port reconcile: deleted bots leave no transcripts (Pitfall 12)", () => {
  function runtimeWith(config: Record<string, unknown>) {
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async (p: { mutate: (d: Record<string, unknown>) => void }) => {
          p.mutate(config);
        },
      },
      channel: {} as PluginRuntimeLike["channel"],
    } as PluginRuntimeLike;
    return runtime;
  }

  it("purges <state>/agents/<ocw-id> of a removed bot after the write; never foreign agents", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "ocw-state-"));
    try {
      for (const id of ["ocw-gone", "main"]) {
        mkdirSync(path.join(state, "agents", id, "agent"), { recursive: true });
        writeFileSync(path.join(state, "agents", id, "agent", "openclaw-agent.sqlite"), "zebra-secret-41");
      }
      const config = { agents: { entries: { "ocw-gone": { name: "Gone" }, main: { name: "main" } } } };
      const p = createOpenClawPort({
        runtime: runtimeWith(config),
        accountId: "default",
        cfg: {},
        stateDir: state,
      });
      const r = await p.reconcile({
        protocolVersion: 1,
        cellId: "c",
        organizationId: "c",
        topic: "cell:c",
        lastSeq: 0,
        agents: [],
        providers: [],
      });
      expect(r.changed).toBe(true);
      expect(existsSync(path.join(state, "agents", "ocw-gone"))).toBe(false);
      expect(existsSync(path.join(state, "agents", "main", "agent", "openclaw-agent.sqlite"))).toBe(true);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("keeps the state when OpenClaw refused the removal (the bot is still configured)", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "ocw-state-"));
    try {
      mkdirSync(path.join(state, "agents", "ocw-gone"), { recursive: true });
      const config = { agents: { entries: { "ocw-gone": { name: "Gone" } } } };
      let calls = 0;
      const runtime = runtimeWith(config);
      runtime.config.mutateConfigFile = async (params) => {
        calls++;
        if (calls === 1) throw new Error("roster removal refused");
        params.mutate(config as never);
      };
      const p = createOpenClawPort({ runtime, accountId: "default", cfg: {}, stateDir: state });
      await p.reconcile({
        protocolVersion: 1,
        cellId: "c",
        organizationId: "c",
        topic: "t",
        lastSeq: 0,
        agents: [],
        providers: [],
      });
      expect(existsSync(path.join(state, "agents", "ocw-gone"))).toBe(true);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
