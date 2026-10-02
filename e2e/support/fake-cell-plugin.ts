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
}

export interface FakeCellOptions {
  apiUrl: string;
  token: string;
  /** Ack every non-disabled bot as `ready` on start and on each `cell.config.changed`. */
  autoAck?: boolean;
  /** Answer every mention with `replyText(mention)` (default: an identity-aware deterministic reply). */
  autoReply?: boolean;
  replyText?: (m: MentionPayload) => string;
  /** Resume cursor; omit to start live. */
  afterSeq?: number;
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
  snapshot: FakeCellSnapshot | null = null;
  lastSeq = 0;
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
    await this.request("POST", "/typing", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId: m.thread.rootMessageId,
    });
    const res = await this.request<{ messageId: string; created: boolean }>("POST", "/messages", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId: m.thread.rootMessageId,
      inReplyToMessageId: m.message.id,
      text,
      idempotencyKey: `evt:${m.eventId}`,
    });
    if (res.status !== 200) throw new Error(`POST /messages → ${res.status} ${JSON.stringify(res.body)}`);
    this.replies.push({ ...res.body, mention: m });
    return res.body;
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
        await this.reply(m, (this.opts.replyText ?? identityReply)(m));
      }
    } catch (err) {
      console.error("fake cell plugin handler failed", err);
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

  async stop(): Promise<void> {
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
