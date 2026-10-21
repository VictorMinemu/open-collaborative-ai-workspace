import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ApproveSandboxPackageRequest,
  packageTreeCanonical,
  type ReviewSandboxPackageRequest,
  type SandboxdPackageReviewResult,
  type SandboxPackage,
  type SandboxPackageList,
  type SandboxPackageReview,
  SandboxPackageSource,
  type UpdateSandboxPackageRequest,
} from "@ocw/contracts";
import {
  agents,
  orgMembers,
  sandboxPackageInstalls,
  sandboxPackages,
  type TenantCtx,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { scoreSandboxPackageRisk } from "../plugins";
import { type SandboxdClient, SandboxdRefusedError } from "./client";

/**
 * Sandbox packages (07.8-18; SBX-04; D-03, D-11 F-3; P-12; ADR-0011's pinned-approval model). A capability the cell
 * refuses (shell tools, browsers, interpreters) reaches bots only as an admin-approved, version-pinned package that is
 * installed into each bot's own sandbox and run there through `ocw_sandbox_exec`.
 *
 * - **Review** (`plugin.manage`): sandboxd resolves the whole dependency tree in a throwaway container through the
 *   egress proxy (the API never fetches a registry). The API recomputes `treeSha256 = sha256(packageTreeCanonical(
 *   entries))` and refuses a review whose reported hash differs (503, nothing stored), scores the risk and mints the
 *   review token: an HMAC over (organization, source, name, version, sha256, treeSha256) that carries those fields.
 * - **Approve**: the token is verified, the tree is resolved again live and compared (top digest and tree hash); the row
 *   stores the lockfile, the tree hash and the dependency count. A pin is never edited in place (a database trigger
 *   refuses it): another version, or a re-approval after an upstream change, replaces the live row.
 * - **Install** (`applyInstalls`, after a sandbox starts): the bot's desired set (approved and enabled; personal bots
 *   only with `personalAllowed`) against its install rows. Removals first, then one `packageInstall` per package with
 *   the row's stored lockfile, sha256 and tree hash. `tree_changed` / `digest_mismatch` mark the install failed and the
 *   package `changed_upstream`; such a package is not tried again until it is re-reviewed and re-approved.
 *
 * Audit metadata: ids, source, name, version, digests, dependency count, risk and risk codes; never the lockfile or the
 * entries. A failed install carries its code only.
 */

const REVIEW_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 600_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** Install results that mean the registry no longer serves the approved tree. */
const UPSTREAM_CODES = new Set(["tree_changed", "digest_mismatch"]);

type PackageRow = typeof sandboxPackages.$inferSelect;
type Coords = ReviewSandboxPackageRequest;
type Pin = Coords & { sha256: string; treeSha256: string };

const unavailable = () =>
  new HttpError(503, "service_unavailable", "The sandbox service could not review this package right now");

// ---------------------------------------------------------------- tree hash and review token

/** `sha256(packageTreeCanonical(entries))`, the same function sandboxd hashes. */
export function treeHashOf(entries: SandboxdPackageReviewResult["entries"]): string {
  return sha256Hex(packageTreeCanonical(entries));
}

const TOKEN_PREFIX = "spr1";

function reviewKey(core: Pick<Core, "env">): Buffer {
  return createHmac("sha256", core.env.BETTER_AUTH_SECRET).update("ocw.sandbox-package-review.v1").digest();
}

/**
 * The review token: `spr1.<payload>.<mac>`, the payload the base64url JSON of (organization, source, name, version,
 * sha256, treeSha256) and the mac an HMAC-SHA256 over it with a key derived from the server secret. It binds what the
 * admin reviewed, in their organization only, and carries the coordinates the approval re-resolves.
 */
export function reviewTokenOf(core: Pick<Core, "env">, organizationId: string, pin: Pin): string {
  const payload = Buffer.from(
    JSON.stringify([organizationId, pin.source, pin.name, pin.version, pin.sha256, pin.treeSha256]),
  ).toString("base64url");
  const mac = createHmac("sha256", reviewKey(core)).update(`${TOKEN_PREFIX}.${payload}`).digest("base64url");
  return `${TOKEN_PREFIX}.${payload}.${mac}`;
}

/** The pin a token carries, or null when it does not verify or names another organization. */
export function readReviewToken(core: Pick<Core, "env">, organizationId: string, token: string): Pin | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payload = "", mac = ""] = parts;
  const want = createHmac("sha256", reviewKey(core)).update(`${TOKEN_PREFIX}.${payload}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 6 || !fields.every((f) => typeof f === "string"))
    return null;
  const [org, source, name, version, sha256, treeSha256] = fields as string[];
  const parsed = SandboxPackageSource.safeParse(source);
  if (org !== organizationId || !parsed.success) return null;
  return {
    source: parsed.data,
    name: name ?? "",
    version: version ?? "",
    sha256: sha256 ?? "",
    treeSha256: treeSha256 ?? "",
  };
}

// ---------------------------------------------------------------- review

/**
 * Asks sandboxd for the tree of one release (outside any transaction) and checks it: the coordinates it names and the
 * tree hash recomputed from its entries. Logs carry the organization and the coordinates only.
 */
async function resolveTree(
  core: Pick<Core, "log">,
  client: SandboxdClient | null,
  organizationId: string,
  c: Coords,
): Promise<SandboxdPackageReviewResult> {
  if (!client) throw unavailable();
  const where = { organizationId, source: c.source, name: c.name, version: c.version };
  let result: SandboxdPackageReviewResult;
  try {
    result = await client.call(
      "packageReview",
      { orgId: organizationId, source: c.source, name: c.name, version: c.version },
      { timeoutMs: REVIEW_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof SandboxdRefusedError && err.code === "not_found") {
      throw notFound("This package or version is not in the registry", "package_not_found");
    }
    core.log.warn(
      { ...where, error: err instanceof Error ? err.name : "unknown" },
      "sandboxd could not review a sandbox package",
    );
    throw unavailable();
  }
  if (result.source !== c.source || result.name !== c.name || result.version !== c.version) {
    core.log.warn(where, "sandboxd reviewed other coordinates than asked; nothing stored");
    throw unavailable();
  }
  if (treeHashOf(result.entries) !== result.treeSha256) {
    core.log.warn(where, "sandboxd reported a tree hash its entries do not have; nothing stored");
    throw unavailable();
  }
  return result;
}

function reviewOf(
  core: Pick<Core, "env">,
  organizationId: string,
  r: SandboxdPackageReviewResult,
): { review: SandboxPackageReview; riskCodes: string[] } {
  const verdict = scoreSandboxPackageRisk({
    source: r.source,
    name: r.name,
    publisher: r.publisher,
    license: r.license,
    hasInstallScript: r.hasInstallScript,
    entries: r.entries,
  });
  return {
    review: {
      source: r.source,
      name: r.name,
      version: r.version,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes,
      license: r.license,
      publisher: r.publisher,
      hasInstallScript: r.hasInstallScript,
      dependencyCount: r.dependencyCount,
      treeSha256: r.treeSha256,
      risk: verdict.risk,
      riskReasons: verdict.reasons.map((x) => x.message),
      reviewToken: reviewTokenOf(core, organizationId, r),
    },
    riskCodes: verdict.reasons.map((x) => x.code),
  };
}

const pinMetadata = (r: SandboxPackageReview | PackageRow, riskCodes: string[]) => ({
  source: r.source,
  name: r.name,
  version: r.version,
  sha256: r.sha256,
  treeSha256: r.treeSha256,
  dependencyCount: r.dependencyCount,
  risk: r.risk,
  riskCodes,
});

/** `POST /api/v1/sandbox/packages/review`: sandboxd's facts, the API's risk and the review token; audited. */
export async function reviewSandboxPackage(
  core: Core,
  client: SandboxdClient | null,
  ctx: TenantCtx,
  c: Coords,
): Promise<SandboxPackageReview> {
  const result = await resolveTree(core, client, ctx.organizationId, c);
  const { review, riskCodes } = reviewOf(core, ctx.organizationId, result);
  await core.db.withTenant(ctx, (tx) =>
    core.audit.record(tx, {
      action: "sandbox.package_reviewed",
      resourceType: "sandbox_package",
      resourceId: null,
      metadata: pinMetadata(review, riskCodes),
    }),
  );
  return review;
}

// ---------------------------------------------------------------- approve, update, remove

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};
const packageExists = () =>
  conflict("This package is already approved; update or remove it instead", "package_exists");

/**
 * `POST /api/v1/sandbox/packages`: approves exactly the reviewed pin. The tree is resolved again live; a different top
 * digest or tree hash is 409 `package_changed_upstream` with the refreshed review. Refused verdicts cannot be approved;
 * a high one needs the typed acknowledgement. Another version of a live package, or the same version after it was
 * marked changed upstream, replaces the live row (the old one becomes `removed`).
 */
export async function approveSandboxPackage(
  core: Core,
  client: SandboxdClient | null,
  ctx: TenantCtx,
  body: ApproveSandboxPackageRequest,
): Promise<SandboxPackage> {
  const pin = readReviewToken(core, ctx.organizationId, body.reviewToken);
  if (!pin) {
    throw conflict("This review is not valid here. Review the package again.", "review_token_invalid");
  }
  const result = await resolveTree(core, client, ctx.organizationId, pin);
  const { review, riskCodes } = reviewOf(core, ctx.organizationId, result);
  if (result.sha256 !== pin.sha256 || result.treeSha256 !== pin.treeSha256) {
    throw new HttpError(
      409,
      "package_changed_upstream",
      "This package or one of its dependencies changed since you reviewed it. Review it again.",
      { review },
    );
  }
  if (review.risk === "refuse") {
    throw new HttpError(403, "package_refused", "This package cannot be installed in bot sandboxes", {
      reasons: review.riskReasons,
    });
  }
  if (review.risk === "high" && body.acknowledge !== "install anyway") {
    throw new HttpError(
      400,
      "acknowledgement_required",
      'This is a high-risk package: type "install anyway" to approve it',
    );
  }
  try {
    return await core.db.withTenant(ctx, async (tx) => {
      const { organizationId, userId } = tenantOf(tx);
      const [live] = await tx
        .select()
        .from(sandboxPackages)
        .where(
          and(
            eq(sandboxPackages.source, pin.source),
            eq(sandboxPackages.name, pin.name),
            ne(sandboxPackages.status, "removed"),
          ),
        )
        .for("update");
      if (live && live.version === pin.version && !live.changedUpstream) throw packageExists();
      const now = new Date().toISOString();
      if (live) {
        await tx
          .update(sandboxPackages)
          .set({ status: "removed", updatedAt: now })
          .where(eq(sandboxPackages.id, live.id));
        await core.audit.record(tx, {
          action: "sandbox.package_updated",
          resourceType: "sandbox_package",
          resourceId: live.id,
          metadata: { ...pinMetadata(live, []), replacedBy: { version: pin.version } },
        });
      }
      const [row] = await tx
        .insert(sandboxPackages)
        .values({
          organizationId,
          source: result.source,
          name: result.name,
          version: result.version,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          license: result.license,
          publisher: result.publisher,
          hasInstallScript: result.hasInstallScript,
          risk: review.risk,
          riskReasons: review.riskReasons,
          reviewToken: body.reviewToken,
          treeSha256: result.treeSha256,
          dependencyCount: result.dependencyCount,
          lockfile: result.lockfile,
          status: "approved",
          // A replaced package keeps its switches.
          enabled: live?.enabled ?? true,
          personalAllowed: live?.personalAllowed ?? false,
          approvedBy: userId ?? null,
          approvedAt: now,
        })
        .returning();
      if (!row) throw new Error("sandbox package insert failed");
      await core.audit.record(tx, {
        action: "sandbox.package_approved",
        resourceType: "sandbox_package",
        resourceId: row.id,
        metadata: {
          ...pinMetadata(row, riskCodes),
          acknowledged: body.acknowledge === "install anyway",
          replaced: live?.id ?? null,
        },
      });
      return (await viewsOf(tx, [row]))[0] as SandboxPackage;
    });
  } catch (err) {
    // Two admins approving the same package at once: the named partial unique index decides.
    if (isUniqueViolation(err)) throw packageExists();
    throw err;
  }
}

async function liveRow(tx: Tx, id: string): Promise<PackageRow> {
  const [row] = await tx
    .select()
    .from(sandboxPackages)
    .where(and(eq(sandboxPackages.id, id), ne(sandboxPackages.status, "removed")))
    .for("update");
  if (!row) throw notFound("Sandbox package not found", "package_not_found");
  return row;
}

/** `PATCH /api/v1/sandbox/packages/:id`: the switches; bots pick the change up at their next start. */
export async function updateSandboxPackage(
  core: Core,
  tx: Tx,
  id: string,
  body: UpdateSandboxPackageRequest,
): Promise<SandboxPackage> {
  const row = await liveRow(tx, id);
  const set = {
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.personalAllowed !== undefined ? { personalAllowed: body.personalAllowed } : {}),
  };
  const [next] = await tx
    .update(sandboxPackages)
    .set({ ...set, updatedAt: new Date().toISOString() })
    .where(eq(sandboxPackages.id, row.id))
    .returning();
  if (!next) throw notFound("Sandbox package not found", "package_not_found");
  await core.audit.record(tx, {
    action: "sandbox.package_updated",
    resourceType: "sandbox_package",
    resourceId: row.id,
    metadata: { source: row.source, name: row.name, version: row.version, ...set },
  });
  return (await viewsOf(tx, [next]))[0] as SandboxPackage;
}

/** `DELETE /api/v1/sandbox/packages/:id`: `removed`; every sandbox drops it at its next start. */
export async function removeSandboxPackage(core: Core, tx: Tx, id: string): Promise<void> {
  const row = await liveRow(tx, id);
  await tx
    .update(sandboxPackages)
    .set({ status: "removed", updatedAt: new Date().toISOString() })
    .where(eq(sandboxPackages.id, row.id));
  await core.audit.record(tx, {
    action: "sandbox.package_removed",
    resourceType: "sandbox_package",
    resourceId: row.id,
    metadata: { source: row.source, name: row.name, version: row.version },
  });
}

// ---------------------------------------------------------------- views

async function viewsOf(tx: Tx, rows: PackageRow[]): Promise<SandboxPackage[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await tx
    .select({
      packageId: sandboxPackageInstalls.packageId,
      status: sandboxPackageInstalls.status,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(sandboxPackageInstalls)
    .innerJoin(agents, eq(agents.id, sandboxPackageInstalls.agentId))
    .where(and(inArray(sandboxPackageInstalls.packageId, ids), isNull(agents.deletedAt)))
    .groupBy(sandboxPackageInstalls.packageId, sandboxPackageInstalls.status);
  const approvers = [...new Set(rows.map((r) => r.approvedBy).filter((u): u is string => !!u))];
  const names = approvers.length
    ? await tx
        .select({ id: orgMembers.userId, displayName: orgMembers.displayName })
        .from(orgMembers)
        .where(inArray(orgMembers.userId, approvers))
    : [];
  const nameOf = new Map(names.map((m) => [m.id, m.displayName]));
  const count = (id: string, statuses: string[]) =>
    counts.filter((c) => c.packageId === id && statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    name: r.name,
    version: r.version,
    sha256: r.sha256,
    dependencyCount: r.dependencyCount,
    treeSha256: r.treeSha256,
    risk: r.risk,
    enabled: r.enabled,
    personalAllowed: r.personalAllowed,
    installedIn: count(r.id, ["installed"]),
    installing: count(r.id, ["pending", "installing"]),
    failed: count(r.id, ["failed"]),
    changedUpstream: r.changedUpstream,
    newerVersion: null,
    approvedBy:
      r.approvedBy && nameOf.has(r.approvedBy)
        ? { id: r.approvedBy, displayName: nameOf.get(r.approvedBy) as string }
        : null,
    approvedAt: new Date(r.approvedAt ?? r.createdAt).toISOString(),
  }));
}

/** `GET /api/v1/sandbox/packages`: the live packages; `manage` is the resolver's `plugin.manage`. */
export async function listSandboxPackages(tx: Tx, manage: boolean): Promise<SandboxPackageList> {
  const rows = await tx
    .select()
    .from(sandboxPackages)
    .where(ne(sandboxPackages.status, "removed"))
    .orderBy(asc(sandboxPackages.name), asc(sandboxPackages.source))
    .limit(200);
  return { items: await viewsOf(tx, rows), viewerCan: { manage } };
}

// ---------------------------------------------------------------- installs (sandbox start)

/**
 * The packages one bot's sandbox should hold: approved and enabled; a personal bot only those with `personalAllowed`.
 * Packages marked changed upstream are part of the set (a sandbox that already holds the approved tree keeps it) but
 * are never installed again (`applyInstalls`).
 */
export async function desiredPackagesFor(tx: Tx, agent: { id: string; scope: "team" | "personal" }) {
  return tx
    .select({
      id: sandboxPackages.id,
      source: sandboxPackages.source,
      name: sandboxPackages.name,
      version: sandboxPackages.version,
      sha256: sandboxPackages.sha256,
      treeSha256: sandboxPackages.treeSha256,
      lockfile: sandboxPackages.lockfile,
      changedUpstream: sandboxPackages.changedUpstream,
    })
    .from(sandboxPackages)
    .where(
      and(
        eq(sandboxPackages.status, "approved"),
        eq(sandboxPackages.enabled, true),
        ...(agent.scope === "personal" ? [eq(sandboxPackages.personalAllowed, true)] : []),
      ),
    )
    .orderBy(asc(sandboxPackages.name));
}

type Desired = Awaited<ReturnType<typeof desiredPackagesFor>>[number];

async function setInstall(
  tx: Tx,
  agentId: string,
  packageId: string,
  status: "installing" | "installed" | "failed" | "removing",
  detail: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await tx
    .insert(sandboxPackageInstalls)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId,
      packageId,
      status,
      detail,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        sandboxPackageInstalls.organizationId,
        sandboxPackageInstalls.agentId,
        sandboxPackageInstalls.packageId,
      ],
      set: { status, detail, updatedAt: now },
    });
}

/** What one start has to do, decided under the bot's tenant (null: nothing). */
async function installPlan(
  tx: Tx,
  agentId: string,
): Promise<{ remove: string[]; install: Desired[] } | null> {
  const [bot] = await tx
    .select({ id: agents.id, scope: agents.scope })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!bot) return null;
  const desired = await desiredPackagesFor(tx, bot);
  const rows = await tx
    .select({ packageId: sandboxPackageInstalls.packageId, status: sandboxPackageInstalls.status })
    .from(sandboxPackageInstalls)
    .where(eq(sandboxPackageInstalls.agentId, agentId));
  const wanted = new Set(desired.map((p) => p.id));
  const have = new Map(rows.map((r) => [r.packageId, r.status]));
  const remove = rows.filter((r) => !wanted.has(r.packageId)).map((r) => r.packageId);
  const install = desired.filter((p) => !p.changedUpstream && have.get(p.id) !== "installed");
  if (remove.length === 0 && install.length === 0) return null;
  for (const id of remove) await setInstall(tx, agentId, id, "removing");
  for (const p of install) await setInstall(tx, agentId, p.id, "installing");
  return { remove, install };
}

/** One install outcome: the status and, for a failure, a short code (never installer output). */
async function installOne(
  client: SandboxdClient,
  target: { orgId: string; agentId: string },
  p: Desired,
): Promise<{ status: "installed" } | { status: "failed"; code: string }> {
  try {
    const out = await client.call(
      "packageInstall",
      {
        target,
        packages: [
          {
            id: p.id,
            source: p.source,
            name: p.name,
            version: p.version,
            sha256: p.sha256,
            treeSha256: p.treeSha256,
            lockfile: p.lockfile,
          },
        ],
      },
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    const r = out.results.find((x) => x.id === p.id);
    if (!r) return { status: "failed", code: "service_unavailable" };
    if (r.status === "installed") return { status: "installed" };
    return { status: "failed", code: r.code ?? "install_failed" };
  } catch (err) {
    if (err instanceof SandboxdRefusedError && UPSTREAM_CODES.has(err.code)) {
      return { status: "failed", code: err.code };
    }
    return { status: "failed", code: "service_unavailable" };
  }
}

/**
 * After a sandbox started (ensure or restart): brings the bot's packages volume to its desired set. Removals first
 * (one `packageRemove`), then one `packageInstall` per missing package, always with the row's stored lockfile, sha256
 * and tree hash. Never throws: a failure is recorded per package (and logged with ids only) and the call that started
 * the sandbox goes on without the package.
 */
export async function applyInstalls(
  core: Pick<Core, "db" | "audit" | "log">,
  client: SandboxdClient,
  target: { orgId: string; agentId: string },
): Promise<void> {
  const ctx = { organizationId: target.orgId };
  try {
    const plan = await core.db.withTenant(ctx, (tx) => installPlan(tx, target.agentId));
    if (!plan) return;
    if (plan.remove.length > 0) {
      try {
        await client.call("packageRemove", { target, ids: plan.remove }, { timeoutMs: REMOVE_TIMEOUT_MS });
        await core.db.withTenant(ctx, (tx) =>
          tx
            .delete(sandboxPackageInstalls)
            .where(
              and(
                eq(sandboxPackageInstalls.agentId, target.agentId),
                inArray(sandboxPackageInstalls.packageId, plan.remove),
              ),
            ),
        );
      } catch (err) {
        // Left `removing`: the next start asks again.
        core.log.warn(
          {
            organizationId: target.orgId,
            agentId: target.agentId,
            error: err instanceof Error ? err.name : "unknown",
          },
          "sandboxd did not remove a bot's sandbox packages; the next start retries",
        );
      }
    }
    for (const p of plan.install) {
      const outcome = await installOne(client, target, p);
      await core.db.withTenant(ctx, async (tx) => {
        if (outcome.status === "installed") {
          await setInstall(tx, target.agentId, p.id, "installed");
          return;
        }
        await setInstall(tx, target.agentId, p.id, "failed", outcome.code);
        if (UPSTREAM_CODES.has(outcome.code)) {
          await tx
            .update(sandboxPackages)
            .set({ changedUpstream: true, updatedAt: new Date().toISOString() })
            .where(eq(sandboxPackages.id, p.id));
        }
        await core.audit.record(tx, {
          action: "sandbox.package_install_failed",
          resourceType: "sandbox_package",
          resourceId: p.id,
          actorKind: "system",
          agentId: target.agentId,
          result: "error",
          metadata: { code: outcome.code },
        });
      });
    }
  } catch (err) {
    core.log.warn(
      {
        organizationId: target.orgId,
        agentId: target.agentId,
        error: err instanceof Error ? err.name : "unknown",
      },
      "a bot's sandbox packages were not brought up to date; the next start retries",
    );
  }
}
