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
      /** The parsed JSON body, `undefined` when the verified body is empty or not JSON. */
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

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
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
