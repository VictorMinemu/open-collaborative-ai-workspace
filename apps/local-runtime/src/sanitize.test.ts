import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './protocol.js';
import { contain, redact, sanitizeEvent, truncateBytes } from './sanitize.js';

const HOME = '/Users/alice';
const ROOT = '/Users/alice/code/acme';
const WT = '/Users/alice/code/acme/.ocw-worktrees/s1';

describe('contain()', () => {
  it('makes paths under the project root repo-relative', () => {
    expect(contain(`Edited ${ROOT}/src/app.ts and ${ROOT}/README.md`, [ROOT], HOME)).toBe('Edited src/app.ts and README.md');
  });

  it('maps the root itself to "."', () => {
    expect(contain(`cwd is ${ROOT}`, [ROOT], HOME)).toBe('cwd is .');
    expect(contain(`cwd is ${ROOT}/`, [ROOT], HOME)).toBe('cwd is ');
  });

  it('prefers the longest root (worktree inside the repo)', () => {
    expect(contain(`${WT}/src/a.ts vs ${ROOT}/src/a.ts`, [ROOT, WT], HOME)).toBe('src/a.ts vs src/a.ts');
  });

  it('does not match sibling directories sharing a prefix', () => {
    expect(contain(`${ROOT}-old/x.ts`, [ROOT], HOME)).toBe('~/code/acme-old/x.ts');
  });

  it('turns other home paths into ~/… and collapses other users homes', () => {
    expect(contain('see /Users/alice/.zshrc', [ROOT], HOME)).toBe('see ~/.zshrc');
    expect(contain('see /home/bob/x and /Users/carol/y', [ROOT], HOME)).toBe('see ~/x and ~/y');
  });

  it('leaves system paths and relative paths alone', () => {
    expect(contain('/usr/bin/git src/a.ts', [ROOT], HOME)).toBe('/usr/bin/git src/a.ts');
  });
});

// Fake credentials are assembled at runtime so secret scanners do not flag this file.
const fake = (...parts: string[]) => parts.join('');
const ANTHROPIC = fake('sk-', 'ant-api03-', 'abcdefghijklmnopqrstuvwxyz0123');

describe('redact()', () => {
  const cases: Array<[string, string]> = [
    [`key ${ANTHROPIC}`, 'key [REDACTED:anthropic-key]'],
    [`OPENAI ${fake('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz012345')}`, 'OPENAI [REDACTED:api-key]'],
    [`token ${fake('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789')}`, 'token [REDACTED:github-token]'],
    [`aws ${fake('AKIA', 'IOSFODNN7EXAMPLE')}`, 'aws [REDACTED:aws-access-key]'],
    [`aws_secret_access_key = ${fake('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY')}`, 'aws_secret_access_key = [REDACTED]'],
    [`Authorization: ${fake('Bearer ', 'abc.def.ghi-123456')}`, 'Authorization: Bearer [REDACTED]'],
    [`ANTHROPIC_API_KEY=${fake('supersecret', 'value')}`, 'ANTHROPIC_API_KEY=[REDACTED]'],
    [`git clone https://bob:${fake('hunter2', 'hunter2')}@github.com/x/y`, 'git clone https://bob:[REDACTED]@github.com/x/y'],
  ];
  for (const [input, expected] of cases) {
    it(`redacts ${expected}`, () => expect(redact(input)).toBe(expected));
  }

  it('redacts PEM blocks, including a block truncated before END', () => {
    const pem = fake('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA ', 'PRIVATE KEY-----');
    expect(redact(`x ${pem} y`)).toBe('x [REDACTED:pem-block] y');
    expect(redact(fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nAAAA'))).toBe('[REDACTED:pem-block]');
  });

  it('keeps ordinary code readable', () => {
    const code = 'const API_KEY: z.string(); const task = "sk-"; token.length > 3';
    expect(redact(code)).toBe(code);
  });

  it('is idempotent', () => {
    const once = redact(`${ANTHROPIC} Bearer abcdefghijkl`);
    expect(redact(once)).toBe(once);
  });
});

describe('sanitizeEvent()', () => {
  it('applies contain + redact to every string field, including nested raw data', () => {
    const event: SessionEvent = {
      type: 'runtime.raw',
      rawType: 'system/init',
      data: { cwd: ROOT, nested: [{ path: `${ROOT}/a.ts`, key: ANTHROPIC }], n: 3 },
    };
    expect(sanitizeEvent(event, [ROOT], HOME)).toEqual({
      type: 'runtime.raw',
      rawType: 'system/init',
      data: { cwd: '.', nested: [{ path: 'a.ts', key: '[REDACTED:anthropic-key]' }], n: 3 },
    });
  });

  it('sanitises approval paths and summaries', () => {
    const event: SessionEvent = {
      type: 'approval.requested',
      approvalId: 'a1',
      tool: 'Edit',
      summary: `Edit ${ROOT}/src/x.ts`,
      paths: [`${ROOT}/src/x.ts`, '/Users/alice/.ssh/config'],
    };
    const out = sanitizeEvent(event, [ROOT], HOME);
    expect(out).toMatchObject({ summary: 'Edit src/x.ts', paths: ['src/x.ts', '~/.ssh/config'] });
    expect(JSON.stringify(out)).not.toContain('/Users/');
  });

  it('does not mutate the input event', () => {
    const event: SessionEvent = { type: 'assistant.message', messageId: 'm', text: `${ROOT}/a` };
    sanitizeEvent(event, [ROOT], HOME);
    expect(event.text).toBe(`${ROOT}/a`);
  });
});

describe('truncateBytes()', () => {
  it('caps by UTF-8 bytes and reports the dropped amount', () => {
    const { text, truncated } = truncateBytes('é'.repeat(3000), 4096);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text.split('\n…')[0] ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…\[truncated 1904 bytes\]$/);
  });
});
