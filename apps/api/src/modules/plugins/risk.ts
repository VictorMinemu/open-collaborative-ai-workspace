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

/** R12 (07.8-18): why a native plugin with shell, file or browser tools is refused, and where the safe path is. */
export const SANDBOX_INSTEAD = "Runs inside the bot runtime, not a sandbox. Use a sandbox package instead.";

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
  // Native plugins run in the gateway (host "cell"). Shell, file and browser tools are refused here too, but they have a
  // safe home: a sandbox package (07.8-18, D-11 F-3, R12). Administration and messaging tools are refused everywhere.
  const dangerous = d.tools.filter((t) => isDangerousToolName(t));
  if (dangerous.length > 0) {
    const sandboxable = dangerous.every((t) => !isDangerousToolName(t, "sandbox"));
    add(
      "refuse",
      "dangerous_tool",
      sandboxable
        ? `${SANDBOX_INSTEAD} (${list(dangerous)})`
        : `Declares tools that are never allowed for bots: ${list(dangerous)}`,
    );
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

// ---------------------------------------------------------------- what the cell reported (03.1-12)

/** Reason codes that refuse a version because of its declared surface (never trust, digest or compatibility). */
const SURFACE_REFUSALS = new Set([
  "channel_bypass",
  "dangerous_tool",
  "bundled_mcp",
  "memory_slot",
  ...Object.values(REFUSED_FAMILIES).map((r) => r.code),
]);

/**
 * Re-scores what an installed plugin actually declares (the cell's `plugins inspect`, untrusted) with neutral trust,
 * digest and compatibility inputs, so only the surface itself can refuse it. Returns the refusing reasons (empty =
 * acceptable). The install was already gated by the reviewed surface; this catches a plugin whose real manifest or
 * runtime registrations differ from what ClawHub published (T-03.1-12-03).
 */
export function refusedReportedSurface(declared: DeclaredSurface, channel: PluginChannel): RiskReason[] {
  const verdict = scorePluginRisk({
    channel,
    publisherOfficial: true,
    verificationTier: "source-linked",
    scan: { status: "clean", blockedFromDownload: false, pending: false },
    compatibility: { minGatewayVersion: OPENCLAW_HOST_VERSION, pluginApiRange: null },
    declared,
  });
  return verdict.reasons.filter((r) => SURFACE_REFUSALS.has(r.code));
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

// ---------------------------------------------------------------- sandbox packages (07.8-18; D-03, D-11 F-3, P-12)

/**
 * What the risk of a sandbox package is decided from: sandboxd's review facts (untrusted registry metadata, read only
 * by sandboxd's containers) and the resolved tree.
 */
export interface SandboxPackageRiskInput {
  source: "npm" | "pypi" | "debian" | "clawhub";
  name: string;
  publisher: string | null;
  license: string | null;
  hasInstallScript: boolean;
  entries: readonly { name: string; version: string; integrity: string }[];
}

/**
 * The dependency-license policy of `pnpm guard` (scripts/guard/license-policy.json), restated: the API image does not
 * ship `scripts/`. A unit test keeps the two lists equal. OR: any operand allowed; AND: every operand; WITH: the base
 * license decides; anything unparseable is denied.
 */
export const SANDBOX_LICENSE_POLICY = {
  allow: [
    "MIT",
    "MIT-0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "Apache-2.0",
    "Unlicense",
    "CC0-1.0",
    "BlueOak-1.0.0",
    "Python-2.0",
    "Zlib",
    "MPL-2.0",
    "LGPL-2.1-or-later",
    "LGPL-3.0-or-later",
    "GPL-3.0-or-later",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later",
    "CC-BY-4.0",
    "WTFPL",
    "MIT-CMU",
    "PSF-2.0",
  ],
  deny: ["GPL-2.0-only", "SSPL-*", "BUSL-*", "Elastic-2.0", "CC-BY-NC-*", "UNLICENSED", "Unknown"],
} as const;

type LicenseNode = { id: string } | { and: LicenseNode[] } | { or: LicenseNode[] };

function parseLicense(expr: string): LicenseNode | null {
  const tokens: (string | { id: string })[] = [];
  for (const raw of expr.replace(/[()]/g, " $& ").trim().split(/\s+/)) {
    if (raw === "") continue;
    if (["(", ")", "AND", "OR", "WITH"].includes(raw)) tokens.push(raw);
    else if (/^[A-Za-z0-9.+-]+$/.test(raw)) tokens.push({ id: raw });
    else return null;
  }
  if (tokens.length === 0) return null;
  let i = 0;
  const atom = (): LicenseNode => {
    const t = tokens[i++];
    if (t === "(") {
      const node = or();
      if (tokens[i++] !== ")") throw new Error("unbalanced");
      return node;
    }
    if (typeof t !== "object") throw new Error("expected a license id");
    if (tokens[i] === "WITH") {
      i += 1;
      if (typeof tokens[i++] !== "object") throw new Error("expected an exception id");
    }
    return t;
  };
  const and = (): LicenseNode => {
    const nodes = [atom()];
    while (tokens[i] === "AND") {
      i += 1;
      nodes.push(atom());
    }
    return nodes.length === 1 ? (nodes[0] as LicenseNode) : { and: nodes };
  };
  const or = (): LicenseNode => {
    const nodes = [and()];
    while (tokens[i] === "OR") {
      i += 1;
      nodes.push(and());
    }
    return nodes.length === 1 ? (nodes[0] as LicenseNode) : { or: nodes };
  };
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

const LICENSE_ALLOWED = new Set<string>(SANDBOX_LICENSE_POLICY.allow);
const LICENSE_DENIED = SANDBOX_LICENSE_POLICY.deny.map(
  (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
);

/** Whether an SPDX expression is one the guard allows. */
export function licenseAllowed(expr: string): boolean {
  const ok = (n: LicenseNode): boolean =>
    "or" in n
      ? n.or.some(ok)
      : "and" in n
        ? n.and.every(ok)
        : LICENSE_ALLOWED.has(n.id) && !LICENSE_DENIED.some((re) => re.test(n.id));
  const tree = parseLicense(expr);
  return tree !== null && ok(tree);
}

/**
 * Widely used packages and, where known, their publishers: a name one typo away (optimal string alignment distance 1)
 * from one of them, published by someone else, is a likely typo-squat. Debian names are curated by the archive and
 * ClawHub skills have no such list, so only npm and PyPI are checked.
 */
const TOP_PACKAGES: Record<"npm" | "pypi", Record<string, readonly string[]>> = {
  npm: {
    lodash: ["jdalton"],
    chalk: ["sindresorhus"],
    express: [],
    react: [],
    axios: [],
    moment: [],
    commander: [],
    request: [],
    debug: [],
    webpack: [],
    typescript: [],
    eslint: [],
    prettier: [],
    jquery: [],
    underscore: [],
    async: [],
    bluebird: [],
    uuid: [],
    dotenv: [],
    yargs: [],
    minimist: [],
    semver: [],
    colors: [],
    mkdirp: [],
    rimraf: [],
    puppeteer: [],
    playwright: [],
    electron: [],
    nodemon: [],
    mongoose: [],
    "cross-env": [],
    "body-parser": [],
    "crypto-js": [],
    "node-fetch": [],
  },
  pypi: {
    requests: [],
    numpy: [],
    pandas: [],
    urllib3: [],
    setuptools: [],
    boto3: [],
    django: [],
    flask: [],
    pyyaml: [],
    cryptography: [],
    pillow: [],
    scipy: [],
    matplotlib: [],
    selenium: [],
    beautifulsoup4: [],
    playwright: [],
    openai: [],
    pytest: [],
  },
};

/** Optimal string alignment distance (insert, delete, substitute, swap two neighbours), capped at `max + 1`. */
function typoDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = v;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

const normalName = (source: string, name: string) =>
  source === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name.toLowerCase();

/**
 * Sandbox package risk (07.8-18; D-03, D-11 F-3; P-12). PURE: no I/O. A sandbox package runs only inside a bot's own
 * sandbox (gVisor, its own network through the egress proxy, a read-only mount), so shell, file and browser
 * capabilities are what it is for and never refuse it (the host-aware `isDangerousToolName(name, "sandbox")` rule).
 * Refused: the OpenClaw platform itself (administration stays refused everywhere) and a tree whose integrity cannot pin
 * it (sha1). High: a license the dependency guard denies or none, and a likely typo-squat. Medium: an install script.
 */
export function scoreSandboxPackageRisk(input: SandboxPackageRiskInput): RiskVerdict {
  const rules: Rule[] = [];
  const add = (level: Rule["level"], code: string, message: string) =>
    rules.push({ level, code, message: cap(message) });
  const lower = input.name.toLowerCase();
  const base = lower.replace(/^@[^/]+\//, "");

  if (lower.startsWith("@openclaw/") || base === "openclaw") {
    add(
      "refuse",
      "platform_admin",
      "This is the OpenClaw platform itself; platform administration tools stay refused everywhere",
    );
  }
  const weak = input.entries.filter((e) => e.integrity.startsWith("sha1-"));
  if (weak.length > 0) {
    add(
      "refuse",
      "weak_integrity",
      `${weak.length === 1 ? "One dependency is" : `${weak.length} dependencies are`} pinned only by sha1, which cannot pin it safely; this version cannot be installed`,
    );
  }

  const license = input.license?.trim() ?? "";
  if (license === "") {
    add("high", "license_unknown", "The registry states no license for this version");
  } else if (!licenseAllowed(license)) {
    add("high", "license_denied", `Its license (${license}) is not one the workspace allows`);
  }

  if (input.source === "npm" || input.source === "pypi") {
    const name = normalName(input.source, input.name);
    const publisher = input.publisher?.trim().toLowerCase() ?? null;
    for (const [top, publishers] of Object.entries(TOP_PACKAGES[input.source])) {
      if (top.length < 4 || name === top) continue;
      if (typoDistance(name, top) !== 1) continue;
      if (publisher !== null && publishers.includes(publisher)) continue;
      add(
        "high",
        "typosquat",
        `Its name is one typo away from ${top}, and it is not published by ${top}'s publisher`,
      );
      break;
    }
  }

  if (input.hasInstallScript) {
    add(
      "medium",
      "install_script",
      "Runs an install script (only inside the installer container, never in the API or the cell)",
    );
  }

  const sorted = rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[b.r.level] - RANK[a.r.level] || a.i - b.i)
    .map(({ r }) => r);
  const risk = sorted.reduce<RiskLevel>((worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst), "low");
  return { risk, reasons: sorted.map(({ code, message }) => ({ code, message })) };
}
