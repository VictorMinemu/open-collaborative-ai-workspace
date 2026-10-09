/**
 * Contract tests: the plugin core (event stream + bridge + HTTP client) against a fake Agent
 * Channel API v1 server speaking the canonical contract, with OpenClaw replaced by a recording fake
 * port.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeMcp } from "../../../infra/fake-model/fake-mcp.mjs";
import type { CellAgent, CellMcpServer, CellProvider, CellSnapshot } from "./agent-channel-protocol.js";
import { AgentChannelHttpError, createAgentChannelClient } from "./api-client.js";
import { AUTH_FAILURE_REPLY, createBridge, FAILURE_REPLY, type OpenClawPort } from "./bridge.js";
import { createMemoryCursorStore } from "./cursor-store.js";
import { CommitTracker, runEventStream } from "./event-stream.js";
import { UNKNOWN_SERVER_ERROR } from "./mcp-probe.js";
import { type MappedMention, mapMention } from "./mention-mapper.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";
import {
  BOOT_CACHE_FILE,
  createPluginInstaller,
  type PluginInstaller,
  type RunCli,
} from "./plugin-installer.js";
import { planReconcile } from "./reconciler.js";
import { registerCapabilities } from "./register-capabilities.js";
import { registerFull } from "./register-full.js";
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

function startPlugin(opts: { token?: string; initialCursor?: number; plugins?: PluginInstaller } = {}) {
  abort = new AbortController();
  cursor = createMemoryCursorStore(
    opts.initialCursor === undefined ? null : { topic: api.topic, seq: opts.initialCursor },
  );
  const client = createAgentChannelClient({
    apiUrl: api.url,
    token: () => opts.token ?? api.token,
    backoff: { baseMs: 5, maxMs: 20 },
  });
  const bridge = createBridge({
    client,
    port,
    signal: abort.signal,
    typingIntervalMs: 50,
    retryDelayMs: 10,
    ...(opts.plugins ? { plugins: opts.plugins } : {}),
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
      eventId: "evt-1",
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

  it("an AI chat mention is answered flat, like a DM, but each mention is its own session (06-10)", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    const aiChat = (n: number) =>
      mention(n, {
        conversation: { id: "chat-1", kind: "ai_chat", name: "Invoices" },
        thread: { rootMessageId: `msg-${n}` },
      });
    api.publishMention(aiChat(3));
    api.publishMention(aiChat(4));
    await api.waitFor(() => api.messages.length === 2);
    for (const posted of api.messages) {
      expect(posted).toMatchObject({ conversationId: "chat-1", threadRootMessageId: null });
    }
    expect(port.dispatched.map((m) => [m.threadRootId, m.target, m.sessionThreadId])).toEqual([
      [null, "conv:chat-1", "msg-3"],
      [null, "conv:chat-1", "msg-4"],
    ]);
    expect(port.dispatched[0]?.conversationLabel).toBe("AI chat “Invoices”");
    await api.waitFor(() => api.typing.some((t) => t.typing === false));
    expect(api.typing.every((t) => t.threadRootMessageId === null)).toBe(true);
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

describe("agent.card_action.v1 → dispatch → reply (06-14)", () => {
  const cardActionData = (over: Record<string, unknown> = {}) => ({
    ...mention(40, {
      message: {
        id: "card-msg-1",
        text: "Sam Lee approved “Deploy api v2.3”",
        createdAt: "2026-10-07T10:00:00.000Z",
        author: { kind: "user", id: "u-sam", displayName: "Sam Lee" },
        mentions: [{ kind: "agent", id: ARCHIE.id }],
      },
    }),
    cardAction: { messageId: "card-msg-1", kind: "approval", title: "Deploy api v2.3", outcome: "approved" },
    ...over,
  });

  it("dispatches through the mention path: typing, the card's thread, the deciding human as sender", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() === 1);
    api.publish("agent.card_action.v1", cardActionData());
    await api.waitFor(() => api.messages.length === 1);
    expect(api.messages[0]).toMatchObject({
      agentId: ARCHIE.id,
      conversationId: "conv-1",
      threadRootMessageId: "root-1",
      inReplyToMessageId: "card-msg-1",
      eventId: "evt-40",
      text: "Hi Sam Lee!",
      idempotencyKey: "evt:evt-40",
    });
    expect(port.dispatched[0]?.body).toBe("Sam Lee approved “Deploy api v2.3”");
    expect(port.dispatched[0]?.contextBlocks.map((b) => b.type)).toContain("card_action");
    await api.waitFor(() => api.typing.some((t) => t.typing === false));
    expect(api.typing[0]).toMatchObject({
      conversationId: "conv-1",
      threadRootMessageId: "root-1",
      typing: true,
    });
  });

  /** What the server puts on every stored event (the fake API's `publish` adds them on the wire). */
  const frameFields = (seq: number) => ({
    seq,
    type: "agent.card_action.v1",
    organizationId: "org-1",
    cellId: "org-1",
  });

  it("an invalid card action is skipped with a warning carrying the seq and field path only; later events flow", async () => {
    const logs: string[] = [];
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const bridge = createBridge({
      client,
      port,
      signal: new AbortController().signal,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      typingIntervalMs: 50,
      retryDelayMs: 10,
    });
    await bridge.refreshCell();
    await bridge.handleFrame({
      seq: 41,
      type: "agent.card_action.v1",
      data: {
        ...frameFields(41),
        ...cardActionData({
          eventId: "evt-41",
          cardAction: { messageId: "card-msg-1", kind: "approval", title: "SECRET TITLE", outcome: "maybe" },
        }),
      },
    });
    expect(port.dispatched).toEqual([]);
    const warning = logs.find((l) => l.includes("seq=41")) ?? "";
    expect(warning).toContain("cardAction.outcome");
    expect(warning).not.toContain("SECRET");
    expect(warning).not.toContain("maybe");
    await bridge.handleFrame({
      seq: 42,
      type: "agent.card_action.v1",
      data: { ...frameFields(42), ...cardActionData({ eventId: "evt-42" }) },
    });
    expect(port.dispatched).toHaveLength(1);
    expect(api.messages.map((m) => m.idempotencyKey)).toEqual(["evt:evt-42"]);
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

describe("mcp.probe (D-13): the cell lists an MCP server's tools with the official SDK and reports them", () => {
  const TOKEN = "contract-mcp-token-1234";
  let mcpServer: Server;
  let mcpBase: string;

  beforeEach(async () => {
    const handle = createFakeMcp({ token: TOKEN });
    mcpServer = createServer((req, res) => {
      if (!handle(req, res, new URL(req.url ?? "/", "http://localhost"))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
    mcpBase = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    mcpServer.closeAllConnections();
    await new Promise((r) => mcpServer.close(r));
  });

  const server = (over: Partial<CellMcpServer> = {}): CellMcpServer => ({
    id: "mcp-1",
    safeName: "m0a1b2c3d",
    transport: "streamable-http",
    url: `${mcpBase}/mcp`,
    headers: [{ name: "Authorization", envName: "OCW_MCP_M0A1B2C3D_0", value: `Bearer ${TOKEN}` }],
    tools: [],
    ...over,
  });

  it("a probe for a snapshot server: one probe, one report with both tools and their hints", async () => {
    api.mcpServers = [server()];
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0);
    const reads = api.cellReads;
    api.publish("mcp.probe", { probeId: "probe-1", serverId: "mcp-1" });
    await api.waitFor(() => api.mcpProbes.length > 0);
    expect(api.mcpProbes).toEqual([
      {
        probeId: "probe-1",
        serverId: "mcp-1",
        ok: true,
        tools: [
          expect.objectContaining({
            name: "echo",
            annotations: { readOnlyHint: true, destructiveHint: false },
          }),
          expect.objectContaining({
            name: "write_note",
            annotations: { readOnlyHint: false, destructiveHint: true },
          }),
        ],
      },
    ]);
    // Known server: no extra snapshot read.
    expect(api.cellReads).toBe(reads);
    expect(JSON.stringify(api.mcpProbes)).not.toContain(TOKEN);
  });

  it("an unknown server refreshes the snapshot once, then probes it when it appeared", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0);
    const reads = api.cellReads;
    // The server joins the snapshot without a cell.config.changed (the probe raced it).
    api.mcpServers = [server({ id: "mcp-late", transport: "sse", url: `${mcpBase}/sse` })];
    api.publish("mcp.probe", { probeId: "probe-2", serverId: "mcp-late" });
    await api.waitFor(() => api.mcpProbes.length > 0);
    expect(api.cellReads).toBe(reads + 1);
    expect(api.mcpProbes[0]).toMatchObject({ probeId: "probe-2", serverId: "mcp-late", ok: true });
    expect(api.mcpProbes[0]?.tools?.map((t) => t.name)).toEqual(["echo", "write_note"]);
  });

  it("a server still unknown after one refresh is reported ok:false without connecting anywhere", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0);
    const reads = api.cellReads;
    api.publish("mcp.probe", { probeId: "probe-3", serverId: "mcp-missing" });
    await api.waitFor(() => api.mcpProbes.length > 0);
    expect(api.cellReads).toBe(reads + 1);
    expect(api.mcpProbes).toEqual([
      { probeId: "probe-3", serverId: "mcp-missing", ok: false, error: UNKNOWN_SERVER_ERROR },
    ]);
  });

  it("wrong credentials: ok:false with a classified reason and no header value", async () => {
    api.mcpServers = [
      server({ headers: [{ name: "Authorization", envName: "E", value: "Bearer not-the-token-777" }] }),
    ];
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0);
    api.publish("mcp.probe", { probeId: "probe-4", serverId: "mcp-1" });
    await api.waitFor(() => api.mcpProbes.length > 0);
    expect(api.mcpProbes[0]).toMatchObject({ ok: false, error: expect.stringContaining("HTTP 401") });
    expect(JSON.stringify(api.mcpProbes)).not.toContain("not-the-token-777");
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

  it("the active turn carries the reply target (conversation, thread, asked message) the card tool binds to (06-14)", async () => {
    const guard = createToolGuard({ client: () => null });
    let during: Record<string, unknown> | undefined;
    const { runtime } = fakeRuntime((params) => {
      const t = guard.activeTurn((params.route as { sessionKey: string }).sessionKey);
      during = t
        ? { conversationId: t.conversationId, threadRootId: t.threadRootId, messageId: t.messageId }
        : {};
    });
    const p = createOpenClawPort({ runtime, accountId: "default", cfg: {}, guard });
    await p.dispatchMention(
      mapMention(event({ turn: TURN } as never), ARCHIE),
      async () => {},
      new AbortController().signal,
    );
    expect(during).toEqual({ conversationId: "conv-1", threadRootId: "root-1", messageId: "msg-1" });
    const dm = mapMention(
      event({
        conversation: { id: "dm-1", kind: "dm", name: null },
        thread: { rootMessageId: "msg-1" },
        turn: TURN,
      } as never),
      ARCHIE,
    );
    await p.dispatchMention(dm, async () => {}, new AbortController().signal);
    expect(during).toEqual({ conversationId: "dm-1", threadRootId: null, messageId: "msg-1" });
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

describe("memory tool (D-10): manifest, registration and the fake API", () => {
  const MEMORY = { untrustedOutput: false, sideEffecting: true };

  it("the manifest declares ocw_memory_save and ocw_agent_card in contracts.tools (OpenClaw discovers tool ownership there)", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    expect(manifest.contracts?.tools).toEqual(["ocw_memory_save", "ocw_agent_card"]);
  });

  it("registerFull registers ocw_memory_save and ocw_agent_card (+ the breaker guard on gateway_start); the gate hooks come from registerCapabilities", () => {
    const hooks: string[] = [];
    const tools: Array<{ opts: { name: string } }> = [];
    const pluginApi = {
      on: (name: string) => hooks.push(name),
      registerTool: (_factory: unknown, opts: { name: string }) => tools.push({ opts }),
    };
    const guard = createToolGuard({ client: () => null });
    registerFull(pluginApi as never, guard);
    expect(hooks).toEqual(["gateway_start"]);
    expect(tools.map((t) => t.opts.name)).toEqual(["ocw_memory_save", "ocw_agent_card"]);
    registerCapabilities(pluginApi as never, guard);
    expect(hooks).toEqual(["gateway_start", "before_tool_call", "after_tool_call"]);
    expect(tools).toHaveLength(2);
  });

  it("a save in an active DM turn reaches POST /memories with the event, the bot and the text only", async () => {
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token });
    const guard = createToolGuard({ client: () => client });
    type Factory = (ctx: Record<string, unknown>) => {
      execute: (id: string, p: unknown) => Promise<unknown>;
    };
    const registered: Factory[] = [];
    registerFull(
      { on: () => undefined, registerTool: (f: Factory) => registered.push(f) } as never,
      guard,
      () => client,
    );
    const turn = {
      tools: ["ocw_memory_save"],
      toolFlags: { ocw_memory_save: MEMORY },
      memory: [],
      now: null,
      maxToolCalls: 8,
      maxWebCalls: 5,
    };
    guard.beginTurn("s-dm", { eventId: "evt-m1", agentId: ARCHIE.id, turn, conversationId: "dm-1" });
    const factory = registered[0];
    if (!factory) throw new Error("ocw_memory_save was not registered");
    const tool = factory({ sessionKey: "s-dm" });
    expect(await tool.execute("tc-1", { text: "lives in Madrid" })).toMatchObject({
      content: [{ type: "text", text: "Saved." }],
    });
    expect(await tool.execute("tc-2", { text: "lives in Madrid" })).toMatchObject({
      content: [{ type: "text", text: "Already saved." }],
    });
    api.refuseMemoryEvents.add("evt-m1");
    const refused = (await tool.execute("tc-3", { text: "something else" })) as {
      content: Array<{ text: string }>;
    };
    expect(refused.content[0]?.text).toBe("Not saved: memory is not available on this turn.");
    expect(api.memories.map(({ eventId, agentId, text }) => ({ eventId, agentId, text }))).toEqual([
      { eventId: "evt-m1", agentId: ARCHIE.id, text: "lives in Madrid" },
      { eventId: "evt-m1", agentId: ARCHIE.id, text: "lives in Madrid" },
      { eventId: "evt-m1", agentId: ARCHIE.id, text: "something else" },
    ]);
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

describe("marketplace executor (D-14): plugin.install.v1 / plugin.uninstall.v1 through the bridge and the fake API", () => {
  const ORIGIN = "http://fake-clawhub.test";
  const BYTES = Buffer.from("echo plugin tarball for the contract test");
  const SHA = createHash("sha256").update(BYTES).digest("hex");
  const ROW = "row-echo";
  const INSPECT = (() => {
    const d = JSON.parse(
      readFileSync(new URL("./testing/fixtures/inspect-ocw-echo.json", import.meta.url), "utf8"),
    );
    delete d.install.integrity;
    return JSON.stringify(d);
  })();
  let state: string;
  let cliCalls: string[][];
  let downloads: string[];

  /** OpenClaw as the CLI sees it: the plugin exists after `plugins install`, with the hooks `config set` wrote. */
  let installed = false;
  let hooksOff = false;
  const exec: RunCli = async (args) => {
    cliCalls.push([...args]);
    if (args[1] === "config") hooksOff = true;
    if (args[2] === "install") installed = true;
    if (args[2] === "inspect") {
      if (!installed) return { code: 1, stdout: "", stderr: "Plugin not found", timedOut: false };
      const data = JSON.parse(INSPECT);
      if (hooksOff) data.policy = { allowConversationAccess: false, allowPromptInjection: false };
      return { code: 0, stdout: JSON.stringify(data), stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    downloads.push(String(input));
    return new Response(new Uint8Array(BYTES), { status: 200 });
  }) as typeof fetch;

  function startWithInstaller() {
    const holder: { bridge?: ReturnType<typeof createBridge> } = {};
    const installer = createPluginInstaller({
      client: createAgentChannelClient({
        apiUrl: api.url,
        token: () => api.token,
        backoff: { baseMs: 5, maxMs: 20 },
      }),
      snapshot: () => holder.bridge?.snapshot(),
      refresh: () => (holder.bridge as ReturnType<typeof createBridge>).refreshCell(),
      stateDir: state,
      clawhubOrigin: ORIGIN,
      exec,
      fetchImpl,
    });
    holder.bridge = startPlugin({ plugins: installer }).bridge;
  }

  const install = (over: Record<string, unknown> = {}) => ({
    flowId: "flow-1",
    pluginRowId: ROW,
    packageName: "@ocw-test/echo-plugin",
    version: "0.1.0",
    artifactUrl: `${ORIGIN}/api/v1/packages/%40ocw-test%2Fecho-plugin/versions/0.1.0/artifact/download`,
    sha256: SHA,
    npmIntegrity: null,
    expectedPluginId: "ocw-echo",
    mode: "install",
    ...over,
  });

  beforeEach(() => {
    state = mkdtempSync(path.join(tmpdir(), "ocw-market-"));
    cliCalls = [];
    downloads = [];
    installed = false;
    hooksOff = false;
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  it("an approved install is executed once and its declared tools reach POST /plugins/report", async () => {
    api.plugins = [
      {
        pluginRowId: ROW,
        packageName: "@ocw-test/echo-plugin",
        version: "0.1.0",
        sha256: SHA,
        pluginId: "ocw-echo",
        status: "approved",
      },
    ];
    startWithInstaller();
    await api.waitFor(() => api.openSockets() > 0);
    api.publish("plugin.install.v1", install());
    await api.waitFor(() => api.pluginReports.length > 0);
    expect(downloads).toHaveLength(1);
    // Not there yet → hooks off first → install → inspect.
    expect(cliCalls.map((c) => c.slice(1, 3).join(" "))).toEqual([
      "plugins inspect",
      "config set",
      "plugins install",
      "plugins inspect",
    ]);
    expect(api.pluginReports).toEqual([
      expect.objectContaining({
        flowId: "flow-1",
        pluginRowId: ROW,
        state: "installed",
        pluginId: "ocw-echo",
        declaredTools: [{ name: "ocw_echo" }],
      }),
    ]);
    expect(api.plugins[0]?.status).toBe("installed");
    // The next refresh mirrors the API's installed rows into the boot cache.
    api.updateCell({});
    await api.waitFor(() => existsSync(path.join(state, BOOT_CACHE_FILE)));
    await api.waitFor(() =>
      JSON.parse(readFileSync(path.join(state, BOOT_CACHE_FILE), "utf8")).installed?.some(
        (p: { pluginId: string }) => p.pluginId === "ocw-echo",
      ),
    );
  });

  it("an install the snapshot does not approve is reported failed and never downloaded nor executed", async () => {
    startWithInstaller();
    await api.waitFor(() => api.openSockets() > 0);
    const reads = api.cellReads;
    api.publish("plugin.install.v1", install());
    await api.waitFor(() => api.pluginReports.length > 0);
    expect(api.cellReads).toBe(reads + 1);
    expect(api.pluginReports[0]).toMatchObject({ state: "failed", error: { code: "not_approved" } });
    expect(downloads).toEqual([]);
    expect(cliCalls).toEqual([]);
  });

  it("an uninstall command removes the plugin and reports uninstalled", async () => {
    api.plugins = [
      {
        pluginRowId: ROW,
        packageName: "@ocw-test/echo-plugin",
        version: "0.1.0",
        sha256: SHA,
        pluginId: "ocw-echo",
        status: "installed",
      },
    ];
    startWithInstaller();
    await api.waitFor(() => api.openSockets() > 0);
    api.publish("plugin.uninstall.v1", { flowId: "flow-2", pluginRowId: ROW, pluginId: "ocw-echo" });
    await api.waitFor(() => api.pluginReports.length > 0);
    expect(cliCalls.map((c) => c.slice(2))).toEqual([["uninstall", "ocw-echo", "--force"]]);
    expect(api.pluginReports).toEqual([
      { flowId: "flow-2", pluginRowId: ROW, state: "uninstalled", pluginId: "ocw-echo" },
    ]);
    expect(api.plugins[0]?.status).toBe("uninstalled");
  });

  it("the fake API, like the real one, applies a report only to the row's current flow", async () => {
    api.plugins = [
      {
        pluginRowId: ROW,
        packageName: "@ocw-test/echo-plugin",
        version: "0.1.0",
        sha256: SHA,
        pluginId: "ocw-echo",
        status: "approved",
      },
    ];
    api.publish("plugin.install.v1", install({ flowId: "flow-a" }));
    api.publish("plugin.uninstall.v1", { flowId: "flow-b", pluginRowId: ROW, pluginId: "ocw-echo" });
    const client = createAgentChannelClient({ apiUrl: api.url, token: () => api.token, maxAttempts: 1 });
    // A late "installed" of the install flow (a replay's re-report) must not undo the uninstall in flight.
    await expect(
      client.reportPlugin({ flowId: "flow-a", pluginRowId: ROW, state: "installed", pluginId: "ocw-echo" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(api.plugins[0]?.status).toBe("uninstalling");
  });

  it("without an executor the plugin ignores marketplace events (older cells)", async () => {
    startPlugin();
    await api.waitFor(() => api.openSockets() > 0);
    api.publish("plugin.install.v1", install());
    api.publishMention(mention(1));
    await api.waitFor(() => api.messages.length === 1);
    expect(api.pluginReports).toEqual([]);
  });
});
