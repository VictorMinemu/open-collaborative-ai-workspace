// Tool-input helpers for the Claude Code adapter: secret-path deny rules, path extraction and
// human summaries for tool.started / approval.requested.

import { homedir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';

/** Basenames that are allowed even though they look like `.env*`. */
const ENV_TEMPLATE_ALLOW = /^\.env\.(example|sample|template|dist)$/i;

const SECRET_BASENAME = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production …
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.keychain(-db)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^credentials(\.json)?$/i,
  /^\.credentials\.json$/i,
  /^device-token$/i,
];

/** Directories (relative to $HOME) whose contents are always off-limits. */
const SECRET_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.ocw', 'Library/Keychains', '.config/gh', '.docker', '.kube'];

/** Substrings that, inside a shell command, indicate an attempt to touch secrets. */
const SECRET_COMMAND_PATTERNS: RegExp[] = [
  /(^|[\s"'=/<>|;&(])\.env(\.[A-Za-z0-9_-]+)?(?=$|[\s"';|&)<>])/,
  /\.ssh\//,
  /(^|[\s"'=/])\.ssh(?=$|[\s"';|&)])/,
  /\.pem\b/,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/,
  /Library\/Keychains/,
  /\bsecurity\s+(find|dump|export)-/,
  /\.aws\/credentials/,
  /\.ocw\//,
  /\bprintenv\b/,
  /^\s*env\s*($|[|;&])/,
];

const ENV_TEMPLATE_IN_COMMAND = /\.env\.(example|sample|template|dist)\b/g;

export function isSecretPath(p: string, cwd: string, home: string = homedir()): boolean {
  if (!p) return false;
  const expanded = p.startsWith('~/') ? `${home}/${p.slice(2)}` : p;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const name = basename(abs);
  if (ENV_TEMPLATE_ALLOW.test(name)) return false;
  if (SECRET_BASENAME.some((re) => re.test(name))) return true;
  for (const dir of SECRET_HOME_DIRS) {
    const root = resolve(home, dir);
    if (abs === root || abs.startsWith(root + sep)) return true;
  }
  return false;
}

export function commandTouchesSecrets(command: string): boolean {
  const scrubbed = command.replace(ENV_TEMPLATE_IN_COMMAND, '');
  return SECRET_COMMAND_PATTERNS.some((re) => re.test(scrubbed));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** File-system paths a tool call will touch, as given by the model (absolute or relative). */
export function extractPaths(_toolName: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = str(input[key]);
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

/** Returns a deny reason if the tool call touches a secret path, else null. */
export function secretDenyReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): string | null {
  for (const p of extractPaths(toolName, input)) {
    if (isSecretPath(p, cwd, home)) return `Access to secret files is blocked by workspace policy (${basename(p)}).`;
  }
  const pattern = str(input.pattern);
  if ((toolName === 'Glob' || toolName === 'Grep') && pattern && /(^|\/)\.env(\.|$|\*)/.test(pattern)) {
    if (!ENV_TEMPLATE_ALLOW.test(basename(pattern))) return 'Searching secret files is blocked by workspace policy.';
  }
  const command = str(input.command);
  if (command && commandTouchesSecrets(command)) {
    return 'Shell access to secret files or environment dumps is blocked by workspace policy.';
  }
  return null;
}

/**
 * Static deny rules passed to Claude Code settings. Enforced by the CLI even for tools that the
 * permission mode auto-allows (so `canUseTool` never sees them). The PreToolUse hook is the
 * second line of defence.
 */
export function secretDenyRules(): string[] {
  const rules: string[] = [];
  for (const tool of ['Read', 'Edit', 'Write']) {
    rules.push(
      `${tool}(**/.env)`,
      `${tool}(**/.env.local)`,
      `${tool}(**/.env.*.local)`,
      `${tool}(**/.env.production)`,
      `${tool}(**/.env.development)`,
      `${tool}(**/*.pem)`,
      `${tool}(**/*.key)`,
      `${tool}(~/.ssh/**)`,
      `${tool}(~/.aws/**)`,
      `${tool}(~/.gnupg/**)`,
      `${tool}(~/.ocw/**)`,
      `${tool}(~/Library/Keychains/**)`,
    );
  }
  return rules;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One-line human summary of a tool call. Paths are made repo-relative later by sanitizeEvent. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const filePath = str(input.file_path) ?? str(input.notebook_path);
  switch (toolName) {
    case 'Bash': {
      const desc = str(input.description);
      const cmd = clip(str(input.command) ?? '', 300);
      return desc ? `${desc}: $ ${cmd}` : `$ ${cmd}`;
    }
    case 'Read':
      return `Read ${filePath ?? '?'}`;
    case 'Write':
      return `Write ${filePath ?? '?'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${filePath ?? '?'}`;
    case 'NotebookEdit':
      return `Edit notebook ${filePath ?? '?'}`;
    case 'Glob':
      return `Find files ${str(input.pattern) ?? ''}${str(input.path) ? ` in ${input.path as string}` : ''}`;
    case 'Grep':
      return `Search "${clip(str(input.pattern) ?? '', 120)}"${str(input.path) ? ` in ${input.path as string}` : ''}`;
    case 'WebFetch':
      return `Fetch ${str(input.url) ?? '?'}`;
    case 'WebSearch':
      return `Web search "${clip(str(input.query) ?? '', 120)}"`;
    case 'Task':
    case 'Agent':
      return `Sub-agent: ${clip(str(input.description) ?? str(input.prompt) ?? '', 200)}`;
    case 'TodoWrite':
      return 'Update task list';
    case 'ExitPlanMode':
      return `Proposed plan:\n${(str(input.plan) ?? '').slice(0, 4000)}`;
    default: {
      let json = '';
      try {
        json = JSON.stringify(input);
      } catch {
        json = '[unserialisable input]';
      }
      return `${toolName} ${clip(json, 300)}`;
    }
  }
}
