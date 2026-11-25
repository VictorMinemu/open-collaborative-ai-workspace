// 07.18 (D-02, D-13, ADR-0044): the environment a Claude Code process gets when its session runs on a pool token.
//
// Claude Code picks its credential in this order (code.claude.com/docs/en/authentication): a cloud provider
// (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`) > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` >
// `CLAUDE_CODE_OAUTH_TOKEN` > profiles > the `/login` credential. A pool token is a `CLAUDE_CODE_OAUTH_TOKEN`, so every
// variable above it goes (else the session would bill a cloud provider or an API key while the platform believes it
// runs on the pool account), and an inherited `CLAUDE_CODE_OAUTH_TOKEN` goes too (the pool one replaces it).
// `apiKeyHelper` lives in settings, not the env: the adapter reports a session whose init says it won (`apiKeySource`).
//
// The token itself lives only in this process's memory for that session: it is handed to the SDK's `Options.env`
// (which replaces the child's env) and never logged, written or put in an event.
//
// A-06 (probed 2026-11-24, Claude Code CLI 2.1.331, macOS): the flag settings layer wins over a project's
// `.claude/settings.json`. A project setting `env.ANTHROPIC_BASE_URL` to listener A and `--settings` setting it to
// listener B, with a dummy `CLAUDE_CODE_OAUTH_TOKEN` and every other host behind a dead local proxy: only B received
// requests (control run without the flag value: A received them). So `poolFlagEnv` pins the base URL, the proxy and the
// CA variables in the flag settings, and a repository cannot send the pool token elsewhere (E16). Without the pin the
// fallback would have been to refuse pool tokens for such projects.
//
// 07.18-19 R1.5 (read from the CLI 2.1.331 binary): more variables take a session off its `CLAUDE_CODE_OAUTH_TOKEN`.
// - Providers and gateways: `CLAUDE_CODE_USE_GATEWAY|MANTLE|ANTHROPIC_AWS|ANTHROPIC_GOOGLE_CLOUD` (read as truthy, so
//   the flag pin `""` turns them off; a project's settings can set them).
// - Credential descriptors and the API socket: the CLI counts `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`,
//   `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_BG_AUTH_SNAPSHOT_PATH` and `ANTHROPIC_UNIX_SOCKET` as a credential
//   present, and with `ANTHROPIC_UNIX_SOCKET` every Anthropic call goes through that socket. They (and the other
//   `*_FILE_DESCRIPTOR` variables of its list) are stripped from the child env. The CLI already drops them from every
//   settings file except managed policy, so their flag pins are a no-op today and a guard if that ever changes (an
//   empty value reads as unset: descriptors are trimmed and compared with "", the socket is tested for truthiness).

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Variables removed from the child env of a pool-token session (each one would win over, or replace, the token). */
export const CLAUDE_POOL_STRIPPED_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "ANTHROPIC_UNIX_SOCKET",
];

/** Pinned to `""` in the flag settings of a pool-token session (R1.5): each one, set, would bill or route elsewhere. */
export const CLAUDE_POOL_PINNED_EMPTY_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_UNIX_SOCKET",
];

/** `base` (the daemon's usual child env) without the competing credentials, plus the pool token. */
export function poolChildEnv(
  base: Record<string, string | undefined>,
  token: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (!CLAUDE_POOL_STRIPPED_VARS.includes(k)) env[k] = v;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/** Where a pool token may go: Anthropic's API, never a base URL a repository chose. */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** Network variables a project could set to route (or intercept) the token; pinned to the daemon's own values. */
export const CLAUDE_POOL_PINNED_NETWORK_VARS: readonly string[] = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  // Node and the CLI also read the lower-case spellings.
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
];

/**
 * The `env` of the flag settings layer for a pool-token session (A-06: it beats project settings): the base URL is
 * Anthropic's, the API-key, provider, gateway, credential-descriptor and socket variables are empty, and the proxy and CA variables are the daemon's own
 * ("" when unset), so a project `.claude/settings.json` cannot redirect the token or bill something else.
 */
export function poolFlagEnv(daemonEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: ANTHROPIC_API_BASE_URL };
  for (const k of CLAUDE_POOL_PINNED_EMPTY_VARS) env[k] = "";
  for (const k of CLAUDE_POOL_PINNED_NETWORK_VARS) env[k] = daemonEnv[k] ?? "";
  return env;
}

export const POOL_REFUSED_PROJECT_CREDENTIALS =
  "This project's Claude settings choose their own credentials; pool accounts are not used here";

/**
 * Whether the project's `.claude/settings.json` (the only settings source the adapter loads) runs its own
 * `apiKeyHelper`. That helper outranks `CLAUDE_CODE_OAUTH_TOKEN` and cannot be pinned through the env, so such a
 * project gets no pool token (the start is refused; the device's own login is unaffected). The env keys a project
 * could use instead (base URL, API keys, proxy, CA) are pinned by `poolFlagEnv`. A file that cannot be parsed counts as
 * overriding (fail closed); no file, nothing to override.
 */
export function projectOverridesAuth(cwd: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, ".claude", "settings.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return true;
    const helper = (parsed as { apiKeyHelper?: unknown }).apiKeyHelper;
    return helper !== undefined && helper !== null && helper !== "";
  } catch {
    return true;
  }
}
