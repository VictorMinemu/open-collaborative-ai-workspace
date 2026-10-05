import { type DeclaredSurface, EMPTY_DECLARED_SURFACE } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  bundledPluginIds,
  compatibilityOf,
  OPENCLAW_HOST_VERSION,
  type RiskInput,
  reviewTokenOf,
  scorePluginRisk,
} from "./risk";

const surface = (over: Partial<DeclaredSurface> = {}): DeclaredSurface => ({
  ...EMPTY_DECLARED_SURFACE,
  ...over,
});

/** Official, clean, source-linked, compatible, one ordinary tool: the `low` baseline. */
const base = (over: Partial<RiskInput> = {}): RiskInput => ({
  channel: "official",
  publisherOfficial: true,
  verificationTier: "source-linked",
  scan: { status: "clean", blockedFromDownload: false, pending: false, moderationState: null },
  compatibility: { minGatewayVersion: ">=2026.7.2", pluginApiRange: ">=2026.9.7" },
  declared: surface({ tools: ["notes_lookup"] }),
  artifactSha256: "a".repeat(64),
  ...over,
});

const codes = (input: RiskInput) => scorePluginRisk(input).reasons.map((r) => r.code);

describe("scorePluginRisk (D-14, research B2 / P-B5)", () => {
  it("official + clean + source-linked + only ordinary named tools → low, no reasons", () => {
    expect(scorePluginRisk(base())).toEqual({ risk: "low", reasons: [] });
  });

  it("official declaring a web search provider → medium (network_provider)", () => {
    const r = scorePluginRisk(base({ declared: surface({ webSearchProviders: ["duckduckgo"] }) }));
    expect(r.risk).toBe("medium");
    expect(r.reasons.map((x) => x.code)).toEqual(["network_provider"]);
    expect(scorePluginRisk(base({ declared: surface({ webFetchProviders: ["firecrawl"] }) })).risk).toBe(
      "medium",
    );
  });

  it("community + clean → high (community_channel)", () => {
    const r = scorePluginRisk(base({ channel: "community", publisherOfficial: false }));
    expect(r.risk).toBe("high");
    expect(r.reasons.map((x) => x.code)).toContain("community_channel");
  });

  it("any channel declaration → refuse (channel_bypass)", () => {
    const r = scorePluginRisk(base({ declared: surface({ channels: ["relay"] }) }));
    expect(r.risk).toBe("refuse");
    expect(r.reasons.map((x) => x.code)).toEqual(["channel_bypass"]);
  });

  it.each([
    ["gatewayMethodDispatch:authenticated-request", "gateway_methods"],
    ["httpRoutes:/hook", "http_routes"],
    ["cliBackends:claude-cli", "cli_backends"],
    ["embeddedExtensionFactories:codex-app-server", "extension_factories"],
    ["agentToolResultMiddleware:openclaw", "tool_result_middleware"],
    ["trustedToolPolicies:workflow-budget", "tool_policy_override"],
    ["kind:memory", "memory_slot"],
    ["kind:context-engine", "memory_slot"],
    ["externalAuthProviders:acme-ai", "external_auth"],
    ["workerProviders:example-worker", "worker_providers"],
    ["codeModeExecutors:quickjs", "code_executor"],
  ])("declared %s → refuse (%s)", (other, code) => {
    const r = scorePluginRisk(base({ declared: surface({ other: [other] }) }));
    expect(r.risk).toBe("refuse");
    expect(r.reasons.map((x) => x.code)).toContain(code);
  });

  it("a declared tool run_shell → refuse (dangerous_tool)", () => {
    const r = scorePluginRisk(base({ declared: surface({ tools: ["notes_lookup", "run_shell"] }) }));
    expect(r.risk).toBe("refuse");
    expect(r.reasons.map((x) => x.code)).toEqual(["dangerous_tool"]);
    expect(r.reasons[0]?.message).toContain("run_shell");
  });

  it("blockedFromDownload or a malicious / quarantined moderation state → refuse (blocked_by_clawhub)", () => {
    const blocked = base({
      scan: { status: "clean", blockedFromDownload: true, pending: false, moderationState: null },
    });
    expect(scorePluginRisk(blocked).risk).toBe("refuse");
    expect(codes(blocked)).toContain("blocked_by_clawhub");
    for (const moderationState of ["malicious", "quarantined", "revoked", "blocked"]) {
      const r = scorePluginRisk(
        base({ scan: { status: "clean", blockedFromDownload: false, pending: false, moderationState } }),
      );
      expect(r.risk).toBe("refuse");
      expect(r.reasons.map((x) => x.code)).toContain("blocked_by_clawhub");
    }
    const malicious = base({
      scan: { status: "malicious", blockedFromDownload: false, pending: false, moderationState: null },
    });
    expect(scorePluginRisk(malicious).risk).toBe("refuse");
    // An approved moderation state is not a block.
    expect(
      scorePluginRisk(
        base({
          scan: { status: "clean", blockedFromDownload: false, pending: false, moderationState: "approved" },
        }),
      ).risk,
    ).toBe("low");
  });

  it("scan pending or missing → at least high (unscanned)", () => {
    const pending = base({
      scan: { status: "clean", blockedFromDownload: false, pending: true, moderationState: null },
    });
    expect(scorePluginRisk(pending).risk).toBe("high");
    expect(codes(pending)).toContain("unscanned");
    const missing = base({
      scan: { status: null, blockedFromDownload: false, pending: false, moderationState: null },
    });
    expect(scorePluginRisk(missing).risk).toBe("high");
    expect(codes(missing)).toContain("unscanned");
    const suspicious = base({
      scan: { status: "suspicious", blockedFromDownload: false, pending: false, moderationState: null },
    });
    expect(scorePluginRisk(suspicious).risk).toBe("high");
    expect(codes(suspicious)).toContain("scan_not_clean");
  });

  it("incompatible with OpenClaw 2026.9.7 → refuse (incompatible)", () => {
    expect(OPENCLAW_HOST_VERSION).toBe("2026.9.7");
    const newer = base({ compatibility: { minGatewayVersion: ">=2026.10.1", pluginApiRange: null } });
    expect(scorePluginRisk(newer).risk).toBe("refuse");
    expect(codes(newer)).toContain("incompatible");
    const api = base({ compatibility: { minGatewayVersion: null, pluginApiRange: "<2026.9.0" } });
    expect(scorePluginRisk(api).risk).toBe("refuse");
    expect(codes(api)).toContain("incompatible");
  });

  it("unknown compatibility: refuse only for a community plugin with both fields missing, else high", () => {
    const none = { minGatewayVersion: null, pluginApiRange: null };
    const community = base({ channel: "community", publisherOfficial: false, compatibility: none });
    expect(scorePluginRisk(community).risk).toBe("refuse");
    expect(codes(community)).toContain("incompatible_unknown");
    const official = base({ compatibility: none });
    expect(scorePluginRisk(official).risk).toBe("high");
    expect(codes(official)).toContain("compatibility_unknown");
    const garbled = base({ compatibility: { minGatewayVersion: "whenever", pluginApiRange: ">=2026.9.7" } });
    expect(scorePluginRisk(garbled).risk).toBe("high");
    expect(codes(garbled)).toContain("compatibility_unknown");
  });

  it("hooks declared → at least high (hooks)", () => {
    const r = scorePluginRisk(base({ declared: surface({ hooks: ["before_agent_run"] }) }));
    expect(r.risk).toBe("high");
    expect(r.reasons.map((x) => x.code)).toEqual(["hooks"]);
  });

  it("bundled MCP servers (stdio inside the gateway) → refuse (bundled_mcp)", () => {
    const r = scorePluginRisk(base({ declared: surface({ mcpServers: ["files"] }) }));
    expect(r.risk).toBe("refuse");
    expect(r.reasons.map((x) => x.code)).toEqual(["bundled_mcp"]);
  });

  it("an unknown declared family or a missing manifest → high", () => {
    expect(codes(base({ declared: surface({ other: ["contracts.futureThing:x"] }) }))).toContain(
      "unknown_capability",
    );
    const r = scorePluginRisk(base({ declared: surface({ other: ["manifest:missing"] }) }));
    expect(r.risk).toBe("high");
    expect(r.reasons.map((x) => x.code)).toEqual(["surface_unknown"]);
  });

  it("no verifiable artifact digest → refuse (missing_digest)", () => {
    const r = scorePluginRisk(base({ artifactSha256: "" }));
    expect(r.risk).toBe("refuse");
    expect(r.reasons.map((x) => x.code)).toEqual(["missing_digest"]);
  });

  it("an unverified source tier → medium (unverified_source)", () => {
    const r = scorePluginRisk(base({ verificationTier: null }));
    expect(r.risk).toBe("medium");
    expect(r.reasons.map((x) => x.code)).toEqual(["unverified_source"]);
  });

  it("reasons are deduplicated and the worst level wins", () => {
    const r = scorePluginRisk(
      base({
        channel: "community",
        publisherOfficial: false,
        declared: surface({
          tools: ["run_shell", "exec_command"],
          channels: ["a", "b"],
          hooks: ["llm_input"],
          webSearchProviders: ["x"],
        }),
      }),
    );
    expect(r.risk).toBe("refuse");
    const list = r.reasons.map((x) => x.code);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toEqual(
      expect.arrayContaining(["dangerous_tool", "channel_bypass", "community_channel", "hooks"]),
    );
    // Worst first, so the admin reads the blocking reason first.
    expect(["dangerous_tool", "channel_bypass"]).toContain(list[0]);
    for (const reason of r.reasons) {
      expect(reason.code.length).toBeLessThanOrEqual(64);
      expect(reason.message.length).toBeLessThanOrEqual(200);
    }
  });

  it("is pure: the same input gives the same verdict", () => {
    const input = base({ declared: surface({ hooks: ["x"], webSearchProviders: ["y"] }) });
    expect(scorePluginRisk(input)).toEqual(scorePluginRisk(structuredClone(input)));
  });
});

describe("compatibilityOf", () => {
  it("evaluates simple ranges against the host version", () => {
    expect(compatibilityOf({ minGatewayVersion: ">=2026.7.2", pluginApiRange: ">=2026.9.7" })).toBe(
      "compatible",
    );
    expect(compatibilityOf({ minGatewayVersion: "2026.9.7", pluginApiRange: null })).toBe("compatible");
    expect(compatibilityOf({ minGatewayVersion: "2026.9.8", pluginApiRange: null })).toBe("incompatible");
    expect(compatibilityOf({ minGatewayVersion: null, pluginApiRange: "^2026.9.0" })).toBe("compatible");
    expect(compatibilityOf({ minGatewayVersion: null, pluginApiRange: ">=2026.1.0 <2026.9.0" })).toBe(
      "incompatible",
    );
    expect(compatibilityOf({ minGatewayVersion: null, pluginApiRange: "<2026.9.0 || >=2026.9.5" })).toBe(
      "compatible",
    );
    expect(compatibilityOf({ minGatewayVersion: ">=2026.7.2-beta.1", pluginApiRange: null })).toBe(
      "compatible",
    );
    expect(compatibilityOf({ minGatewayVersion: null, pluginApiRange: null })).toBe("unknown");
    expect(compatibilityOf({ minGatewayVersion: "soon", pluginApiRange: null })).toBe("unknown");
  });
});

describe("reviewTokenOf", () => {
  const review = {
    packageName: "@ocw-test/notes-plugin",
    version: "1.0.0",
    sha256: "a".repeat(64),
    declared: surface({ tools: ["notes_lookup", "notes_search"], hooks: ["x"] }),
  };

  it("is a sha256 hex string and stable across key and list order", () => {
    const token = reviewTokenOf(review);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      declared: Object.fromEntries(
        Object.entries({ ...review.declared, tools: ["notes_search", "notes_lookup"] }).reverse(),
      ) as DeclaredSurface,
      sha256: review.sha256,
      version: review.version,
      packageName: review.packageName,
    };
    expect(reviewTokenOf(reordered)).toBe(token);
  });

  it("changes when the version, the digest or any declared entry changes", () => {
    const token = reviewTokenOf(review);
    expect(reviewTokenOf({ ...review, version: "1.0.1" })).not.toBe(token);
    expect(reviewTokenOf({ ...review, sha256: "b".repeat(64) })).not.toBe(token);
    expect(reviewTokenOf({ ...review, packageName: "@ocw-test/other" })).not.toBe(token);
    for (const key of Object.keys(EMPTY_DECLARED_SURFACE) as (keyof DeclaredSurface)[]) {
      const grown = { ...review.declared, [key]: [...review.declared[key], "added"] };
      expect(reviewTokenOf({ ...review, declared: grown })).not.toBe(token);
    }
  });
});

describe("bundledPluginIds", () => {
  it("returns the env list (already parsed: `none` → [])", () => {
    expect(bundledPluginIds({ OCW_BUNDLED_PLUGINS: ["duckduckgo", "searxng"] })).toEqual([
      "duckduckgo",
      "searxng",
    ]);
    expect(bundledPluginIds({ OCW_BUNDLED_PLUGINS: [] })).toEqual([]);
  });
});
