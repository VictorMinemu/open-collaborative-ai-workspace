import type { ConnectorAuthFailure, ConnectorErrorCode } from "@ocw/contracts";
import { ConnectorOAuthError } from "./oauth";

/**
 * Sign-in diagnosis (07.14 D-10, D-18): which step of an organization sign-in, a client-credentials grant or a Test
 * sign-in failed, as one of the eight `ConnectorAuthFailure` codes in their fixed order (public URL → discovery →
 * issuer → endpoints → PKCE → client registration → token). The answer is always a closed code: provider error
 * bodies, `error_description` and SDK messages are never read into a code, a step or a response. Member flows keep
 * their 07.4 `ConnectorErrorCode` unchanged (COA-05); only the organization paths and the Test sign-in read these.
 */

/** The D-10 code of a 07.4 code, for an error whose throw site named no step. */
const FROM_CODE: Partial<Record<ConnectorErrorCode, ConnectorAuthFailure>> = {
  https_required: "https_required",
  discovery_failed: "discovery_failed",
  pkce_unsupported: "pkce_unsupported",
  issuer_mismatch: "issuer_mismatch",
  token_exchange_failed: "token_exchange_failed",
  needs_client: "client_registration_unavailable",
  egress_refused: "token_endpoint_untrusted",
};

/**
 * The D-10 failure an error stands for: its `step` when the throw site set one, else derived from its code; anything
 * that is not a `ConnectorOAuthError` (or a code with no D-10 meaning) is `token_exchange_failed`. Pure: no I/O, and
 * the error's message is never read.
 */
export function authFailureOf(err: unknown): ConnectorAuthFailure {
  if (!(err instanceof ConnectorOAuthError)) return "token_exchange_failed";
  return err.step ?? FROM_CODE[err.code] ?? "token_exchange_failed";
}
