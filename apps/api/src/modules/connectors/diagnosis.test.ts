import { ConnectorAuthFailure, ConnectorErrorCode } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { authFailureOf } from "./diagnosis";
import { ConnectorOAuthError } from "./oauth";

/** Unit tests of the D-10 failure mapping and the Test sign-in run (07.14-04). */

describe("authFailureOf (07.14 D-10)", () => {
  it("the member codes stay exactly the 07.4 set (COA-05)", () => {
    expect(ConnectorErrorCode.options).toEqual([
      "https_required",
      "discovery_failed",
      "pkce_unsupported",
      "needs_client",
      "egress_refused",
      "flow_expired",
      "session_mismatch",
      "access_denied",
      "issuer_mismatch",
      "token_exchange_failed",
      "not_connected",
      "needs_reconnect",
    ]);
  });

  it("a step wins over the code", () => {
    for (const step of ConnectorAuthFailure.options) {
      expect(authFailureOf(new ConnectorOAuthError("discovery_failed", { step }))).toBe(step);
    }
    expect(authFailureOf(new ConnectorOAuthError("egress_refused", { step: "discovery_failed" }))).toBe(
      "discovery_failed",
    );
  });

  it("without a step, the code decides", () => {
    const rows: Array<[ConnectorErrorCode, ConnectorAuthFailure]> = [
      ["https_required", "https_required"],
      ["discovery_failed", "discovery_failed"],
      ["pkce_unsupported", "pkce_unsupported"],
      ["issuer_mismatch", "issuer_mismatch"],
      ["token_exchange_failed", "token_exchange_failed"],
      ["needs_client", "client_registration_unavailable"],
      ["egress_refused", "token_endpoint_untrusted"],
      ["needs_reconnect", "token_exchange_failed"],
      ["access_denied", "token_exchange_failed"],
    ];
    for (const [code, failure] of rows) expect(authFailureOf(new ConnectorOAuthError(code))).toBe(failure);
  });

  it("anything that is not a ConnectorOAuthError is token_exchange_failed, its text never read", () => {
    for (const err of [
      new Error("discovery_failed"),
      new TypeError("x"),
      "pkce_unsupported",
      null,
      undefined,
    ]) {
      expect(authFailureOf(err)).toBe("token_exchange_failed");
    }
  });
});
