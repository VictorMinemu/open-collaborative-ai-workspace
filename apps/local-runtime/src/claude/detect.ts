// Claude Code detection: installed? version? authenticated? Only booleans and the version string
// leave this module (never the account email, org id or config paths printed by `claude auth status`).

import { execFile } from 'node:child_process';
import { filterEnv } from '../exec-path.js';
import type { RuntimeInfo } from '../protocol.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** Detection probes run without API-key variables so they report the CLI's own login. */
const PROBE_DROP = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']);

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    const env = filterEnv(process.env, (k) => k.startsWith('OCW_') || PROBE_DROP.has(k));
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      // On non-zero exit `err.code` is the exit code; on spawn failure (ENOENT) it is a string.
      const errCode = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof errCode === 'number' ? errCode : null;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export function parseClaudeVersion(stdout: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(stdout);
  return m?.[1] ?? null;
}

export function parseAuthStatus(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return /logged in/i.test(stdout) && !/not logged in/i.test(stdout);
  }
}

/**
 * `loggedIn` reflects the CLI's own auth status (`claude auth status`), i.e. the user's Claude
 * subscription login. It is checked with API-key variables removed so a stray key cannot mask a
 * missing login; a key only counts when `useApiKey` is explicitly enabled.
 */
export async function detectClaudeCode(
  opts: { claudePath?: string; exec?: ExecFn; env?: NodeJS.ProcessEnv; useApiKey?: boolean } = {},
): Promise<RuntimeInfo> {
  const exec = opts.exec ?? defaultExec;
  const bin = opts.claudePath ?? 'claude';
  const env = opts.env ?? process.env;
  const info: RuntimeInfo = { id: 'claude-code', installed: false, version: null, loggedIn: false };

  const version = await exec(bin, ['--version'], 10_000).catch(() => null);
  if (!version || version.code !== 0) return info;
  info.installed = true;
  info.version = parseClaudeVersion(version.stdout);

  if (opts.useApiKey && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    info.loggedIn = true;
    return info;
  }
  const auth = await exec(bin, ['auth', 'status'], 15_000).catch(() => null);
  info.loggedIn = auth !== null && auth.code === 0 && parseAuthStatus(auth.stdout);
  return info;
}
