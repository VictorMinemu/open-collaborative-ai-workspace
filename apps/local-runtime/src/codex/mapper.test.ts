import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../protocol.js';
import { sanitizeEvent } from '../sanitize.js';
import type { JsonRpcNotification } from './jsonrpc.js';
import { CodexEventMapper } from './mapper.js';

const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');
const FIXTURE_ROOT = '/tmp/ocw-fixture-repo';

interface RpcLine {
  dir: 'in' | 'out';
  msg: { id?: number | string; method?: string; params?: unknown; result?: unknown };
}

function load(): RpcLine[] {
  const file = readdirSync(FIXTURE_DIR).find((f) => f.endsWith('.plan-read.rpc.jsonl'));
  if (!file) throw new Error('fixture missing; run `npx tsx scripts/record-codex-fixture.ts`');
  return readFileSync(join(FIXTURE_DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RpcLine);
}

describe('CodexEventMapper — recorded fixture (real codex app-server, read-only sandbox)', () => {
  const lines = load();
  const mapper = new CodexEventMapper();
  mapper.currentPromptId = 'prompt-1';
  const events: SessionEvent[] = lines
    .filter((l) => l.dir === 'in' && l.msg.method && l.msg.id === undefined)
    .flatMap((l) => mapper.map(l.msg as JsonRpcNotification));

  it('the client asked for on-request approvals and a non-full-access sandbox', () => {
    const start = lines.find((l) => l.dir === 'out' && l.msg.method === 'thread/start');
    expect(start?.msg.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only', cwd: FIXTURE_ROOT });
  });

  it('emits tool and message events in order and completes the prompt', () => {
    const types = events.map((e) => e.type).filter((t) => t !== 'assistant.delta' && t !== 'runtime.raw');
    expect(types).toEqual(['tool.started', 'tool.completed', 'assistant.message', 'prompt.completed']);
  });

  it('maps the command execution', () => {
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({ name: 'Bash', summary: expect.stringContaining('cat hello.txt') });
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({
      ok: true,
      output: 'Hello from the fixture repo.\n',
    });
  });

  it('streams deltas and the final message for the same item', () => {
    const msg = events.find((e) => e.type === 'assistant.message') as { messageId: string; text: string };
    expect(msg.text).toBe('OK');
    const deltas = events.filter((e) => e.type === 'assistant.delta' && e.messageId === msg.messageId);
    expect(deltas.map((d) => (d as { text: string }).text).join('')).toBe('OK');
  });

  it('reports token usage on prompt.completed', () => {
    const done = events.at(-1) as Extract<SessionEvent, { type: 'prompt.completed' }>;
    expect(done).toMatchObject({ type: 'prompt.completed', promptId: 'prompt-1' });
    expect(done.usage.outputTokens).toBeGreaterThan(0);
    expect(done.isError).toBeUndefined();
  });

  it('leaves no absolute path once sanitised', () => {
    const out = JSON.stringify(events.map((e) => sanitizeEvent(e, [FIXTURE_ROOT], '/Users/fixture-user')));
    expect(out).not.toContain(FIXTURE_ROOT);
    expect(out).not.toContain('/Users/');
  });
});

describe('CodexEventMapper — hand-written cases', () => {
  it('maps file changes, failures and interrupted turns', () => {
    const m = new CodexEventMapper();
    m.currentPromptId = 'p';
    const change = { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/r/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' }] };
    const ev = [
      ...m.map({ method: 'item/started', params: { item: change, threadId: 't', turnId: 'u', startedAtMs: 0 } }),
      ...m.map({ method: 'item/completed', params: { item: { ...change, status: 'failed' }, threadId: 't', turnId: 'u', completedAtMs: 0 } }),
      ...m.map({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'interrupted', error: null, items: [] } } }),
    ];
    expect(ev).toMatchObject([
      { type: 'tool.started', toolUseId: 'f1', name: 'Edit', summary: 'Edit /r/src/a.ts' },
      { type: 'tool.completed', toolUseId: 'f1', ok: false, output: expect.stringContaining('+b') },
      { type: 'prompt.completed', promptId: 'p', interrupted: true },
    ]);
  });

  it('maps failed turns and fatal errors to session.error', () => {
    const m = new CodexEventMapper();
    expect(m.map({ method: 'error', params: { error: { message: 'boom' }, willRetry: false, threadId: 't', turnId: 'u' } })).toEqual([
      { type: 'session.error', message: 'boom' },
    ]);
    expect(
      m.map({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: 'quota' }, items: [] } } }),
    ).toMatchObject([{ type: 'session.error', message: 'quota' }, { type: 'prompt.completed', isError: true }]);
  });

  it('forwards unknown notifications as runtime.raw', () => {
    expect(new CodexEventMapper().map({ method: 'brand/new', params: { a: 1 } })).toEqual([
      { type: 'runtime.raw', rawType: 'brand/new', data: { a: 1 } },
    ]);
  });
});
