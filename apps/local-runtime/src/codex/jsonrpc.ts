// Minimal JSON-RPC peer over newline-delimited JSON on a child process's stdio, as spoken by
// `codex app-server` (JSON-RPC 2.0 semantics, no `jsonrpc` header on the wire).

import type { Readable, Writable } from 'node:stream';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface JsonRpcHandlers {
  onNotification(n: JsonRpcNotification): void;
  /** Server-initiated request; resolve with the result or throw a JsonRpcError. */
  onRequest(r: JsonRpcRequest): Promise<unknown>;
  onClose?(err?: Error): void;
  /** Raw line hook (fixture recording). */
  onLine?(direction: 'in' | 'out', message: unknown): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout | null;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonRpcHandlers,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    input.on('end', () => this.close());
    input.on('error', (err) => this.close(err));
    output.on('error', (err) => this.close(err));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex app-server connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`codex request ${method} timed out`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err ?? new Error('codex app-server connection closed'));
    }
    this.pending.clear();
    this.handlers.onClose?.(err);
  }

  private write(msg: unknown): void {
    if (this.closed) return;
    this.handlers.onLine?.('out', msg);
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not protocol output
    }
    this.handlers.onLine?.('in', msg);
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (hasId && method) {
      const id = msg.id as JsonRpcId;
      this.handlers
        .onRequest({ id, method, params: msg.params })
        .then((result) => this.write({ id, result: result ?? null }))
        .catch((err: unknown) => {
          const code = err instanceof JsonRpcError ? err.code : -32603;
          this.write({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
        });
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as JsonRpcId);
      if (!p) return;
      this.pending.delete(msg.id as JsonRpcId);
      if (p.timer) clearTimeout(p.timer);
      const error = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (error) p.reject(new JsonRpcError(error.message ?? 'codex error', error.code ?? -32000, error.data));
      else p.resolve(msg.result);
      return;
    }
    if (method) this.handlers.onNotification({ method, params: msg.params });
  }
}
