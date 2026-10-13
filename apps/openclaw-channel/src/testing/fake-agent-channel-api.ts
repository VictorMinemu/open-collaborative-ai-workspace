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
 *   POST /agent-channel/v1/runtime         records the report (`runtimeReports`)
 *   POST /agent-channel/v1/provider-auth  (status per report: `authResponder`, default 200)
 *   POST /agent-channel/v1/tool-calls     records and allows (denies tools listed in `denyTools`)
 *   POST /agent-channel/v1/tool-calls/:id/result  records the outcome
 *   POST /agent-channel/v1/memories       records the note (dedupes exact text per event's bot; 409 for
 *                                          events listed in `refuseMemoryEvents`)
 *   POST /agent-channel/v1/memory/read    a file of `memoryFileStore` by scope alias / id and path (case-insensitive), else
 *                                          `{refused:"not_found"}`; `memoryRefusals` forces a refusal per event; strict body
 *                                          (an unknown key is 400 bad_request, like the contract); every call in `memoryCalls`
 *   POST /agent-channel/v1/cards          records the card (`cards`; idempotent on agentId + idempotencyKey, version 1)
 *   PATCH /agent-channel/v1/cards/:id     posting agent only (403), expectedVersion must match (409
 *                                          card_version_conflict); records the patch (`cardPatches`)
 *   POST /agent-channel/v1/board/read     a fixed two-column board (Backlog, In progress); the turn's card when the
 *                                          event's `threadRootId` names a stored board card (`boardTurnCards`), else null
 *   POST /agent-channel/v1/board/cards    records the card (`boardCards`; idempotent on agentId + idempotencyKey, 201
 *                                          then 200, version 1, the first column by default)
 *   PATCH /agent-channel/v1/board/cards/:id  move / waiting state of a stored board card (409
 *                                          board_card_version_conflict, 403 not_author on any text key)
 *   POST /agent-channel/v1/mcp/probe-results  records the probe report (`mcpProbes`)
 *   POST /agent-channel/v1/plugins/report     records the report (`pluginReports`) and moves the row's status
 *   POST /agent-channel/v1/plugins/verify-install  approves only a row `installing` with the same package, version
 *                                          and sha256 (`verifyCalls`); like the real API, the install gate's authority
 *   GET  /agent-channel/v1/plugins            the rows with a plugin id (boot allowlist)
 * Test-only controls under /__test/* (never part of the real API).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type {
  AgentChannelBoardCreateCard,
  AgentChannelBoardPatchCard,
  AgentChannelMcpProbeResult,
  AgentChannelMemorySave,
  AgentChannelPatchCard,
  AgentChannelPluginReport,
  AgentChannelPostCard,
  AgentChannelPostMessage,
  AgentChannelProviderAuthReport,
  AgentChannelRuntimeReport,
  AgentChannelStatusReport,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  AgentChannelTyping,
  AgentMentionEvent,
  CellAgent,
  CellApprovedPlugin,
  CellMcpServer,
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
/** One file of the fake memory store (`scope` is "personal", "agent" or a scope id, as the tools send it). */
export type FakeMemoryFile = { scope: string; path: string; version: number; content: string };
export type MemoryRoute = "list" | "read" | "write" | "propose";
export type StoredMemoryCall = { route: MemoryRoute; body: Record<string, unknown> };
export type StoredCard = AgentChannelPostCard & { messageId: string; version: number };
export type StoredCardPatch = AgentChannelPatchCard & { messageId: string; status: number };
export type StoredBoardCard = AgentChannelBoardCreateCard & {
  messageId: string;
  columnId: string;
  waitingOn: string;
  version: number;
};
export type StoredBoardPatch = AgentChannelBoardPatchCard & { messageId: string; status: number };
export type VerifyCall = {
  packageName: string;
  version: string;
  sha256: string;
  approved: boolean;
  reason: string | null;
};

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
  /** The fake memory files the /memory routes act on (tests seed it). */
  memoryFileStore: FakeMemoryFile[];
  /** Every POST /memory/* body, in order (refused ones included). */
  memoryCalls: StoredMemoryCall[];
  /** Event id → the refusal every /memory route answers for it (`{refused}` with 200, like the real API). */
  memoryRefusals: Map<string, string>;
  /** Every card stored by POST /cards (idempotent retries are not stored twice); `version` follows the patches. */
  cards: StoredCard[];
  /** Every PATCH /cards/:id attempt with the status it got. */
  cardPatches: StoredCardPatch[];
  /** Every board card stored by POST /board/cards (idempotent retries are not stored twice). */
  boardCards: StoredBoardCard[];
  /** Every PATCH /board/cards/:id attempt with the status it got. */
  boardPatches: StoredBoardPatch[];
  /** Every POST /board/read (event ids). */
  boardReads: string[];
  /** Event id → the board card whose thread the turn runs in (what the real API reads from the stored turn). */
  boardTurnCards: Map<string, string>;
  /** Snapshot `mcpServers` (header values included, as the real API sends them); `[]` = none. */
  mcpServers: CellMcpServer[];
  /** Every POST /mcp/probe-results, in order. */
  mcpProbes: AgentChannelMcpProbeResult[];
  /** Number of GET /cell requests served. */
  cellReads: number;
  /** Snapshot `plugins` (approved marketplace plugins); publishing a plugin event moves its row's status. */
  plugins: CellApprovedPlugin[];
  /** Every POST /plugins/report attempt, in order (404s for unknown rows included). */
  pluginReports: AgentChannelPluginReport[];
  /** Every POST /plugins/verify-install (the install gate's questions) with the answer. */
  verifyCalls: VerifyCall[];
  events: StoredEvent[];
  authReports: AgentChannelProviderAuthReport[];
  /** HTTP status for each POST /provider-auth (default 200). */
  authResponder: (report: AgentChannelProviderAuthReport) => number;
  messages: StoredMessage[];
  /** Every POST /messages attempt, including retries and failures. */
  messageAttempts: AgentChannelPostMessage[];
  typing: AgentChannelTyping[];
  statusReports: StatusReport[];
  /** Every POST /runtime (why the cell runs without its channel), in order. */
  runtimeReports: AgentChannelRuntimeReport[];
  /** `afterSeq` of every accepted `sub` (null = live), in order. */
  subscriptions: Array<number | null>;
  authFailures: number;
  publish(type: string, data: Record<string, unknown>): StoredEvent;
  publishMention(input: MentionInput): StoredEvent;
  /** Replace agents/providers and emit `cell.config.changed` (`agentId` names the bot it is about). */
  updateCell(
    next: {
      agents?: CellAgent[];
      providers?: CellProvider[];
      subscriptions?: CellSubscription[];
      mcpServers?: CellMcpServer[];
    },
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

/** The fake board every board route acts on (the real API reads it from the stored turn). */
const FAKE_BOARD_ID = "0199a000-0000-7000-8000-0000000b0a2d";
export const FAKE_BOARD_COLUMNS = [
  {
    id: "0199a000-0000-7000-8000-0000000b0c01",
    conversationId: FAKE_BOARD_ID,
    name: "Backlog",
    rank: "a0",
    category: "backlog",
    defaultWaitingOn: null,
  },
  {
    id: "0199a000-0000-7000-8000-0000000b0c02",
    conversationId: FAKE_BOARD_ID,
    name: "In progress",
    rank: "a1",
    category: "started",
    defaultWaitingOn: null,
  },
];

function boardCardOut(c: StoredBoardCard) {
  const firstLine = (c.description ?? "").split("\n").find((l) => l.trim()) ?? "";
  return {
    messageId: c.messageId,
    conversationId: FAKE_BOARD_ID,
    columnId: c.columnId,
    rank: "a0",
    waitingOn: c.waitingOn,
    title: c.title ?? firstLine.trim().slice(0, 80),
    titleSource: c.title ? "user" : "heuristic",
    description: c.description ?? "",
    number: null,
    fields: {},
    authorKind: "agent",
    authorId: c.agentId,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    movedAt: "2026-10-12T10:00:00.000Z",
    version: c.version,
  };
}

/** The keys each /memory body may carry (the contract's strict objects): never an owner or user id. */
const MEMORY_BODY_KEYS: Record<MemoryRoute, readonly string[]> = {
  list: ["eventId", "agentId", "scope", "folder"],
  read: ["eventId", "agentId", "scope", "path"],
  write: ["eventId", "agentId", "scope", "path", "mode", "content", "expectedVersion"],
  propose: ["eventId", "agentId", "scope", "path", "op", "content", "baseVersion", "reason"],
};

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
    mcpServers?: CellMcpServer[];
    plugins?: CellApprovedPlugin[];
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
  /** Current flow per plugin row (set when a plugin command is published), as `cell_plugins.flow_id`. */
  const pluginFlows = new Map<string, string>();

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
    runtimeReports: [] as AgentChannelRuntimeReport[],
    subscriptions: [] as Array<number | null>,
    authFailures: 0,
    webSearchProvider: opts.webSearchProvider,
    denyTools: new Set(opts.denyTools ?? []),
    toolCalls: [] as StoredToolCall[],
    toolResults: [] as StoredToolResult[],
    memories: [] as StoredMemory[],
    refuseMemoryEvents: new Set<string>(),
    memoryFileStore: [] as FakeMemoryFile[],
    memoryCalls: [] as StoredMemoryCall[],
    memoryRefusals: new Map<string, string>(),
    cards: [] as StoredCard[],
    cardPatches: [] as StoredCardPatch[],
    boardCards: [] as StoredBoardCard[],
    boardPatches: [] as StoredBoardPatch[],
    boardReads: [] as string[],
    boardTurnCards: new Map<string, string>(),
    mcpServers: opts.mcpServers ?? ([] as CellMcpServer[]),
    mcpProbes: [] as AgentChannelMcpProbeResult[],
    cellReads: 0,
    plugins: opts.plugins ?? ([] as CellApprovedPlugin[]),
    pluginReports: [] as AgentChannelPluginReport[],
    verifyCalls: [] as VerifyCall[],
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
    ...(state.mcpServers.length > 0 ? { mcpServers: state.mcpServers } : {}),
    plugins: state.plugins.filter((p) => p.status !== "uninstalled"),
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
            mcpServers?: CellMcpServer[];
            reason?: string;
            agentId?: string | null;
          };
          return json(res, 200, api.updateCell(body, body.reason, body.agentId ?? null));
        }
        if (req.method === "POST" && url.pathname === "/__test/plugins") {
          // Replace the approved list without an event (the smoke publishes the install event next).
          state.plugins = ((await readJson(req)) as { plugins: CellApprovedPlugin[] }).plugins ?? [];
          return json(res, 200, { ok: true, plugins: state.plugins });
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
            runtimeReports: state.runtimeReports,
            subscriptions: state.subscriptions,
            authReports: state.authReports,
            events: state.events.length,
            toolCalls: state.toolCalls,
            toolResults: state.toolResults,
            memories: state.memories,
            memoryCalls: state.memoryCalls,
            cards: state.cards,
            cardPatches: state.cardPatches,
            boardCards: state.boardCards,
            boardPatches: state.boardPatches,
            boardReads: state.boardReads,
            mcpProbes: state.mcpProbes,
            cellReads: state.cellReads,
            plugins: state.plugins,
            pluginReports: state.pluginReports,
            verifyCalls: state.verifyCalls,
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
      if (req.method === "GET" && route === "/cell") {
        state.cellReads++;
        return json(res, 200, snapshot());
      }
      if (req.method === "POST" && route === "/mcp/probe-results") {
        const body = (await readJson(req)) as AgentChannelMcpProbeResult;
        if (!body.probeId || !body.serverId || typeof body.ok !== "boolean") {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        state.mcpProbes.push(body);
        return json(res, 200, { ok: true, applied: true });
      }
      if (req.method === "POST" && route === "/plugins/report") {
        const body = (await readJson(req)) as AgentChannelPluginReport;
        if (!body.flowId || !body.pluginRowId || !body.state) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        // Every attempt is recorded (also the ones answered 404, like a report for a row the API never approved).
        state.pluginReports.push(body);
        const row = state.plugins.find((p) => p.pluginRowId === body.pluginRowId);
        // Like the API: only the row's current flow (the last command published for it) may change it.
        const current = row ? pluginFlows.get(row.pluginRowId) : undefined;
        if (!row || (current !== undefined && current !== body.flowId)) {
          return json(res, 404, { error: { code: "plugin_flow_not_found" } });
        }
        if (body.state === "installed") {
          row.status = "installed";
          if (body.pluginId) row.pluginId = body.pluginId;
        } else if (body.state === "failed") row.status = "failed";
        else if (body.state === "uninstalled") row.status = "uninstalled";
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/plugins/verify-install") {
        const body = (await readJson(req)) as { packageName?: string; version?: string; sha256?: string };
        if (!body.packageName || !body.version || !/^[0-9a-f]{64}$/u.test(body.sha256 ?? "")) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const same = state.plugins.filter((p) => p.packageName === body.packageName);
        const row = same.find(
          (p) => p.status === "installing" && p.version === body.version && p.sha256 === body.sha256,
        );
        const reason = row
          ? null
          : same.length === 0
            ? "not_approved"
            : !same.some((p) => p.status === "installing")
              ? "not_in_flight"
              : !same.some((p) => p.version === body.version)
                ? "version_mismatch"
                : "digest_mismatch";
        const call: VerifyCall = {
          packageName: body.packageName,
          version: body.version,
          sha256: body.sha256 as string,
          approved: Boolean(row),
          reason,
        };
        state.verifyCalls.push(call);
        return json(res, 200, { approved: call.approved, reason });
      }
      if (req.method === "GET" && route === "/plugins") {
        const plugins = state.plugins
          .filter((p) => p.pluginId && ["installing", "installed", "uninstalling"].includes(p.status))
          .map((p) => ({
            pluginId: p.pluginId,
            packageName: p.packageName,
            version: p.version,
            status: p.status,
          }));
        return json(res, 200, { plugins });
      }
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
      const memoryRoute = /^\/memory\/(list|read|write|propose)$/u.exec(route)?.[1] as
        | MemoryRoute
        | undefined;
      if (req.method === "POST" && memoryRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        state.memoryCalls.push({ route: memoryRoute, body });
        const allowed = MEMORY_BODY_KEYS[memoryRoute];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const forced = state.memoryRefusals.get(body.eventId);
        if (forced) return json(res, 200, { refused: forced });
        const key = (p: unknown) => String(p).normalize("NFC").toLowerCase();
        const find = (scope: unknown, p: unknown) =>
          state.memoryFileStore.find((f) => f.scope === scope && key(f.path) === key(p));
        if (memoryRoute === "read") {
          const file = find(body.scope, body.path);
          if (!file) return json(res, 200, { refused: "not_found" });
          return json(res, 200, { file: { path: file.path, version: file.version, content: file.content } });
        }
        return json(res, 404, { error: { code: "not_found" } });
      }
      if (req.method === "POST" && route === "/cards") {
        const body = (await readJson(req)) as AgentChannelPostCard;
        if (
          !body.agentId ||
          !body.conversationId ||
          !("threadRootId" in body) ||
          typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length < 8 ||
          !body.card?.summary
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (!state.agents.some((a) => a.id === body.agentId)) {
          return json(res, 404, { error: { code: "agent_not_found" } });
        }
        const same = state.cards.find(
          (c) => c.agentId === body.agentId && c.idempotencyKey === body.idempotencyKey,
        );
        if (same) return json(res, 200, { messageId: same.messageId, created: false, version: same.version });
        const stored: StoredCard = { ...body, messageId: randomUUID(), version: 1 };
        state.cards.push(stored);
        return json(res, 201, { messageId: stored.messageId, created: true, version: 1 });
      }
      const cardMatch = /^\/cards\/([^/]+)$/u.exec(route);
      if (req.method === "PATCH" && cardMatch?.[1]) {
        const messageId = decodeURIComponent(cardMatch[1]);
        const body = (await readJson(req)) as AgentChannelPatchCard;
        const card = state.cards.find((c) => c.messageId === messageId);
        const status = !card
          ? 404
          : card.agentId !== body.agentId
            ? 403
            : card.version !== body.patch?.expectedVersion
              ? 409
              : 200;
        state.cardPatches.push({ ...body, messageId, status });
        if (status === 404) return json(res, 404, { error: { code: "card_not_found" } });
        if (status === 403) return json(res, 403, { error: { code: "not_card_author" } });
        if (status === 409) return json(res, 409, { error: { code: "card_version_conflict" } });
        const c = card as StoredCard;
        c.version++;
        return json(res, 200, { messageId, version: c.version });
      }
      if (req.method === "POST" && route === "/board/read") {
        const body = (await readJson(req)) as { eventId?: string; agentId?: string };
        if (!body.eventId || !body.agentId) return json(res, 400, { error: { code: "bad_request" } });
        state.boardReads.push(body.eventId);
        const turnCard = state.boardTurnCards.get(body.eventId);
        const card = state.boardCards.find((c) => c.messageId === turnCard);
        return json(res, 200, {
          board: {
            conversationId: FAKE_BOARD_ID,
            templateId: null,
            prefix: null,
            namingRule: null,
            fields: [],
            version: 1,
          },
          columns: FAKE_BOARD_COLUMNS,
          card: card ? boardCardOut(card) : null,
        });
      }
      if (req.method === "POST" && route === "/board/cards") {
        const body = (await readJson(req)) as AgentChannelBoardCreateCard;
        if (
          !body.eventId ||
          !body.agentId ||
          typeof body.idempotencyKey !== "string" ||
          !(body.title || body.description)
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const same = state.boardCards.find(
          (c) => c.agentId === body.agentId && c.idempotencyKey === body.idempotencyKey,
        );
        if (same) return json(res, 200, { card: boardCardOut(same) });
        const stored: StoredBoardCard = {
          ...body,
          messageId: randomUUID(),
          columnId: body.columnId ?? (FAKE_BOARD_COLUMNS[0] as { id: string }).id,
          waitingOn: body.waitingOn ?? "none",
          version: 1,
        };
        state.boardCards.push(stored);
        return json(res, 201, { card: boardCardOut(stored) });
      }
      const boardCardMatch = /^\/board\/cards\/([^/]+)$/u.exec(route);
      if (req.method === "PATCH" && boardCardMatch?.[1]) {
        const messageId = decodeURIComponent(boardCardMatch[1]);
        const body = (await readJson(req)) as AgentChannelBoardPatchCard & Record<string, unknown>;
        const card = state.boardCards.find((c) => c.messageId === messageId);
        const text = ["title", "description", "fields"].some((k) => k in body);
        const status = text ? 403 : !card ? 404 : card.version !== body.expectedVersion ? 409 : 200;
        state.boardPatches.push({ ...body, messageId, status });
        if (status === 403) return json(res, 403, { error: { code: "not_author" } });
        if (status === 404) return json(res, 404, { error: { code: "card_not_in_board" } });
        if (status === 409) return json(res, 409, { error: { code: "board_card_version_conflict" } });
        const c = card as StoredBoardCard;
        if (body.move) c.columnId = body.move.columnId;
        if (body.waitingOn) c.waitingOn = body.waitingOn;
        c.version++;
        return json(res, 200, { card: boardCardOut(c) });
      }
      if (req.method === "POST" && route === "/typing") {
        state.typing.push((await readJson(req)) as AgentChannelTyping);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/runtime") {
        state.runtimeReports.push((await readJson(req)) as AgentChannelRuntimeReport);
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
    get memoryFileStore() {
      return state.memoryFileStore;
    },
    get memoryCalls() {
      return state.memoryCalls;
    },
    get memoryRefusals() {
      return state.memoryRefusals;
    },
    get cards() {
      return state.cards;
    },
    get cardPatches() {
      return state.cardPatches;
    },
    get boardCards() {
      return state.boardCards;
    },
    get boardPatches() {
      return state.boardPatches;
    },
    get boardReads() {
      return state.boardReads;
    },
    get boardTurnCards() {
      return state.boardTurnCards;
    },
    get mcpServers() {
      return state.mcpServers;
    },
    set mcpServers(value: CellMcpServer[]) {
      state.mcpServers = value;
    },
    get mcpProbes() {
      return state.mcpProbes;
    },
    get cellReads() {
      return state.cellReads;
    },
    get plugins() {
      return state.plugins;
    },
    set plugins(value: CellApprovedPlugin[]) {
      state.plugins = value;
    },
    get pluginReports() {
      return state.pluginReports;
    },
    get verifyCalls() {
      return state.verifyCalls;
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
    get runtimeReports() {
      return state.runtimeReports;
    },
    get subscriptions() {
      return state.subscriptions;
    },
    get authFailures() {
      return state.authFailures;
    },
    publish(type, data) {
      // Like the API: an install / uninstall command moves its row (installing / uninstalling) before it is sent.
      const row = state.plugins.find((p) => p.pluginRowId === data.pluginRowId);
      if (row && type === "plugin.install.v1") row.status = "installing";
      if (row && type === "plugin.uninstall.v1") row.status = "uninstalling";
      if (row && typeof data.flowId === "string" && type.startsWith("plugin.")) {
        pluginFlows.set(row.pluginRowId, data.flowId);
      }
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
      if (next.mcpServers) state.mcpServers = next.mcpServers;
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
