import { describe, expect, it } from "vitest";
import {
  AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  AgentChannelConnectorList,
  AgentChannelToolRefusal,
  ConnectionStatus,
  ConnectorAuthMode,
  ConnectorErrorCode,
  ConnectorOAuthClientInput,
  ConnectorOAuthClientView,
  ConnectorOAuthStatus,
  connectorOAuthUrls,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("connector vocabulary (07.4 D-01, CONN-01)", () => {
  it("names the three auth modes, the OAuth and connection states and the error codes", () => {
    expect(ConnectorAuthMode.options).toEqual(["org_secret", "per_member_oauth", "per_member_secret"]);
    expect(ConnectorOAuthStatus.options).toEqual(["ready", "needs_client", "https_required", "error"]);
    expect(ConnectionStatus.options).toEqual(["not_connected", "connected", "needs_reconnect"]);
    expect(ConnectorErrorCode.options).toEqual(
      expect.arrayContaining(["https_required", "pkce_unsupported", "issuer_mismatch", "needs_reconnect"]),
    );
    expect(ConnectorErrorCode.options).toHaveLength(12);
  });

  it("an OAuth client takes its secret write-only and shows only whether one is stored", () => {
    expect(
      ConnectorOAuthClientInput.parse({
        issuer: "https://auth.example.com",
        clientId: "ocw",
        clientSecret: "s",
      }),
    ).toEqual({ issuer: "https://auth.example.com", clientId: "ocw", clientSecret: "s" });
    expect(ConnectorOAuthClientInput.safeParse({ issuer: "not a url", clientId: "ocw" }).success).toBe(false);
    expect(ConnectorOAuthClientInput.safeParse({ issuer: "https://a.test", clientId: "" }).success).toBe(
      false,
    );
    expect(
      ConnectorOAuthClientInput.safeParse({ issuer: "https://a.test", clientId: "x".repeat(257) }).success,
    ).toBe(false);
    const view = ConnectorOAuthClientView.parse({
      issuer: "https://auth.example.com",
      clientId: "ocw",
      hasSecret: true,
      method: "pre_registered",
      clientSecret: "leak",
    });
    expect(view).toEqual({
      issuer: "https://auth.example.com",
      clientId: "ocw",
      hasSecret: true,
      method: "pre_registered",
    });
    expect(ConnectorOAuthClientView.safeParse({ ...view, method: "manual" }).success).toBe(false);
  });
});

describe("connectorOAuthUrls (D-02: redirect on the API, CIMD only over https)", () => {
  it("a public https URL gives the callback, the client metadata document and OAuth", () => {
    expect(connectorOAuthUrls("https://ocw.example.com")).toEqual({
      redirectUri: "https://ocw.example.com/api/v1/connectors/oauth/callback",
      clientMetadataUrl: "https://ocw.example.com/api/v1/connectors/oauth/client-metadata.json",
      oauthAvailable: true,
    });
  });

  it("loopback over http still offers OAuth (redirects to localhost are allowed), without CIMD", () => {
    for (const base of ["http://127.0.0.1:4290", "http://localhost:4000", "http://[::1]:4000"]) {
      const urls = connectorOAuthUrls(base);
      expect(urls.oauthAvailable, base).toBe(true);
      expect(urls.clientMetadataUrl, base).toBeNull();
      expect(urls.redirectUri, base).toBe(`${base}/api/v1/connectors/oauth/callback`);
    }
  });

  it("plain http on a LAN name cannot offer OAuth", () => {
    expect(connectorOAuthUrls("http://ocw.lan")).toEqual({
      redirectUri: "http://ocw.lan/api/v1/connectors/oauth/callback",
      clientMetadataUrl: null,
      oauthAvailable: false,
    });
  });

  it("handles a trailing slash and a path prefix, and drops query and fragment", () => {
    expect(connectorOAuthUrls("https://ocw.example.com/").redirectUri).toBe(
      "https://ocw.example.com/api/v1/connectors/oauth/callback",
    );
    expect(connectorOAuthUrls("https://example.com/ocw/").clientMetadataUrl).toBe(
      "https://example.com/ocw/api/v1/connectors/oauth/client-metadata.json",
    );
    expect(connectorOAuthUrls("https://example.com/ocw?x=1#y").redirectUri).toBe(
      "https://example.com/ocw/api/v1/connectors/oauth/callback",
    );
  });

  it("an unusable public URL offers nothing", () => {
    for (const base of ["", "not a url", "ftp://ocw.example.com"]) {
      expect(connectorOAuthUrls(base).oauthAvailable, base).toBe(false);
      expect(connectorOAuthUrls(base).clientMetadataUrl, base).toBeNull();
    }
  });
});

describe("Agent Channel connector tools (D-02, D-07: the requester is the stored turn's human)", () => {
  const call = { eventId: ID, agentId: ID2, connector: "m1a2b3c4d", tool: "whoami", arguments: { q: 1 } };

  it("a connector call names a safe connector name and a tool, never a user", () => {
    expect(AgentChannelConnectorCall.parse(call)).toEqual(call);
    const stripped = AgentChannelConnectorCall.parse({ ...call, userId: ID, ownerUserId: ID });
    expect(stripped).not.toHaveProperty("userId");
    expect(stripped).not.toHaveProperty("ownerUserId");
    for (const connector of ["Acme", "m1a2b3c4", "m1a2b3c4dd", "M1A2B3C4D", "x1a2b3c4d", "m1a2b3c4g"]) {
      expect(AgentChannelConnectorCall.safeParse({ ...call, connector }).success, connector).toBe(false);
    }
    expect(AgentChannelConnectorCall.safeParse({ ...call, tool: "" }).success).toBe(false);
    expect(AgentChannelConnectorCall.safeParse({ ...call, tool: "t".repeat(129) }).success).toBe(false);
    expect(
      AgentChannelConnectorCall.parse({ eventId: ID, agentId: ID2, connector: "m1a2b3c4d", tool: "x" })
        .arguments,
    ).toEqual({});
  });

  it("refuses arguments over 32 KB serialized", () => {
    expect(
      AgentChannelConnectorCall.safeParse({ ...call, arguments: { text: "x".repeat(32 * 1024) } }).success,
    ).toBe(false);
    expect(
      AgentChannelConnectorCall.safeParse({ ...call, arguments: { text: "x".repeat(32 * 1024 - 20) } })
        .success,
    ).toBe(true);
  });

  it("the list body names only the delivery and the agent", () => {
    expect(AgentChannelConnectorList.parse({ eventId: ID, agentId: ID2, userId: ID })).toEqual({
      eventId: ID,
      agentId: ID2,
    });
  });

  it("the call response is bounded text", () => {
    expect(
      AgentChannelConnectorCallResponse.parse({ content: "hi", truncated: false, isError: false }),
    ).toEqual({ content: "hi", truncated: false, isError: false });
    expect(
      AgentChannelConnectorCallResponse.safeParse({
        content: "x".repeat(32 * 1024 + 1),
        truncated: true,
        isError: false,
      }).success,
    ).toBe(false);
  });

  it("refusal codes include the member-account cases", () => {
    expect(AgentChannelToolRefusal.options).toEqual(
      expect.arrayContaining([
        "member_account",
        "not_connected",
        "needs_reconnect",
        "unknown_turn",
        "tainted",
      ]),
    );
    expect(AgentChannelToolRefusal.options).toHaveLength(13);
  });
});
