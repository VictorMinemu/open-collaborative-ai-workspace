// Records a REAL Claude Code session through ClaudeCodeRuntime and stores the raw SDK messages as a
// fixture for mapper tests. Manual tool, never run in CI.
//
// Cost guard: refuses to run when ANTHROPIC_API_KEY is set (metered API) and aborts if the CLI
// reports any API-key source other than 'none' (i.e. it must use the local claude.ai login).
// One trivial prompt, plan mode (read-only), haiku.
//
//   npx tsx scripts/record-fixture.ts

import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as sdkQuery, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeRuntime, type QueryHandle } from '../src/claude/claude-runtime.js';
import type { SessionEvent } from '../src/protocol.js';
import { sanitizeEvent } from '../src/sanitize.js';

const FIXTURE_ROOT = '/tmp/ocw-fixture-repo';
const FIXTURE_HOME = '/Users/fixture-user';
const INIT_KEEP = new Set([
  'type',
  'subtype',
  'session_id',
  'uuid',
  'model',
  'permissionMode',
  'cwd',
  'claude_code_version',
  'apiKeySource',
  'output_style',
]);

if (process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is set; refusing to record (would be metered). Unset it to use the local login.');
  process.exit(1);
}

function scrubString(s: string, roots: string[]): string {
  let out = s;
  for (const r of roots) out = out.split(r).join(FIXTURE_ROOT);
  out = out.split(homedir()).join(FIXTURE_HOME);
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'fixture@example.com');
}

function scrub(v: unknown, roots: string[]): unknown {
  if (typeof v === 'string') return scrubString(v, roots);
  if (Array.isArray(v)) return v.map((x) => scrub(x, roots));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, roots);
    return out;
  }
  return v;
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'ocw-fixture-'));
  const real = await realpath(tmp);
  const roots = [...new Set([real, tmp])].sort((a, b) => b.length - a.length);
  await writeFile(join(real, 'hello.txt'), 'Hello from the fixture repo.\n');

  const raw: SDKMessage[] = [];
  const events: SessionEvent[] = [];
  let aborted = false;

  const runtime = new ClaudeCodeRuntime({
    queryFn: (params) => {
      const q = sdkQuery(params);
      const tee: QueryHandle = {
        interrupt: () => q.interrupt(),
        close: () => q.close(),
        async *[Symbol.asyncIterator]() {
          for await (const m of q) {
            if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource !== 'none') {
              aborted = true;
              console.error(`apiKeySource=${m.apiKeySource}: not the local login; aborting.`);
              q.close();
              return;
            }
            raw.push(m);
            yield m;
          }
        },
      };
      return tee;
    },
  });

  const done = new Promise<void>((resolve) => {
    void runtime.start({ sessionId: 'fixture-session', cwd: real, permissionMode: 'plan', model: 'haiku' }, (ev) => {
      events.push(ev);
      if (ev.type === 'approval.requested') runtime.resolveApproval('fixture-session', ev.approvalId, 'deny');
      if (ev.type === 'prompt.completed' || (ev.type === 'session.state' && ev.status === 'failed')) resolve();
    });
  });
  await runtime.prompt('fixture-session', {
    promptId: 'prompt-1',
    text: 'Use the Read tool to read hello.txt, then reply with exactly: OK',
  });
  await done;
  await runtime.stop('fixture-session');

  if (aborted) process.exit(1);

  const fixtureMessages = raw.map((m) => {
    const scrubbed = scrub(m, roots) as Record<string, unknown>;
    if (scrubbed.type === 'system' && scrubbed.subtype === 'init') {
      for (const k of Object.keys(scrubbed)) if (!INIT_KEEP.has(k)) delete scrubbed[k];
    }
    return scrubbed;
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'src', 'claude', '__fixtures__');
  await mkdir(outDir, { recursive: true });
  const version = (fixtureMessages.find((m) => m.subtype === 'init')?.claude_code_version as string) ?? 'unknown';
  const file = join(outDir, `claude-code-${version}.plan-read.sdk.jsonl`);
  await writeFile(file, `${fixtureMessages.map((m) => JSON.stringify(m)).join('\n')}\n`);
  await rm(real, { recursive: true, force: true });

  console.log(`wrote ${fixtureMessages.length} SDK messages -> ${file.replace(homedir(), '~')}`);
  console.log('normalised events (sanitised):');
  for (const ev of events) console.log(JSON.stringify(sanitizeEvent(ev, roots)).slice(0, 300));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
