import { createHash } from "node:crypto";
import {
  type DeclaredSurface,
  isDangerousToolName,
  type PluginChannel,
  type RiskLevel,
  type RiskReason,
} from "@ocw/contracts";
import type { Env } from "../../config/env";

/**
 * Marketplace risk (D-14, research B2 / P-B5). PURE: no I/O, the same input always gives the same verdict.
 *
 * Native OpenClaw plugins run in-process with the gateway and are not sandboxed, so "declared capabilities" are
 * not containment. The scorer therefore refuses anything that would open a second path around our controls
 * (channels, gateway methods / HTTP routes, CLI backends, tool-policy or tool-result middleware, memory/context
 * slots, external auth, workers, code executors, bundled stdio MCP servers, dangerous tool names, a ClawHub
 * block, an incompatible host or a missing digest) and keeps everything not proven safe at `high`.
 */

/** The OpenClaw version the cell image pins (infra/openclaw). */
export const OPENCLAW_HOST_VERSION = "2026.9.7";

export interface RiskInput {
  channel: PluginChannel;
  publisherOfficial: boolean;
  verificationTier: string | null;
  scan: {
    status: string | null;
    blockedFromDownload: boolean;
    pending: boolean;
    moderationState?: string | null;
  };
  compatibility: { minGatewayVersion: string | null; pluginApiRange: string | null };
  declared: DeclaredSurface;
  /** When given, an empty or malformed digest refuses the version (nothing verifiable to pin). */
  artifactSha256?: string | null;
}

export interface RiskVerdict {
  risk: RiskLevel;
  reasons: RiskReason[];
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, refuse: 3 };

type Rule = { level: Exclude<RiskLevel, "low">; code: string; message: string };

/** `other` families that bypass our controls. */
const REFUSED_FAMILIES: Record<string, Omit<Rule, "level">> = {
  gatewayMethodDispatch: {
    code: "gateway_methods",
    message: "Dispatches Gateway methods from its own routes, around the Agent Channel API",
  },
  httpRoutes: { code: "http_routes", message: "Registers HTTP routes on the gateway" },
  cliBackends: { code: "cli_backends", message: "Registers CLI backends that run external agent programs" },
  embeddedExtensionFactories: {
    code: "extension_factories",
    message: "Registers embedded extension factories inside the agent runtime",
  },
  agentToolResultMiddleware: {
    code: "tool_result_middleware",
    message: "Can rewrite every tool result before the model sees it",
  },
  trustedToolPolicies: {
    code: "tool_policy_override",
    message: "Registers trusted tool policies that can override the workspace tool gate",
  },
  externalAuthProviders: {
    code: "external_auth",
    message: "Owns external authentication profiles for model providers",
  },
  workerProviders: { code: "worker_providers", message: "Provisions remote workers from the gateway" },
  codeModeExecutors: { code: "code_executor", message: "Supplies a code execution engine" },
  contextEngines: { code: "memory_slot", message: "Takes over the memory or context-engine slot" },
};

/** `kind:<value>` slots that replace our memory / context handling. */
const REFUSED_KINDS = new Set(["memory", "context-engine", "contextengine", "context"]);

/** Provider-like contract families: additive, but they process workspace data. */
const PROVIDER_FAMILIES = new Set([
  "embeddingProviders",
  "decisionProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "usageProviders",
  "migrationProviders",
]);

/** ClawHub moderation states that block a release. */
const BLOCKING_MODERATION = new Set([
  "malicious",
  "quarantine",
  "quarantined",
  "revoked",
  "blocked",
  "hidden",
  "removed",
]);
const BLOCKING_SCAN = new Set(["malicious", "blocked"]);
/** Verification tiers that do not link the release to anything. */
const UNVERIFIED_TIERS = new Set(["", "none", "unverified", "unknown"]);

const list = (items: readonly string[], max = 4) => {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};
const cap = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}...` : s);

// ---------------------------------------------------------------- compatibility

type Version = { nums: [number, number, number]; pre: string | null };

function parseVersion(raw: string): Version | null {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.nums[i] as number) - (b.nums[i] as number);
    if (d !== 0) return Math.sign(d);
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** One comparator set (`>=a <b`). `bare` is the meaning of an operator-less version. null = unparseable. */
function satisfiesSet(host: Version, set: string, bare: ">=" | "="): boolean | null {
  const parts = set.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === "*" || part === "x") continue;
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(part);
    const v = m?.[2] ? parseVersion(m[2]) : null;
    if (!m || !v) return null;
    const c = compare(host, v);
    const op = m[1] ?? bare;
    let ok: boolean;
    switch (op) {
      case ">=":
        ok = c >= 0;
        break;
      case ">":
        ok = c > 0;
        break;
      case "<=":
        ok = c <= 0;
        break;
      case "<":
        ok = c < 0;
        break;
      case "^":
        ok = c >= 0 && host.nums[0] === v.nums[0];
        break;
      case "~":
        ok = c >= 0 && host.nums[0] === v.nums[0] && host.nums[1] === v.nums[1];
        break;
      default:
        ok = c === 0;
    }
    if (!ok) return false;
  }
  return true;
}

function satisfies(hostRaw: string, range: string, bare: ">=" | "="): boolean | null {
  const host = parseVersion(hostRaw) as Version;
  let unknown = false;
  for (const set of range.split("||")) {
    const r = satisfiesSet(host, set, bare);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

/**
 * Whether a version can load in the pinned OpenClaw: `minGatewayVersion` (a bare version means "at least") and
 * `pluginApiRange` (semver-style, a bare version means "exactly") must both admit the host. A missing field is
 * no constraint; both missing or anything unparseable is `unknown`.
 */
export function compatibilityOf(
  c: { minGatewayVersion: string | null; pluginApiRange: string | null },
  host: string = OPENCLAW_HOST_VERSION,
): "compatible" | "incompatible" | "unknown" {
  const min = c.minGatewayVersion?.trim() || null;
  const api = c.pluginApiRange?.trim() || null;
  if (!min && !api) return "unknown";
  const results = [min ? satisfies(host, min, ">=") : true, api ? satisfies(host, api, "=") : true];
  if (results.includes(false)) return "incompatible";
  if (results.includes(null)) return "unknown";
  return "compatible";
}

// ---------------------------------------------------------------- scorer

export function scorePluginRisk(input: RiskInput): RiskVerdict {
  const rules: Rule[] = [];
  const add = (level: Rule["level"], code: string, message: string) =>
    rules.push({ level, code, message: cap(message) });
  const d = input.declared;

  // Bypasses of the platform's controls.
  if (d.channels.length > 0) {
    add(
      "refuse",
      "channel_bypass",
      `Declares messaging channels (${list(d.channels)}): a second message path around the Agent Channel API`,
    );
  }
  const dangerous = d.tools.filter((t) => isDangerousToolName(t));
  if (dangerous.length > 0) {
    add("refuse", "dangerous_tool", `Declares tools that are never allowed for bots: ${list(dangerous)}`);
  }
  if (d.mcpServers.length > 0) {
    add(
      "refuse",
      "bundled_mcp",
      `Bundles MCP servers (${list(d.mcpServers)}) that would run inside the gateway; register remote MCP servers instead`,
    );
  }

  let providerFamilies = 0;
  for (const entry of d.other) {
    const idx = entry.indexOf(":");
    const family = idx >= 0 ? entry.slice(0, idx) : entry;
    const value = idx >= 0 ? entry.slice(idx + 1) : "";
    const refused = REFUSED_FAMILIES[family];
    if (refused) {
      add("refuse", refused.code, value ? `${refused.message} (${value})` : refused.message);
    } else if (family === "kind") {
      if (REFUSED_KINDS.has(value.toLowerCase())) {
        add("refuse", "memory_slot", `Takes over the ${value} slot`);
      } else {
        add("high", "unknown_capability", `Declares an unrecognised plugin kind: ${value}`);
      }
    } else if (family === "manifest") {
      add("high", "surface_unknown", "ClawHub publishes no capability manifest for this version");
    } else if (family === "dangerousConfigFlags") {
      add("high", "dangerous_config", `Has dangerous configuration flags (${value})`);
    } else if (family === "cliCommands") {
      add("medium", "cli_commands", "Adds operator CLI commands");
    } else if (family === "skills") {
      add("medium", "skills", "Bundles skills (extra instructions for the model)");
    } else if (PROVIDER_FAMILIES.has(family)) {
      providerFamilies++;
    } else {
      add("high", "unknown_capability", `Declares an unrecognised capability: ${entry}`);
    }
  }

  // ClawHub trust.
  const moderation = input.scan.moderationState?.trim().toLowerCase() || null;
  const status = input.scan.status?.trim().toLowerCase() || null;
  if (
    input.scan.blockedFromDownload ||
    (moderation !== null && BLOCKING_MODERATION.has(moderation)) ||
    (status !== null && BLOCKING_SCAN.has(status))
  ) {
    add(
      "refuse",
      "blocked_by_clawhub",
      "ClawHub blocks this release (moderation or a malicious scan verdict)",
    );
  } else {
    if (input.scan.pending || status === null) {
      add("high", "unscanned", "ClawHub has not finished scanning this release");
    } else if (status !== "clean") {
      add("high", "scan_not_clean", `ClawHub scan status is "${status}"`);
    }
    if (moderation !== null && moderation !== "approved") {
      add("high", "moderation_pending", `ClawHub moderation state is "${moderation}"`);
    }
  }

  // Integrity.
  if (input.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(input.artifactSha256 ?? "")) {
    add(
      "refuse",
      "missing_digest",
      "ClawHub publishes no sha256 digest for this release, so it cannot be pinned",
    );
  }

  // Compatibility with the pinned host.
  const compat = compatibilityOf(input.compatibility);
  if (compat === "incompatible") {
    add("refuse", "incompatible", `Not compatible with OpenClaw ${OPENCLAW_HOST_VERSION} in this workspace`);
  } else if (compat === "unknown") {
    const bothMissing =
      !input.compatibility.minGatewayVersion?.trim() && !input.compatibility.pluginApiRange?.trim();
    if (input.channel === "community" && bothMissing) {
      add(
        "refuse",
        "incompatible_unknown",
        "A community release that declares no compatible OpenClaw version",
      );
    } else {
      add("high", "compatibility_unknown", `Compatibility with OpenClaw ${OPENCLAW_HOST_VERSION} is unknown`);
    }
  }

  // Provenance.
  if (input.channel === "community") {
    add(
      "high",
      "community_channel",
      "Community plugin: not reviewed by OpenClaw; it runs inside the gateway with full access",
    );
  } else if (!input.publisherOfficial) {
    add("medium", "publisher_unverified", "Official channel, but the publisher is not marked official");
  }
  if (UNVERIFIED_TIERS.has(input.verificationTier?.trim().toLowerCase() ?? "")) {
    add("medium", "unverified_source", "The release is not linked to a verified source");
  }

  // Additive but sensitive surfaces.
  if (d.hooks.length > 0) {
    add("high", "hooks", `Registers hooks (${list(d.hooks)}) that run on agent events`);
  }
  if (d.webSearchProviders.length > 0 || d.webFetchProviders.length > 0) {
    const names = [...d.webSearchProviders, ...d.webFetchProviders];
    add(
      "medium",
      "network_provider",
      `Adds web search or fetch providers (${list(names)}) that reach the internet`,
    );
  }
  if (d.providers.length > 0) {
    add(
      "medium",
      "model_provider",
      `Adds model providers (${list(d.providers)}) that receive prompts when selected`,
    );
  }
  if (providerFamilies > 0) {
    add(
      "medium",
      "provider_capability",
      "Adds media, document or other providers that process workspace data",
    );
  }

  const seen = new Set<string>();
  const unique = rules.filter((r) => !seen.has(r.code) && seen.add(r.code));
  // Worst first (stable), so the blocking reason is read first.
  const sorted = unique
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[b.r.level] - RANK[a.r.level] || a.i - b.i)
    .map(({ r }) => r);
  const risk = sorted.reduce<RiskLevel>((worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst), "low");
  return { risk, reasons: sorted.map(({ code, message }) => ({ code, message })) };
}

// ---------------------------------------------------------------- review binding

const SURFACE_KEYS = [
  "tools",
  "hooks",
  "channels",
  "providers",
  "webSearchProviders",
  "webFetchProviders",
  "mcpServers",
  "other",
] as const satisfies readonly (keyof DeclaredSurface)[];

/** The declared surface with every list deduplicated and sorted (what is stored and hashed). */
export function canonicalSurface(d: DeclaredSurface): DeclaredSurface {
  return Object.fromEntries(
    SURFACE_KEYS.map((k) => [k, [...new Set(d[k] ?? [])].sort()]),
  ) as unknown as DeclaredSurface;
}

/**
 * Binds an approval to exactly what the admin reviewed: sha256 hex of a canonical JSON of the package, version,
 * artifact digest and declared surface (key and list order do not matter).
 */
export function reviewTokenOf(r: {
  packageName: string;
  version: string;
  sha256: string;
  declared: DeclaredSurface;
}): string {
  const canonical = JSON.stringify([
    "ocw-plugin-review-v1",
    r.packageName,
    r.version,
    r.sha256.toLowerCase(),
    SURFACE_KEYS.map((k) => [k, [...new Set(r.declared[k] ?? [])].sort()]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Plugin ids bundled in the cell image (`OCW_BUNDLED_PLUGINS`, shared with the cell; `none` → []). */
export function bundledPluginIds(env: Pick<Env, "OCW_BUNDLED_PLUGINS">): string[] {
  return [...env.OCW_BUNDLED_PLUGINS];
}
