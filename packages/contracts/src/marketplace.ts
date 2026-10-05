import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * OpenClaw Marketplace (ClawHub) for the organization's cell (Phase 3.1, D-14; BOT-09, BOT-10). The API proxies
 * ClawHub (metadata cached, no telemetry, the cell never browses). Every version gets a deterministic risk from
 * its channel, verification, scan/trust state, compatibility and declared surface; Organization Admins
 * (`plugin.manage`) approve exact, pinned versions bound to a `reviewToken` (package, version, digest, declared
 * surface). The cell installs only approved digests (03.1-12).
 */

export const PluginChannel = z.enum(["official", "community"]);
export type PluginChannel = z.infer<typeof PluginChannel>;

/** `refuse` can never be installed; `high` needs an explicit acknowledgement. */
export const RiskLevel = z.enum(["low", "medium", "high", "refuse"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const RiskReason = z.object({ code: z.string().max(64), message: z.string().max(200) });
export type RiskReason = z.infer<typeof RiskReason>;

/**
 * What a plugin version declares (its manifest summary on ClawHub, or what the cell inspected after install).
 * `other` lists every further capability as `<family>:<id>` (`gatewayMethodDispatch:authenticated-request`,
 * `cliBackends:…`, `kind:memory`, `skills:…`, `embeddingProviders:…`, `manifest:missing`).
 */
export const DeclaredSurface = z.object({
  tools: z.array(z.string()),
  hooks: z.array(z.string()),
  channels: z.array(z.string()),
  providers: z.array(z.string()),
  webSearchProviders: z.array(z.string()),
  webFetchProviders: z.array(z.string()),
  mcpServers: z.array(z.string()),
  other: z.array(z.string()),
});
export type DeclaredSurface = z.infer<typeof DeclaredSurface>;

export const EMPTY_DECLARED_SURFACE: DeclaredSurface = Object.freeze({
  tools: [],
  hooks: [],
  channels: [],
  providers: [],
  webSearchProviders: [],
  webFetchProviders: [],
  mcpServers: [],
  other: [],
}) as DeclaredSurface;

export const MarketplaceEntry = z.object({
  packageName: z.string(),
  displayName: z.string(),
  summary: z.string().nullable(),
  publisher: z.string(),
  publisherOfficial: z.boolean(),
  channel: PluginChannel,
  latestVersion: z.string(),
  downloads: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
  stars: z.number().int().nonnegative(),
  scanStatus: z.string().nullable(),
  verificationTier: z.string().nullable(),
  /** Already bundled in the cell image (`OCW_BUNDLED_PLUGINS`): nothing to install. */
  bundled: z.boolean(),
  /** This organization's active install of the package, if any. */
  installed: z.object({ id: Id, version: z.string(), status: z.string() }).nullable(),
});
export type MarketplaceEntry = z.infer<typeof MarketplaceEntry>;

export const MarketplaceSearchResult = z.object({
  entries: z.array(MarketplaceEntry),
  nextCursor: z.string().nullable(),
  /** `cache` = served from the API's ClawHub cache (fresh, or stale while ClawHub is unreachable). */
  source: z.enum(["live", "cache"]),
});
export type MarketplaceSearchResult = z.infer<typeof MarketplaceSearchResult>;

export const MarketplaceVersionReview = z.object({
  packageName: z.string(),
  version: z.string(),
  publishedAt: IsoDateTime.nullable(),
  channel: PluginChannel,
  publisher: z.string(),
  verification: z.object({
    tier: z.string().nullable(),
    hasProvenance: z.boolean(),
    sourceRepo: z.string().nullable(),
    sourceCommit: z.string().nullable(),
  }),
  scan: z.object({
    status: z.string().nullable(),
    blockedFromDownload: z.boolean(),
    pending: z.boolean(),
    reasons: z.array(z.string()),
  }),
  compatibility: z.object({
    minGatewayVersion: z.string().nullable(),
    pluginApiRange: z.string().nullable(),
    compatible: z.boolean(),
  }),
  /** `sha256` is empty when ClawHub publishes no digest (such a version is refused). */
  artifact: z.object({
    sha256: z.string(),
    npmIntegrity: z.string().nullable(),
    size: z.number().int().nullable(),
  }),
  declared: DeclaredSurface,
  risk: RiskLevel,
  riskReasons: z.array(RiskReason),
  /** sha256 of (package, version, digest, declared surface): approval must send it back unchanged. */
  reviewToken: z.string(),
});
export type MarketplaceVersionReview = z.infer<typeof MarketplaceVersionReview>;

export const MarketplacePackageDetail = z.object({
  entry: MarketplaceEntry,
  versions: z.array(z.object({ version: z.string(), publishedAt: IsoDateTime.nullable() })),
  review: MarketplaceVersionReview,
});
export type MarketplacePackageDetail = z.infer<typeof MarketplacePackageDetail>;

export const ApprovePluginInstallRequest = z.object({
  packageName: z.string().max(214),
  version: z.string().max(64),
  reviewToken: z.string().max(128),
  acknowledgeHighRisk: z.boolean().default(false),
  /** Personal bots may use the plugin. A high-risk plugin needs `acknowledgeHighRisk` with it. */
  personalAllowed: z.boolean().default(false),
});
export type ApprovePluginInstallRequest = z.infer<typeof ApprovePluginInstallRequest>;

export const CellPluginStatus = z.enum([
  "approved",
  "installing",
  "installed",
  "failed",
  "uninstalling",
  "uninstalled",
]);
export type CellPluginStatus = z.infer<typeof CellPluginStatus>;

export const CellPlugin = z.object({
  id: Id,
  packageName: z.string(),
  pluginId: z.string().nullable(),
  version: z.string(),
  channel: PluginChannel,
  publisher: z.string().nullable(),
  risk: RiskLevel,
  riskReasons: z.array(RiskReason),
  status: CellPluginStatus,
  statusDetail: z.string().nullable(),
  orgEnabled: z.boolean(),
  personalAllowed: z.boolean(),
  trustedChaining: z.boolean(),
  tools: z.array(
    z.object({ name: z.string(), description: z.string().nullable(), sideEffecting: z.boolean() }),
  ),
  approvedAt: IsoDateTime.nullable(),
  installedAt: IsoDateTime.nullable(),
});
export type CellPlugin = z.infer<typeof CellPlugin>;

export const CellPluginList = z.object({ plugins: z.array(CellPlugin) });
export type CellPluginList = z.infer<typeof CellPluginList>;

/** `PATCH /cell-plugins/:id`: any subset, no defaults (a flag PATCH must not reset the others). */
export const UpdateCellPluginRequest = z.object({
  orgEnabled: z.boolean().optional(),
  personalAllowed: z.boolean().optional(),
  trustedChaining: z.boolean().optional(),
  acknowledgeHighRisk: z.boolean().optional(),
  /** Manual update to another pinned version, bound to that version's fresh review. */
  upgrade: z.object({ version: z.string().max(64), reviewToken: z.string().max(128) }).optional(),
});
export type UpdateCellPluginRequest = z.infer<typeof UpdateCellPluginRequest>;

/** `GET /marketplace/search` query. Empty `q` browses the catalog (most downloaded first). */
export const MarketplaceSearchQuery = z.object({
  q: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(200).optional(),
});
export type MarketplaceSearchQuery = z.infer<typeof MarketplaceSearchQuery>;

export const MarketplacePackageParams = z.object({ name: z.string().min(1).max(214) });
export const MarketplacePackageQuery = z.object({ version: z.string().max(64).optional() });
