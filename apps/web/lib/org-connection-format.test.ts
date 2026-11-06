import { AUTH_FAILURE_FIX, authFailureFix, type OrgConnection, OrgSignInError } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  arrivalBanner,
  disconnectCopy,
  failureBox,
  notConnectedLine,
  orgConnectionLine,
  orgConnectionStatus,
  orgDeleteSentence,
  reasonLine,
  stepLabel,
  stepOfFailure,
} from "./org-connection-format";

const NOW = Date.parse("2026-11-06T12:00:00Z");

function conn(over: Partial<OrgConnection> = {}): OrgConnection {
  return {
    method: "oauth",
    status: "connected",
    accountLabel: "alice@acme.test",
    clientId: null,
    tokenEndpoint: null,
    scopes: [],
    connectedBy: { id: "00000000-0000-4000-8000-000000000001", name: "Víctor" },
    connectedAt: new Date(NOW).toISOString(),
    lastUsedAt: null,
    reconnectReason: null,
    hasSecret: false,
    ...over,
  };
}

describe("orgConnectionLine", () => {
  it("names the account, who connected it and when", () => {
    expect(orgConnectionLine(conn(), NOW)).toBe("Connected as alice@acme.test · by Víctor · just now");
  });

  it("says Connected without an account label", () => {
    expect(orgConnectionLine(conn({ accountLabel: null }), NOW)).toBe("Connected · by Víctor · just now");
  });

  it("names the client for client credentials", () => {
    expect(
      orgConnectionLine(
        conn({ method: "client_credentials", accountLabel: null, clientId: "ocw-e2e-cc", hasSecret: true }),
        NOW,
      ),
    ).toBe("Client ocw-e2e-cc · by Víctor · just now");
  });

  it("drops the parts it does not know", () => {
    expect(orgConnectionLine(conn({ connectedBy: null, connectedAt: null }), NOW)).toBe(
      "Connected as alice@acme.test",
    );
    const hourAgo = new Date(NOW - 3_600_000).toISOString();
    expect(orgConnectionLine(conn({ connectedAt: hourAgo }), NOW)).toBe(
      "Connected as alice@acme.test · by Víctor · 1 hour ago",
    );
  });
});

describe("orgConnectionStatus and the not-connected line", () => {
  it("reads null as not connected", () => {
    expect(orgConnectionStatus(null)).toBe("not_connected");
    expect(orgConnectionStatus(conn())).toBe("connected");
    expect(orgConnectionStatus(conn({ status: "needs_reconnect", reconnectReason: "revoked" }))).toBe(
      "needs_reconnect",
    );
  });

  it("says what bots cannot do until an admin connects", () => {
    expect(notConnectedLine("org_oauth", "Acme")).toBe(
      "Not connected. Bots can't use Acme until an admin connects it.",
    );
    expect(notConnectedLine("org_client_credentials", "Acme")).toBe("No client credentials yet.");
  });
});

describe("reasonLine", () => {
  it("explains each reconnect reason", () => {
    expect(reasonLine("revoked")).toBe("Access was revoked at the provider.");
    expect(reasonLine("expired")).toBe("The sign-in expired.");
    expect(reasonLine("provider_changed")).toBe("The provider's sign-in server changed.");
    expect(reasonLine(null)).toBe("The sign-in expired.");
  });
});

describe("steps", () => {
  it("labels the seven steps", () => {
    expect(stepLabel("public_url")).toBe("This workspace's address");
    expect(stepLabel("discovery")).toBe("Sign-in information");
    expect(stepLabel("issuer")).toBe("Sign-in server identity");
    expect(stepLabel("endpoints")).toBe("Secure endpoints");
    expect(stepLabel("pkce")).toBe("PKCE (S256)");
    expect(stepLabel("client_registration")).toBe("Client registration");
    expect(stepLabel("token")).toBe("Token");
  });

  it("maps every failure code to its step", () => {
    expect(stepOfFailure("https_required")).toBe("public_url");
    expect(stepOfFailure("discovery_failed")).toBe("discovery");
    expect(stepOfFailure("issuer_mismatch")).toBe("issuer");
    expect(stepOfFailure("token_endpoint_untrusted")).toBe("endpoints");
    expect(stepOfFailure("pkce_unsupported")).toBe("pkce");
    expect(stepOfFailure("client_registration_unavailable")).toBe("client_registration");
    expect(stepOfFailure("scope_rejected")).toBe("token");
    expect(stepOfFailure("token_exchange_failed")).toBe("token");
  });
});

describe("failureBox", () => {
  it("names the failed step and carries the contract's fix line", () => {
    expect(failureBox("pkce_unsupported", "Acme")).toEqual({
      title: "Last sign-in failed: PKCE (S256).",
      fix: authFailureFix("pkce_unsupported", "Acme"),
    });
  });
});

describe("arrivalBanner", () => {
  it("confirms a connection for the organization", () => {
    expect(arrivalBanner({ connected: "x" }, "Acme")).toEqual({
      kind: "success",
      title: "Connected Acme for the organization.",
      body: null,
    });
  });

  it("names the failed step with its fix line", () => {
    expect(arrivalBanner({ error: "pkce_unsupported" }, "Acme")).toEqual({
      kind: "error",
      title: "Couldn't connect Acme: PKCE (S256).",
      body: authFailureFix("pkce_unsupported", "Acme"),
    });
  });

  it("ignores unknown codes, so provider text is never shown", () => {
    expect(arrivalBanner({ error: "server_error" }, "Acme")).toBeNull();
    expect(arrivalBanner({ error: "<b>pwned</b>" }, "Acme")).toBeNull();
    expect(arrivalBanner({}, "Acme")).toBeNull();
  });

  it("never reads a fix line from anywhere but the contract", () => {
    for (const code of Object.keys(AUTH_FAILURE_FIX) as Array<keyof typeof AUTH_FAILURE_FIX>) {
      expect(arrivalBanner({ error: code }, "Acme")?.body).toBe(authFailureFix(code, "Acme"));
    }
  });
});

describe("every organization sign-in outcome", () => {
  it("maps every OrgSignInError value to a banner", () => {
    for (const code of OrgSignInError.options.flatMap((o) => o.options)) {
      const b = arrivalBanner({ error: code }, "Acme");
      expect(b, code).not.toBeNull();
      expect(b?.kind).toBe("error");
    }
  });

  it("says the three user outcomes in their own sentences, without a fix line", () => {
    expect(arrivalBanner({ error: "access_denied" }, "Acme")).toEqual({
      kind: "error",
      title: "Acme didn't allow access.",
      body: null,
    });
    expect(arrivalBanner({ error: "flow_expired" }, "Acme")?.title).toBe(
      "That sign-in took too long or was already used. Try Connect again.",
    );
    expect(arrivalBanner({ error: "session_mismatch" }, "Acme")?.title).toBe(
      "That sign-in was started from another account. Sign in as the admin who started it and try again.",
    );
  });
});

describe("disconnect and delete copy", () => {
  it("names the server", () => {
    expect(orgDeleteSentence("Acme")).toBe("The organization's sign-in to Acme is deleted too.");
    expect(disconnectCopy("Acme")).toEqual({
      title: "Disconnect Acme?",
      body: "Bots stop using the organization's account on Acme. OCW also signs it out at the provider when it can.",
    });
  });
});
