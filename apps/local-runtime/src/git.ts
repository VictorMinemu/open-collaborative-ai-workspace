// Git adapter. Uses the `git` binary via execFile (no shell). Everything returned is repo-relative.

import { execFile } from 'node:child_process';
import { mkdir, readFile, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffFile } from './protocol.js';
import { redact, truncateBytes } from './sanitize.js';

export const PATCH_MAX_BYTES = 500 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WORKTREE_DIR = '.ocw-worktrees';

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface GitRun {
  stdout: string;
  code: number;
}

function git(cwd: string, args: string[], opts: { allowCodes?: number[]; maxBuffer?: number } = {}): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        const errCode = (err as { code?: unknown } | null)?.code;
        const code = !err ? 0 : typeof errCode === 'number' ? errCode : -1;
        if (code === 0 || opts.allowCodes?.includes(code)) {
          resolve({ stdout: String(stdout), code });
          return;
        }
        // stderr may contain absolute paths; callers sanitise before anything leaves the device.
        reject(new GitError(`git ${args[0]} failed: ${String(stderr).trim() || String(err)}`, code));
      },
    );
  });
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    const out = (await git(cwd, args)).stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Strip credentials from a remote URL (`https://user:token@host/x` -> `https://host/x`). */
export function sanitizeRemoteUrl(url: string | null): string | null {
  if (!url) return null;
  return redact(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1'));
}

export interface RepoInfo {
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  remote: string | null;
  defaultBranch: string | null;
  dirty: boolean;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await gitOrNull(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, branch: null, headSha: null, remote: null, defaultBranch: null, dirty: false };
  }
  const [branch, headSha, remote, originHead, status] = await Promise.all([
    gitOrNull(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    gitOrNull(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    gitOrNull(cwd, ['remote', 'get-url', 'origin']),
    gitOrNull(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).then((r) => r.stdout),
  ]);
  const defaultBranch = originHead ? originHead.replace(/^origin\//, '') : branch;
  return { isRepo: true, branch, headSha, remote: sanitizeRemoteUrl(remote), defaultBranch, dirty: status.length > 0 };
}

async function baseRef(cwd: string): Promise<string> {
  return (await gitOrNull(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])) ? 'HEAD' : EMPTY_TREE;
}

const STATUS_MAP: Record<string, DiffFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'modified',
  U: 'unmerged',
};

interface NumStat {
  additions: number;
  deletions: number;
}

function parseNumstatZ(out: string): Map<string, NumStat> {
  // Format with -z: "<add>\t<del>\t<path>\0" or for renames "<add>\t<del>\t\0<old>\0<new>\0".
  const map = new Map<string, NumStat>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const additions = m[1] === '-' ? 0 : Number(m[1]);
    const deletions = m[2] === '-' ? 0 : Number(m[2]);
    let path = m[3] ?? '';
    if (path === '') {
      // rename: next two entries are old and new paths
      i += 2;
      path = parts[i] ?? '';
    }
    map.set(path, { additions, deletions });
  }
  return map;
}

async function countLines(absPath: string): Promise<number> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return 0;
    const buf = await readFile(absPath);
    if (buf.includes(0)) return 0; // binary
    if (buf.length === 0) return 0;
    let n = 0;
    for (const byte of buf) if (byte === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return 0;
  }
}

/** Changed files versus HEAD (staged + unstaged + untracked), repo-relative. */
export async function changedFiles(cwd: string): Promise<DiffFile[]> {
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const base = await baseRef(cwd);
  const [statusOut, numstatOut] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then((r) => r.stdout),
    git(cwd, ['diff', base, '--numstat', '-z', '-M']).then((r) => r.stdout),
  ]);
  const numstat = parseNumstatZ(numstatOut);
  const files: DiffFile[] = [];
  const entries = statusOut.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const path = entry.slice(3);
    if (x === '?' && y === '?') {
      files.push({ path, status: 'untracked', additions: await countLines(join(top, path)), deletions: 0 });
      continue;
    }
    if (x === '!' && y === '!') continue;
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C') {
      i += 1;
      oldPath = entries[i];
    }
    const code = x === 'U' || y === 'U' ? 'U' : x !== ' ' && x !== '?' ? x : y;
    const status = STATUS_MAP[code] ?? 'modified';
    const ns = numstat.get(path) ?? { additions: 0, deletions: 0 };
    const file: DiffFile = { path, status, additions: ns.additions, deletions: ns.deletions };
    if (oldPath) file.oldPath = oldPath;
    files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Unified patch versus HEAD including untracked files, capped at `maxBytes`. */
export async function unifiedPatch(
  cwd: string,
  maxBytes: number = PATCH_MAX_BYTES,
): Promise<{ patch: string; truncated: boolean }> {
  const base = await baseRef(cwd);
  const tracked = (await git(cwd, ['diff', base, '-M', '--no-color', '--no-ext-diff'])).stdout;
  let patch = tracked;
  if (Buffer.byteLength(patch, 'utf8') < maxBytes) {
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
      .split('\0')
      .filter(Boolean);
    for (const file of untracked) {
      if (Buffer.byteLength(patch, 'utf8') >= maxBytes) break;
      const r = await git(cwd, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file], {
        allowCodes: [1],
      });
      patch += r.stdout;
    }
  }
  const { text, truncated } = truncateBytes(patch, maxBytes);
  return { patch: text, truncated };
}

export interface WorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Create (or reuse) a per-session worktree at `<repo>/.ocw-worktrees/<sessionId>` on branch
 * `ocw/<sessionId-short>`. The directory is excluded locally via `.git/info/exclude`.
 */
export async function ensureSessionWorktree(repo: string, sessionId: string): Promise<WorktreeResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new GitError('invalid session id for worktree', null);
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const path = join(top, WORKTREE_DIR, sessionId);
  const branch = `ocw/${sessionId.replace(/-/g, '').slice(0, 12)}`;
  await excludeWorktreeDir(top);
  if (existsSync(join(path, '.git'))) return { path, branch, created: false };
  await mkdir(join(top, WORKTREE_DIR), { recursive: true });
  if (!(await gitOrNull(top, ['rev-parse', '--verify', '-q', 'HEAD']))) {
    throw new GitError('repository has no commits; cannot create a worktree', null);
  }
  const branchExists = (await gitOrNull(top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])) !== null;
  const args = branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'];
  await git(top, args);
  return { path, branch, created: true };
}

export async function removeSessionWorktree(repo: string, sessionId: string): Promise<void> {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const path = join(top, WORKTREE_DIR, sessionId);
  if (!existsSync(path)) return;
  await git(top, ['worktree', 'remove', '--force', path]);
}

async function excludeWorktreeDir(top: string): Promise<void> {
  const commonDir = (await git(top, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const gitDir = commonDir.startsWith('/') ? commonDir : join(top, commonDir);
  const exclude = join(gitDir, 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(exclude, 'utf8');
  } catch {
    await mkdir(join(gitDir, 'info'), { recursive: true });
  }
  if (!current.split('\n').some((l) => l.trim() === `/${WORKTREE_DIR}/`)) {
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/${WORKTREE_DIR}/\n`);
  }
}
