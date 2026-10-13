import type { vaultItems } from "@ocw/db";
import { z } from "zod";
import { type Egress, EgressRefusedError, readCapped } from "../../lib/egress";
import { hostAllowed, KeychainError, type StoredOAuthSecret } from "./inject";

/**
 * OAuth client credentials for keychain items of kind `oauth` (Phase 07.4, D-07 item 3; RFC 6749 §4.4). The token
 * request goes through the egress guard to the item's token URL, which must be on the item's allowed hosts. The
 * access token lives only in this process's memory, per item and value version, until 30 s before it expires: it is
 * never persisted, never logged and never part of an error.
 */

type VaultItemRow = typeof vaultItems.$inferSelect;

/** Refetch this long before the token's own expiry. */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
/** Upper bound on cached tokens; the oldest entry goes first. */
const CACHE_MAX = 1000;

const TokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive().max(31_536_000).optional(),
});

/** Without `expires_in`, a token is reused for five minutes at most. */
const DEFAULT_TTL_S = 300;

interface Entry {
  version: string;
  token: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<{ token: string; expiresAt: number }>>();

/** The value version a cached token belongs to: replacing the client secret moves `value_updated_at`. */
const versionOf = (item: VaultItemRow, secret: StoredOAuthSecret) =>
  `${item.valueUpdatedAt}|${item.tokenUrl ?? ""}|${secret.clientId}|${secret.scope ?? ""}`;

/** Drops the cached token of an item (value replaced, token URL changed, item deleted). */
export function forgetClientCredentialsToken(itemId: string): void {
  cache.delete(itemId);
}

export async function clientCredentialsToken(
  egress: Egress,
  item: VaultItemRow,
  secret: StoredOAuthSecret,
  privateAllow: string[],
  opts: { now?: () => number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const now = opts.now ?? Date.now;
  const version = versionOf(item, secret);
  const hit = cache.get(item.id);
  if (hit && hit.version === version && hit.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) {
    return { token: hit.token, expiresAt: hit.expiresAt };
  }
  const key = `${item.id}|${version}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchToken(egress, item, secret, privateAllow, now).then((t) => {
    if (t.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) {
      cache.delete(item.id);
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(item.id, { version, ...t });
    }
    return t;
  });
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function fetchToken(
  egress: Egress,
  item: VaultItemRow,
  secret: StoredOAuthSecret,
  privateAllow: string[],
  now: () => number,
): Promise<{ token: string; expiresAt: number }> {
  let url: URL;
  try {
    url = new URL(item.tokenUrl ?? "");
  } catch {
    throw new KeychainError("token_url_not_allowed");
  }
  // Checked before any request: a token URL outside the allowlist never receives the client secret.
  if (!hostAllowed(item.allowedHosts, url)) throw new KeychainError("token_url_not_allowed");

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (secret.scope) body.set("scope", secret.scope);
  // client_secret_basic (RFC 6749 §2.3.1): both parts form-urlencoded before base64.
  const basic = Buffer.from(
    `${encodeURIComponent(secret.clientId)}:${encodeURIComponent(secret.clientSecret)}`,
    "utf8",
  ).toString("base64");
  let res: Response;
  try {
    res = await egress.fetch(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
      },
      { privateAllow, maxBytes: TOKEN_RESPONSE_MAX_BYTES, timeoutMs: TOKEN_TIMEOUT_MS },
    );
  } catch (err) {
    // The guard's error carries a code and a host only; anything else is reduced to a code.
    if (err instanceof EgressRefusedError) throw err;
    throw new KeychainError("token_request_failed");
  }
  let text: string;
  try {
    ({ text } = await readCapped(res, TOKEN_RESPONSE_MAX_BYTES));
  } catch (err) {
    if (err instanceof EgressRefusedError) throw err;
    throw new KeychainError("token_request_failed");
  }
  if (!res.ok) throw new KeychainError("token_request_failed");
  let parsed: z.infer<typeof TokenResponse>;
  try {
    parsed = TokenResponse.parse(JSON.parse(text));
  } catch {
    throw new KeychainError("token_invalid_response");
  }
  if (parsed.token_type !== undefined && parsed.token_type.toLowerCase() !== "bearer") {
    throw new KeychainError("token_invalid_response");
  }
  return { token: parsed.access_token, expiresAt: now() + (parsed.expires_in ?? DEFAULT_TTL_S) * 1000 };
}
