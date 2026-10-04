import {
  ClientFrame,
  type DurableFrame,
  type EphemeralFrame,
  PRESENCE_CLIENT_THROTTLE_MS,
  type PresenceState,
  ServerFrame,
  WS_AUTH_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from "@ocw/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { backoffDelay } from "./backoff";
import { applyPresenceFrame, type PresenceSnapshot } from "./presence";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionState {
  status: ConnectionStatus;
  attempt: number;
  lastError: string | null;
}

export type TopicFrame = DurableFrame | EphemeralFrame;
export type TopicListener = (frame: TopicFrame) => void;

/** Minimal WebSocket surface shared by the browser global and the `ws` package. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface RealtimeClientOptions {
  url: string;
  /** Injected constructor (browser global by default; pass `ws` in Node). */
  WebSocket?: WebSocketCtor;
  pingIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Called for `err` frames (e.g. forbidden topic). */
  onError?: (code: string, topic?: string, message?: string) => void;
  /**
   * Short-lived access JWT source, awaited before every (re)connect. The token travels as the
   * `ocw.auth.<jwt>` Sec-WebSocket-Protocol entry (never in the URL). A rejection carrying `status: 401`
   * means signed out and stops the client; any other rejection counts as a failed attempt (backoff).
   */
  getToken?: (opts: { force: boolean }) => Promise<string>;
}

interface TopicState {
  listeners: Set<TopicListener>;
  lastSeq: number;
  subscribed: boolean;
  onResync: Set<() => void>;
  /** A replay is in flight because we observed a gap. */
  replaying: boolean;
  /** Listeners that show this conversation (RT-04): while > 0 the `sub` carries `presence: true`. */
  presence: number;
}

const OPEN = 1;

/**
 * One socket, many topics. Durable frames are de-duplicated by (topic, seq) and delivered in order; a gap
 * (seq > lastSeq + 1) triggers a re-subscribe with afterSeq = lastSeq so the server replays what is missing.
 * On reconnect every topic is re-subscribed with its lastSeq (resume).
 */
export class RealtimeClient {
  readonly status: StoreApi<ConnectionState>;
  /** Who is here now per subscribed `conv`/`ws` topic (RT-04): topic → conn → member. */
  readonly presence: StoreApi<PresenceSnapshot>;
  private readonly opts: Required<Omit<RealtimeClientOptions, "onError" | "WebSocket" | "getToken">> &
    Pick<RealtimeClientOptions, "onError" | "getToken">;
  private readonly Ctor: WebSocketCtor;
  private ws: WebSocketLike | null = null;
  private topics = new Map<string, TopicState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  /** Bumped on every open() and close(): a token that resolves for an older attempt is ignored. */
  private generation = 0;
  /** One forced token refresh per 4401; re-armed by a successful subscribe. */
  private authRetried = false;
  /** RT-04 away: the state this tab wants to show, and the last one the current socket was told. */
  private desiredPresence: PresenceState = "online";
  private sentPresence: PresenceState = "online";
  private presenceSentAt = Number.NEGATIVE_INFINITY;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeClientOptions) {
    const Ctor = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error("No WebSocket implementation available; pass options.WebSocket");
    this.Ctor = Ctor;
    this.opts = {
      url: options.url,
      pingIntervalMs: options.pingIntervalMs ?? 25_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      onError: options.onError,
      getToken: options.getToken,
    };
    this.status = createStore<ConnectionState>(() => ({ status: "idle", attempt: 0, lastError: null }));
    this.presence = createStore<PresenceSnapshot>(() => ({ topics: {} }));
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "client closed");
    for (const t of this.topics.values()) t.subscribed = false;
    this.clearPresence();
    this.status.setState({ status: "closed" });
  }

  lastSeq(topic: string): number {
    return this.topics.get(topic)?.lastSeq ?? 0;
  }

  /**
   * Subscribe to a topic. `afterSeq` is the seq of the snapshot you already hold (from the REST response);
   * events after it are replayed. `presence: true` marks a listener that shows the conversation: the user counts
   * as "here" and `client.presence` tracks the topic while at least one such listener is subscribed (background
   * watchers leave it out). Returns an unsubscribe function.
   */
  subscribe(
    topic: string,
    listener: TopicListener,
    opts: { afterSeq?: number; onResync?: () => void; presence?: boolean } = {},
  ): () => void {
    let state = this.topics.get(topic);
    if (!state) {
      state = {
        listeners: new Set(),
        lastSeq: opts.afterSeq ?? 0,
        subscribed: false,
        onResync: new Set(),
        replaying: false,
        presence: 0,
      };
      this.topics.set(topic, state);
    } else if (opts.afterSeq !== undefined && opts.afterSeq > state.lastSeq) {
      state.lastSeq = opts.afterSeq;
    }
    state.listeners.add(listener);
    if (opts.onResync) state.onResync.add(opts.onResync);
    const becamePresent = opts.presence === true && state.presence++ === 0;
    // Not subscribed yet, or already subscribed without presence: (re-)send the sub with the current flag.
    if (!state.subscribed || becamePresent) this.sendSub(topic);

    return () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.listeners.delete(listener);
      if (opts.onResync) s.onResync.delete(opts.onResync);
      const leftPresence = opts.presence === true && --s.presence === 0;
      if (s.listeners.size === 0) {
        this.topics.delete(topic);
        this.send({ op: "unsub", topic });
        this.dropPresence(topic);
      } else if (leftPresence) {
        // Background listeners remain: keep the stream, stop being "here".
        this.dropPresence(topic);
        if (s.subscribed) this.sendSub(topic);
      }
    };
  }

  /** Reset the cursor for a topic after refetching its snapshot (e.g. after `resync`). */
  setLastSeq(topic: string, seq: number): void {
    const s = this.topics.get(topic);
    if (!s) return;
    s.lastSeq = seq;
    this.sendSub(topic);
  }

  sendEphemeral(topic: string, type: string, data: unknown): void {
    this.send({ op: "eph", topic, type, data });
  }

  /**
   * This tab's own state in every conversation it shows (RT-04, D-04). Sent on the leading edge when it differs
   * from what the socket was last told; changes inside PRESENCE_CLIENT_THROTTLE_MS collapse into one trailing send
   * of the latest state. While disconnected it is only remembered: the next connection reports `away` before
   * re-subscribing (a new server connection starts online).
   */
  setPresence(state: PresenceState): void {
    this.desiredPresence = state;
    if (this.presenceTimer) return; // the trailing send picks up the latest state
    const wait = this.presenceSentAt + PRESENCE_CLIENT_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      this.flushPresence();
      return;
    }
    if (state === this.sentPresence) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, wait);
  }

  // ---- internals ----

  /** `force` bypasses the token cache (after the server closed the socket with 4401). */
  private open({ force }: { force: boolean } = { force: false }): void {
    const prev = this.status.getState();
    this.status.setState({ status: prev.attempt > 0 ? "reconnecting" : "connecting" });
    const generation = ++this.generation;
    const getToken = this.opts.getToken;
    if (!getToken) {
      this.construct();
      return;
    }
    getToken({ force }).then(
      (token) => {
        if (this.stopped || generation !== this.generation) return;
        this.construct([WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`]);
      },
      (err: unknown) => {
        if (this.stopped || generation !== this.generation) return;
        if ((err as { status?: unknown } | null)?.status === 401) {
          // Signed out: there is no session to fetch a token for.
          this.stopped = true;
          this.status.setState({ status: "closed", lastError: "unauthorized" });
          return;
        }
        this.status.setState({ lastError: "token unavailable" });
        this.scheduleReconnect();
      },
    );
  }

  private construct(protocols?: string[]): void {
    let ws: WebSocketLike;
    try {
      ws = protocols ? new this.Ctor(this.opts.url, protocols) : new this.Ctor(this.opts.url);
    } catch (err) {
      this.status.setState({ lastError: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.status.setState({ status: "open", attempt: 0, lastError: null });
      // A new server connection starts online: report away first, so every join below is stored as away.
      this.sentPresence = "online";
      if (this.desiredPresence === "away") this.flushPresence();
      for (const topic of this.topics.keys()) this.sendSub(topic);
      this.pingTimer = setInterval(() => this.send({ op: "ping" }), this.opts.pingIntervalMs);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      this.status.setState({ lastError: "socket error" });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      for (const t of this.topics.values()) {
        t.subscribed = false;
        t.replaying = false;
      }
      // Nobody is "here" for us while we are disconnected; the next `subscribed` brings a fresh snapshot.
      this.clearPresence();
      if (this.stopped) return;
      // 4401 = session revoked or token rejected. With a token source, refresh it once and reconnect: a
      // revoked session then fails the refresh with 401 and stops; a second 4401 before any successful
      // subscribe stops too. Without one, stop and let the app re-authenticate.
      if (ev.code === 4401 && this.opts.getToken && !this.authRetried) {
        this.authRetried = true;
        this.open({ force: true });
        return;
      }
      if (ev.code === 4401 || ev.code === 1008) {
        this.stopped = true;
        this.status.setState({ status: "closed", lastError: ev.reason ?? "unauthorized" });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const attempt = this.status.getState().attempt + 1;
    this.status.setState({ status: "reconnecting", attempt });
    const delay = backoffDelay(attempt - 1, this.opts.backoffBaseMs, this.opts.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  /** Sends the desired state when the current socket was told something else (no-op while disconnected). */
  private flushPresence(): void {
    const state = this.desiredPresence;
    if (state === this.sentPresence) return;
    if (!this.send({ op: "presence", state })) return;
    this.sentPresence = state;
    this.presenceSentAt = Date.now();
  }

  private dropPresence(topic: string): void {
    const p = this.presence.getState();
    if (!p.topics[topic]) return;
    const { [topic]: _gone, ...rest } = p.topics;
    this.presence.setState({ topics: rest }, true);
  }

  private clearPresence(): void {
    if (Object.keys(this.presence.getState().topics).length) this.presence.setState({ topics: {} });
  }

  private sendSub(topic: string): void {
    const s = this.topics.get(topic);
    if (!s) return;
    const frame: ClientFrame = {
      op: "sub",
      topic,
      afterSeq: s.lastSeq,
      ...(s.presence > 0 ? { presence: true } : {}),
    };
    if (this.send(frame)) s.subscribed = true;
  }

  private send(frame: ClientFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(ClientFrame.parse(frame)));
    return true;
  }

  private onMessage(raw: unknown): void {
    let parsed: ServerFrame;
    try {
      const text = typeof raw === "string" ? raw : String(raw);
      const r = ServerFrame.safeParse(JSON.parse(text));
      if (!r.success) return;
      parsed = r.data;
    } catch {
      return;
    }
    switch (parsed.op) {
      case "ev": {
        const s = this.topics.get(parsed.topic);
        if (!s) return;
        if (parsed.seq <= s.lastSeq) return; // duplicate
        if (parsed.seq > s.lastSeq + 1) {
          // Gap: ask the server to replay from our cursor; frames after the gap will be re-sent.
          if (!s.replaying) {
            s.replaying = true;
            this.sendSub(parsed.topic);
          }
          return;
        }
        s.lastSeq = parsed.seq;
        for (const l of s.listeners) l(parsed);
        return;
      }
      case "eph": {
        const s = this.topics.get(parsed.topic);
        if (!s) return;
        for (const l of s.listeners) l(parsed);
        return;
      }
      case "subscribed": {
        this.authRetried = false;
        const s = this.topics.get(parsed.topic);
        if (s) {
          s.subscribed = true;
          s.replaying = false;
        }
        return;
      }
      case "resync": {
        const s = this.topics.get(parsed.topic);
        if (!s) return;
        s.replaying = false;
        for (const cb of s.onResync) cb();
        return;
      }
      case "err":
        this.opts.onError?.(parsed.code, parsed.topic, parsed.message);
        return;
      case "presence": {
        if (!this.topics.get(parsed.topic)?.presence) return;
        const prev = this.presence.getState();
        const next = applyPresenceFrame(prev, parsed);
        if (next !== prev) this.presence.setState(next, true);
        return;
      }
      case "pong":
        return;
    }
  }
}
