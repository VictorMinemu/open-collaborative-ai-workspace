import { randomBytes } from "node:crypto";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

/**
 * Standard Webhooks verification (07.6-10; D-02, D-07, Pitfall 4). The HMAC, the constant-time comparison, the
 * space-separated `v1,` signature list and the ±5-minute timestamp window are the `standardwebhooks` library's; this
 * file only tries each valid secret (current, then the previous one during a rotation's grace) and names the failed
 * check for the endpoint owner's rejection line. Nothing here logs or returns the body, a header or a secret.
 */

/** Why a request was refused: the reason the owner sees (R4); the sender always gets the same 401. */
export type WebhookRejection = "signature" | "timestamp";

export type WebhookVerification =
  | {
      ok: true;
      /** The `webhook-id` header: the idempotency key of the delivery. */
      id: string;
      /** The parsed JSON body, `undefined` when the verified body is empty, not JSON or not storable (`parseJson`). */
      payload: unknown;
    }
  | { ok: false; reason: WebhookRejection };

const TIMESTAMP_ERRORS = new Set(["Message timestamp too old", "Message timestamp too new"]);

/**
 * Verifies `raw` (the exact request bytes) against the three Standard Webhooks headers with each secret in turn.
 * Missing headers, a malformed timestamp or no matching signature are `signature`; a timestamp outside the window is
 * `timestamp` (the library checks it before the signature, for every secret alike).
 */
export function verifyStandardWebhook(
  raw: Buffer,
  headers: Record<string, string | undefined>,
  secrets: readonly string[],
): WebhookVerification {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (!id || !timestamp || !signature) return { ok: false, reason: "signature" };
  const required = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
  for (const secret of secrets) {
    try {
      new Webhook(secret).verify(raw, required, { jsonParse: false });
      return { ok: true, id, payload: parseJson(raw) };
    } catch (err) {
      if (err instanceof WebhookVerificationError && TIMESTAMP_ERRORS.has(err.message)) {
        return { ok: false, reason: "timestamp" };
      }
      // Any other failure (no matching signature, a malformed header or secret) tries the next secret.
    }
  }
  return { ok: false, reason: "signature" };
}

/**
 * The verified body as storable JSON (07.6 review A LO-04), or `undefined` (the route answers 400, like a non-JSON body):
 * - an integer beyond 2^53 keeps its exact digits as a string (the reviver reads the source text), so a 64-bit order
 *   or ticket id never rounds onto another one and merges two threads;
 * - a lone surrogate or U+0000 in any string or key is refused: PostgreSQL `jsonb` rejects both, and a 500 would be
 *   retried by the sender forever.
 */
function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"), exactIntegers as Reviver);
    return storable(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

type Reviver = (this: unknown, key: string, value: unknown) => unknown;

/** `JSON.parse`'s reviver with the source text of a primitive (Node 22+). */
function exactIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  return source && /^-?\d+$/.test(source) ? source : value;
}

/** A lone surrogate (a `u`-mode class matches only unpaired halves) or U+0000. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is exactly what jsonb refuses.
const UNSTORABLE = /[\uD800-\uDFFF\u0000]/u;

/** True when no string or key of `value` holds a character `jsonb` refuses. Iterative: any nesting depth. */
function storable(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (UNSTORABLE.test(v)) return false;
    } else if (Array.isArray(v)) {
      for (const child of v) stack.push(child);
    } else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (UNSTORABLE.test(k)) return false;
        stack.push(child);
      }
    }
  }
  return true;
}

/** A new signing secret: `whsec_` + base64 of 32 random bytes (Standard Webhooks' format). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new public id: 128 random bits as 26 Crockford base32 characters (upper case), the unguessable URL segment. */
export function newPublicId(): string {
  let n = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** A public id as stored (upper case), or null when the segment cannot be one (the route answers 404). */
export function normalizePublicId(segment: string): string | null {
  const upper = segment.toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(upper) ? upper : null;
}
