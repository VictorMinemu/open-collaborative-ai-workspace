import {
  isAllowedInjectionHeader,
  VaultApiKeySecret,
  VaultBasicSecret,
  type VaultInjection,
  type VaultKind,
  VaultOAuthSecret,
  vaultHostAllowed,
} from "@ocw/contracts";
import { z } from "zod";

/**
 * Pure keychain helpers (Phase 07.4, D-04, D-07 item 3): which URLs a key may go to, how the header is built from the
 * stored secret, which model-supplied headers are dropped, and every string the proxy must redact from a response.
 * Nothing here reads the database or the network.
 */

/** What is sealed in `app.secrets` for one keychain item (JSON, AAD `${org}:vault:${itemId}`). Never returned. */
export const StoredSecret = z.discriminatedUnion("kind", [
  VaultApiKeySecret.extend({ kind: z.literal("api_key") }),
  VaultBasicSecret.extend({ kind: z.literal("basic") }),
  VaultOAuthSecret.extend({ kind: z.literal("oauth") }),
]);
export type StoredSecret = z.infer<typeof StoredSecret>;
export type StoredOAuthSecret = Extract<StoredSecret, { kind: "oauth" }>;

/** A keychain refusal; the message names the code only, never a value, a path or a host. */
export class KeychainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Keychain refused: ${code}`);
    this.name = "KeychainError";
    this.code = code;
  }
}

/**
 * True when `url` may receive the key: http(s), no userinfo, the host equals a pattern or is a strict subdomain of a
 * `*.` pattern, and the port is the pattern's (or the scheme's default when the pattern has none).
 */
export function hostAllowed(patterns: readonly string[], url: URL): boolean {
  return vaultHostAllowed(patterns, url.href);
}

/**
 * True when the URL's path (already normalised by `URL`: `..` and `%2e%2e` segments resolved) lies under `prefix`, on
 * a segment boundary: `/v1/` and `/v1` both accept `/v1/items` and refuse `/v10`. No prefix = any path.
 */
export function pathAllowed(prefix: string | null, url: URL): boolean {
  if (prefix === null || prefix === "" || prefix === "/") return true;
  const path = url.pathname;
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === base || path.startsWith(`${base}/`);
}

/** Header names a model may never set on a keychain request (credentials, cookies, routing, framing, hop-by-hop). */
const DROPPED_MODEL_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: header values must never carry control characters
const BAD_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * The model's headers minus every one that could override or leak the injected credential: `authorization`, `cookie`,
 * `host`, `proxy-*`, framing and hop-by-hop headers, the injected header's own name (case-insensitive), invalid names
 * and values carrying control characters.
 */
export function sanitizeModelHeaders(
  h: Record<string, string>,
  injectedHeader: string,
): Record<string, string> {
  const injected = injectedHeader.toLowerCase();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || typeof value !== "string" || BAD_VALUE.test(value)) continue;
    if (DROPPED_MODEL_HEADERS.has(lower) || lower.startsWith("proxy-") || lower === injected) continue;
    out[name] = value;
  }
  return out;
}

const basicToken = (user: string, pass: string) => Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

/**
 * The header the API attaches: `api_key` → `Bearer <value>` (or the raw value), `basic` → `Basic base64(user:pass)`,
 * `oauth` → `Bearer <token>` (or the raw token) from the client-credentials exchange. The header name must pass
 * `isAllowedInjectionHeader` (never cookie, host, framing or `proxy-*`).
 */
export function buildInjectionHeader(
  kind: VaultKind,
  inj: VaultInjection,
  secret: StoredSecret,
  token?: string,
): { name: string; value: string } {
  if (!isAllowedInjectionHeader(inj.header)) throw new KeychainError("injection_header");
  if (secret.kind !== kind) throw new KeychainError("value_unavailable");
  if (secret.kind === "basic") {
    return { name: "Authorization", value: `Basic ${basicToken(secret.username, secret.password)}` };
  }
  let credential: string;
  if (secret.kind === "api_key") credential = secret.value;
  else {
    if (!token) throw new KeychainError("token_missing");
    credential = token;
  }
  if (inj.scheme === "basic") throw new KeychainError("injection_scheme");
  const value = inj.scheme === "raw" ? credential : `Bearer ${credential}`;
  if (BAD_VALUE.test(value)) throw new KeychainError("injection_value");
  return { name: inj.header, value };
}

/**
 * Every string the proxy must redact from a response before the model sees it: the header value, the raw value or
 * token, passwords and client secrets, and the base64 forms of `user:pass` / `id:secret` (standard and URL-safe).
 * Longest first, so a redactor replacing them in order never leaves a fragment of a longer part.
 */
export function secretParts(secret: StoredSecret, headerValue: string, token?: string): string[] {
  const parts = new Set<string>([headerValue]);
  const add64 = (raw: string) => {
    const b64 = Buffer.from(raw, "utf8").toString("base64");
    parts.add(b64);
    parts.add(b64.replace(/=+$/, ""));
    parts.add(Buffer.from(raw, "utf8").toString("base64url"));
  };
  switch (secret.kind) {
    case "api_key":
      parts.add(secret.value);
      add64(secret.value);
      break;
    case "basic":
      parts.add(secret.password);
      parts.add(`${secret.username}:${secret.password}`);
      add64(`${secret.username}:${secret.password}`);
      break;
    case "oauth":
      parts.add(secret.clientSecret);
      add64(`${secret.clientId}:${secret.clientSecret}`);
      add64(`${encodeURIComponent(secret.clientId)}:${encodeURIComponent(secret.clientSecret)}`);
      break;
  }
  if (token) parts.add(token);
  return [...parts].filter((p) => p.length > 0).sort((a, b) => b.length - a.length);
}
