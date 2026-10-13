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
  /** Access token lifetime in seconds (default 3600). */
  expires_in?: number;
}

export interface FakeMcpOAuthStats {
  tokenRequests: { authorization_code: number; refresh_token: number };
  /** The `resource` parameter last received on each request kind (null until one arrives). */
  lastResource: { authorize: string | null; token: string | null; refresh: string | null };
  /** Every HTTP request to `/mcp-oauth/mcp`, rejected ones included. */
  mcpRequests: number;
  /** Authenticated `tools/call` requests. */
  mcpCalls: number;
  /** sha256 hex of every access token issued; never a token. */
  accessTokenHashes: string[];
}

export interface FakeMcpOAuth {
  /** Returns true when it owned the route (`/.well-known/oauth-*` for `mcp-oauth`, `/mcp-oauth/*`). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  /** In-process only, for leak sweeps: every raw token and code issued. Never served over HTTP. */
  issuedTokens(): { access: string[]; refresh: string[]; codes: string[] };
  setScenario(scenario: FakeMcpOAuthScenario): void;
  /** Forgets every token, code, session, registered client and counter; keeps `preRegistered`. */
  reset(): void;
}

export function createFakeMcpOAuth(opts?: { preRegistered?: FakeMcpOAuthClient[] }): FakeMcpOAuth;
