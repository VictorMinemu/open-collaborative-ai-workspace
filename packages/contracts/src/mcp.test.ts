import { describe, expect, it } from "vitest";
import {
  AgentChannelEventTypes,
  AgentChannelMcpProbeResult,
  CellMcpServer,
  CellSnapshot,
  CreateMcpServerRequest,
  CreatePermissionRuleRequest,
  McpHeaderInput,
  McpProbeEvent,
  McpServer,
  McpServerList,
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
    expect(McpServer.parse(server)).toEqual(server);
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
