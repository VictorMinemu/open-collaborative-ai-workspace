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
  /** Absent: a public client (`token_endpoint_auth_method: none`). Present: a confidential client, which may also
   * use the `client_credentials` grant (subject `sub_cc_<client_id>`, no refresh token; 07.14-03). */
  client_secret?: string;
  /** Compared exactly at authorize and token; `[]` for a client-credentials-only client. */
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
  /** AS metadata lists `client_secret_post` alone in `token_endpoint_auth_methods_supported`, and the token endpoint
   * refuses a Basic header with 401 `invalid_client` (07.14 D-10: a client must pick post from the metadata). */
  cc_post_only?: boolean;
  /** AS metadata of a client-credentials-only server: `issuer`, `token_endpoint`, `grant_types_supported:
   * ["client_credentials"]`, `token_endpoint_auth_methods_supported` (and revocation), with no
   * `authorization_endpoint`, `response_types_supported` or `code_challenge_methods_supported` (07.14 D-17). */
  no_authorization_endpoint?: boolean;
  /** AS metadata's `issuer` is `<base>/mcp-oauth-other` while it is served at the `mcp-oauth` well-known path
   * (07.14 D-10 `issuer_mismatch`). */
  issuer_mismatch_meta?: boolean;
  /** authorize redirects to the registered redirect with `error=invalid_scope`, `state` and `iss`, and no code
   * (07.14 D-10 `scope_rejected`). */
  invalid_scope_at_authorize?: boolean;
}

export interface FakeMcpOAuthStats {
  /** Every token request per grant type, refused and 503 ones included. */
  tokenRequests: { authorization_code: number; refresh_token: number; client_credentials: number };
  /** Rotated refresh tokens presented again (each one revoked its family). */
  refreshReuse: number;
  /** Revocation requests. */
  revocations: number;
  /** Successful dynamic client registrations. */
  registrations: number;
  /** The `resource` parameter last received on each request kind (null until one arrives). */
  lastResource: {
    authorize: string | null;
    token: string | null;
    refresh: string | null;
    /** The last `client_credentials` token request (07.14-03). */
    cc: string | null;
  };
  /** How the last token request (any grant) presented client credentials: an `Authorization: Basic` header,
   * `client_secret` in the body, or neither. Never the secret itself; null until one arrives (07.14-03). */
  lastClientAuth: "basic" | "post" | "none" | null;
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
  /** The Basic pair `/kc/whoami` accepts (default kcuser / kcpass). */
  kcBasic?: { user: string; pass: string };
  /** The client-credentials client `/kc/token` accepts (default kc-client / kc-secret). */
  kcClient?: { id: string; secret: string };
}

/** `/kc/whoami` body: how the request authenticated. */
export type FakeKcMethod = "bearer" | "basic" | "client_credentials";

export function createFakeMcpOAuth(opts?: FakeMcpOAuthOptions): FakeMcpOAuth;
