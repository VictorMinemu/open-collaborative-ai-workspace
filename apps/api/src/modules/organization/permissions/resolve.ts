import {
  AGENT_PERMISSIONS,
  type AuthzDenial,
  CELL_PERMISSIONS,
  DEVICE_PERMISSIONS,
  type OrgRole,
  PERMISSION_SURFACE,
  type Permission,
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
export type ResourceState = "private" | "archived" | "revoked" | "device_revoked";
export type ResourceType =
  | "organization"
  | "unit"
  | "user"
  | "member"
  | "channel"
  | "channel_member"
  | "device"
  | "work_session"
  | "invitation";

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

function ruleDenial(rule: RuleFact): Denial {
  const layer =
    rule.subjectKind === "user" ? "user" : rule.subjectKind === "agent" ? "agent" : ("org" as const);
  return { layer, reason: "denied_by_rule", ruleId: rule.id };
}

export function resolveEffectivePermissions(
  p: PrincipalFacts,
  r: ResourceFacts,
  rules: readonly RuleFact[],
  _onBehalfOf?: OnBehalfOf,
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

  const denies = rules.filter(
    (rule) => rule.effect === "deny" && rule.scopeUnitId === null && subjectMatches(rule, p),
  );
  for (const perm of grants) {
    const pre = precondition(perm, p, r);
    if (pre) {
      denied.set(perm, { permission: perm, ...pre });
      continue;
    }
    const rule = denies.find((d) => permissionMatches(d.permission, perm));
    if (rule) denied.set(perm, { permission: perm, ...ruleDenial(rule) });
  }

  const permissions = new Set([...grants].filter((perm) => !denied.has(perm)));
  return { permissions, denied };
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
  if (res.principalDenied) return { allowed: false, denial: { ...res.principalDenied, permission } };
  const denial = res.denied.get(permission);
  if (denial) return { allowed: false, denial };
  return {
    allowed: false,
    denial: { permission, layer: "role", reason: MISSING_REASON[permission] ?? "missing_permission" },
  };
}
