import {
  type AutomationTargetKind,
  type EscalationTarget,
  type EscalationTargetView,
  userHandle,
} from "@ocw/contracts";
import { orgMembers, orgUnits, type Tx } from "@ocw/db";
import { inArray } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { createConversationAccess, loadDirectory } from "../chat";
import { type PermissionService, unitResource } from "../organization";

/**
 * Escalation targets (Phase 07.17, D-08, PD-15): up to five people or teams an automation's bot names when it finishes
 * or needs help. Stored by stable id only (principle 11); validated at save and resolved again at every delivery, so a
 * person who left or lost access to the target and a deleted unit simply drop out. A person qualifies while they are
 * an active member who reads the target conversation (on a DM target only the run-as person, whose DM it is); a unit
 * while it is a team or a department the run-as person may read (`unit.read`). Never audited, logged or stored by name
 * or handle: callers record counts only.
 */

export interface EscalationDeps {
  core: Core;
  perms: PermissionService;
}

/** Where the automation delivers and whom it runs as: what a target is decided against. */
export interface EscalationScope {
  runAsUserId: string;
  targetKind: AutomationTargetKind;
  /** The target conversation (channel, thread, board); null for a DM target. */
  conversationId: string | null;
}

/** The one refusal of a target that does not qualify (or of targets on an automation that is not an agent turn). */
export const escalationNotAllowed = () =>
  new HttpError(
    400,
    "escalation_not_allowed",
    "Pick people who can read where this automation posts, and teams or departments you can see",
  );

/** Each target's view in the stored order, or null where it does not qualify (any more). */
async function resolveTargets(
  tx: Tx,
  deps: EscalationDeps,
  scope: EscalationScope,
  targets: readonly EscalationTarget[],
): Promise<(EscalationTargetView | null)[]> {
  if (targets.length === 0) return [];
  const userIds = [...new Set(targets.filter((t) => t.kind === "user").map((t) => t.id))];
  const unitIds = [...new Set(targets.filter((t) => t.kind === "unit").map((t) => t.id))];
  // Tenant RLS: another organization's people and units are simply not found.
  const members = new Map(
    userIds.length === 0
      ? []
      : (
          await tx
            .select({
              userId: orgMembers.userId,
              displayName: orgMembers.displayName,
              email: orgMembers.email,
              deactivatedAt: orgMembers.deactivatedAt,
            })
            .from(orgMembers)
            .where(inArray(orgMembers.userId, userIds))
        ).map((m) => [m.userId, m]),
  );
  const units = new Map(
    unitIds.length === 0
      ? []
      : (
          await tx
            .select({
              id: orgUnits.id,
              kind: orgUnits.kind,
              name: orgUnits.name,
              handle: orgUnits.handle,
              path: orgUnits.path,
            })
            .from(orgUnits)
            .where(inArray(orgUnits.id, unitIds))
        ).map((u) => [u.id, u]),
  );
  const access = createConversationAccess(deps.core);
  // 07.17 code review WR-04: a unit whose handle a person or bot holds never resolves to the unit (agents, then users,
  // then units, ADR-0039 § 10), so the bot told "mention @x" would name them instead: not a target.
  const shadowing = unitIds.length > 0 ? (await loadDirectory(tx)).byHandle : new Map<string, unknown>();
  const out: (EscalationTargetView | null)[] = [];
  for (const t of targets) {
    if (t.kind === "user") {
      const m = members.get(t.id);
      if (!m || m.deactivatedAt) {
        out.push(null);
        continue;
      }
      const reads =
        scope.targetKind === "dm"
          ? t.id === scope.runAsUserId
          : scope.conversationId !== null &&
            (await access.isReadable(tx, t.id, scope.conversationId, { kinds: ["channel"] }));
      out.push(
        reads
          ? {
              kind: "user",
              id: t.id,
              handle: userHandle({ displayName: m.displayName, email: m.email }).slice(0, 64),
              displayName: m.displayName.slice(0, 200),
            }
          : null,
      );
      continue;
    }
    const u = units.get(t.id);
    if (!u || (u.kind !== "team" && u.kind !== "department") || shadowing.has(u.handle)) {
      out.push(null);
      continue;
    }
    const reading = await deps.perms.decide(
      tx,
      { kind: "user", userId: scope.runAsUserId },
      "unit.read",
      unitResource(u),
    );
    out.push(
      reading.allowed
        ? { kind: "unit", id: u.id, handle: u.handle.slice(0, 64), displayName: u.name.slice(0, 200) }
        : null,
    );
  }
  return out;
}

/**
 * At save (create and update): every target must qualify, else one 400 `escalation_not_allowed` (which one is not
 * said, so the answer never tells who reads a private channel).
 */
export async function validateEscalation(
  tx: Tx,
  deps: EscalationDeps,
  p: EscalationScope & { targets: readonly EscalationTarget[] },
): Promise<void> {
  const views = await resolveTargets(tx, deps, p, p.targets);
  if (views.some((v) => v === null)) throw escalationNotAllowed();
}

/**
 * At delivery (the DTO, the run and item events): the stored targets that still qualify, in the saved order; gone or
 * no longer valid ones are dropped.
 */
export async function escalationFor(
  tx: Tx,
  deps: EscalationDeps,
  a: {
    escalationTargets: readonly EscalationTarget[];
    targetKind: AutomationTargetKind;
    conversationId: string | null;
    runAsUserId: string;
  },
): Promise<EscalationTargetView[]> {
  const views = await resolveTargets(tx, deps, a, a.escalationTargets);
  return views.filter((v): v is EscalationTargetView => v !== null);
}
