import { z } from "zod";
import { IsoDateTime } from "./common";
import { DevicePlatform, EnrollDeviceResponse } from "./device";

/**
 * Phase 07.12 (headless Work Zone server, HSR-03, D-03, D-13): terminal pairing by device code, the user-facing slice of
 * RFC 8628. A server runs `ocw-runtime enroll --server <url>` (or `setup`) without a code: it starts a pairing, prints
 * the short user code and the verification link, and polls the token route with the device code until the owner
 * approves or denies it, signed in, in Settings › Devices. Approval creates the device for the approving user exactly
 * like the typed-code flow (`POST /api/v1/devices/enroll`, unchanged).
 *
 * Two secrets with different roles:
 * - the **device code** is the poll secret: random, long, only ever sent in request bodies between the runtime and the
 *   API, never shown to people, never logged, never stored (the API keeps only its hash);
 * - the **user code** is what a person compares and types: 8 Crockford base32 symbols (40 bits), shown `XXXX-XXXX`,
 *   valid 10 minutes, single use, rate-limited.
 *
 * Sent by `apps/local-runtime` (07.12-03), answered by the API's device module (07.12-02), shown and approved by the web
 * (07.12-07). Imports `zod`, `./common` and `./device`.
 */

// ---- user codes (D-03) ----

/**
 * Crockford base32: 32 symbols, no I, L, O or U (O reads as 0, I and L as 1; U is left out against accidental words).
 * Device-code user codes only; the typed-code flow keeps its own 31-symbol alphabet in the API.
 */
export const USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 8 symbols × 5 bits = 40 bits (D-03 asks ≥ 40). */
export const USER_CODE_LENGTH = 8;

const USER_CODE_SYMBOLS = new Set(USER_CODE_ALPHABET);

/**
 * The canonical user code (8 upper-case Crockford symbols, no separator) for what a person typed: trimmed, upper-cased,
 * spaces and `-` dropped, O read as 0, I and L as 1. Null for U, any other symbol outside the alphabet, or a length
 * other than 8.
 */
export function normalizeUserCode(text: string): string | null {
  const canonical = text
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (canonical.length !== USER_CODE_LENGTH) return null;
  for (const symbol of canonical) if (!USER_CODE_SYMBOLS.has(symbol)) return null;
  return canonical;
}

/** `ABCDEFGH` → `ABCD-EFGH`: how a user code is shown (terminal, web, verification link). */
export function formatUserCode(canonical: string): string {
  const half = USER_CODE_LENGTH / 2;
  return `${canonical.slice(0, half)}-${canonical.slice(half)}`;
}

/** A user code as a person may type it (`abcd-efgh`, `ABCD EFGH`, `ABCDEFGH`); normalize before any lookup. */
export const UserCodeInput = z
  .string()
  .trim()
  .min(8)
  .max(16)
  .refine((s) => normalizeUserCode(s) !== null, { message: "not a valid pairing code" });
export type UserCodeInput = z.infer<typeof UserCodeInput>;

const FormattedUserCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
const DeviceCode = z.string().min(32).max(128);
const DeviceName = z.string().trim().min(1).max(80);

// ---- timing (PD-06) ----

/** A pending pairing lives 10 minutes (D-03). */
export const PAIRING_TTL_SECONDS = 600;
/** The runtime polls the token route at most every 5 seconds (RFC 8628 `interval`). */
export const PAIRING_INTERVAL_SECONDS = 5;
/** On `slow_down` the runtime adds 5 seconds to its interval (RFC 8628 §3.5). */
export const PAIRING_SLOW_DOWN_STEP_SECONDS = 5;

// ---- start (public, the runtime) ----

/** `POST /api/v1/devices/pairings` (public, rate-limited per IP): the runtime asks for a pairing. */
export const StartPairingRequest = z.strictObject({
  /** The name the runtime proposes (the hostname by default); the approver may change it. */
  name: DeviceName,
  platform: DevicePlatform,
  runtimeVersion: z.string().max(64).optional(),
});
export type StartPairingRequest = z.infer<typeof StartPairingRequest>;

/**
 * The answer to a start. `deviceCode` is the poll secret (never shown to people); `userCode` is shown `XXXX-XXXX` with
 * `verificationUri` (Settings › Devices) and `verificationUriComplete` (the same page with `?pair=<userCode>`).
 */
export const StartPairingResponse = z.object({
  deviceCode: DeviceCode,
  userCode: FormattedUserCode,
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type StartPairingResponse = z.infer<typeof StartPairingResponse>;

// ---- token (public, the runtime polls) ----

/** `POST /api/v1/devices/pairings/token` (public): the device code goes in the body, never in a URL. */
export const PairingTokenRequest = z.strictObject({ deviceCode: DeviceCode });
export type PairingTokenRequest = z.infer<typeof PairingTokenRequest>;

/**
 * RFC 8628 §3.5 error codes, answered as HTTP 400 in the API's `{ error: { code, message } }` envelope: keep polling,
 * poll slower, the owner denied it, or it expired / was already used / was never started (start again).
 */
export const PairingErrorCode = z.enum([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);
export type PairingErrorCode = z.infer<typeof PairingErrorCode>;

/** An approved pairing answers exactly like the typed-code enroll: the device, its org and its token (once). */
export const PairingTokenResponse = EnrollDeviceResponse;
export type PairingTokenResponse = z.infer<typeof PairingTokenResponse>;

// ---- lookup, approve, deny (signed-in user with `device.pair`, the web) ----

/** `POST /api/v1/devices/pairings/lookup`: the web shows what is asking before anyone approves it. */
export const PairingLookupRequest = z.strictObject({ userCode: UserCodeInput });
export type PairingLookupRequest = z.infer<typeof PairingLookupRequest>;

/** `POST /api/v1/devices/pairings/approve`: the approver chooses the device's name; audited. */
export const ApprovePairingRequest = z.strictObject({ userCode: UserCodeInput, name: DeviceName });
export type ApprovePairingRequest = z.infer<typeof ApprovePairingRequest>;

/** `POST /api/v1/devices/pairings/deny`: audited; the polling runtime gets `access_denied`. */
export const DenyPairingRequest = z.strictObject({ userCode: UserCodeInput });
export type DenyPairingRequest = z.infer<typeof DenyPairingRequest>;

/**
 * A pending pairing as the approver sees it (anti-phishing: compare the code, the name, the platform, where the request
 * came from and how long ago, RFC 8628 §5.4). Never carries the device code.
 */
export const PairingRequestView = z.object({
  userCode: FormattedUserCode,
  name: z.string().max(80),
  platform: DevicePlatform,
  runtimeVersion: z.string().max(64).nullable(),
  requestIp: z.string().max(64).nullable(),
  requestedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type PairingRequestView = z.infer<typeof PairingRequestView>;
