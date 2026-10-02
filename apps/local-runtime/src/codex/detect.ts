// Codex detection: `codex --version` + `codex login status`. Only the ChatGPT (subscription)
// login counts as logged in, unless API-key use is explicitly enabled.

import { type ExecFn, defaultExec } from '../claude/detect.js';
import type { RuntimeInfo } from '../protocol.js';

export function parseCodexVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(stdout)?.[1] ?? null;
}

/** 'chatgpt' | 'apikey' | null (not logged in / unknown). */
export function parseCodexLogin(output: string): 'chatgpt' | 'apikey' | null {
  if (/not logged in/i.test(output)) return null;
  if (/logged in/i.test(output) && /chatgpt/i.test(output)) return 'chatgpt';
  if (/logged in/i.test(output) && /api key/i.test(output)) return 'apikey';
  return null;
}

export async function detectCodex(
  opts: { codexPath?: string; exec?: ExecFn; useApiKey?: boolean } = {},
): Promise<RuntimeInfo> {
  const exec = opts.exec ?? defaultExec;
  const bin = opts.codexPath ?? 'codex';
  const info: RuntimeInfo = { id: 'codex', installed: false, version: null, loggedIn: false };
  const version = await exec(bin, ['--version'], 10_000).catch(() => null);
  if (!version || version.code !== 0) return info;
  info.installed = true;
  info.version = parseCodexVersion(version.stdout);
  // `codex login status` prints to stderr on some versions.
  const status = await exec(bin, ['login', 'status'], 15_000).catch(() => null);
  if (status && status.code === 0) {
    const mode = parseCodexLogin(`${status.stdout}\n${status.stderr}`);
    info.loggedIn = mode === 'chatgpt' || (mode === 'apikey' && opts.useApiKey === true);
  }
  return info;
}
