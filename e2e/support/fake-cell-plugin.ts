/**
 * Fake OpenClaw cell plugin — a test double that speaks the Agent Channel API v1 exactly like
 * `apps/openclaw-channel` does (see 01-AGENT-CHANNEL-API.md), without OpenClaw or a model.
 * Dependency-free (Node 24 global fetch + WebSocket) so API integration tests, Playwright specs and CI
 * scripts can all reuse it.
 *
 *   const plugin = new FakeCellPlugin({ apiUrl, token, autoAck: true, autoReply: true });
 *   await plugin.start();            // GET /cell, acks bots, opens /ws, subscribes live
 *   await plugin.waitFor((e) => e.type === "agent.mention.v1");
 *   await plugin.stop();
 */

export interface FakeCellEvent {
  seq: number;
  type: string;
  data: Record<string, unknown> & { seq: number; type?: string };
}

export interface FakeCellAgent {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  modelRef: string;
  instructions: string;
}

export interface FakeCellSnapshot {
  protocolVersion: number;
  cellId: string;
  organizationId: string;
  topic: string;
  lastSeq: number;
  agents: FakeCellAgent[];
  providers: Array<{
    id: string;
    kind: string;
    api: string;
    baseUrl: string;
    apiKey: string | null;
    models: string[];
  }>;
  subscriptions?: Array<{ id: string; kind: string; runtimeProvider: string; models: string[] }>;
  /** Org-enabled MCP servers with their header VALUES (cell token only, 03.1-10). */
  mcpServers?: Array<{
    id: string;
    safeName: string;
    transport: string;
    url: string;
    headers: Array<{ name: string; envName: string; value: string }>;
    tools: string[];
  }>;
}

export interface MentionPayload {
  eventId: string;
  seq: number;
  agent: { id: string; handle: string; displayName: string };
  conversation: { id: string; kind: string; name: string | null };
  thread: { rootMessageId: string };
  message: { id: string; text: string; author: { kind: string; id: string; displayName: string } };
  threadHistory: Array<{
    id: string;
    author: { kind: string; id: string; displayName: string };
    text: string;
  }>;
  roster: Array<{ kind: string; id: string; displayName: string }>;
  /** What this bot may do for this human on this turn (03.1-03); absent = no tools (fail closed). */
  turn?: {
    tools: string[];
    memory?: Array<{ id: string; text: string; createdAt: string }>;
    now?: { iso: string; timeZone: string; local: string } | null;
    /** AI chat deliveries (06-10): tools withheld from this turn and why. */
    withheld?: Array<{ tool: string; reason: string }>;
  };
}

/** Subscription sign-in emulation (provider.auth.* commands), against a fake device-auth server. */
export interface FakeDeviceAuthOptions {
  /** Base URL of e2e/support/fake-device-auth-server.ts (stands in for https://auth.openai.com). */
  serverUrl: string;
  /** Plugin instance id sent as `reporterId` (default: random). */
  reporterId?: string;
  /** Poll interval of the token endpoint (default 200 ms). */
  pollMs?: number;
}

export interface FakeCellOptions {
  apiUrl: string;
  token: string;
  /** Ack every non-disabled bot as `ready` on start and on each `cell.config.changed`. */
  autoAck?: boolean;
  /**
   * Answer every mention with `replyText(mention)` (default: an identity-aware deterministic reply), or with the
   * simulated tool calls when the message carries `[[call …]]` directives (`simulateToolCalls`), followed by the
   * turn-tools suffix (`turnToolsSuffix`) and the turn-context suffix (`turnContextSuffix`).
   */
  autoReply?: boolean;
  replyText?: (m: MentionPayload) => string;
  /** Resume cursor; omit to start live. */
  afterSeq?: number;
  /** Handle `provider.auth.start|cancel|revoke` like apps/openclaw-channel does (device-code sign-in). */
  deviceAuth?: FakeDeviceAuthOptions;
  /**
   * Simulate the marketplace executor (03.1-12): `plugin.install.v1` reports `installing`, then `installed` with
   * `declaredTools = pluginTools["<package>@<version>"] ?? pluginTools[package] ?? []`; `plugin.uninstall.v1` reports `uninstalled`. Unset = the
   * plugin events are ignored (an older cell).
   */
  pluginTools?: Record<string, string[]>;
  /** Delay before each plugin report and each probe, so a browser can see `Installing` / `Probing` (default 1200 ms). */
  stepMs?: number;
  /**
   * Simulate the MCP probe (03.1-10): on `mcp.probe`, find the server in `GET /cell`, rewrite its `host:port`
   * through this map (e.g. `fake-mcp:4291` → `127.0.0.1:4291`), run `initialize` + `tools/list` over streamable
   * HTTP with the snapshot's headers and POST `/mcp/probe-results`. Unset = probes are ignored.
   */
  hostMap?: Record<string, string>;
}

/**
 * Appended to every simulated reply: ` [turn tools: <sorted turn.tools joined by commas> | none]`. Lets a
 * browser spec see which tools the API gave the bot for that very turn (a policy change bites next turn).
 */
export function turnToolsSuffix(m: MentionPayload): string {
  const tools = [...(m.turn?.tools ?? [])].sort();
  return ` [turn tools: ${tools.length > 0 ? tools.join(",") : "none"}]`;
}

/**
 * Appended after the turn tools on every simulated reply: ` [memory: <turn.memory.length>] [now: <zone> | none]`.
 * Lets a browser spec see the bot's notes about the asker (D-10) and the asker's time zone (D-12) per turn.
 */
export function turnContextSuffix(m: MentionPayload): string {
  return ` [memory: ${m.turn?.memory?.length ?? 0}] [now: ${m.turn?.now?.timeZone ?? "none"}]`;
}

/** `[[call <tool> <json>]]` directives in a message (same grammar as infra/fake-model), in order. */
export function parseCallDirectives(text: string): Array<{ tool: string; args: Record<string, unknown> }> {
  const out: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const m of text.matchAll(/\[\[call\s+([A-Za-z0-9_.:-]+)\s+(?=\{)/gu)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1 || !text.startsWith("]]", end)) continue;
    try {
      const args = JSON.parse(text.slice(start, end)) as unknown;
      if (args && typeof args === "object" && !Array.isArray(args) && m[1]) {
        out.push({ tool: m[1], args: args as Record<string, unknown> });
      }
    } catch {
      /* not a directive */
    }
  }
  return out;
}

/** Deterministic, identity-aware reply (mirrors infra/fake-model): proves structured attribution travelled. */
export function identityReply(m: MentionPayload): string {
  const people = [
    ...new Set(
      [...m.threadHistory.map((h) => h.author), m.message.author]
        .filter((a) => a.kind === "user")
        .map((a) => a.displayName),
    ),
  ].sort();
  return `Asked by ${m.message.author.displayName} (${m.message.author.id}). Thread participants: ${people.join(", ")}.`;
}

export class FakeCellPlugin {
  readonly events: FakeCellEvent[] = [];
  readonly replies: Array<{ messageId: string; created: boolean; mention: MentionPayload }> = [];
  /** Every `POST /tool-calls` this fake cell made (06-12: a withheld tool never reaches the gate). */
  readonly toolCallRequests: Array<{ eventId: string; tool: string }> = [];
  snapshot: FakeCellSnapshot | null = null;
  lastSeq = 0;
  /** Subscription credentials this fake cell "holds" (provider → account), like OpenClaw's auth store. */
  readonly credentials = new Map<string, { email: string | null; planType: string | null }>();
  /** Every `POST /provider-auth` report sent, with the HTTP status it got. */
  readonly authReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  readonly revoked: string[] = [];
  /** Every `POST /plugins/report` and `POST /mcp/probe-results` sent, with the HTTP status it got. */
  readonly pluginReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  readonly probeReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  private readonly flows = new Map<string, AbortController>();
  private readonly reporterId = `fake-${Math.random().toString(36).slice(2, 12)}`;
  private ws: WebSocket | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly opts: FakeCellOptions) {}

  private get base() {
    return `${this.opts.apiUrl.replace(/\/+$/, "")}/agent-channel/v1`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async fetchCell(): Promise<FakeCellSnapshot> {
    const res = await this.request<FakeCellSnapshot>("GET", "/cell");
    if (res.status !== 200) throw new Error(`GET /cell → ${res.status} ${JSON.stringify(res.body)}`);
    this.snapshot = res.body;
    return res.body;
  }

  /** Reports `ready` for every bot that is not disabled and not ready yet (what the real reconciler does). */
  async ackAll(): Promise<number> {
    const cell = await this.fetchCell();
    let n = 0;
    for (const a of cell.agents) {
      if (a.status === "disabled" || a.status === "ready") continue;
      const res = await this.request("POST", `/agents/${a.id}/status`, { status: "ready" });
      if (res.status === 200) n++;
    }
    return n;
  }

  async reply(m: MentionPayload, text: string) {
    // DMs and AI chats are flat (D-04, P-10): like apps/openclaw-channel, reply and type with no thread root.
    const flat = m.conversation.kind === "dm" || m.conversation.kind === "ai_chat";
    const threadRootMessageId = flat ? null : m.thread.rootMessageId;
    await this.request("POST", "/typing", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId,
    });
    const res = await this.request<{ messageId: string; created: boolean }>("POST", "/messages", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId,
      inReplyToMessageId: m.message.id,
      // The trigger (like apps/openclaw-channel): the delivered turn this reply answers.
      eventId: m.eventId,
      text,
      idempotencyKey: `evt:${m.eventId}`,
    });
    if (res.status !== 200) throw new Error(`POST /messages → ${res.status} ${JSON.stringify(res.body)}`);
    this.replies.push({ ...res.body, mention: m });
    return res.body;
  }

  /**
   * Posts a typed Agent Card (06-13, `POST /agent-channel/v1/cards`) as `input.agentId`, like the real plugin's card
   * tool: the card lands where the agent may post, for a delivered turn (`eventId`, or the message it was delivered
   * for); 201 when created, 200 on an idempotent retry, 403 `no_trigger` without a turn.
   */
  async postCard(input: {
    agentId: string;
    conversationId: string;
    threadRootId: string | null;
    inReplyToMessageId?: string;
    eventId?: string;
    idempotencyKey: string;
    card: Record<string, unknown>;
  }): Promise<{ messageId: string; version: number }> {
    const res = await this.request<{ messageId: string; version: number }>("POST", "/cards", input);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`POST /cards → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { messageId: res.body.messageId, version: res.body.version };
  }

  /** Updates one of its cards in place (`PATCH /agent-channel/v1/cards/:messageId`, optimistic version). */
  async patchCard(
    messageId: string,
    body: { agentId: string; patch: Record<string, unknown> & { expectedVersion: number } },
  ): Promise<{ version: number }> {
    const res = await this.request<{ version: number }>("PATCH", `/cards/${messageId}`, body);
    if (res.status !== 200) throw new Error(`PATCH /cards → ${res.status} ${JSON.stringify(res.body)}`);
    return { version: res.body.version };
  }

  async start(): Promise<void> {
    if (this.opts.autoAck) await this.ackAll();
    else await this.fetchCell();
    await this.connect(this.opts.afterSeq);
  }

  connect(afterSeq?: number): Promise<void> {
    const url = `${this.base.replace(/^http/, "ws")}/ws`;
    // Node's WebSocket (undici) accepts non-standard headers; browsers never can (the API refuses Origin).
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.opts.token}` } } as never);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onerror = () => reject(new Error("cell WebSocket failed"));
      ws.onopen = () => {
        const topic = this.snapshot?.topic;
        if (!topic) return reject(new Error("call fetchCell() first"));
        ws.send(JSON.stringify({ op: "sub", topic, ...(afterSeq !== undefined ? { afterSeq } : {}) }));
      };
      ws.onmessage = (msg) => {
        const frame = JSON.parse(String(msg.data)) as {
          op: string;
          seq?: number;
          type?: string;
          data?: FakeCellEvent["data"];
          lastSeq?: number;
        };
        if (frame.op === "subscribed") {
          this.lastSeq = Math.max(this.lastSeq, frame.lastSeq ?? 0);
          resolve();
        } else if (frame.op === "ev" && frame.seq && frame.type && frame.data) {
          this.lastSeq = frame.seq;
          this.events.push({ seq: frame.seq, type: frame.type, data: frame.data });
          void this.onEvent(frame.type, frame.data).finally(() => this.notify());
        }
        this.notify();
      };
    });
  }

  private async onEvent(type: string, data: FakeCellEvent["data"]) {
    try {
      if (type === "cell.config.changed" && this.opts.autoAck) await this.ackAll();
      if (type === "agent.mention.v1" && this.opts.autoReply) {
        const m = data as unknown as MentionPayload;
        const calls = parseCallDirectives(m.message.text);
        const body =
          calls.length > 0
            ? (await this.simulateToolCalls(m, calls)).join("\n")
            : (this.opts.replyText ?? identityReply)(m);
        await this.reply(m, body + turnToolsSuffix(m) + turnContextSuffix(m));
      }
      if (this.opts.pluginTools && (type === "plugin.install.v1" || type === "plugin.uninstall.v1")) {
        await this.runPluginFlow(type, data);
      }
      if (this.opts.hostMap && type === "mcp.probe") await this.runMcpProbe(data);
      if (this.opts.deviceAuth) {
        if (type === "provider.auth.start") void this.runDeviceFlow(data);
        if (type === "provider.auth.cancel") this.flows.get(String(data.flowId))?.abort();
        if (type === "provider.auth.revoke") {
          this.credentials.delete(String(data.provider));
          this.revoked.push(String(data.provider));
        }
      }
    } catch (err) {
      console.error("fake cell plugin handler failed", err);
    }
  }

  /**
   * Simulates the cell running each `[[call <tool> <json>]]` of a mention, the way apps/openclaw-channel does:
   * a tool is offered only when it (or a name ending in `__<tool>`) is in `turn.tools`; `ocw_memory_save` posts
   * `{eventId, agentId, text}` to `/agent-channel/v1/memories`; `ocw_board_card` calls the board routes itself
   * (`boardCall`, 07.1-13: like memory, never `/tool-calls`); any other tool asks `/agent-channel/v1/tool-calls`
   * and, when allowed, reports a result. One line per call: `Tool <offered name>: allowed | denied (<reason>)`,
   * `Tool <name>: saved | created | moved | waiting set | read | not offered`.
   */
  async simulateToolCalls(
    m: MentionPayload,
    calls: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<string[]> {
    const lines: string[] = [];
    const offered = m.turn?.tools ?? [];
    let boardCreates = 0;
    for (const call of calls) {
      const name = offered.find((t) => t === call.tool || t.endsWith(`__${call.tool}`));
      if (!name) {
        // Like apps/openclaw-channel's "Tools withheld in this conversation" block (06-10): say why, for whom.
        const withheld = m.turn?.withheld?.find(
          (w) => w.tool === call.tool || w.tool.endsWith(`__${call.tool}`),
        );
        lines.push(
          withheld
            ? `Tool ${call.tool}: not available for ${m.message.author.displayName} (${withheld.reason})`
            : `Tool ${call.tool}: not offered`,
        );
        continue;
      }
      if (name === "ocw_memory_save") {
        const res = await this.request<{ error?: { code?: string } }>("POST", "/memories", {
          eventId: m.eventId,
          agentId: m.agent.id,
          text: typeof call.args.text === "string" ? call.args.text : "",
        });
        lines.push(
          res.status === 200
            ? `Tool ${call.tool}: saved`
            : `Tool ${call.tool}: denied (${res.body?.error?.code ?? res.status})`,
        );
        continue;
      }
      if (name === "ocw_board_card") {
        lines.push(`Tool ${call.tool}: ${await this.boardCall(m, call.args, ++boardCreates)}`);
        continue;
      }
      const params: { query?: string; url?: string } = {};
      if (typeof call.args.query === "string") params.query = call.args.query;
      if (typeof call.args.url === "string") params.url = call.args.url;
      this.toolCallRequests.push({ eventId: m.eventId, tool: name });
      const res = await this.request<{ callId?: string; allowed?: boolean; reason?: string | null }>(
        "POST",
        "/tool-calls",
        { eventId: m.eventId, agentId: m.agent.id, tool: name, params },
      );
      // The line names the tool the turn offered (`<safe>__echo` for an MCP tool), like the gate saw it.
      if (res.status !== 200 || !res.body.allowed || !res.body.callId) {
        lines.push(`Tool ${name}: denied (${res.body.reason ?? res.status})`);
        continue;
      }
      await this.request("POST", `/tool-calls/${res.body.callId}/result`, {
        status: "ok",
        resultCount: 0,
        durationMs: 1,
      });
      lines.push(`Tool ${name}: allowed`);
    }
    return lines;
  }

  /** Every board route call the simulated `ocw_board_card` made, with the status it got (07.1-13). */
  readonly boardRequests: Array<{ eventId: string; route: string; status: number }> = [];

  /**
   * `ocw_board_card` the way apps/openclaw-channel's board-tool.ts runs it (07.1-13): only the mention's event and agent
   * travel, never a conversation; a create is keyed `<eventId>:board:<n>`; a move or a waiting state reads the turn
   * thread's card version first (`POST /board/read`) and names it. Never card text on a change. Answers `created`,
   * `moved`, `waiting set`, `read` or `denied (<code>)`.
   */
  private async boardCall(m: MentionPayload, args: Record<string, unknown>, n: number): Promise<string> {
    const turn = { eventId: m.eventId, agentId: m.agent.id };
    type ErrorBody = { error?: { code?: string } };
    const call = async <T>(method: string, route: string, body: Record<string, unknown>) => {
      const res = await this.request<T & ErrorBody>(method, route, body);
      this.boardRequests.push({ eventId: m.eventId, route: `${method} ${route}`, status: res.status });
      return res;
    };
    const denied = (res: { status: number; body: ErrorBody | null }) =>
      `denied (${res.body?.error?.code ?? res.status})`;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (args.action === "create") {
      const res = await call<{ card: { messageId: string } }>("POST", "/board/cards", {
        ...turn,
        idempotencyKey: `${m.eventId}:board:${n}`,
        description: str(args.description) ?? "",
        ...(str(args.title) ? { title: str(args.title) } : {}),
        ...(str(args.columnId) ? { columnId: str(args.columnId) } : {}),
        ...(str(args.waitingOn) ? { waitingOn: str(args.waitingOn) } : {}),
      });
      return res.status === 201 || res.status === 200 ? "created" : denied(res);
    }
    const read = await call<{ card: { messageId: string; version: number } | null }>(
      "POST",
      "/board/read",
      turn,
    );
    if (read.status !== 200) return denied(read);
    if (args.action === "read") return "read";
    const card = read.body.card;
    if (!card) return "denied (not_a_card)";
    const change =
      args.action === "move"
        ? { move: { columnId: str(args.columnId) ?? "", afterCardId: str(args.afterCardId) ?? null } }
        : args.action === "set_waiting"
          ? { waitingOn: str(args.waitingOn) ?? "" }
          : null;
    if (!change) return "denied (unknown_action)";
    const res = await call("PATCH", `/board/cards/${card.messageId}`, {
      ...turn,
      expectedVersion: card.version,
      ...change,
    });
    if (res.status !== 200) return denied(res);
    return args.action === "move" ? "moved" : "waiting set";
  }

  private step() {
    return new Promise((r) => setTimeout(r, this.opts.stepMs ?? 1200));
  }

  /** The marketplace executor, simulated: no download, no OpenClaw; the API re-scores the report as usual. */
  private async runPluginFlow(type: string, data: FakeCellEvent["data"]) {
    const step = () => this.step();
    const report = async (body: Record<string, unknown>) => {
      const res = await this.request("POST", "/plugins/report", body);
      this.pluginReports.push({ status: res.status, body });
      this.notify();
      return res;
    };
    const flowId = String(data.flowId);
    const pluginRowId = String(data.pluginRowId);
    if (type === "plugin.uninstall.v1") {
      await step();
      await report({ flowId, pluginRowId, state: "uninstalled", pluginId: String(data.pluginId) });
      return;
    }
    const packageName = String(data.packageName);
    await step();
    await report({ flowId, pluginRowId, state: "installing" });
    await step();
    const tools =
      this.opts.pluginTools?.[`${packageName}@${String(data.version)}`] ??
      this.opts.pluginTools?.[packageName] ??
      [];
    await report({
      flowId,
      pluginRowId,
      state: "installed",
      pluginId: typeof data.expectedPluginId === "string" ? data.expectedPluginId : packageName,
      version: String(data.version),
      declaredTools: tools.map((name) => ({ name })),
    });
  }

  /** The MCP probe, simulated with plain JSON-RPC over fetch (the fake MCP answers single JSON responses). */
  private async runMcpProbe(data: FakeCellEvent["data"]) {
    const probeId = String(data.probeId);
    const serverId = String(data.serverId);
    await this.step();
    const cell = await this.fetchCell();
    const server = cell.mcpServers?.find((s) => s.id === serverId);
    const send = async (body: Record<string, unknown>) => {
      const res = await this.request("POST", "/mcp/probe-results", body);
      this.probeReports.push({ status: res.status, body });
      this.notify();
    };
    if (!server) {
      await send({ probeId, serverId, ok: false, error: "The cell does not know this MCP server." });
      return;
    }
    const url = new URL(server.url);
    const mapped = this.opts.hostMap?.[url.host];
    if (mapped) url.host = mapped;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const h of server.headers) headers[h.name] = h.value;
    let session: string | null = null;
    const rpc = async (id: number | null, method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
        redirect: "error",
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `The MCP server refused the credentials (HTTP ${res.status}). Check the header values.`,
        );
      }
      if (!res.ok && res.status !== 202) throw new Error(`The MCP server answered HTTP ${res.status}.`);
      session = res.headers.get("mcp-session-id") ?? session;
      const text = await res.text();
      return text ? (JSON.parse(text) as { result?: Record<string, unknown> }) : {};
    };
    try {
      await rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ocw-fake-cell", version: "1.0.0" },
      });
      await rpc(null, "notifications/initialized");
      const listed = await rpc(2, "tools/list");
      const tools = ((listed.result?.tools as Array<Record<string, unknown>> | undefined) ?? []).map((t) => ({
        name: String(t.name),
        ...(typeof t.title === "string" ? { title: t.title } : {}),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(t.annotations && typeof t.annotations === "object"
          ? {
              annotations: {
                readOnlyHint: (t.annotations as { readOnlyHint?: boolean }).readOnlyHint === true,
                destructiveHint: (t.annotations as { destructiveHint?: boolean }).destructiveHint === true,
              },
            }
          : {}),
      }));
      await send({ probeId, serverId, ok: true, tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await send({
        probeId,
        serverId,
        ok: false,
        error: /fetch failed/i.test(message) ? "Could not reach the MCP server." : message.slice(0, 300),
      });
    }
  }

  async reportAuth(body: Record<string, unknown>) {
    const res = await this.request("POST", "/provider-auth", {
      reporterId: this.opts.deviceAuth?.reporterId ?? this.reporterId,
      ...body,
    });
    this.authReports.push({ status: res.status, body });
    this.notify();
    return res;
  }

  /**
   * Mirrors apps/openclaw-channel/src/provider-auth.ts: request a code, report it, poll until the owner
   * approves (or denies / it expires / the admin cancels), exchange, report the account. Never logs codes.
   */
  private async runDeviceFlow(data: FakeCellEvent["data"]) {
    const da = this.opts.deviceAuth;
    if (!da) return;
    const flowId = String(data.flowId);
    const provider = String(data.provider);
    if (Date.parse(String(data.startBefore)) < Date.now()) return; // stale replay
    const abort = new AbortController();
    this.flows.set(flowId, abort);
    const post = async (path: string, body: Record<string, string>, form = false) => {
      const res = await fetch(`${da.serverUrl}${path}`, {
        method: "POST",
        headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: abort.signal,
      });
      return { status: res.status, json: (await res.json()) as Record<string, string> };
    };
    try {
      const code = await post("/api/accounts/deviceauth/usercode", { client_id: "fake" });
      const pending = await this.reportAuth({
        provider,
        flowId,
        state: "pending",
        verificationUrl: `${da.serverUrl}/codex/device`,
        userCode: code.json.user_code,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      if (pending.status !== 200) return; // claimed by another instance / closed
      for (;;) {
        await new Promise((r) => setTimeout(r, da.pollMs ?? 200));
        if (abort.signal.aborted) return;
        const poll = await post("/api/accounts/deviceauth/token", {
          device_auth_id: code.json.device_auth_id ?? "",
          user_code: code.json.user_code ?? "",
        });
        if (poll.status === 403) continue;
        if (poll.status !== 200) {
          const err =
            poll.json.error === "access_denied"
              ? "denied"
              : poll.json.error === "expired_token"
                ? "expired"
                : "failed";
          await this.reportAuth({
            provider,
            flowId,
            state: "error",
            error: { code: err, message: "device authorization failed" },
          });
          return;
        }
        const tokens = await post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            code: poll.json.authorization_code ?? "",
            code_verifier: poll.json.code_verifier ?? "",
          },
          true,
        );
        const claims = JSON.parse(
          Buffer.from((tokens.json.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8") || "{}",
        ) as { email?: string; "https://api.openai.com/auth"?: { chatgpt_plan_type?: string } };
        const account = {
          email: claims.email ?? null,
          planType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null,
        };
        this.credentials.set(provider, account);
        await this.reportAuth({ provider, flowId, state: "connected", account });
        return;
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        await this.reportAuth({
          provider,
          flowId,
          state: "error",
          error: { code: "failed", message: String(err).slice(0, 200) },
        });
      }
    } finally {
      this.flows.delete(flowId);
    }
  }

  private notify() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves with the first event matching `pred` (already received or future). */
  async waitFor(pred: (e: FakeCellEvent) => boolean, timeoutMs = 10_000): Promise<FakeCellEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`timed out waiting for cell event (got ${this.events.map((e) => e.type)})`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitUntil(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Debug snapshot for failing specs: socket state and the durable events seen so far. */
  debugState(): { readyState: number | null; lastSeq: number; events: string[] } {
    return {
      readyState: this.ws?.readyState ?? null,
      lastSeq: this.lastSeq,
      events: this.events.map((e) => `${e.seq}:${e.type}`),
    };
  }

  async stop(): Promise<void> {
    for (const f of this.flows.values()) f.abort();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((r) => {
      ws.onclose = () => r();
      ws.close();
      setTimeout(r, 1000);
    });
  }
}
