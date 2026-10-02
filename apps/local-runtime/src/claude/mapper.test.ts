import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../protocol.js';
import { sanitizeEvent } from '../sanitize.js';
import { ClaudeEventMapper, TOOL_OUTPUT_MAX_BYTES } from './mapper.js';

const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');
const FIXTURE_ROOT = '/tmp/ocw-fixture-repo';

function loadFixture(name: string): SDKMessage[] {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SDKMessage);
}

function run(messages: SDKMessage[], promptId = 'prompt-1'): SessionEvent[] {
  const mapper = new ClaudeEventMapper();
  mapper.currentPromptId = promptId;
  return messages.flatMap((m) => mapper.map(m));
}

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

describe('ClaudeEventMapper — recorded fixture (real Claude Code session, plan mode)', () => {
  const file = readdirSync(FIXTURE_DIR).find((f) => f.endsWith('.plan-read.sdk.jsonl'));
  if (!file) throw new Error('fixture missing; run `npx tsx scripts/record-fixture.ts`');
  const events = run(loadFixture(file));
  const types = events.map((e) => e.type);

  it('emits the normalised lifecycle in order', () => {
    const lifecycle = types.filter((t) => t !== 'assistant.delta' && t !== 'runtime.raw');
    expect(lifecycle).toEqual([
      'session.started',
      'assistant.message',
      'tool.started',
      'tool.completed',
      'assistant.message',
      'prompt.completed',
    ]);
    expect(types.filter((t) => t === 'assistant.delta').length).toBeGreaterThan(0);
  });

  it('reports runtime metadata on session.started', () => {
    expect(events[0]).toMatchObject({ type: 'session.started', runtime: 'claude-code', permissionMode: 'plan' });
    expect((events[0] as { runtimeSessionId?: string }).runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps the Read tool call and its result', () => {
    const started = events.find((e) => e.type === 'tool.started');
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(started).toMatchObject({ name: 'Read', summary: `Read ${FIXTURE_ROOT}/hello.txt` });
    expect(completed).toMatchObject({ ok: true, summary: 'Read completed' });
    expect(completed && 'output' in completed ? completed.output : '').toContain('Hello from the fixture repo.');
    expect(completed && 'toolUseId' in completed ? completed.toolUseId : '').toBe(
      started && 'toolUseId' in started ? started.toolUseId : 'x',
    );
  });

  it('streams deltas whose concatenation equals the final message', () => {
    const final = events.filter((e) => e.type === 'assistant.message').at(-1) as { messageId: string; text: string };
    const deltas = events
      .filter((e): e is Extract<SessionEvent, { type: 'assistant.delta' }> => e.type === 'assistant.delta')
      .filter((e) => e.messageId === final.messageId)
      .map((e) => e.text)
      .join('');
    expect(final.text).toBe('OK');
    expect(deltas).toBe(final.text);
  });

  it('completes the prompt with usage and a cost estimate', () => {
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'prompt.completed', promptId: 'prompt-1' });
    const usage = (done as { usage: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(typeof (done as { costUsd?: number }).costUsd).toBe('number');
  });

  it('leaves no absolute path once sanitised', () => {
    const out = JSON.stringify(events.map((e) => sanitizeEvent(e, [FIXTURE_ROOT], '/Users/fixture-user')));
    expect(out).not.toContain(FIXTURE_ROOT);
    expect(out).not.toContain('/Users/');
    expect(out).toContain('"summary":"Read hello.txt"');
  });
});

describe('ClaudeEventMapper — hand-written cases', () => {
  it('reports per-prompt cost from the cumulative total_cost_usd', () => {
    const mapper = new ClaudeEventMapper();
    const result = (cost: number) => sdk({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, usage: {} });
    mapper.currentPromptId = 'p1';
    expect(mapper.map(result(0.5))).toMatchObject([{ type: 'prompt.completed', promptId: 'p1', costUsd: 0.5 }]);
    mapper.currentPromptId = 'p2';
    expect(mapper.map(result(0.75))).toMatchObject([{ type: 'prompt.completed', promptId: 'p2', costUsd: 0.25 }]);
  });

  it('maps error results to session.error + failed prompt', () => {
    const events = run([
      sdk({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], total_cost_usd: 0, usage: {} }),
    ]);
    expect(events).toMatchObject([
      { type: 'session.error', message: 'too many turns' },
      { type: 'prompt.completed', promptId: 'prompt-1', isError: true },
    ]);
  });

  it('truncates tool output to 4 KB and marks failures', () => {
    const big = 'x'.repeat(10_000);
    const events = run([
      sdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } }),
      sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: big }] } }),
    ]);
    expect(events[0]).toMatchObject({ type: 'tool.started', name: 'Bash', summary: '$ make' });
    const done = events[1] as { ok: boolean; output: string; summary: string };
    expect(done.ok).toBe(false);
    expect(done.summary).toMatch(/^Bash failed/);
    expect(Buffer.byteLength(done.output.split('\n…')[0] ?? '')).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });

  it('forwards unknown SDK messages as runtime.raw and drops known noise', () => {
    const events = run([
      sdk({ type: 'system', subtype: 'brand_new_thing', foo: 1 }),
      sdk({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: 1 }),
      sdk({ type: 'system', subtype: 'status', status: 'requesting' }),
    ]);
    expect(events).toEqual([{ type: 'runtime.raw', rawType: 'system/brand_new_thing', data: { type: 'system', subtype: 'brand_new_thing', foo: 1 } }]);
  });

  it('ignores sub-agent text and replayed user messages', () => {
    const events = run([
      sdk({ type: 'assistant', parent_tool_use_id: 'task1', message: { id: 'm2', content: [{ type: 'text', text: 'inner' }] } }),
      sdk({ type: 'user', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
    ]);
    expect(events).toEqual([]);
  });
});
