/**
 * Contract tests: the plugin core (event stream + bridge + HTTP client) against a fake Agent
 * Channel API v1 server speaking the canonical contract, with OpenClaw replaced by a recording fake
 * port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellAgent, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import { AUTH_FAILURE_REPLY, createBridge, FAILURE_REPLY, type OpenClawPort } from "./bridge.js";
import { createMemoryCursorStore } from "./cursor-store.js";
import { CommitTracker, runEventStream } from "./event-stream.js";
import type { MappedMention } from "./mention-mapper.js";
import { planReconcile } from "./reconciler.js";
import {
  type FakeAgentChannelApi,
  type MentionInput,
  startFakeAgentChannelApi,
} from "./testing/fake-agent-channel-api.js";

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
