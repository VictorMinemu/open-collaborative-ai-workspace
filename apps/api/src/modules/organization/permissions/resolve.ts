import {
  AGENT_PERMISSIONS,
  type AuthzDenial,
  CELL_PERMISSIONS,
  DEVICE_PERMISSIONS,
  LEAD_PERMISSIONS,
  NON_DELEGABLE_PERMISSIONS,
  type OrgRole,
  PERMISSION_SURFACE,
  Permission,
  permissionMatches,
  ROLE_PERMISSIONS,
  ROLE_SURFACES,
  type RuleEffect,
  type RuleSubjectKind,
} from "@ocw/contracts";
import { MISSING_REASON, precondition, RELATION_PERMISSIONS } from "./policy";

/**
 * The one authority for authorization (ORG-03, research §Pattern 1). PURE: no database, no Fastify. Facts
 * are loaded by facts.ts and composed per request by service.ts; this file only decides.
 */

export type Relation = "self" | "owner" | "member" | "creator" | "device_owner" | "grantee" | "inviter";
export type ResourceState =
  | "private"
  | "archived"
  | "revoked"
  | "device_revoked"
  /** Agents: a personal bot (owner-only) / a disabled bot. */
  | "personal"
  | "disabled"
  /** Channel resources: a direct conversation (fixed membership). */
  | "dm";
export type ResourceType =
  | "organization"
  | "unit"
  | "user"
  | "member"
  | "channel"
  | "channel_member"
  | "device"
  | "work_session"
  | "invitation"
  | "agent";

export interface PrincipalFacts {
  kind: "user" | "agent" | "cell" | "device";
  id: string;
  /** Users only; null for agents, cells and devices (and for a user without a membership row). */
  orgRole: OrgRole | null;
  /** Users: deactivated or not a member; agents: disabled or deleted; devices: revoked. */
  deactivated: boolean;
  /** Ancestor path (root→self) of every unit the user belongs to. */
  memberUnitPaths: readonly (readonly string[])[];
  /** Units where the user's unit role is `lead`. */
  leadOfUnitIds: ReadonlySet<string>;
}

export interface ResourceFacts {
  type: ResourceType;
  /** Ancestor units of the resource (root→self); [] = the organization root. */
  unitPath: readonly string[];
  relations: ReadonlySet<Relation>;
  state: ReadonlySet<ResourceState>;
  /** Tool layer input (e.g. the Work Zone tool of an approval). */
  tool?: string;
  /** Invitations: the role being granted (role ceiling). */
  invitedRole?: OrgRole;
}

export interface RuleFact {
  id: string;
  scopeUnitId: string | null;
  subjectKind: RuleSubjectKind;
  subjectId: string | null;
  /** Exact permission or `prefix.*`. */
  permission: string;
  tool: string | null;
  effect: RuleEffect;
}

/** An agent acting for a human: the agent never exceeds what the human could do (confused deputy). */
export interface OnBehalfOf {
  principal: PrincipalFacts;
  resource: ResourceFacts;
}

export interface Resolution {
  permissions: ReadonlySet<Permission>;
  /** The first denial (in layer order) of every permission that was granted and then removed. */
  denied: ReadonlyMap<Permission, AuthzDenial>;
  /** Set when the principal itself is disabled; `permission` is `org.read` (the base of every member). */
  principalDenied?: AuthzDenial;
}

type Denial = Omit<AuthzDenial, "permission">;

function principalDenial(p: PrincipalFacts): Denial {
  switch (p.kind) {
    case "user":
      return { layer: "user", reason: "deactivated" };
    case "agent":
      return { layer: "agent", reason: "agent_disabled" };
    case "device":
      return { layer: "device", reason: "device_revoked" };
    case "cell":
      return { layer: "agent", reason: "cell_disabled" };
  }
}

/** The principal's own, unconditional grants. */
function basePermissions(p: PrincipalFacts): readonly Permission[] {
  switch (p.kind) {
    case "user":
      return p.orgRole ? ROLE_PERMISSIONS[p.orgRole] : [];
    case "agent":
      return AGENT_PERMISSIONS;
    case "cell":
      return CELL_PERMISSIONS;
    case "device":
      return DEVICE_PERMISSIONS;
  }
}

/**
 * Relation grants (owner, creator, self, …). For users they only unlock permissions on a surface the role
 * already has, so a stale ownership never outlives a demotion; other principals never widen their own set.
 */
function relationGrants(p: PrincipalFacts, r: ResourceFacts, base: readonly Permission[]): Permission[] {
  const byRelation = RELATION_PERMISSIONS[r.type];
  const out: Permission[] = [];
  for (const relation of r.relations) {
    for (const perm of byRelation[relation] ?? []) {
      if (p.kind === "user") {
        if (p.orgRole && ROLE_SURFACES[p.orgRole].includes(PERMISSION_SURFACE[perm])) out.push(perm);
      } else if (base.includes(perm)) {
        out.push(perm);
      }
    }
  }
  return out;
}

function subjectMatches(rule: RuleFact, p: PrincipalFacts): boolean {
  switch (rule.subjectKind) {
    case "everyone":
      return p.kind === "user" || p.kind === "agent";
    case "role":
      return p.kind === "user" && p.orgRole !== null && p.orgRole === rule.subjectId;
    case "user":
      return p.kind === "user" && p.id === rule.subjectId;
    case "agent":
      return p.kind === "agent" && p.id === rule.subjectId;
  }
}

/**
 * Depth at which a rule's scope applies: -1 for organization scope, else the shallowest index of the scope
 * unit on the resource path or on any of the principal's unit paths; null when the scope does not apply.
 */
function scopeDepth(rule: RuleFact, p: PrincipalFacts, r: ResourceFacts): number | null {
  if (rule.scopeUnitId === null) return -1;
  let best = r.unitPath.indexOf(rule.scopeUnitId);
  for (const path of p.memberUnitPaths) {
    const i = path.indexOf(rule.scopeUnitId);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best < 0 ? null : best;
}

const toolMatches = (rule: RuleFact, r: ResourceFacts) => rule.tool === null || rule.tool === r.tool;

/** Rank of a deny in the PRD layer order Org → units (shallowest first) → User → Agent → Tool. */
const RANK_USER = 1_000_000;
const RANK_AGENT = RANK_USER + 1;
const RANK_TOOL = RANK_USER + 2;

interface ApplicableDeny {
  rule: RuleFact;
  rank: number;
  denial: Denial;
}

function denyOf(rule: RuleFact, depth: number): ApplicableDeny {
  const base = { reason: "denied_by_rule", ruleId: rule.id };
  const unit = rule.scopeUnitId === null ? {} : { unitId: rule.scopeUnitId };
  if (rule.tool !== null) return { rule, rank: RANK_TOOL, denial: { layer: "tool", ...base, ...unit } };
  if (rule.subjectKind === "user")
    return { rule, rank: RANK_USER, denial: { layer: "user", ...base, ...unit } };
  if (rule.subjectKind === "agent")
    return { rule, rank: RANK_AGENT, denial: { layer: "agent", ...base, ...unit } };
  if (depth < 0) return { rule, rank: 0, denial: { layer: "org", ...base } };
  return { rule, rank: 1 + depth, denial: { layer: "unit", ...base, ...unit } };
}

const DELEGABLE = new Set(Permission.options.filter((perm) => !NON_DELEGABLE_PERMISSIONS.includes(perm)));

/**
 * The PRD intersection Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device:
 * grants = role ∪ unit-lead ∪ relations ∪ allow rules (never non-delegable); every applicable deny and every
 * resource-state precondition removes a grant, whatever granted it (explicit deny precedence).
 */
export function resolveEffectivePermissions(
  p: PrincipalFacts,
  r: ResourceFacts,
  rules: readonly RuleFact[],
  onBehalfOf?: OnBehalfOf,
): Resolution {
  const denied = new Map<Permission, AuthzDenial>();
  if (p.deactivated) {
    return {
      permissions: new Set(),
      denied,
      principalDenied: { permission: "org.read", ...principalDenial(p) },
    };
  }

  const base = basePermissions(p);
  const grants = new Set<Permission>([...base, ...relationGrants(p, r, base)]);
  if (p.kind === "user" && r.unitPath.some((unitId) => p.leadOfUnitIds.has(unitId))) {
    for (const perm of LEAD_PERMISSIONS) grants.add(perm);
  }

  const denies: ApplicableDeny[] = [];
  for (const rule of rules) {
    if (!subjectMatches(rule, p) || !toolMatches(rule, r)) continue;
    const depth = scopeDepth(rule, p, r);
    if (depth === null) continue;
    if (rule.effect === "deny") {
      denies.push(denyOf(rule, depth));
    } else {
      for (const perm of DELEGABLE) if (permissionMatches(rule.permission, perm)) grants.add(perm);
    }
  }
  // Deterministic explanation: upper layers first, then rule id (input order never matters).
  denies.sort((a, b) => a.rank - b.rank || (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));

  for (const perm of grants) {
    const pre = precondition(perm, p, r);
    if (pre) {
      denied.set(perm, { permission: perm, ...pre });
      continue;
    }
    const hit = denies.find((d) => permissionMatches(d.rule.permission, perm));
    if (hit) denied.set(perm, { permission: perm, ...hit.denial });
  }

  let permissions = new Set([...grants].filter((perm) => !denied.has(perm)));

  if (onBehalfOf) {
    // Confused-deputy rule: an agent acting for a human never exceeds the human.
    const human = resolveEffectivePermissions(onBehalfOf.principal, onBehalfOf.resource, rules);
    const kept = new Set<Permission>();
    for (const perm of permissions) {
      if (human.permissions.has(perm)) kept.add(perm);
      else denied.set(perm, explain(human, perm));
    }
    permissions = kept;
  }
  return { permissions, denied };
}

/** Why `res` does not hold `permission`. */
function explain(res: Resolution, permission: Permission): AuthzDenial {
  if (res.principalDenied) return { ...res.principalDenied, permission };
  return (
    res.denied.get(permission) ?? {
      permission,
      layer: "role",
      reason: MISSING_REASON[permission] ?? "missing_permission",
    }
  );
}

/** One permission: allowed, or the denial that explains why not. */
export function decide(
  p: PrincipalFacts,
  r: ResourceFacts,
  rules: readonly RuleFact[],
  permission: Permission,
  onBehalfOf?: OnBehalfOf,
): { allowed: boolean; denial?: AuthzDenial } {
  const res = resolveEffectivePermissions(p, r, rules, onBehalfOf);
  if (res.permissions.has(permission)) return { allowed: true };
  return { allowed: false, denial: explain(res, permission) };
}
