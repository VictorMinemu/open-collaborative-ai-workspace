import {
  DEFAULT_WORK_ZONE_POLICY,
  EffortLevel,
  PermissionMode,
  type RuntimeId,
  RuntimeUpdatesLevel,
  type UpdateWorkZonePolicyRequest,
  type WorkZonePolicy,
  type WorkZonePolicyView,
} from "@ocw/contracts";
import { devices, type Tx, tenantOf, workZonePolicies } from "@ocw/db";
import { isNull } from "drizzle-orm";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { catalogsOf } from "./controls";

/**
 * The organization's Work Zone policy (Phase 03.2, D-02, D-11; ADR-0012): one `work_zone_policies` row per org,
 * `DEFAULT_WORK_ZONE_POLICY` when it is absent (Full access and fast mode off). Its restriction always wins: it is
 * one input of every controls intersection, every settings request and every turn (controls.ts).
 */

type PolicyRow = typeof workZonePolicies.$inferSelect;
const RUNTIMES: readonly RuntimeId[] = ["claude-code", "codex"];
const ListedMode = PermissionMode.exclude(["fullAccess"]);
const ModelIds = z.array(z.string().max(200)).max(100);

/** Tolerant read: every stored key that no longer parses falls back to its default. */
function fromRow(row: PolicyRow | undefined): WorkZonePolicy {
  const d = structuredClone(DEFAULT_WORK_ZONE_POLICY);
  if (!row) return { ...d, updatedAt: null };
  const modes = z.array(ListedMode).min(1).max(4).safeParse(row.allowedPermissionModes);
  const models = (row.allowedModels ?? {}) as Record<string, unknown>;
  const efforts = (row.maxEffort ?? {}) as Record<string, unknown>;
  const allowedModels = { ...d.allowedModels };
  const maxEffort = { ...d.maxEffort };
  for (const rt of RUNTIMES) {
    const m = ModelIds.safeParse(models[rt]);
    if (m.success) allowedModels[rt] = m.data;
    const e = EffortLevel.nullable().safeParse(efforts[rt]);
    if (e.success) maxEffort[rt] = e.data;
  }
  const runtimeUpdates = RuntimeUpdatesLevel.safeParse(row.runtimeUpdates);
  return {
    allowedPermissionModes: modes.success ? [...new Set(modes.data)] : d.allowedPermissionModes,
    allowFullAccess: row.allowFullAccess,
    allowedModels,
    maxEffort,
    allowFastMode: row.allowFastMode,
    runtimeUpdates: runtimeUpdates.success ? runtimeUpdates.data : d.runtimeUpdates,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function loadWorkZonePolicy(tx: Tx): Promise<WorkZonePolicy> {
  const [row] = await tx.select().from(workZonePolicies).limit(1);
  return fromRow(row);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** Top-level keys that differ between two policies. */
function changedKeys(before: WorkZonePolicy, after: WorkZonePolicy): string[] {
  const out: string[] = [];
  if (!sameList(before.allowedPermissionModes, after.allowedPermissionModes))
    out.push("allowedPermissionModes");
  if (before.allowFullAccess !== after.allowFullAccess) out.push("allowFullAccess");
  if (RUNTIMES.some((rt) => !sameList(before.allowedModels[rt], after.allowedModels[rt])))
    out.push("allowedModels");
  if (RUNTIMES.some((rt) => before.maxEffort[rt] !== after.maxEffort[rt])) out.push("maxEffort");
  if (before.allowFastMode !== after.allowFastMode) out.push("allowFastMode");
  if (before.runtimeUpdates !== after.runtimeUpdates) out.push("runtimeUpdates");
  return out;
}

/**
 * Upsert the policy. Returns the new policy and the changed top-level keys (empty = nothing written). 400
 * `empty_modes` when no mode would remain (the contract already refuses `[]`; kept as the domain rule).
 */
export async function saveWorkZonePolicy(
  tx: Tx,
  patch: UpdateWorkZonePolicyRequest,
  actorUserId: string | null,
): Promise<{ policy: WorkZonePolicy; changed: string[] }> {
  const before = await loadWorkZonePolicy(tx);
  const trimEffort = (e: string | null) => (e === null ? null : e.trim());
  const next: WorkZonePolicy = {
    allowedPermissionModes: patch.allowedPermissionModes
      ? [...new Set(patch.allowedPermissionModes)]
      : before.allowedPermissionModes,
    allowFullAccess: patch.allowFullAccess ?? before.allowFullAccess,
    allowedModels: patch.allowedModels
      ? {
          "claude-code": [...new Set(patch.allowedModels["claude-code"].map((m) => m.trim()))],
          codex: [...new Set(patch.allowedModels.codex.map((m) => m.trim()))],
        }
      : before.allowedModels,
    maxEffort: patch.maxEffort
      ? {
          "claude-code": trimEffort(patch.maxEffort["claude-code"]),
          codex: trimEffort(patch.maxEffort.codex),
        }
      : before.maxEffort,
    allowFastMode: patch.allowFastMode ?? before.allowFastMode,
    runtimeUpdates: patch.runtimeUpdates ?? before.runtimeUpdates,
    updatedAt: before.updatedAt,
  };
  if (next.allowedPermissionModes.length === 0) {
    throw badRequest("Allow at least one permission mode", "empty_modes");
  }
  const changed = changedKeys(before, next);
  if (changed.length === 0) return { policy: before, changed };

  const values = {
    allowedPermissionModes: next.allowedPermissionModes,
    allowFullAccess: next.allowFullAccess,
    allowedModels: next.allowedModels,
    maxEffort: next.maxEffort,
    allowFastMode: next.allowFastMode,
    runtimeUpdates: next.runtimeUpdates,
    updatedBy: actorUserId,
    updatedAt: new Date().toISOString(),
  };
  const [row] = await tx
    .insert(workZonePolicies)
    .values({ organizationId: tenantOf(tx).organizationId, ...values })
    .onConflictDoUpdate({ target: workZonePolicies.organizationId, set: values })
    .returning();
  return { policy: fromRow(row), changed };
}

/** Every model the organization's (non-revoked) devices reported, per runtime, by id (for the admin page). */
export async function knownModels(tx: Tx): Promise<WorkZonePolicyView["knownModels"]> {
  const rows = await tx
    .select({ catalog: devices.runtimeCatalog })
    .from(devices)
    .where(isNull(devices.revokedAt));
  const out: WorkZonePolicyView["knownModels"] = { "claude-code": [], codex: [] };
  for (const r of rows) {
    for (const c of catalogsOf(r.catalog)) {
      const list = out[c.runtime];
      for (const m of c.models) {
        if (!list.some((k) => k.id === m.id)) list.push({ id: m.id, displayName: m.displayName });
      }
    }
  }
  return out;
}
