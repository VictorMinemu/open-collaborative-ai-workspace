import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  AgentChannelConnectorList,
  AgentChannelConnectorListResponse,
  AgentChannelHttpRequest,
  AgentChannelHttpResponse,
  AgentChannelToolRefusal,
  AgentTemplate,
  AgentTemplateLink,
  AgentTemplateList,
  AgentTemplateOptions,
  AgentTemplatePreview,
  AgentTemplateVersion,
  ConnectionStatus,
  ConnectorAuthMode,
  ConnectorErrorCode,
  ConnectorOAuthClientInput,
  ConnectorOAuthClientView,
  ConnectorOAuthStatus,
  ConnectSecretRequest,
  ConnectStartResponse,
  CreateMemberAccountShareRequest,
  connectorOAuthUrls,
  InstantiateAgentTemplateResponse,
  McpServer,
  McpServerList,
  MemberAccountShare,
  MemberAccountShareList,
  MemberConnector,
  MemberConnectorList,
  ReadersPreview,
  VaultItem,
  VaultItemList,
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
        "unit_audience",
        "not_connected",
        "needs_reconnect",
        "unknown_turn",
        "tainted",
      ]),
    );
    expect(AgentChannelToolRefusal.options).toHaveLength(14);
  });
});

const NOW = "2026-10-13T10:00:00.000Z";

const memberConnector = {
  serverId: ID,
  name: "Acme CRM",
  safeName: "m1a2b3c4d",
  authMode: "per_member_oauth",
  status: "connected",
  connectedAt: NOW,
  lastUsedAt: null,
  scopes: ["crm.read"],
  oauthStatus: "ready",
  secretHeaderName: null,
  secretHeaderPrefix: null,
  accountLabel: "sam@example.com",
  reconnectReason: null,
};

describe("member connections (D-01, R1, R2)", () => {
  it("a member connector shows the account it is connected as, or none for keys", () => {
    expect(MemberConnector.parse(memberConnector)).toEqual(memberConnector);
    const key = {
      ...memberConnector,
      authMode: "per_member_secret",
      oauthStatus: null,
      scopes: [],
      secretHeaderName: "X-Api-Key",
      secretHeaderPrefix: "",
      accountLabel: null,
    };
    expect(MemberConnector.parse(key)).toEqual(key);
    expect(MemberConnector.safeParse({ ...memberConnector, authMode: "org_secret" }).success).toBe(false);
  });

  it("says why a connection needs reconnecting, and nothing else", () => {
    for (const reconnectReason of ["expired", "revoked", "provider_changed"]) {
      expect(
        MemberConnector.safeParse({ ...memberConnector, status: "needs_reconnect", reconnectReason }).success,
        reconnectReason,
      ).toBe(true);
    }
    for (const reconnectReason of ["invalid_grant", "", "other"]) {
      expect(
        MemberConnector.safeParse({ ...memberConnector, status: "needs_reconnect", reconnectReason }).success,
        reconnectReason,
      ).toBe(false);
    }
  });

  it("the list carries the instance's OAuth URLs; connecting returns only where to go", () => {
    expect(
      MemberConnectorList.parse({
        connectors: [memberConnector],
        oauth: { redirectUri: "https://o.test/cb", clientMetadataUrl: null, oauthAvailable: true },
      }).connectors,
    ).toHaveLength(1);
    expect(ConnectStartResponse.parse({ authorizeUrl: "https://auth.example.com/authorize?x=1" })).toEqual({
      authorizeUrl: "https://auth.example.com/authorize?x=1",
    });
  });

  it("a member's key is write-only and never empty", () => {
    expect(ConnectSecretRequest.safeParse({ value: "" }).success).toBe(false);
    expect(ConnectSecretRequest.safeParse({ value: "x".repeat(8193) }).success).toBe(false);
    expect(ConnectSecretRequest.parse({ value: "sk-1" })).toEqual({ value: "sk-1" });
  });
});

describe("member-account shares (D-03, R7)", () => {
  const share = {
    id: ID,
    conversationId: ID2,
    conversationName: "#sales",
    resourceKind: "connector",
    resourceId: ID,
    resourceName: "Acme CRM",
    readersAtGrant: 7,
    grantedAt: NOW,
  };

  it("a share records the conversation, the account and the readers when granted", () => {
    expect(MemberAccountShare.parse(share)).toEqual(share);
    expect(MemberAccountShareList.parse({ shares: [share] }).shares).toHaveLength(1);
    expect(MemberAccountShare.safeParse({ ...share, resourceKind: "agent" }).success).toBe(false);
    expect(MemberAccountShare.safeParse({ ...share, readersAtGrant: -1 }).success).toBe(false);
  });

  it("creating names the conversation and the account, never a user", () => {
    const req = { conversationId: ID2, resourceKind: "vault_item", resourceId: ID };
    expect(CreateMemberAccountShareRequest.parse({ ...req, userId: ID })).toEqual(req);
  });

  it("the readers preview counts who would see results", () => {
    const preview = { conversationId: ID2, conversationName: null, readers: 12, unbounded: false };
    expect(ReadersPreview.parse(preview)).toEqual(preview);
  });
});

describe("Agent Channel http requests with a keychain handle (D-04)", () => {
  const req = {
    eventId: ID,
    agentId: ID2,
    handle: "k_abcdefgh23",
    method: "GET",
    url: "https://erp.example.com/v2/orders",
  };

  it("takes a handle, a method, an http(s) URL and bounded headers and body; never a user", () => {
    expect(AgentChannelHttpRequest.parse({ ...req, userId: ID })).toEqual(req);
    expect(AgentChannelHttpRequest.safeParse({ ...req, url: "ftp://erp.example.com/x" }).success).toBe(false);
    expect(AgentChannelHttpRequest.safeParse({ ...req, url: "file:///etc/passwd" }).success).toBe(false);
    expect(
      AgentChannelHttpRequest.safeParse({ ...req, url: `https://e.test/${"x".repeat(2048)}` }).success,
    ).toBe(false);
    expect(AgentChannelHttpRequest.safeParse({ ...req, method: "CONNECT" }).success).toBe(false);
    expect(AgentChannelHttpRequest.safeParse({ ...req, handle: "k_bad" }).success).toBe(false);
    expect(
      AgentChannelHttpRequest.safeParse({ ...req, method: "POST", body: "x".repeat(64 * 1024 + 1) }).success,
    ).toBe(false);
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    expect(AgentChannelHttpRequest.safeParse({ ...req, headers }).success).toBe(false);
    expect(
      AgentChannelHttpRequest.safeParse({
        ...req,
        headers: Object.fromEntries(Object.entries(headers).slice(0, 20)),
      }).success,
    ).toBe(true);
    expect(AgentChannelHttpRequest.safeParse({ ...req, headers: { "Bad Header": "v" } }).success).toBe(false);
    expect(AgentChannelHttpRequest.safeParse({ ...req, headers: { "X-A": "x".repeat(1025) } }).success).toBe(
      false,
    );
  });

  it("the response is bounded text with the redirect host only", () => {
    const res = {
      status: 302,
      contentType: null,
      body: "",
      truncated: false,
      redirectHost: "login.example.com",
    };
    expect(AgentChannelHttpResponse.parse(res)).toEqual(res);
    expect(AgentChannelHttpResponse.safeParse({ ...res, body: "x".repeat(256 * 1024 + 1) }).success).toBe(
      false,
    );
  });

  it("the connector list also names the turn's keys", () => {
    const list = {
      connectors: [
        {
          connector: "m1a2b3c4d",
          name: "Acme CRM",
          status: "connected",
          tools: [{ name: "whoami", description: "Who am I", inputSchema: null }],
        },
      ],
      keys: [{ handle: "k_abcdefgh23", name: "ERP", allowedHosts: ["erp.example.com"] }],
    };
    expect(AgentChannelConnectorListResponse.parse(list)).toEqual(list);
    expect(
      AgentChannelConnectorListResponse.safeParse({ ...list, keys: Array(33).fill(list.keys[0]) }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- leak shape (D-06, T-07.4-01-01)

const SECRET_KEYS = new Set([
  "value",
  "token",
  "secret",
  "password",
  "clientSecret",
  "accessToken",
  "refreshToken",
]);

/** Every object key reachable in a Zod schema: objects, arrays, records, unions, wrappers, pipes and intersections. */
function schemaKeys(schema: z.ZodType, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  const walk = (s: unknown) => schemaKeys(s as z.ZodType, seen);
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      return Object.entries(shape).flatMap(([k, v]) => [k, ...walk(v)]);
    }
    case "array":
      return walk(def.element);
    case "record":
      return walk(def.valueType);
    case "union":
      return (def.options as z.ZodType[]).flatMap(walk);
    case "intersection":
      return [...walk(def.left), ...walk(def.right)];
    case "pipe":
      return [...walk(def.in), ...walk(def.out)];
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
      return walk(def.innerType);
    case "lazy":
      return walk((def.getter as () => unknown)());
    default:
      return [];
  }
}

describe("no response schema of 07.4 can carry a secret (D-06, CONN-05)", () => {
  const responses: Record<string, z.ZodType> = {
    MemberConnector,
    MemberConnectorList,
    ConnectStartResponse,
    MemberAccountShare,
    MemberAccountShareList,
    ReadersPreview,
    VaultItem,
    VaultItemList,
    AgentTemplate,
    AgentTemplateVersion,
    AgentTemplateList,
    AgentTemplatePreview,
    AgentTemplateLink,
    AgentTemplateOptions,
    InstantiateAgentTemplateResponse,
    McpServer,
    McpServerList,
    AgentChannelConnectorListResponse,
    AgentChannelConnectorCallResponse,
    AgentChannelHttpResponse,
  };

  for (const [name, schema] of Object.entries(responses)) {
    it(`${name} has no secret-named key`, () => {
      const keys = schemaKeys(schema);
      expect(keys.length, name).toBeGreaterThan(0);
      expect(
        keys.filter((k) => SECRET_KEYS.has(k)),
        name,
      ).toEqual([]);
    });
  }

  it("the walker sees through wrappers and finds request secrets (self-test)", () => {
    expect(schemaKeys(ConnectSecretRequest)).toContain("value");
    expect(schemaKeys(McpServer)).toContain("hasSecret");
    expect(schemaKeys(InstantiateAgentTemplateResponse)).toContain("instructions");
  });
});
