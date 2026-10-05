/**
 * Fake Agent Channel API v1 server (tests + local/container smoke runs), speaking the canonical
 * contract (`01-AGENT-CHANNEL-API.md`, `packages/contracts/src/agent-channel.ts`).
 *
 * Self-contained on purpose (only `ws` + node builtins, type-only imports) so it also runs with
 * plain `node` type stripping: `node apps/openclaw-channel/src/testing/run-fake-api.ts`.
 *
 *   GET  /agent-channel/v1/cell
 *   GET  /agent-channel/v1/ws            client {op:"sub", topic, afterSeq?} → {op:"ev"|"subscribed"|"err"|"pong"}
 *   POST /agent-channel/v1/messages      idempotent on agentId + idempotencyKey
 *   POST /agent-channel/v1/typing
 *   POST /agent-channel/v1/agents/:id/status
 *   POST /agent-channel/v1/provider-auth  (status per report: `authResponder`, default 200)
 *   POST /agent-channel/v1/tool-calls     records and allows (denies tools listed in `denyTools`)
 *   POST /agent-channel/v1/tool-calls/:id/result  records the outcome
 *   POST /agent-channel/v1/memories       records the note (dedupes exact text per event's bot; 409 for
 *                                          events listed in `refuseMemoryEvents`)
 * Test-only controls under /__test/* (never part of the real API).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type {
  AgentChannelMemorySave,
  AgentChannelPostMessage,
  AgentChannelProviderAuthReport,
  AgentChannelStatusReport,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  AgentChannelTyping,
  AgentMentionEvent,
  CellAgent,
  CellProvider,
  CellSnapshot,
  CellSubscription,
} from "../agent-channel-protocol.js";

export type StoredEvent = { seq: number; type: string; data: Record<string, unknown> };
export type StoredMessage = AgentChannelPostMessage & { messageId: string; receivedAt: number };
export type StatusReport = AgentChannelStatusReport & { agentId: string };
export type MentionInput = Omit<AgentMentionEvent, "seq" | "type" | "organizationId" | "cellId">;
export type StoredToolCall = AgentChannelToolCallRequest & { callId: string; allowed: boolean };
export type StoredToolResult = AgentChannelToolCallResult & { callId: string };
export type StoredMemory = AgentChannelMemorySave & { memoryId: string; created: boolean };

export type FakeAgentChannelApi = {
  url: string;
  server: Server;
  token: string;
  cellId: string;
  topic: string;
  agents: CellAgent[];
  providers: CellProvider[];
  /** Snapshot `subscriptions`; `undefined` = an older API that does not send the field. */
  cellSubscriptions: CellSubscription[] | undefined;
  /** Snapshot `webSearch.provider`; `undefined` = not sent. */
  webSearchProvider: string | undefined;
  /** Tools whose `/tool-calls` the fake API denies (`denied_by_test`). */
  denyTools: Set<string>;
  toolCalls: StoredToolCall[];
  toolResults: StoredToolResult[];
  /** Every POST /memories (also refused ones: `memoryId` "" and `created` false). */
  memories: StoredMemory[];
  /** Event ids whose memory saves the fake API refuses with 409 `tainted`. */
  refuseMemoryEvents: Set<string>;
  events: StoredEvent[];
  authReports: AgentChannelProviderAuthReport[];
  /** HTTP status for each POST /provider-auth (default 200). */
  authResponder: (report: AgentChannelProviderAuthReport) => number;
  messages: StoredMessage[];
  /** Every POST /messages attempt, including retries and failures. */
  messageAttempts: AgentChannelPostMessage[];
  typing: AgentChannelTyping[];
  statusReports: StatusReport[];
  /** `afterSeq` of every accepted `sub` (null = live), in order. */
  subscriptions: Array<number | null>;
  authFailures: number;
  publish(type: string, data: Record<string, unknown>): StoredEvent;
  publishMention(input: MentionInput): StoredEvent;
  /** Replace agents/providers and emit `cell.config.changed` (`agentId` names the bot it is about). */
  updateCell(
    next: { agents?: CellAgent[]; providers?: CellProvider[]; subscriptions?: CellSubscription[] },
    reason?: string,
    agentId?: string | null,
  ): StoredEvent;
  /** Next `n` POST /messages respond with `status` (before idempotency handling). */
  failNextPosts(n: number, status?: number): void;
  /** Close every open plugin socket (simulates an API restart / network blip). */
  dropConnections(): void;
  /** Send `{op:"resync"}` to every subscribed socket. */
  sendResync(): void;
  openSockets(): number;
  waitFor<T>(fn: () => T | undefined | false | null, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
};

const BASE = "/agent-channel/v1";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function startFakeAgentChannelApi(
  opts: {
    token?: string;
    cellId?: string;
    agents?: CellAgent[];
    providers?: CellProvider[];
    subscriptions?: CellSubscription[];
    webSearchProvider?: string;
    denyTools?: string[];
    port?: number;
    host?: string;
  } = {},
): Promise<FakeAgentChannelApi> {
  const token = opts.token ?? "test-cell-token";
  const cellId = opts.cellId ?? "0199a000-0000-7000-8000-0000000000c1";
  const topic = `cell:${cellId}`;
  const subscribed = new Set<WebSocket>();
  const sockets = new Set<WebSocket>();
  let failures = { n: 0, status: 503 };
  const byKey = new Map<string, StoredMessage>();

  const state = {
    agents: opts.agents ?? [],
    providers: opts.providers ?? [],
    cellSubscriptions: opts.subscriptions as CellSubscription[] | undefined,
    authReports: [] as AgentChannelProviderAuthReport[],
    authResponder: (() => 200) as (report: AgentChannelProviderAuthReport) => number,
    events: [] as StoredEvent[],
    messages: [] as StoredMessage[],
    messageAttempts: [] as AgentChannelPostMessage[],
    typing: [] as AgentChannelTyping[],
    statusReports: [] as StatusReport[],
    subscriptions: [] as Array<number | null>,
    authFailures: 0,
    webSearchProvider: opts.webSearchProvider,
    denyTools: new Set(opts.denyTools ?? []),
    toolCalls: [] as StoredToolCall[],
    toolResults: [] as StoredToolResult[],
    memories: [] as StoredMemory[],
    refuseMemoryEvents: new Set<string>(),
  };

  const snapshot = (): CellSnapshot => ({
    protocolVersion: 1,
    cellId,
    organizationId: cellId,
    topic,
    lastSeq: state.events.at(-1)?.seq ?? 0,
    agents: state.agents,
    providers: state.providers,
    ...(state.cellSubscriptions ? { subscriptions: state.cellSubscriptions } : {}),
    ...(state.webSearchProvider ? { webSearch: { provider: state.webSearchProvider } } : {}),
  });
  const frameFor = (ev: StoredEvent) =>
    JSON.stringify({ op: "ev", topic, seq: ev.seq, type: ev.type, data: ev.data });
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/__test/")) {
        if (req.method === "POST" && url.pathname === "/__test/mention") {
          return json(res, 200, api.publishMention((await readJson(req)) as MentionInput));
        }
        if (req.method === "POST" && url.pathname === "/__test/cell") {
          const body = (await readJson(req)) as {
            agents?: CellAgent[];
            providers?: CellProvider[];
            reason?: string;
            agentId?: string | null;
          };
          return json(res, 200, api.updateCell(body, body.reason, body.agentId ?? null));
        }
        if (req.method === "POST" && url.pathname === "/__test/event") {
          const { type, data } = (await readJson(req)) as { type: string; data: Record<string, unknown> };
          return json(res, 200, api.publish(type, data));
        }
        if (req.method === "GET" && url.pathname === "/__test/state") {
          return json(res, 200, {
            messages: state.messages,
            typing: state.typing,
            statusReports: state.statusReports,
            subscriptions: state.subscriptions,
            authReports: state.authReports,
            events: state.events.length,
            toolCalls: state.toolCalls,
            toolResults: state.toolResults,
            memories: state.memories,
          });
        }
        return json(res, 404, { error: { code: "not_found" } });
      }
      if (!url.pathname.startsWith(BASE)) return json(res, 404, { error: { code: "not_found" } });
      if (!authorized(req)) {
        state.authFailures++;
        return json(res, 401, { error: { code: "invalid_cell_token" } });
      }
      const route = url.pathname.slice(BASE.length);
      if (req.method === "GET" && route === "/cell") return json(res, 200, snapshot());
      if (req.method === "POST" && route === "/messages") {
        const body = (await readJson(req)) as AgentChannelPostMessage;
        state.messageAttempts.push(body);
        if (failures.n > 0) {
          failures.n--;
          return json(res, failures.status, { error: { code: "unavailable", message: "injected failure" } });
        }
        if (
          !body.agentId ||
          !body.conversationId ||
          !body.text ||
          !body.idempotencyKey ||
          !("threadRootMessageId" in body)
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (!state.agents.some((a) => a.id === body.agentId))
          return json(res, 404, { error: { code: "agent_not_found" } });
        const key = `${body.agentId}:${body.idempotencyKey}`;
        const existing = byKey.get(key);
        const reply = (m: StoredMessage, created: boolean) => ({
          messageId: m.messageId,
          created,
          conversationId: m.conversationId,
          threadRootMessageId: m.threadRootMessageId,
        });
        if (existing) return json(res, 200, reply(existing, false));
        const stored: StoredMessage = { ...body, messageId: randomUUID(), receivedAt: Date.now() };
        byKey.set(key, stored);
        state.messages.push(stored);
        return json(res, 200, reply(stored, true));
      }
      if (req.method === "POST" && route === "/provider-auth") {
        const report = (await readJson(req)) as AgentChannelProviderAuthReport;
        state.authReports.push(report);
        const status = state.authResponder(report);
        return status === 200
          ? json(res, 200, { ok: true })
          : json(res, status, { error: { code: status === 409 ? "flow_claimed" : "error" } });
      }
      if (req.method === "POST" && route === "/tool-calls") {
        const body = (await readJson(req)) as AgentChannelToolCallRequest;
        const allowed = !state.denyTools.has(body.tool);
        const stored: StoredToolCall = { ...body, callId: randomUUID(), allowed };
        state.toolCalls.push(stored);
        return json(res, 200, {
          callId: stored.callId,
          allowed,
          reason: allowed ? null : "denied_by_test",
        });
      }
      const resultMatch = /^\/tool-calls\/([^/]+)\/result$/u.exec(route);
      if (req.method === "POST" && resultMatch?.[1]) {
        const callId = decodeURIComponent(resultMatch[1]);
        if (!state.toolCalls.some((c) => c.callId === callId && c.allowed)) {
          return json(res, 404, { error: { code: "unknown_call" } });
        }
        state.toolResults.push({ ...((await readJson(req)) as AgentChannelToolCallResult), callId });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/memories") {
        const body = (await readJson(req)) as AgentChannelMemorySave;
        if (!body.eventId || !body.agentId || typeof body.text !== "string" || body.text.length > 500) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (state.refuseMemoryEvents.has(body.eventId)) {
          state.memories.push({ ...body, memoryId: "", created: false });
          return json(res, 409, { error: { code: "tainted", message: "refused by test" } });
        }
        const same = state.memories.find(
          (m) => m.memoryId && m.agentId === body.agentId && m.text === body.text,
        );
        const stored: StoredMemory = { ...body, memoryId: same?.memoryId ?? randomUUID(), created: !same };
        state.memories.push(stored);
        return json(res, 200, { memoryId: stored.memoryId, created: stored.created });
      }
      if (req.method === "POST" && route === "/typing") {
        state.typing.push((await readJson(req)) as AgentChannelTyping);
        return json(res, 200, { ok: true });
      }
      const statusMatch = /^\/agents\/([^/]+)\/status$/u.exec(route);
      if (req.method === "POST" && statusMatch?.[1]) {
        const agentId = decodeURIComponent(statusMatch[1]);
        const body = (await readJson(req)) as AgentChannelStatusReport;
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) return json(res, 404, { error: { code: "agent_not_found" } });
        state.statusReports.push({ agentId, ...body });
        if (agent.status !== "disabled") agent.status = body.status;
        return json(res, 200, agent);
      }
      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== `${BASE}/ws` || !authorized(req)) {
      state.authFailures++;
      socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (req.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
        subscribed.delete(ws);
      });
      ws.on("message", (raw) => {
        let frame: { op?: string; topic?: string; afterSeq?: number };
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ op: "err", code: "bad_frame" }));
          return;
        }
        if (frame.op === "ping") {
          ws.send(JSON.stringify({ op: "pong" }));
          return;
        }
        if (frame.op !== "sub") {
          ws.send(JSON.stringify({ op: "err", code: "bad_frame" }));
          return;
        }
        if (frame.topic !== topic) {
          ws.send(JSON.stringify({ op: "err", code: "forbidden", topic: frame.topic }));
          return;
        }
        const afterSeq = typeof frame.afterSeq === "number" ? frame.afterSeq : null;
        state.subscriptions.push(afterSeq);
        if (afterSeq !== null) for (const ev of state.events) if (ev.seq > afterSeq) ws.send(frameFor(ev));
        subscribed.add(ws);
        ws.send(JSON.stringify({ op: "subscribed", topic, lastSeq: state.events.at(-1)?.seq ?? 0 }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  const api: FakeAgentChannelApi = {
    url: `http://${opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1"}:${address.port}`,
    server,
    token,
    cellId,
    topic,
    get agents() {
      return state.agents;
    },
    set agents(value: CellAgent[]) {
      state.agents = value;
    },
    get providers() {
      return state.providers;
    },
    set providers(value: CellProvider[]) {
      state.providers = value;
    },
    get cellSubscriptions() {
      return state.cellSubscriptions;
    },
    set cellSubscriptions(value: CellSubscription[] | undefined) {
      state.cellSubscriptions = value;
    },
    get webSearchProvider() {
      return state.webSearchProvider;
    },
    set webSearchProvider(value: string | undefined) {
      state.webSearchProvider = value;
    },
    get denyTools() {
      return state.denyTools;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    get toolResults() {
      return state.toolResults;
    },
    get memories() {
      return state.memories;
    },
    get refuseMemoryEvents() {
      return state.refuseMemoryEvents;
    },
    get authReports() {
      return state.authReports;
    },
    get authResponder() {
      return state.authResponder;
    },
    set authResponder(fn: (report: AgentChannelProviderAuthReport) => number) {
      state.authResponder = fn;
    },
    get events() {
      return state.events;
    },
    get messages() {
      return state.messages;
    },
    get messageAttempts() {
      return state.messageAttempts;
    },
    get typing() {
      return state.typing;
    },
    get statusReports() {
      return state.statusReports;
    },
    get subscriptions() {
      return state.subscriptions;
    },
    get authFailures() {
      return state.authFailures;
    },
    publish(type, data) {
      const seq = (state.events.at(-1)?.seq ?? 0) + 1;
      const ev: StoredEvent = { seq, type, data: { ...data, type, organizationId: cellId, cellId, seq } };
      state.events.push(ev);
      for (const ws of subscribed) ws.send(frameFor(ev));
      return ev;
    },
    publishMention(input) {
      return api.publish("agent.mention.v1", input as unknown as Record<string, unknown>);
    },
    updateCell(next, reason = "agent.updated", agentId = null) {
      if (next.agents) state.agents = next.agents;
      if (next.providers) state.providers = next.providers;
      if (next.subscriptions) state.cellSubscriptions = next.subscriptions;
      return api.publish("cell.config.changed", { reason: reason ?? "agent.updated", agentId });
    },
    failNextPosts(n, status = 503) {
      failures = { n, status };
    },
    dropConnections() {
      for (const ws of sockets) ws.terminate();
    },
    sendResync() {
      for (const ws of subscribed) ws.send(JSON.stringify({ op: "resync", topic }));
    },
    openSockets: () => subscribed.size,
    async waitFor(fn, timeoutMs = 12_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = fn();
        if (value) return value as never;
        if (Date.now() > deadline) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
