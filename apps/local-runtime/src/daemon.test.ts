import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { controlRequest } from './control-socket.js';
import { Daemon } from './daemon.js';
import { silentLogger } from './logger.js';
import type { ApprovalDecision, CommandFrame, DeviceFrame, PromptPayload, RuntimeInfo, SessionEvent } from './protocol.js';
import type { AgentRuntime, EventSink, RuntimeCapabilities, StartSessionOptions } from './runtime.js';

// Fake credential assembled at runtime so secret scanners do not flag the test.
const LEAKY_KEY = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');

class FakeRuntime implements AgentRuntime {
  readonly id = 'claude-code' as const;
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: false,
    supportsResume: true,
    supportsPermissionModes: ['default', 'acceptEdits', 'plan'],
    supportsImages: false,
  };
  readonly started: StartSessionOptions[] = [];
  readonly resolved: Array<[string, ApprovalDecision]> = [];
  readonly prompts: PromptPayload[] = [];
  sinks = new Map<string, EventSink>();

  detect(): Promise<RuntimeInfo> {
    return Promise.resolve({ id: 'claude-code', installed: true, version: '9.9.9', loggedIn: true });
  }
  async start(o: StartSessionOptions, sink: EventSink): Promise<void> {
    this.started.push(o);
    this.sinks.set(o.sessionId, sink);
    sink({ type: 'session.state', status: 'idle' });
  }
  async prompt(sessionId: string, p: PromptPayload): Promise<void> {
    this.prompts.push(p);
    const sink = this.sinks.get(sessionId);
    const cwd = this.started.find((s) => s.sessionId === sessionId)?.cwd ?? '';
    sink?.({ type: 'prompt.started', promptId: p.promptId });
    sink?.({ type: 'assistant.message', messageId: 'm1', text: `Edited ${cwd}/src/x.ts using ${LEAKY_KEY}` });
    sink?.({ type: 'approval.requested', approvalId: 'ap1', tool: 'Edit', summary: `Edit ${cwd}/src/x.ts`, paths: [`${cwd}/src/x.ts`] });
  }
  async interrupt(): Promise<void> {}
  resolveApproval(_s: string, approvalId: string, decision: ApprovalDecision): boolean {
    if (approvalId !== 'ap1') return false;
    this.resolved.push([approvalId, decision]);
    return true;
  }
  async stop(sessionId: string): Promise<void> {
    this.sinks.get(sessionId)?.({ type: 'session.state', status: 'completed' });
  }
  async stopAll(): Promise<void> {}
  emit(sessionId: string, e: SessionEvent): void {
    this.sinks.get(sessionId)?.(e);
  }
}

class FakeServer {
  readonly wss: WebSocketServer;
  readonly connections: Array<{ ws: WebSocket; req: IncomingMessage; frames: DeviceFrame[] }> = [];
  private listeners: Array<() => void> = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws, req) => {
      const conn = { ws, req, frames: [] as DeviceFrame[] };
      this.connections.push(conn);
      ws.on('message', (d) => {
        conn.frames.push(JSON.parse(d.toString()) as DeviceFrame);
        for (const l of this.listeners) l();
      });
      for (const l of this.listeners) l();
    });
  }
  get url(): string {
    return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  get last() {
    const c = this.connections.at(-1);
    if (!c) throw new Error('no connection');
    return c;
  }
  waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = fn();
        if (v !== undefined) {
          this.listeners = this.listeners.filter((l) => l !== check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== check);
        reject(new Error('timed out waiting for frame'));
      }, timeoutMs);
      this.listeners.push(check);
      check();
    });
  }
  frame<T extends DeviceFrame['type']>(type: T, pred: (f: Extract<DeviceFrame, { type: T }>) => boolean = () => true) {
    return this.waitFor(() =>
      this.connections
        .flatMap((c) => c.frames)
        .find((f): f is Extract<DeviceFrame, { type: T }> => f.type === type && pred(f as Extract<DeviceFrame, { type: T }>)),
    );
  }
  send(cmd: Omit<CommandFrame, 'type'>): void {
    this.last.ws.send(JSON.stringify({ type: 'command', ...cmd }));
  }
  close(): Promise<void> {
    for (const c of this.connections) c.ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

let home: string;
let project: string;
let server: FakeServer;
let runtime: FakeRuntime;
let daemon: Daemon;
const socketPath = () => join(home, 'rt.sock');

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ocw-d-')));
  project = join(home, 'acme');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  writeFileSync(join(project, 'README.md'), 'hello\n');
  server = new FakeServer();
  await new Promise<void>((r) => server.wss.once("listening", () => r()));
  runtime = new FakeRuntime();
  daemon = await Daemon.create({
    home,
    env: {},
    token: 'device-token-123',
    config: { serverUrl: server.url },
    runtimes: [runtime],
    logger: silentLogger,
    controlSocket: socketPath(),
    link: { backoffMinMs: 20, backoffMaxMs: 50, heartbeatMs: 60_000 },
  });
});

afterEach(async () => {
  await daemon?.stop();
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

/** Through the control socket once the daemon runs; directly in the registry before start(). */
async function addProject(): Promise<string> {
  if (!daemon.isConnected && !existsSync(socketPath())) return (await daemon.registry.add(project)).localId;
  const res = await controlRequest(socketPath(), { cmd: 'addProject', path: project });
  expect(res.ok).toBe(true);
  return (res.result as { localId: string }).localId;
}

describe('Daemon <-> Device Link', () => {
  it('handshakes with Bearer token, hello and projects.sync (no absolute paths)', async () => {
    await daemon.start();
    const localId = await addProject();
    await server.frame('hello');
    expect(server.last.req.headers.authorization).toBe('Bearer device-token-123');
    const hello = await server.frame('hello');
    expect(hello).toMatchObject({ protocolVersion: 1, runtimes: [{ id: 'claude-code', installed: true, version: '9.9.9', loggedIn: true }] });
    const sync = await server.frame('projects.sync', (f) => f.projects.length === 1);
    expect(sync.projects).toEqual([{ localId, name: 'acme', gitRemote: null, defaultBranch: 'main' }]);
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it('session.start -> events -> prompt -> approval flow, all acked and sanitised', async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame('hello');

    server.send({ id: 'c1', kind: 'session.start', sessionId: 'ws1', payload: { projectLocalId: localId, permissionMode: 'acceptEdits' } });
    await server.frame('ack', (f) => f.commandId === 'c1');
    expect(runtime.started[0]).toMatchObject({ sessionId: 'ws1', cwd: realpathSync(project), permissionMode: 'acceptEdits' });
    expect(await server.frame('event', (f) => f.sessionId === 'ws1')).toMatchObject({ event: { type: 'session.state', status: 'idle' }, localSeq: 1 });

    server.send({ id: 'c2', kind: 'prompt', sessionId: 'ws1', payload: { promptId: 'p1', text: 'fix it' } });
    expect(await server.frame('ack', (f) => f.commandId === 'c2')).toMatchObject({ ok: true });
    const msg = await server.frame('event', (f) => f.event.type === 'assistant.message');
    expect(msg.event).toEqual({ type: 'assistant.message', messageId: 'm1', text: 'Edited src/x.ts using [REDACTED:anthropic-key]' });
    const approval = await server.frame('event', (f) => f.event.type === 'approval.requested');
    expect(approval.event).toMatchObject({ summary: 'Edit src/x.ts', paths: ['src/x.ts'] });

    server.send({ id: 'c3', kind: 'approval.resolve', sessionId: 'ws1', payload: { approvalId: 'ap1', decision: 'session' } });
    expect(await server.frame('ack', (f) => f.commandId === 'c3')).toMatchObject({ ok: true });
    expect(runtime.resolved).toEqual([['ap1', 'session']]);

    server.send({ id: 'c4', kind: 'approval.resolve', sessionId: 'ws1', payload: { approvalId: 'nope', decision: 'once' } });
    expect(await server.frame('ack', (f) => f.commandId === 'c4')).toMatchObject({ ok: false });

    // replayed command id: acked again, not re-executed
    server.send({ id: 'c2', kind: 'prompt', sessionId: 'ws1', payload: { promptId: 'p1', text: 'fix it' } });
    await server.waitFor(() => (server.last.frames.filter((f) => f.type === 'ack' && f.commandId === 'c2').length === 2 ? true : undefined));
    expect(runtime.prompts).toHaveLength(1);

    const seqs = server.last.frames.filter((f) => f.type === 'event').map((f) => (f as { localSeq: number }).localSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(JSON.stringify(server.last.frames)).not.toContain(home);
  });

  it('rejects bypassPermissions and unknown projects with a failed ack', async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame('hello');
    server.send({ id: 'b1', kind: 'session.start', sessionId: 'ws2', payload: { projectLocalId: localId, permissionMode: 'bypassPermissions' } });
    expect(await server.frame('ack', (f) => f.commandId === 'b1')).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
    expect(await server.frame('event', (f) => f.sessionId === 'ws2' && f.event.type === 'session.state')).toMatchObject({
      event: { status: 'failed' },
    });
    server.send({ id: 'b2', kind: 'session.start', sessionId: 'ws3', payload: { projectLocalId: 'lp_missing' } });
    expect(await server.frame('ack', (f) => f.commandId === 'b2')).toMatchObject({ ok: false });
    expect(runtime.started).toHaveLength(0);
  });

  it('answers diff.request with repo-relative files and patch', async () => {
    const localId = await addProject();
    writeFileSync(join(project, 'new.ts'), 'export {};\n');
    await daemon.start();
    await server.frame('hello');
    server.send({ id: 'd1', kind: 'diff.request', sessionId: 'ws9', payload: { projectLocalId: localId } });
    const diff = await server.frame('diff.result', (f) => f.requestId === 'd1');
    expect(diff.files.map((f) => f.path).sort()).toEqual(['README.md', 'new.ts']);
    expect(diff.patch).toContain('b/new.ts');
    expect(diff.patch).not.toContain(home);
    await server.frame('ack', (f) => f.commandId === 'd1');
  });

  it('buffers events while offline and replays them in order after reconnect', async () => {
    const localId = await addProject();
    await daemon.start();
    await server.frame('hello');
    server.send({ id: 'r1', kind: 'session.start', sessionId: 'ws5', payload: { projectLocalId: localId } });
    await server.frame('ack', (f) => f.commandId === 'r1');

    const first = server.last;
    first.ws.terminate();
    await server.waitFor(() => (daemon.isConnected ? undefined : true));
    runtime.emit('ws5', { type: 'tool.started', toolUseId: 't1', name: 'Bash', summary: '$ ls' });
    runtime.emit('ws5', { type: 'assistant.delta', messageId: 'm', text: 'ephemeral' });
    runtime.emit('ws5', { type: 'tool.completed', toolUseId: 't1', ok: true, summary: 'done' });

    await server.waitFor(() => (server.connections.length === 2 && server.last.frames.length >= 4 ? true : undefined));
    const types = server.last.frames.map((f) => (f.type === 'event' ? f.event.type : f.type));
    expect(types.slice(0, 4)).toEqual(['hello', 'projects.sync', 'tool.started', 'tool.completed']);
  });
});

describe('Control socket', () => {
  it('is a 0600 unix socket supporting status, list, add and remove', async () => {
    await daemon.start();
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
    const localId = await addProject();
    const list = await controlRequest(socketPath(), { cmd: 'listProjects' });
    expect(list.result).toMatchObject([{ localId, path: realpathSync(project), name: 'acme' }]);
    const status = await controlRequest(socketPath(), { cmd: 'status' });
    expect(status.result).toMatchObject({ paired: true, projects: 1 });
    expect(await controlRequest(socketPath(), { cmd: 'removeProject', localId })).toMatchObject({ ok: true, result: { removed: true } });
    expect(await controlRequest(socketPath(), { cmd: 'addProject', path: join(home, 'missing') })).toMatchObject({ ok: false });
  });
});
