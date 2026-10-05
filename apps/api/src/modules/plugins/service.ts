import { randomUUID } from "node:crypto";
import {
  AgentChannelEventTypes,
  type AgentChannelPluginList,
  type AgentChannelPluginReport,
  type AgentChannelPluginVerifyInstall,
  type AgentChannelPluginVerifyInstallResponse,
  type ApprovePluginInstallRequest,
  BUILTIN_TOOLS,
  type CellApprovedPlugin,
  type CellPlugin,
  CellPluginStatus,
  cellTopic,
  type DeclaredSurface,
  DeclaredSurface as DeclaredSurfaceSchema,
  EMPTY_DECLARED_SURFACE,
  type MarketplaceEntry,
  type MarketplacePackageDetail,
  type MarketplaceSearchQuery,
  type MarketplaceSearchResult,
  type MarketplaceVersionReview,
  RiskReason,
  type UpdateCellPluginRequest,
} from "@ocw/contracts";
import { botToolGrants, cellPlugins, cellPluginTools, type TenantCtx, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { notifyCellConfig } from "../bot-capabilities";
import {
  type ClawhubClient,
  type ClawhubPackage,
  type ClawhubVersionDetail,
  MarketplaceNotFoundError,
  MarketplaceUnavailableError,
} from "./clawhub";
import {
  bundledPluginIds,
  canonicalSurface,
  compatibilityOf,
  refusedReportedSurface,
  reviewTokenOf,
  scorePluginRisk,
} from "./risk";

/**
 * Marketplace service (D-14, BOT-09, BOT-10). ClawHub is called OUTSIDE database transactions (a slow registry
 * never holds a connection). Approvals re-read the release live and compare `reviewTokenOf` with the token the
 * admin reviewed (T-03.1-11-02); the cell gets exactly the reviewed digest from the configured origin
 * (T-03.1-11-03). Every lifecycle step is audited with package, version and digest (T-03.1-11-08).
 */

export interface PluginsDeps {
  core: Core;
  clawhub: ClawhubClient;
}

type PluginRow = typeof cellPlugins.$inferSelect;
type ToolRow = typeof cellPluginTools.$inferSelect;

const ACTIVE = ne(cellPlugins.status, "uninstalled");

// ---------------------------------------------------------------- errors

/** Maps ClawHub failures to typed API errors: 503 `marketplace_unavailable`, 404 `package_not_found`. */
async function clawhubCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MarketplaceUnavailableError) {
      throw new HttpError(
        503,
        "marketplace_unavailable",
        "The OpenClaw Marketplace is unreachable right now",
        {
          reason: error.reason,
        },
      );
    }
    if (error instanceof MarketplaceNotFoundError) {
      throw notFound("Package or version not found on the marketplace", "package_not_found");
    }
    throw error;
  }
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

// ---------------------------------------------------------------- review

/**
 * The admin-facing review of one release: ClawHub metadata, the pure risk verdict and the review token. A
 * package without an OpenClaw plugin id is refused too (the cell could not verify what the install produced).
 */
export function buildVersionReview(d: ClawhubVersionDetail): MarketplaceVersionReview {
  const verdict = scorePluginRisk({
    channel: d.package.channel,
    publisherOfficial: d.package.publisherOfficial,
    verificationTier: d.verification.tier,
    scan: d.scan,
    compatibility: d.compatibility,
    declared: d.declared,
    artifactSha256: d.artifact.sha256,
  });
  let { risk, reasons } = verdict;
  if (!d.package.runtimeId) {
    risk = "refuse";
    reasons = [
      { code: "missing_plugin_id", message: "ClawHub publishes no OpenClaw plugin id for this package" },
      ...reasons,
    ];
  }
  return {
    packageName: d.package.packageName,
    version: d.version,
    publishedAt: d.publishedAt,
    channel: d.package.channel,
    publisher: d.package.publisher,
    verification: d.verification,
    scan: {
      status: d.scan.status,
      blockedFromDownload: d.scan.blockedFromDownload,
      pending: d.scan.pending,
      reasons: d.scan.reasons,
    },
    compatibility: {
      minGatewayVersion: d.compatibility.minGatewayVersion,
      pluginApiRange: d.compatibility.pluginApiRange,
      compatible: compatibilityOf(d.compatibility) === "compatible",
    },
    artifact: d.artifact,
    declared: d.declared,
    risk,
    riskReasons: reasons,
    reviewToken: reviewTokenOf({
      packageName: d.package.packageName,
      version: d.version,
      sha256: d.artifact.sha256,
      declared: d.declared,
    }),
  };
}

// ---------------------------------------------------------------- DTOs

function toCellPlugin(row: PluginRow, tools: readonly ToolRow[]): CellPlugin {
  const reasons = z.array(RiskReason).safeParse(row.riskReasons);
  return {
    id: row.id,
    packageName: row.packageName,
    pluginId: row.pluginId,
    version: row.version,
    channel: row.channel,
    publisher: row.publisher,
    risk: row.risk,
    riskReasons: reasons.success ? reasons.data : [],
    status: CellPluginStatus.parse(row.status),
    statusDetail: row.statusDetail,
    orgEnabled: row.orgEnabled,
    personalAllowed: row.personalAllowed,
    trustedChaining: row.trustedChaining,
    tools: tools
      .filter((t) => t.pluginRowId === row.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, sideEffecting: t.sideEffecting })),
    approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
    installedAt: row.installedAt ? new Date(row.installedAt).toISOString() : null,
  };
}

async function findPlugin(tx: Tx, id: string): Promise<PluginRow> {
  const [row] = await tx.select().from(cellPlugins).where(eq(cellPlugins.id, id));
  if (!row || row.status === "uninstalled") throw notFound("Plugin not found", "plugin_not_found");
  return row;
}

/** 404 `plugin_not_found` when absent, uninstalled or another tenant's (RLS). */
export async function getCellPlugin(tx: Tx, id: string): Promise<CellPlugin> {
  const row = await findPlugin(tx, id);
  const tools = await tx.select().from(cellPluginTools).where(eq(cellPluginTools.pluginRowId, id));
  return toCellPlugin(row, tools);
}

/** The organization's approved / installed plugins (uninstalled history omitted). */
export async function listCellPlugins(tx: Tx): Promise<CellPlugin[]> {
  const rows = await tx.select().from(cellPlugins).where(ACTIVE).orderBy(asc(cellPlugins.packageName));
  if (rows.length === 0) return [];
  const tools = await tx.select().from(cellPluginTools);
  return rows.map((r) => toCellPlugin(r, tools));
}

async function installedByPackage(tx: Tx): Promise<Map<string, MarketplaceEntry["installed"]>> {
  const rows = await tx
    .select({
      id: cellPlugins.id,
      packageName: cellPlugins.packageName,
      version: cellPlugins.version,
      status: cellPlugins.status,
    })
    .from(cellPlugins)
    .where(ACTIVE);
  return new Map(rows.map((r) => [r.packageName, { id: r.id, version: r.version, status: r.status }]));
}

function toEntry(
  p: ClawhubPackage,
  bundled: ReadonlySet<string>,
  installed: Map<string, MarketplaceEntry["installed"]>,
): MarketplaceEntry {
  return {
    packageName: p.packageName,
    displayName: p.displayName,
    summary: p.summary,
    publisher: p.publisher,
    publisherOfficial: p.publisherOfficial,
    channel: p.channel,
    latestVersion: p.latestVersion,
    downloads: p.downloads,
    installs: p.installs,
    stars: p.stars,
    scanStatus: p.scanStatus,
    verificationTier: p.verificationTier,
    bundled: p.runtimeId !== null && bundled.has(p.runtimeId.toLowerCase()),
    installed: installed.get(p.packageName) ?? null,
  };
}

// ---------------------------------------------------------------- browse

export async function searchMarketplace(
  deps: PluginsDeps,
  ctx: TenantCtx,
  q: MarketplaceSearchQuery,
): Promise<MarketplaceSearchResult> {
  const result = await clawhubCall(() =>
    deps.clawhub.search(q.q, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) }),
  );
  const installed = await deps.core.db.withTenant(ctx, (tx) => installedByPackage(tx));
  const bundled = new Set(bundledPluginIds(deps.core.env));
  return {
    entries: result.packages.map((p) => toEntry(p, bundled, installed)),
    nextCursor: result.nextCursor,
    source: result.source,
  };
}

export async function packageDetail(
  deps: PluginsDeps,
  ctx: TenantCtx,
  name: string,
  version?: string,
): Promise<MarketplacePackageDetail> {
  // A review is what an approval binds to: ask ClawHub first (a cached copy only during an outage).
  const { detail } = await clawhubCall(() => deps.clawhub.versionDetail(name, version, { refresh: true }));
  const installed = await deps.core.db.withTenant(ctx, (tx) => installedByPackage(tx));
  return {
    entry: toEntry(detail.package, new Set(bundledPluginIds(deps.core.env)), installed),
    versions: detail.versions,
    review: buildVersionReview(detail),
  };
}

// ---------------------------------------------------------------- approvals

/**
 * The live, admin-bound review of `name@version`: re-read from ClawHub (never the cache), compared with the
 * admin's token, refused / acknowledged per risk.
 */
async function liveApprovedReview(
  deps: PluginsDeps,
  name: string,
  version: string,
  reviewToken: string,
  acknowledgeHighRisk: boolean,
): Promise<{ detail: ClawhubVersionDetail; review: MarketplaceVersionReview }> {
  const { detail } = await clawhubCall(() => deps.clawhub.versionDetail(name, version, { live: true }));
  const review = buildVersionReview(detail);
  if (review.reviewToken !== reviewToken) {
    throw new HttpError(
      409,
      "review_changed",
      "This release changed on the marketplace since you reviewed it. Review it again.",
      { review },
    );
  }
  if (review.risk === "refuse") {
    throw new HttpError(422, "plugin_refused", "This plugin version cannot be installed in this workspace", {
      reasons: review.riskReasons,
    });
  }
  if (review.risk === "high" && !acknowledgeHighRisk) {
    throw conflict(
      "This is a high-risk plugin: acknowledge the risk to install it",
      "high_risk_ack_required",
    );
  }
  return { detail, review };
}

function artifactUrlOf(deps: PluginsDeps, name: string, version: string): string {
  const url = deps.clawhub.artifactUrl(name, version);
  // Defense in depth: the cell will only download from this origin (T-03.1-11-03).
  if (new URL(url).origin !== new URL(deps.core.env.OCW_CLAWHUB_URL).origin) {
    throw new Error("artifact URL is not on the configured ClawHub origin");
  }
  return url;
}

function storedSurface(d: DeclaredSurface): Record<string, unknown> {
  return DeclaredSurfaceSchema.parse(d);
}

export async function approveInstall(
  deps: PluginsDeps,
  ctx: TenantCtx,
  input: ApprovePluginInstallRequest,
): Promise<CellPlugin> {
  const { core } = deps;
  const { detail, review } = await liveApprovedReview(
    deps,
    input.packageName,
    input.version,
    input.reviewToken,
    input.acknowledgeHighRisk,
  );
  const runtimeId = detail.package.runtimeId;
  if (runtimeId && bundledPluginIds(core.env).includes(runtimeId.toLowerCase())) {
    throw conflict("This plugin is already bundled in the cell image", "bundled_plugin");
  }
  // A high-risk plugin reaches personal bots only when asked for together with the acknowledgement (P-B5).
  const personalAllowed = input.personalAllowed && (review.risk !== "high" || input.acknowledgeHighRisk);
  const artifactUrl = artifactUrlOf(deps, input.packageName, input.version);

  try {
    return await core.db.withTenant(ctx, async (tx) => {
      const { organizationId, userId } = tenantOf(tx);
      const [existing] = await tx
        .select({ id: cellPlugins.id })
        .from(cellPlugins)
        .where(and(eq(cellPlugins.packageName, input.packageName), ACTIVE));
      if (existing) {
        throw conflict(
          "This plugin is already installed; update or uninstall it instead",
          "already_installed",
        );
      }
      const flowId = randomUUID();
      const now = new Date().toISOString();
      const [row] = await tx
        .insert(cellPlugins)
        .values({
          organizationId,
          packageName: input.packageName,
          pluginId: runtimeId,
          version: input.version,
          channel: review.channel,
          publisher: review.publisher,
          artifactSha256: review.artifact.sha256,
          npmIntegrity: review.artifact.npmIntegrity,
          artifactUrl,
          risk: review.risk,
          riskReasons: review.riskReasons,
          declared: storedSurface(review.declared),
          status: "installing",
          personalAllowed,
          flowId,
          approvedBy: userId ?? null,
          approvedAt: now,
        })
        .returning();
      if (!row) throw new Error("cell plugin insert failed");

      await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.pluginInstall, {
        type: AgentChannelEventTypes.pluginInstall,
        organizationId,
        cellId: organizationId,
        flowId,
        pluginRowId: row.id,
        packageName: row.packageName,
        version: row.version,
        artifactUrl,
        sha256: row.artifactSha256,
        npmIntegrity: row.npmIntegrity,
        expectedPluginId: runtimeId,
        mode: "install",
      });
      await core.audit.record(tx, {
        action: "plugin.install_requested",
        resourceType: "cell_plugin",
        resourceId: row.id,
        metadata: {
          packageName: row.packageName,
          version: row.version,
          sha256: row.artifactSha256,
          channel: row.channel,
          publisher: row.publisher,
          risk: row.risk,
          riskCodes: review.riskReasons.map((r) => r.code),
          acknowledgeHighRisk: input.acknowledgeHighRisk,
          personalAllowed,
          flowId,
        },
      });
      return toCellPlugin(row, []);
    });
  } catch (error) {
    // Two admins approving the same package at once: the unique index decides.
    if (isUniqueViolation(error)) {
      throw conflict("This plugin is already installed; update or uninstall it instead", "already_installed");
    }
    throw error;
  }
}

// ---------------------------------------------------------------- settings and updates

const FLAGS = ["orgEnabled", "personalAllowed", "trustedChaining"] as const;

export async function updateCellPlugin(
  deps: PluginsDeps,
  ctx: TenantCtx,
  id: string,
  input: UpdateCellPluginRequest,
): Promise<CellPlugin> {
  const { core } = deps;
  // Fail fast (404 / state) before calling ClawHub.
  const current = await core.db.withTenant(ctx, (tx) => findPlugin(tx, id));
  if (current.status === "uninstalling") {
    throw conflict("This plugin is being uninstalled", "plugin_uninstalling");
  }
  let upgrade: { detail: ClawhubVersionDetail; review: MarketplaceVersionReview } | null = null;
  if (input.upgrade) {
    if (current.status !== "installed" && current.status !== "failed") {
      throw conflict("Wait until the current install or update finishes", "plugin_busy");
    }
    if (input.upgrade.version === current.version) {
      throw conflict("This version is already installed", "same_version");
    }
    upgrade = await liveApprovedReview(
      deps,
      current.packageName,
      input.upgrade.version,
      input.upgrade.reviewToken,
      input.acknowledgeHighRisk === true,
    );
  }

  return core.db.withTenant(ctx, async (tx) => {
    const { organizationId, userId } = tenantOf(tx);
    const row = await findPlugin(tx, id);
    if (row.status === "uninstalling")
      throw conflict("This plugin is being uninstalled", "plugin_uninstalling");
    if (
      upgrade &&
      ((row.status !== "installed" && row.status !== "failed") || row.version !== current.version)
    ) {
      throw conflict("Wait until the current install or update finishes", "plugin_busy");
    }

    const patch: Partial<typeof cellPlugins.$inferInsert> = {};
    const changed: string[] = [];
    for (const key of FLAGS) {
      const value = input[key];
      if (value !== undefined && value !== row[key]) {
        patch[key] = value;
        changed.push(key);
      }
    }
    const risk = upgrade?.review.risk ?? row.risk;
    const personal = patch.personalAllowed ?? row.personalAllowed;
    // Community / high-risk plugins reach personal bots only with an explicit acknowledgement (P-B5).
    if (
      personal &&
      risk === "high" &&
      (changed.includes("personalAllowed") || upgrade) &&
      !input.acknowledgeHighRisk
    ) {
      throw conflict(
        "This is a high-risk plugin: acknowledge the risk to allow it for personal bots",
        "high_risk_ack_required",
      );
    }

    const now = new Date().toISOString();
    let flowId: string | null = null;
    if (upgrade) {
      flowId = randomUUID();
      const artifactUrl = artifactUrlOf(deps, row.packageName, upgrade.review.version);
      Object.assign(patch, {
        version: upgrade.review.version,
        channel: upgrade.review.channel,
        publisher: upgrade.review.publisher,
        artifactSha256: upgrade.review.artifact.sha256,
        npmIntegrity: upgrade.review.artifact.npmIntegrity,
        artifactUrl,
        risk: upgrade.review.risk,
        riskReasons: upgrade.review.riskReasons,
        declared: storedSurface(upgrade.review.declared),
        status: "installing",
        statusDetail: null,
        flowId,
        approvedBy: userId ?? null,
        approvedAt: now,
      } satisfies Partial<typeof cellPlugins.$inferInsert>);
    }
    if (changed.length === 0 && !upgrade) return getCellPlugin(tx, id);

    await tx
      .update(cellPlugins)
      .set({ ...patch, updatedAt: now })
      .where(eq(cellPlugins.id, id));

    if (upgrade && flowId) {
      await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.pluginInstall, {
        type: AgentChannelEventTypes.pluginInstall,
        organizationId,
        cellId: organizationId,
        flowId,
        pluginRowId: id,
        packageName: row.packageName,
        version: upgrade.review.version,
        artifactUrl: patch.artifactUrl,
        sha256: upgrade.review.artifact.sha256,
        npmIntegrity: upgrade.review.artifact.npmIntegrity,
        expectedPluginId: row.pluginId ?? upgrade.detail.package.runtimeId,
        mode: "update",
      });
      await core.audit.record(tx, {
        action: "plugin.update_requested",
        resourceType: "cell_plugin",
        resourceId: id,
        metadata: {
          packageName: row.packageName,
          fromVersion: row.version,
          version: upgrade.review.version,
          fromSha256: row.artifactSha256,
          sha256: upgrade.review.artifact.sha256,
          risk: upgrade.review.risk,
          riskCodes: upgrade.review.riskReasons.map((r) => r.code),
          acknowledgeHighRisk: input.acknowledgeHighRisk === true,
          flowId,
        },
      });
    }
    if (changed.length > 0) {
      await core.audit.record(tx, {
        action: "plugin.settings_updated",
        resourceType: "cell_plugin",
        resourceId: id,
        metadata: {
          packageName: row.packageName,
          version: patch.version ?? row.version,
          changed,
          ...Object.fromEntries(changed.map((k) => [k, patch[k as (typeof FLAGS)[number]]])),
          ...(input.acknowledgeHighRisk ? { acknowledgeHighRisk: true } : {}),
        },
      });
      // The tool catalog / alsoAllow / taint flags of every bot may change.
      await notifyCellConfig(core, tx, "tools.updated", null);
    }
    return getCellPlugin(tx, id);
  });
}

// ---------------------------------------------------------------- uninstall

/**
 * Takes the plugin's tools off every bot (same transaction), then asks the cell to remove it. Idempotent while
 * the cell works on it.
 */
export async function uninstallCellPlugin(
  deps: PluginsDeps,
  ctx: TenantCtx,
  id: string,
): Promise<CellPlugin> {
  const { core } = deps;
  return core.db.withTenant(ctx, async (tx) => {
    const { organizationId } = tenantOf(tx);
    const row = await findPlugin(tx, id);
    if (row.status === "uninstalling") return getCellPlugin(tx, id);

    const removed = await tx
      .delete(botToolGrants)
      .where(and(eq(botToolGrants.sourceKind, "plugin"), eq(botToolGrants.sourceId, id)))
      .returning({ agentId: botToolGrants.agentId });
    const flowId = randomUUID();
    const now = new Date().toISOString();
    // Without a plugin id nothing in the cell can be identified: the row is closed directly.
    const status = row.pluginId ? "uninstalling" : "uninstalled";
    await tx
      .update(cellPlugins)
      .set({ status, statusDetail: null, flowId, updatedAt: now })
      .where(eq(cellPlugins.id, id));
    if (row.pluginId) {
      await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.pluginUninstall, {
        type: AgentChannelEventTypes.pluginUninstall,
        organizationId,
        cellId: organizationId,
        flowId,
        pluginRowId: id,
        pluginId: row.pluginId,
      });
    }
    await core.audit.record(tx, {
      action: "plugin.uninstall_requested",
      resourceType: "cell_plugin",
      resourceId: id,
      metadata: {
        packageName: row.packageName,
        version: row.version,
        sha256: row.artifactSha256,
        pluginId: row.pluginId,
        removedGrants: removed.length,
        flowId,
      },
    });
    await notifyCellConfig(core, tx, "tools.updated", null);
    if (status === "uninstalled") {
      const tools = await tx.select().from(cellPluginTools).where(eq(cellPluginTools.pluginRowId, id));
      return toCellPlugin({ ...row, status, flowId }, tools);
    }
    return getCellPlugin(tx, id);
  });
}

// ---------------------------------------------------------------- the cell's side (03.1-12)

/** Who acts for the audit rows of the cell's plugin routes (the cell principal, never a human). */
export interface CellActor {
  sessionId: string;
}

/** Statuses the cell sees in `GET /cell`: in flight, installed, being removed, or rejected (still to remove). */
const CELL_VISIBLE = ["installing", "installed", "uninstalling", "failed"] as const;

/** `GET /cell` `plugins`: the approved tuples the cell's executor may act on (D-14). */
export async function cellApprovedPlugins(tx: Tx): Promise<CellApprovedPlugin[]> {
  const rows = await tx
    .select()
    .from(cellPlugins)
    .where(inArray(cellPlugins.status, [...CELL_VISIBLE]))
    .orderBy(asc(cellPlugins.packageName));
  return rows.map((r) => ({
    pluginRowId: r.id,
    packageName: r.packageName,
    version: r.version,
    sha256: r.artifactSha256,
    pluginId: r.pluginId,
    status: r.status,
  }));
}

/** `GET /agent-channel/v1/plugins`: what the boot render re-allows (installed ids); no digest, no secret. */
export async function cellPluginList(tx: Tx): Promise<AgentChannelPluginList> {
  const rows = await tx
    .select()
    .from(cellPlugins)
    .where(inArray(cellPlugins.status, ["installing", "installed", "uninstalling"]))
    .orderBy(asc(cellPlugins.packageName));
  return {
    plugins: rows.flatMap((r) =>
      r.pluginId && (r.status === "installing" || r.status === "installed" || r.status === "uninstalling")
        ? [{ pluginId: r.pluginId, packageName: r.packageName, version: r.version, status: r.status }]
        : [],
    ),
  };
}

/**
 * The install gate's question (`POST /agent-channel/v1/plugins/verify-install`): is exactly this staged artifact an
 * admin-approved install in flight? Only a row of this organization (RLS) in status `installing` with the same
 * package, version and sha256 approves. A single read; a refusal is audited (`plugin.install_blocked`).
 */
export async function verifyInstall(
  core: Core,
  tx: Tx,
  q: AgentChannelPluginVerifyInstall,
  actor: CellActor,
): Promise<AgentChannelPluginVerifyInstallResponse> {
  const rows = await tx
    .select()
    .from(cellPlugins)
    .where(and(eq(cellPlugins.packageName, q.packageName), ACTIVE));
  const sha = q.sha256.toLowerCase();
  const inFlight = rows.filter((r) => r.status === "installing");
  const hit = inFlight.find((r) => r.version === q.version && r.artifactSha256.toLowerCase() === sha);
  if (hit) return { approved: true, reason: null };
  const reason =
    rows.length === 0
      ? "not_approved"
      : inFlight.length === 0
        ? "not_in_flight"
        : !inFlight.some((r) => r.version === q.version)
          ? "version_mismatch"
          : "digest_mismatch";
  await core.audit.record(tx, {
    action: "plugin.install_blocked",
    resourceType: "cell_plugin",
    resourceId: rows[0]?.id ?? null,
    actorKind: "system",
    clientKind: "agent",
    sessionId: actor.sessionId,
    result: "denied",
    metadata: { packageName: q.packageName, version: q.version, sha256: sha, reason },
  });
  return { approved: false, reason };
}

const TOOL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOLS));

/**
 * `POST /agent-channel/v1/plugins/report` (03.1-12): one flow's outcome, applied only to the row's current flow
 * (another flow, another organization's row or an unknown row → 404 `plugin_flow_not_found`). What the cell
 * inspected is untrusted: it is re-scored, and a refused surface, a builtin or malformed tool name, or a plugin id /
 * version other than the approved one rejects the plugin (`failed`, `plugin.uninstall.v1`, audited
 * `plugin.rejected_after_install`). Accepted tools replace `cell_plugin_tools` (always side-effecting). Status machine:
 * `installing → installed | failed`, `uninstalling → uninstalled`; a rejected row stays `failed` after the cell removed
 * it. Replays of a recorded outcome are accepted and change nothing; any other transition is 409.
 */
export async function recordPluginReport(
  core: Core,
  tx: Tx,
  report: AgentChannelPluginReport,
  actor: CellActor,
): Promise<void> {
  const { organizationId } = tenantOf(tx);
  const [row] = await tx.select().from(cellPlugins).where(eq(cellPlugins.id, report.pluginRowId));
  if (!row || row.flowId !== report.flowId) {
    throw notFound("No such plugin flow in this cell", "plugin_flow_not_found");
  }
  const invalid = () =>
    conflict(
      `A ${report.state} report does not apply to a plugin that is ${row.status}`,
      "invalid_plugin_state",
    );
  const audit = (
    action: string,
    metadata: Record<string, unknown>,
    result?: "success" | "denied" | "error",
  ) =>
    core.audit.record(tx, {
      action,
      resourceType: "cell_plugin",
      resourceId: row.id,
      actorKind: "system",
      clientKind: "agent",
      sessionId: actor.sessionId,
      ...(result ? { result } : {}),
      metadata: {
        packageName: row.packageName,
        version: row.version,
        sha256: row.artifactSha256,
        flowId: report.flowId,
        ...metadata,
      },
    });
  const now = new Date().toISOString();

  if (report.state === "installing") return;

  if (report.state === "failed") {
    const code = report.error?.code ?? "install_failed";
    const detail = `${code}: ${report.error?.message ?? "The cell could not complete the change."}`;
    if (row.status === "installing") {
      await tx
        .update(cellPlugins)
        .set({ status: "failed", statusDetail: detail, updatedAt: now })
        .where(eq(cellPlugins.id, row.id));
      await audit("plugin.install_failed", { pluginId: row.pluginId, code }, "error");
      return;
    }
    if (row.status === "uninstalling" || row.status === "failed") {
      if (row.status === "failed" && row.statusDetail?.includes(code)) return;
      await tx
        .update(cellPlugins)
        .set({
          statusDetail: row.status === "failed" ? `${row.statusDetail ?? ""} (${detail})` : detail,
          updatedAt: now,
        })
        .where(eq(cellPlugins.id, row.id));
      await audit("plugin.uninstall_failed", { pluginId: row.pluginId, code }, "error");
      return;
    }
    throw invalid();
  }

  if (report.state === "uninstalled") {
    if (row.status === "uninstalled") return;
    if (row.status !== "uninstalling" && row.status !== "failed") throw invalid();
    await tx.delete(cellPluginTools).where(eq(cellPluginTools.pluginRowId, row.id));
    await tx
      .delete(botToolGrants)
      .where(and(eq(botToolGrants.sourceKind, "plugin"), eq(botToolGrants.sourceId, row.id)));
    const removedNote = " (removed from the cell)";
    await tx
      .update(cellPlugins)
      .set(
        row.status === "uninstalling"
          ? { status: "uninstalled", statusDetail: null, updatedAt: now }
          : {
              statusDetail: row.statusDetail?.endsWith(removedNote)
                ? row.statusDetail
                : `${row.statusDetail ?? "failed"}${removedNote}`,
              updatedAt: now,
            },
      )
      .where(eq(cellPlugins.id, row.id));
    await audit("plugin.uninstalled", { pluginId: report.pluginId ?? row.pluginId });
    await notifyCellConfig(core, tx, "tools.updated", null);
    return;
  }

  // installed
  if (row.status === "installed") return;
  if (row.status !== "installing") throw invalid();
  const toolNames = [
    ...new Set([...(report.declared?.tools ?? []), ...(report.declaredTools ?? []).map((t) => t.name)]),
  ].sort();
  const declared = canonicalSurface({
    ...EMPTY_DECLARED_SURFACE,
    ...(report.declared ?? {}),
    tools: toolNames,
  });
  const reasons: Array<{ code: string; message: string }> = [];
  const pluginId = report.pluginId ?? null;
  if (
    !pluginId ||
    (row.pluginId !== null && pluginId !== row.pluginId) ||
    (report.version && report.version !== row.version)
  ) {
    reasons.push({
      code: "plugin_mismatch",
      message: "The cell installed another plugin id or version than the one approved",
    });
  }
  reasons.push(...refusedReportedSurface(declared, row.channel));
  const builtin = toolNames.filter((t) => BUILTIN_NAMES.has(t.toLowerCase()));
  if (builtin.length > 0) {
    reasons.push({
      code: "builtin_tool_name",
      message: `Declares tools named like built-in tools: ${builtin.join(", ")}`,
    });
  }
  const malformed = toolNames.filter((t) => !TOOL_NAME.test(t));
  if (malformed.length > 0) {
    reasons.push({ code: "invalid_tool_name", message: "Declares tool names that cannot be granted safely" });
  }

  if (reasons.length > 0) {
    // Rejected after install: nothing reaches a bot, and the cell is told to remove what it installed.
    const removePluginId = pluginId ?? row.pluginId;
    const flowId = randomUUID();
    await tx.delete(cellPluginTools).where(eq(cellPluginTools.pluginRowId, row.id));
    const removed = await tx
      .delete(botToolGrants)
      .where(and(eq(botToolGrants.sourceKind, "plugin"), eq(botToolGrants.sourceId, row.id)))
      .returning({ agentId: botToolGrants.agentId });
    const codes = [...new Set(reasons.map((r) => r.code))];
    await tx
      .update(cellPlugins)
      .set({
        status: "failed",
        statusDetail: `${codes.join(", ")}: ${reasons[0]?.message ?? "refused"}; the plugin is removed from the cell`,
        flowId,
        updatedAt: now,
      })
      .where(eq(cellPlugins.id, row.id));
    if (removePluginId) {
      await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.pluginUninstall, {
        type: AgentChannelEventTypes.pluginUninstall,
        organizationId,
        cellId: organizationId,
        flowId,
        pluginRowId: row.id,
        pluginId: removePluginId,
      });
    }
    await audit(
      "plugin.rejected_after_install",
      { pluginId: removePluginId, reasons: codes, tools: toolNames, removedGrants: removed.length },
      "denied",
    );
    if (removed.length > 0) await notifyCellConfig(core, tx, "tools.updated", null);
    return;
  }

  const descriptions = new Map((report.declaredTools ?? []).map((t) => [t.name, t.description ?? null]));
  await tx.delete(cellPluginTools).where(eq(cellPluginTools.pluginRowId, row.id));
  if (toolNames.length > 0) {
    await tx.insert(cellPluginTools).values(
      toolNames.map((name) => ({
        organizationId,
        pluginRowId: row.id,
        name,
        description: descriptions.get(name)?.slice(0, 1000) ?? null,
        // Plugin code is untrusted: its tools always count as side-effecting for the taint rule (D-08).
        sideEffecting: true,
      })),
    );
  }
  // An update that dropped a tool takes it off every bot.
  await tx
    .delete(botToolGrants)
    .where(
      and(
        eq(botToolGrants.sourceKind, "plugin"),
        eq(botToolGrants.sourceId, row.id),
        ...(toolNames.length > 0 ? [notInArray(botToolGrants.toolName, toolNames)] : []),
      ),
    );
  const reviewed = DeclaredSurfaceSchema.safeParse(row.declared);
  const grew = reviewed.success
    ? (Object.keys(declared) as Array<keyof DeclaredSurface>).flatMap((k) =>
        declared[k].filter((v) => !reviewed.data[k].includes(v)).map((v) => `${k}:${v}`),
      )
    : [];
  await tx
    .update(cellPlugins)
    .set({
      status: "installed",
      pluginId,
      installedAt: now,
      statusDetail: null,
      declared: storedSurface(declared),
      updatedAt: now,
    })
    .where(eq(cellPlugins.id, row.id));
  await audit("plugin.installed", {
    pluginId,
    tools: toolNames,
    ...(grew.length > 0 ? { surfaceGrew: grew } : {}),
  });
  await notifyCellConfig(core, tx, "tools.updated", null);
}
