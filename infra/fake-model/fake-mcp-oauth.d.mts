import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Types for the TypeScript tests that run the fake OAuth-protected MCP server and its authorization server
 * in-process (implementation: fake-mcp-oauth.mjs, 07.4-04).
 */

export const FAKE_MCP_OAUTH_TOOLS: ReadonlyArray<{
  name: "whoami" | "create_record" | "echo_auth";
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}>;

export interface FakeMcpOAuthClient {
  client_id: string;
  /** Absent: a public client (`token_endpoint_auth_method: none`). */
  client_secret?: string;
  /** Compared exactly at authorize and token. */
  redirect_uris: string[];
}

/** Test knobs (`POST /mcp-oauth/__scenario` or `setScenario`); each call replaces the previous scenario. */
export interface FakeMcpOAuthScenario {
  /** authorize redirects with `error=access_denied` and no code. */
  deny?: boolean;
  /** AS metadata leaves out `code_challenge_methods_supported` (a client must refuse to proceed). */
  no_pkce_meta?: boolean;
  /** The authorization response carries no `iss`. */
  no_iss?: boolean;
  /** The authorization response's `iss` names the other issuer (mix-up). */
  wrong_iss?: boolean;
  /** Every authenticated MCP request is a 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`. */
  insufficient_scope?: boolean;
  /** Access token lifetime in seconds (default 3600). */
  expires_in?: number;
  /** Revokes every grant issued so far and rejects every token while set. */
  revoke_all?: boolean;
  /** Delays each MCP `tools/call` by this many milliseconds. */
  slow_mcp_ms?: number;
  /** The PRM names the second authorization server (`<base>/mcp-oauth/alt`). */
  different_issuer?: boolean;
  /** The token endpoint answers 503 `temporarily_unavailable` (the attempt is still counted). */
  fail_token_5xx?: boolean;
  /** The code exchange returns no `id_token`. */
  no_id_token?: boolean;
  /** AS metadata advertises neither dynamic registration nor client ID metadata documents (a client must be
   * pre-registered). */
  no_registration?: boolean;
}

export interface FakeMcpOAuthStats {
  /** Every token request per grant type, refused and 503 ones included. */
  tokenRequests: { authorization_code: number; refresh_token: number };
  /** Rotated refresh tokens presented again (each one revoked its family). */
  refreshReuse: number;
  /** Revocation requests. */
  revocations: number;
  /** Successful dynamic client registrations. */
  registrations: number;
  /** The `resource` parameter last received on each request kind (null until one arrives). */
  lastResource: { authorize: string | null; token: string | null; refresh: string | null };
  /** Every HTTP request to `/mcp-oauth/mcp`, rejected ones included. */
  mcpRequests: number;
  /** Authenticated `tools/call` requests. */
  mcpCalls: number;
  /** sha256 hex of every MCP access token issued; never a token. */
  accessTokenHashes: string[];
  /** Keychain targets: `/kc/token` requests and `/kc/whoami` outcomes. */
  kc: { tokenRequests: number; authorized: number; rejected: number };
}

export interface FakeMcpOAuth {
  /** Returns true when it owned the route (`/.well-known/oauth-*` for `mcp-oauth`, `/mcp-oauth/*`, `/kc/*`). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  /** In-process only, for leak sweeps: every raw token (`/kc/token` bearers in `access`) and code issued. Never
   * served over HTTP. */
  issuedTokens(): { access: string[]; refresh: string[]; codes: string[] };
  setScenario(scenario: FakeMcpOAuthScenario): void;
  /** Forgets every token, code, session, registered client and counter; keeps `preRegistered`. */
  reset(): void;
}

export interface FakeMcpOAuthOptions {
  preRegistered?: FakeMcpOAuthClient[];
  /** How the AS reads a client ID metadata document (an https `client_id`); default: fetch with a 5 s timeout. */
  cimdFetch?: (url: string) => Promise<unknown>;
  /** The static bearer `/kc/whoami` accepts (default `fake-kc-token`). Basic is always kcuser:kcpass and the
   * client-credentials client kc-client / kc-secret. */
  kcToken?: string;
}

/** `/kc/whoami` body: how the request authenticated. */
export type FakeKcMethod = "bearer" | "basic" | "client_credentials";

export function createFakeMcpOAuth(opts?: FakeMcpOAuthOptions): FakeMcpOAuth;
