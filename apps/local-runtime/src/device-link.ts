// Device Link client: one OUTBOUND WebSocket to `${serverUrl}/runtime/ws` (Bearer device token).
// The daemon never listens on a TCP port. Frames produced while offline go to an in-memory append
// log and are replayed, in order, after the next successful connect.

import WebSocket from 'ws';
import { type Logger, errorMessage, silentLogger } from './logger.js';
import { type CommandFrame, CommandFrameSchema, type DeviceFrame } from './protocol.js';

export interface DeviceLinkOptions {
  url: string;
  token: string;
  /** Frames sent first on every (re)connect, before the offline log is replayed. */
  onOpenFrames: () => Promise<DeviceFrame[]> | DeviceFrame[];
  onCommand: (command: CommandFrame) => void;
  logger?: Logger;
  heartbeatMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  maxOfflineFrames?: number;
  /** Injection point for tests. */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

export class DeviceLink {
  private ws: WebSocket | null = null;
  private readonly offline: DeviceFrame[] = [];
  private attempts = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private readonly log: Logger;
  droppedFrames = 0;

  constructor(private readonly opts: DeviceLinkOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  get connected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  get queuedFrames(): number {
    return this.offline.length;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close(1000, 'daemon stopping');
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1000).unref();
      });
    }
  }

  /**
   * Send a frame now, or append it to the offline log. Ephemeral frames (heartbeats,
   * `assistant.delta`) are dropped instead of logged.
   */
  send(frame: DeviceFrame): void {
    if (this.connected && this.trySend(frame)) return;
    if (isEphemeral(frame)) return;
    this.offline.push(frame);
    const max = this.opts.maxOfflineFrames ?? 10_000;
    if (this.offline.length > max) {
      this.offline.shift();
      this.droppedFrames++;
      if (this.droppedFrames === 1 || this.droppedFrames % 1000 === 0) {
        this.log.warn('offline log full; dropping oldest frames', { dropped: this.droppedFrames });
      }
    }
  }

  private trySend(frame: DeviceFrame): boolean {
    try {
      this.ws?.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.log.warn('send failed', { error: errorMessage(err) });
      return false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const headers = { Authorization: `Bearer ${this.opts.token}` };
    let ws: WebSocket;
    try {
      ws = this.opts.createSocket
        ? this.opts.createSocket(this.opts.url, headers)
        : new WebSocket(this.opts.url, { headers, handshakeTimeout: 10_000, perMessageDeflate: false });
    } catch (err) {
      this.log.error('cannot create websocket', { error: errorMessage(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      void this.onOpen(ws);
    });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) this.log.error('device token rejected by server', { status });
      else this.log.warn('unexpected handshake response', { status });
      ws.terminate();
    });
    ws.on('error', (err) => this.log.debug('websocket error', { error: errorMessage(err) }));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      this.ws = null;
      this.stopHeartbeat();
      if (wasReady) this.log.info('disconnected from server', { code });
      this.scheduleReconnect();
    });
  }

  private async onOpen(ws: WebSocket): Promise<void> {
    try {
      const initial = await this.opts.onOpenFrames();
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      for (const frame of initial) ws.send(JSON.stringify(frame));
      // Replay the offline log in order. Frames that fail stay at the head of the log.
      while (this.offline.length > 0 && ws.readyState === WebSocket.OPEN) {
        const frame = this.offline[0] as DeviceFrame;
        ws.send(JSON.stringify(frame));
        this.offline.shift();
      }
      this.ready = true;
      this.attempts = 0;
      this.startHeartbeat();
      this.log.info('connected to server');
    } catch (err) {
      this.log.error('handshake failed', { error: errorMessage(err) });
      ws.close(1011, 'handshake failed');
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.log.warn('ignoring non-JSON frame');
      return;
    }
    const type = (parsed as { type?: unknown } | null)?.type;
    if (type !== 'command') {
      this.log.debug('ignoring server frame', { type: String(type) });
      return;
    }
    const cmd = CommandFrameSchema.safeParse(parsed);
    if (!cmd.success) {
      const id = (parsed as { id?: unknown }).id;
      this.log.warn('invalid command frame', { id: typeof id === 'string' ? id : undefined });
      if (typeof id === 'string') this.send({ type: 'ack', commandId: id, ok: false, error: 'invalid command frame' });
      return;
    }
    this.opts.onCommand(cmd.data);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const min = this.opts.backoffMinMs ?? 500;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempts);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: 'heartbeat' }), this.opts.heartbeatMs ?? 15_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function isEphemeral(frame: DeviceFrame): boolean {
  if (frame.type === 'heartbeat') return true;
  return frame.type === 'event' && frame.event.type === 'assistant.delta';
}
