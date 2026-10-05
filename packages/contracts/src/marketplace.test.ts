import { describe, expect, it } from "vitest";
import {
  AgentChannelEventTypes,
  AgentChannelPluginReport,
  ApprovePluginInstallRequest,
  CellApprovedPlugin,
  CellPlugin,
  CellSnapshot,
  DeclaredSurface,
  EMPTY_DECLARED_SURFACE,
  MarketplacePackageDetail,
  MarketplaceSearchResult,
  PluginInstallEvent,
  PluginUninstallEvent,
  UpdateCellPluginRequest,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-05T10:00:00.000Z";

const declared = {
  tools: ["notes_lookup"],
  hooks: [],
  channels: [],
  providers: [],
  webSearchProviders: [],
  webFetchProviders: [],
  mcpServers: [],
  other: [],
};

const entry = {
  packageName: "@ocw-test/notes-plugin",
  displayName: "Notes",
  summary: null,
  publisher: "ocw-test",
  publisherOfficial: true,
  channel: "official",
  latestVersion: "1.1.0",
  downloads: 10,
  installs: 2,
  stars: 0,
  scanStatus: "clean",
  verificationTier: "source-linked",
  bundled: false,
  installed: null,
};

const review = {
  packageName: "@ocw-test/notes-plugin",
  version: "1.0.0",
  publishedAt: NOW,
  channel: "official",
  publisher: "ocw-test",
  verification: { tier: "source-linked", hasProvenance: false, sourceRepo: "ocw/notes", sourceCommit: "abc" },
  scan: { status: "clean", blockedFromDownload: false, pending: false, reasons: [] },
  compatibility: { minGatewayVersion: ">=2026.7.2", pluginApiRange: ">=2026.9.7", compatible: true },
  artifact: { sha256: "a".repeat(64), npmIntegrity: null, size: 1000 },
  declared,
  risk: "low",
  riskReasons: [],
  reviewToken: "f".repeat(64),
};

describe("marketplace contracts (D-14, BOT-09)", () => {
  it("EMPTY_DECLARED_SURFACE is a valid, empty DeclaredSurface", () => {
    expect(DeclaredSurface.parse(EMPTY_DECLARED_SURFACE)).toEqual({ ...declared, tools: [] });
  });

  it("ApprovePluginInstallRequest defaults acknowledgeHighRisk and personalAllowed to false", () => {
    expect(
      ApprovePluginInstallRequest.parse({ packageName: "@a/b", version: "1.0.0", reviewToken: "t" }),
    ).toEqual({
      packageName: "@a/b",
      version: "1.0.0",
      reviewToken: "t",
      acknowledgeHighRisk: false,
      personalAllowed: false,
    });
    expect(
      ApprovePluginInstallRequest.safeParse({ packageName: "x".repeat(215), version: "1", reviewToken: "t" })
        .success,
    ).toBe(false);
  });

  it("search results and package detail parse", () => {
    expect(MarketplaceSearchResult.parse({ entries: [entry], nextCursor: null, source: "live" }).source).toBe(
      "live",
    );
    expect(
      MarketplaceSearchResult.safeParse({ entries: [entry], nextCursor: null, source: "stale" }).success,
    ).toBe(false);
    const detail = MarketplacePackageDetail.parse({
      entry: { ...entry, installed: { id: ID, version: "1.0.0", status: "installed" } },
      versions: [{ version: "1.0.0", publishedAt: NOW }],
      review,
    });
    expect(detail.review.risk).toBe("low");
  });

  it("CellPlugin and UpdateCellPluginRequest", () => {
    const plugin = CellPlugin.parse({
      id: ID,
      packageName: "@ocw-test/notes-plugin",
      pluginId: "notes",
      version: "1.0.0",
      channel: "official",
      publisher: "ocw-test",
      risk: "low",
      riskReasons: [],
      status: "installing",
      statusDetail: null,
      orgEnabled: true,
      personalAllowed: false,
      trustedChaining: false,
      tools: [{ name: "notes_lookup", description: null, sideEffecting: true }],
      approvedAt: NOW,
      installedAt: null,
    });
    expect(plugin.status).toBe("installing");
    // No defaults: a PATCH of one flag must not reset the others.
    expect(UpdateCellPluginRequest.parse({ trustedChaining: true })).toEqual({ trustedChaining: true });
    expect(UpdateCellPluginRequest.parse({ upgrade: { version: "1.1.0", reviewToken: "t" } })).toEqual({
      upgrade: { version: "1.1.0", reviewToken: "t" },
    });
  });
});

describe("Agent Channel plugin events (additive)", () => {
  it("plugin.install.v1 and plugin.uninstall.v1 round-trip", () => {
    expect(AgentChannelEventTypes.pluginInstall).toBe("plugin.install.v1");
    expect(AgentChannelEventTypes.pluginUninstall).toBe("plugin.uninstall.v1");
    const install = {
      type: "plugin.install.v1",
      organizationId: ID,
      cellId: ID,
      seq: 7,
      flowId: ID2,
      pluginRowId: ID,
      packageName: "@ocw-test/notes-plugin",
      version: "1.0.0",
      artifactUrl:
        "https://clawhub.ai/api/v1/packages/%40ocw-test%2Fnotes-plugin/versions/1.0.0/artifact/download",
      sha256: "a".repeat(64),
      npmIntegrity: null,
      expectedPluginId: "notes",
      mode: "install",
    };
    expect(PluginInstallEvent.parse(JSON.parse(JSON.stringify(install)))).toEqual(install);
    expect(PluginInstallEvent.safeParse({ ...install, mode: "reinstall" }).success).toBe(false);
    const uninstall = {
      type: "plugin.uninstall.v1",
      organizationId: ID,
      cellId: ID,
      seq: 8,
      flowId: ID2,
      pluginRowId: ID,
      pluginId: "notes",
    };
    expect(PluginUninstallEvent.parse(uninstall)).toEqual(uninstall);
  });

  it("AgentChannelPluginReport round-trips and caps what the cell may send", () => {
    const report = {
      flowId: ID2,
      pluginRowId: ID,
      state: "installed",
      pluginId: "notes",
      version: "1.0.0",
      declared,
      declaredTools: [{ name: "notes_lookup", description: "Look up a note" }],
    };
    expect(AgentChannelPluginReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(
      AgentChannelPluginReport.safeParse({
        ...report,
        declaredTools: Array.from({ length: 101 }, (_, i) => ({ name: `t${i}` })),
      }).success,
    ).toBe(false);
    expect(
      AgentChannelPluginReport.parse({
        flowId: ID2,
        pluginRowId: ID,
        state: "failed",
        error: { code: "digest_mismatch", message: "The artifact digest does not match" },
      }).error?.code,
    ).toBe("digest_mismatch");
    expect(AgentChannelPluginReport.safeParse({ ...report, state: "approved" }).success).toBe(false);
  });

  it("an older CellSnapshot without plugins still parses (plugins = [])", () => {
    const old = {
      protocolVersion: 1,
      cellId: ID,
      organizationId: ID,
      topic: `cell:${ID}`,
      lastSeq: 0,
      agents: [],
      providers: [],
    };
    expect(CellSnapshot.parse(old).plugins).toEqual([]);
    const approved = {
      pluginRowId: ID,
      packageName: "@ocw-test/notes-plugin",
      version: "1.0.0",
      sha256: "a".repeat(64),
      pluginId: null,
      status: "installing",
    };
    expect(CellApprovedPlugin.parse(approved)).toEqual(approved);
    expect(CellSnapshot.parse({ ...old, plugins: [approved] }).plugins).toHaveLength(1);
  });
});
