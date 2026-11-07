import { describe, expect, it } from "vitest";
import {
  AgentChannelEventTypes,
  AgentChannelMcpProbeResult,
  AuthTestStep,
  CellMcpServer,
  CellSnapshot,
  CreateMcpServerRequest,
  CreatePermissionRuleRequest,
  McpHeaderInput,
  McpProbeEvent,
  McpServer,
  McpServerList,
  McpServerTool,
  OAuthTestRequest,
  OAuthTestResponse,
  UpdateMcpServerRequest,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = "2026-10-05T10:00:00.000Z";

const server = {
  id: ID,
  name: "Docs",
  safeName: "m3f9a12c4",
  transport: "streamable-http",
  url: "https://mcp.example.com/mcp",
  sandboxServer: null,
  headers: [{ name: "Authorization", hasValue: true }],
  orgEnabled: true,
  personalAllowed: false,
  trustedChaining: false,
  status: "ready",
  statusDetail: null,
  probedAt: NOW,
  tools: [
    {
      name: "echo",
      openclawName: "m3f9a12c4__echo",
      title: null,
      description: "Echo text back",
      readOnly: true,
      destructive: false,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

/** What a Phase 3.1 payload (no 07.4 fields) reads back as. */
const orgSecretDefaults = {
  authMode: "org_secret",
  memberHeaderName: null,
  memberHeaderPrefix: null,
  oauthScopes: null,
  oauthStatus: null,
  oauthUseCimd: true,
  oauthClients: [],
  memberConnections: 0,
  orgConnection: null,
  authFailure: null,
};

describe("MCP registry contracts (D-13)", () => {
  it("header input carries a value or keeps the stored one", () => {
    expect(McpHeaderInput.parse({ name: "Authorization", value: "Bearer x" })).toEqual({
      name: "Authorization",
      value: "Bearer x",
    });
    expect(McpHeaderInput.parse({ name: "X-Api-Key", keep: true })).toEqual({
      name: "X-Api-Key",
      keep: true,
    });
    expect(McpHeaderInput.safeParse({ name: "Bad Header", value: "x" }).success).toBe(false);
    expect(McpHeaderInput.safeParse({ name: "X-Api-Key", value: "" }).success).toBe(false);
  });

  it("create applies the safe defaults and refuses a 9th header", () => {
    const parsed = CreateMcpServerRequest.parse({
      name: "  Docs  ",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
    expect(parsed).toMatchObject({
      name: "Docs",
      headers: [],
      orgEnabled: true,
      personalAllowed: false,
      trustedChaining: false,
    });
    const headers = Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(
      CreateMcpServerRequest.safeParse({ name: "Docs", transport: "sse", url: "https://x.test/sse", headers })
        .success,
    ).toBe(false);
    expect(
      CreateMcpServerRequest.safeParse({
        name: "Docs",
        transport: "sse",
        url: "https://x.test/sse",
        headers: headers.slice(0, 8),
      }).success,
    ).toBe(true);
  });

  it("update never changes the transport and applies no create defaults (a flag PATCH keeps the headers)", () => {
    expect(UpdateMcpServerRequest.parse({ transport: "sse", personalAllowed: true })).toEqual({
      personalAllowed: true,
    });
    expect(UpdateMcpServerRequest.parse({})).toEqual({});
  });

  it("McpServer has no field that could carry a header value", () => {
    expect(McpServer.parse(server)).toEqual({ ...server, ...orgSecretDefaults });
    const leaky = McpServer.parse({
      ...server,
      headers: [{ name: "Authorization", hasValue: true, value: "s" }],
    });
    expect(JSON.stringify(leaky)).not.toContain('"value"');
    expect(
      McpServer.safeParse({ ...server, headers: [{ name: "Authorization", hasValue: false }] }).success,
    ).toBe(false);
    expect(Object.keys(McpServer.shape)).not.toContain("secretId");
    expect(
      McpServerList.parse({ servers: [server], sandbox: { available: false, servers: [] } }).servers,
    ).toHaveLength(1);
  });
});

describe("Agent Channel MCP additions", () => {
  it("mcp.probe event and probe result", () => {
    expect(AgentChannelEventTypes.mcpProbe).toBe("mcp.probe");
    expect(
      McpProbeEvent.parse({
        type: "mcp.probe",
        organizationId: ID,
        cellId: ID,
        seq: 3,
        probeId: ID,
        serverId: ID,
      }),
    ).toMatchObject({ probeId: ID });
    const result = AgentChannelMcpProbeResult.parse({
      probeId: ID,
      serverId: ID,
      ok: true,
      tools: [{ name: "echo", annotations: { readOnlyHint: true } }, { name: "write_note" }],
    });
    expect(result.tools).toHaveLength(2);
    expect(
      AgentChannelMcpProbeResult.safeParse({ probeId: ID, serverId: ID, ok: false, error: "x".repeat(301) })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `t${i}` }));
    expect(
      AgentChannelMcpProbeResult.safeParse({ probeId: ID, serverId: ID, ok: true, tools: many }).success,
    ).toBe(false);
  });

  it("CellMcpServer carries env-named header values; the snapshot defaults to no servers", () => {
    expect(
      CellMcpServer.parse({
        id: ID,
        safeName: "m3f9a12c4",
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", envName: "OCW_MCP_M3F9A12C4_0", value: "Bearer x" }],
        tools: ["echo"],
      }).headers[0]?.envName,
    ).toBe("OCW_MCP_M3F9A12C4_0");
    expect(
      CellMcpServer.safeParse({
        id: ID,
        safeName: "m1",
        transport: "sandboxed-stdio",
        url: "x",
        headers: [],
        tools: [],
      }).success,
    ).toBe(false);
    const snap = CellSnapshot.parse({
      protocolVersion: 1,
      cellId: ID,
      organizationId: ID,
      topic: `cell:${ID}`,
      lastSeq: 0,
      agents: [],
      providers: [],
    });
    expect(snap.mcpServers).toEqual([]);
  });
});

describe("permission rules: tool layer for bot tools (03.1-03 note)", () => {
  const rule = (r: Record<string, unknown>) =>
    CreatePermissionRuleRequest.safeParse({
      subjectKind: "role",
      subjectId: "developer",
      effect: "deny",
      ...r,
    }).success;

  it("a deny rule can name one MCP tool on bot.tool.use", () => {
    expect(rule({ permission: "bot.tool.use", tool: "m3f9a12c4__echo" })).toBe(true);
    expect(rule({ permission: "bot.*", tool: "m3f9a12c4__write_note" })).toBe(true);
    expect(rule({ permission: "work_session.approve", tool: "Bash" })).toBe(true);
    expect(rule({ permission: "bot.internet", tool: "m3f9a12c4__echo" })).toBe(false);
    expect(rule({ permission: "channel.post", tool: "m3f9a12c4__echo" })).toBe(false);
  });
});

describe("connector auth modes on the registry (07.4 D-01, CONN-01)", () => {
  const http = {
    name: "Acme CRM",
    transport: "streamable-http",
    url: "https://crm.example.com/mcp",
  } as const;

  it("a Phase 3.1 server reads back as org_secret with no member connections", () => {
    const parsed = McpServer.parse(server);
    expect(parsed.authMode).toBe("org_secret");
    expect(parsed.memberConnections).toBe(0);
    expect(parsed.oauthClients).toEqual([]);
    expect(parsed.tools[0]?.inputSchema).toBeUndefined();
    expect(CreateMcpServerRequest.parse(http).authMode).toBe("org_secret");
  });

  it("a per-member server carries its mode, header, scopes, clients and member count", () => {
    const perMember = {
      ...server,
      authMode: "per_member_oauth",
      headers: [],
      oauthScopes: ["crm.read"],
      oauthStatus: "ready",
      oauthClients: [
        { issuer: "https://auth.example.com", clientId: "ocw", hasSecret: false, method: "cimd" },
      ],
      memberConnections: 3,
      tools: [{ ...server.tools[0], inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    };
    expect(McpServer.parse(perMember)).toMatchObject({ authMode: "per_member_oauth", memberConnections: 3 });
    expect(McpServer.safeParse({ ...perMember, memberConnections: -1 }).success).toBe(false);
  });

  it("a per-member mode is refused on the stdio sandbox transport", () => {
    for (const authMode of ["per_member_oauth", "per_member_secret"] as const) {
      const res = CreateMcpServerRequest.safeParse({
        name: "Local",
        transport: "sandboxed-stdio",
        sandboxServer: "everything",
        authMode,
        memberHeaderName: "X-Api-Key",
      });
      expect(res.success, authMode).toBe(false);
      expect(JSON.stringify(res.error?.issues), authMode).toContain("stdio");
    }
  });

  it("a per-member mode never carries organization headers", () => {
    expect(
      CreateMcpServerRequest.safeParse({
        ...http,
        authMode: "per_member_oauth",
        headers: [{ name: "Authorization", value: "Bearer org" }],
      }).success,
    ).toBe(false);
    expect(CreateMcpServerRequest.safeParse({ ...http, authMode: "per_member_oauth" }).success).toBe(true);
  });

  it("per_member_secret needs the header the member's key goes in, with a safe prefix", () => {
    expect(CreateMcpServerRequest.safeParse({ ...http, authMode: "per_member_secret" }).success).toBe(false);
    expect(
      CreateMcpServerRequest.parse({
        ...http,
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      }),
    ).toMatchObject({ memberHeaderName: "Authorization", memberHeaderPrefix: "Bearer " });
    for (const prefix of ["Bearer\r\n", "a\nb", "a\rb", "x".repeat(33)]) {
      expect(
        CreateMcpServerRequest.safeParse({
          ...http,
          authMode: "per_member_secret",
          memberHeaderName: "Authorization",
          memberHeaderPrefix: prefix,
        }).success,
        JSON.stringify(prefix),
      ).toBe(false);
    }
    expect(
      CreateMcpServerRequest.safeParse({
        ...http,
        authMode: "per_member_secret",
        memberHeaderName: "Bad Name",
      }).success,
    ).toBe(false);
  });

  it("an OAuth client belongs to per_member_oauth only", () => {
    const oauthClient = { issuer: "https://auth.example.com", clientId: "ocw", clientSecret: "s" };
    expect(CreateMcpServerRequest.safeParse({ ...http, oauthClient }).success).toBe(false);
    expect(
      CreateMcpServerRequest.safeParse({ ...http, authMode: "per_member_oauth", oauthClient }).success,
    ).toBe(true);
    expect(
      CreateMcpServerRequest.safeParse({
        ...http,
        authMode: "per_member_oauth",
        oauthScopes: Array(33).fill("s"),
      }).success,
    ).toBe(false);
  });

  it("the client metadata document can be turned off for a sign-in connector only (WINDOWS #179)", () => {
    expect(McpServer.parse(server).oauthUseCimd).toBe(true);
    expect(
      CreateMcpServerRequest.parse({ ...http, authMode: "per_member_oauth", oauthUseCimd: false })
        .oauthUseCimd,
    ).toBe(false);
    expect(CreateMcpServerRequest.safeParse({ ...http, oauthUseCimd: false }).success).toBe(false);
    expect(UpdateMcpServerRequest.parse({ oauthUseCimd: false })).toEqual({ oauthUseCimd: false });
    expect(UpdateMcpServerRequest.safeParse({ authMode: "org_secret", oauthUseCimd: false }).success).toBe(
      false,
    );
  });

  it("update checks the resulting mode only when it names one", () => {
    expect(UpdateMcpServerRequest.parse({ personalAllowed: true })).toEqual({ personalAllowed: true });
    expect(
      UpdateMcpServerRequest.safeParse({
        authMode: "per_member_oauth",
        headers: [{ name: "Authorization", keep: true }],
      }).success,
    ).toBe(false);
    expect(
      UpdateMcpServerRequest.safeParse({ authMode: "per_member_secret", memberHeaderName: null }).success,
    ).toBe(false);
    expect(
      UpdateMcpServerRequest.safeParse({
        authMode: "org_secret",
        oauthClient: { issuer: "https://a.test", clientId: "c" },
      }).success,
    ).toBe(false);
    expect(
      UpdateMcpServerRequest.parse({
        authMode: "per_member_oauth",
        oauthClient: null,
        clearConnections: true,
      }),
    ).toEqual({
      authMode: "per_member_oauth",
      oauthClient: null,
      clearConnections: true,
    });
    expect(UpdateMcpServerRequest.safeParse({ memberHeaderPrefix: "a\nb" }).success).toBe(false);
  });

  it("a tool input schema is capped at 16 KB serialized", () => {
    const tool = server.tools[0];
    expect(McpServerTool.safeParse({ ...tool, inputSchema: null }).success).toBe(true);
    expect(
      McpServerTool.safeParse({ ...tool, inputSchema: { description: "x".repeat(16 * 1024) } }).success,
    ).toBe(false);
  });

  it("the list carries the OAuth URLs (optional, so a Phase 3.1 list still parses)", () => {
    const oauth = {
      redirectUri: "https://o.test/api/v1/connectors/oauth/callback",
      clientMetadataUrl: null,
      oauthAvailable: true,
    };
    expect(
      McpServerList.parse({ servers: [], sandbox: { available: false, servers: [] }, oauth }).oauth,
    ).toEqual(oauth);
  });
});

describe("organization credential modes on the registry (07.14 D-01 … D-03)", () => {
  const http = {
    name: "Acme CRM",
    transport: "streamable-http",
    url: "https://crm.example.com/mcp",
  } as const;
  const oauthClient = { issuer: "https://auth.example.com", clientId: "ocw", clientSecret: "s" };
  const issuesAt = (res: { error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> } }) =>
    (res.error?.issues ?? []).map((i) => i.path.map(String).join("."));

  it("an org-mode create parses end to end", () => {
    expect(CreateMcpServerRequest.parse({ ...http, authMode: "org_oauth" })).toMatchObject({
      authMode: "org_oauth",
      headers: [],
    });
    expect(CreateMcpServerRequest.parse({ ...http, authMode: "org_client_credentials" }).authMode).toBe(
      "org_client_credentials",
    );
  });

  it("both organization modes are refused on the stdio sandbox transport", () => {
    for (const authMode of ["org_oauth", "org_client_credentials"] as const) {
      const res = CreateMcpServerRequest.safeParse({
        name: "Local",
        transport: "sandboxed-stdio",
        sandboxServer: "everything",
        authMode,
      });
      expect(res.success, authMode).toBe(false);
      expect(issuesAt(res), authMode).toContain("authMode");
      expect(JSON.stringify(res.error?.issues), authMode).toContain("stdio");
    }
  });

  it("both organization modes refuse organization headers", () => {
    for (const authMode of ["org_oauth", "org_client_credentials"] as const) {
      const res = CreateMcpServerRequest.safeParse({
        ...http,
        authMode,
        headers: [{ name: "Authorization", value: "Bearer org" }],
      });
      expect(res.success, authMode).toBe(false);
      expect(issuesAt(res), authMode).toContain("headers");
    }
  });

  it("an OAuth client and a CIMD opt-out belong to the sign-in modes only", () => {
    expect(
      CreateMcpServerRequest.safeParse({ ...http, authMode: "org_oauth", oauthClient, oauthUseCimd: false })
        .success,
    ).toBe(true);
    for (const authMode of ["org_client_credentials", "org_secret", "per_member_secret"] as const) {
      const extra = authMode === "per_member_secret" ? { memberHeaderName: "X-Api-Key" } : {};
      const withClient = CreateMcpServerRequest.safeParse({ ...http, ...extra, authMode, oauthClient });
      expect(withClient.success, authMode).toBe(false);
      expect(issuesAt(withClient), authMode).toContain("oauthClient");
      const noCimd = CreateMcpServerRequest.safeParse({ ...http, ...extra, authMode, oauthUseCimd: false });
      expect(noCimd.success, authMode).toBe(false);
      expect(issuesAt(noCimd), authMode).toContain("oauthUseCimd");
    }
  });

  it("scopes belong to the sign-in modes and client credentials only", () => {
    for (const authMode of ["per_member_oauth", "org_oauth", "org_client_credentials"] as const) {
      expect(
        CreateMcpServerRequest.safeParse({ ...http, authMode, oauthScopes: ["read"] }).success,
        authMode,
      ).toBe(true);
    }
    const memberKey = CreateMcpServerRequest.safeParse({
      ...http,
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
      oauthScopes: ["read"],
    });
    expect(memberKey.success).toBe(false);
    expect(issuesAt(memberKey)).toContain("oauthScopes");
    const orgHeaders = CreateMcpServerRequest.safeParse({ ...http, oauthScopes: ["read"] });
    expect(orgHeaders.success).toBe(false);
    expect(issuesAt(orgHeaders)).toContain("oauthScopes");
  });

  it("a member key header is still per_member_secret only", () => {
    const res = CreateMcpServerRequest.safeParse({
      ...http,
      authMode: "org_oauth",
      memberHeaderName: "X-Api-Key",
    });
    expect(res.success).toBe(false);
    expect(issuesAt(res)).toContain("memberHeaderName");
  });

  it("update checks an organization mode against the request's fields", () => {
    expect(
      UpdateMcpServerRequest.safeParse({ authMode: "org_client_credentials", oauthClient }).success,
    ).toBe(false);
    expect(
      UpdateMcpServerRequest.parse({ authMode: "org_oauth", oauthScopes: ["read"], clearConnections: true }),
    ).toEqual({ authMode: "org_oauth", oauthScopes: ["read"], clearConnections: true });
  });
});

describe("the organization connection on the server and Test sign-in (07.14 D-10, D-18; COA-04, COA-05)", () => {
  it("a 3.1 or 07.4 server payload without the 07.14 fields parses with no connection and no failure", () => {
    const parsed = McpServer.parse(server);
    expect(parsed.orgConnection).toBeNull();
    expect(parsed.authFailure).toBeNull();
    const member = McpServer.parse({
      ...server,
      authMode: "per_member_oauth",
      headers: [],
      memberConnections: 2,
    });
    expect(member.orgConnection).toBeNull();
    expect(member.authFailure).toBeNull();
  });

  it("an organization server carries its connection and its last sign-in failure", () => {
    const parsed = McpServer.parse({
      ...server,
      authMode: "org_oauth",
      headers: [],
      authFailure: "pkce_unsupported",
      orgConnection: {
        method: "oauth",
        status: "connected",
        accountLabel: "ops@example.com",
        clientId: null,
        tokenEndpoint: null,
        scopes: [],
        connectedBy: { id: ID, name: "Ada Admin" },
        connectedAt: NOW,
        lastUsedAt: NOW,
        reconnectReason: null,
        hasSecret: false,
      },
    });
    expect(parsed.orgConnection?.accountLabel).toBe("ops@example.com");
    expect(parsed.authFailure).toBe("pkce_unsupported");
    expect(McpServer.safeParse({ ...server, authFailure: "needs_client" }).success).toBe(false);
  });

  const issuesOf = (input: unknown) => {
    const res = OAuthTestRequest.safeParse(input);
    return res.success ? [] : res.error.issues.map((i) => i.path.map(String).join("."));
  };

  it("Test sign-in needs a URL or a saved server (E9)", () => {
    expect(OAuthTestRequest.safeParse({ authMode: "org_oauth" }).success).toBe(false);
    expect(
      OAuthTestRequest.safeParse({ authMode: "org_oauth", url: "https://crm.example.com/mcp" }).success,
    ).toBe(true);
    expect(OAuthTestRequest.safeParse({ authMode: "per_member_oauth", serverId: ID }).success).toBe(true);
  });

  it("client credentials only for org_client_credentials, an OAuth client only for the sign-in modes", () => {
    const clientCredentials = { clientId: "ocw-test-cc", clientSecret: "s" };
    const oauthClient = { issuer: "https://auth.example.com", clientId: "ocw" };
    expect(issuesOf({ authMode: "org_oauth", serverId: ID, clientCredentials })).toContain(
      "clientCredentials",
    );
    expect(issuesOf({ authMode: "per_member_oauth", serverId: ID, clientCredentials })).toContain(
      "clientCredentials",
    );
    expect(issuesOf({ authMode: "org_client_credentials", serverId: ID, oauthClient })).toContain(
      "oauthClient",
    );
    expect(issuesOf({ authMode: "org_client_credentials", serverId: ID, oauthUseCimd: false })).toContain(
      "oauthUseCimd",
    );
    expect(issuesOf({ authMode: "org_oauth", serverId: ID, oauthClient, oauthUseCimd: false })).toEqual([]);
    expect(OAuthTestRequest.safeParse({ authMode: "org_secret", serverId: ID }).success).toBe(false);
    expect(OAuthTestRequest.safeParse({ authMode: "per_member_secret", serverId: ID }).success).toBe(false);
  });

  it("a full client-credentials Test parses; an unknown key is refused", () => {
    const full = {
      url: "https://crm.example.com/mcp",
      transport: "streamable-http",
      authMode: "org_client_credentials",
      clientCredentials: {
        clientId: "ocw-test-cc",
        clientSecret: "s",
        tokenEndpoint: "https://auth.example.com/token",
      },
      oauthScopes: ["crm.read"],
      pageOrigin: "https://ocw.example.com",
    };
    expect(OAuthTestRequest.parse(full)).toEqual(full);
    expect(OAuthTestRequest.safeParse({ ...full, headers: [] }).success).toBe(false);
    expect(OAuthTestRequest.safeParse({ ...full, transport: "sandboxed-stdio" }).success).toBe(false);
    expect(OAuthTestRequest.safeParse({ ...full, url: "x".repeat(2001) }).success).toBe(false);
  });

  it("the Test answer reports each of the seven steps and carries no provider text", () => {
    expect(AuthTestStep.options).toEqual([
      "public_url",
      "discovery",
      "issuer",
      "endpoints",
      "pkce",
      "client_registration",
      "token",
    ]);
    const answer = {
      ok: false,
      failure: "pkce_unsupported",
      steps: AuthTestStep.options.map((step, i) => ({
        step,
        status: i < 4 ? "ok" : i === 4 ? "failed" : "skipped",
      })),
      clientMethod: null,
      issuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/token",
      redirectUri: "https://ocw.example.com/api/v1/connectors/oauth/callback",
      clientMetadataUrl: null,
    };
    expect(OAuthTestResponse.parse(answer)).toEqual(answer);
    const withText = OAuthTestResponse.parse({ ...answer, error_description: "provider says no" });
    expect(withText).not.toHaveProperty("error_description");
    expect(
      OAuthTestResponse.safeParse({ ...answer, steps: [{ step: "pkce", status: "maybe" }] }).success,
    ).toBe(false);
  });
});
