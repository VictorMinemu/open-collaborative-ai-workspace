// Locate an executable on PATH (plus common user install dirs) without spawning a shell.

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const EXTRA_DIRS = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin'];

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const extra of EXTRA_DIRS) dirs.push(join(homedir(), extra));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Copy of `env` without the given keys / key patterns. */
export function filterEnv(env: NodeJS.ProcessEnv, drop: (key: string) => boolean): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!drop(k)) out[k] = v;
  return out;
}
