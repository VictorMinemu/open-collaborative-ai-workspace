import {
  type AuthzDenial,
  INVITABLE_ROLES,
  type OrgRole,
  type Permission,
  type PermissionMode,
} from "@ocw/contracts";
import type { PrincipalFacts, Relation, ResourceFacts, ResourceState, ResourceType } from "./resolve";

/**
 * Per-resource policy (PURE): which relations grant what, which resource states deny what, and the pure
 * builders that turn row data into ResourceFacts. Routes build a resource here and ask the service.
 */

/** Relation grants per resource type. For users they are filtered by the role's surfaces (resolve.ts). */
export const RELATION_PERMISSIONS: Record<ResourceType, Partial<Record<Relation, readonly Permission[]>>> = {
  organization: {},
  unit: {},
  user: { self: ["account.manage"] },
  member: {},
  // CHAT-02: the owner moves the channel between units and edits its topic (`channel.update`).
  channel: { owner: ["channel.archive", "channel.members.remove", "channel.update"] },
  channel_member: { owner: ["channel.members.remove"], self: ["channel.members.remove"] },
  // P-06: `device.full_access` is relation-only — the owner, or a member whose cap on the device is Full access.
  device: {
    owner: ["device.use", "device.update", "device.revoke", "device.full_access"],
    grantee: ["device.use"],
    full_access_grantee: ["device.use", "device.full_access"],
  },
  work_session: {
    creator: ["work_session.approve", "work_session.archive"],
    device_owner: ["work_session.approve", "work_session.archive"],
  },
  invitation: { inviter: ["invitation.revoke"] },
  // D-01: the owner of a (personal) bot sees, uses and configures it; the surface filter keeps it to
  // members whose role has the `bots` surface (every role).
  agent: { owner: ["bot.read", "bot.configure"] },
};

/** Reason reported when a permission is simply not granted (default `missing_permission`). */
export const MISSING_REASON: Partial<Record<Permission, string>> = {
  "device.use": "device_not_shared",
};

type Denial = Omit<AuthzDenial, "permission">;

/** A resource-state precondition: an explicit deny evaluated before any rule. */
export interface Precondition {
  applies(permission: Permission): boolean;
  check(p: PrincipalFacts, r: ResourceFacts, permission: Permission): Denial | null;
}

/** Permissions that use or configure one bot: owner-only on a personal bot (D-01). */
const PERSONAL_BOT_GATED = new Set<Permission>(["bot.read", "bot.configure", "bot.internet", "bot.tool.use"]);
/** Membership of a direct conversation is fixed at creation (D-03). */
const DM_FIXED = new Set<Permission>([
  "channel.members.add",
  "channel.members.remove",
  "channel.archive",
  // Direct conversations never belong to a unit (CHAT-02).
  "channel.update",
]);

const DEVICE_GATED = new Set<Permission>([
  "work_session.create",
  "work_session.prompt",
  "work_session.approve",
  "work_session.configure",
]);
/** Channel preconditions only judge a concrete channel; organization-scope answers stay role-based. */
const isChannel = (r: ResourceFacts) => r.type === "channel" || r.type === "channel_member";
const notMember = (p: PrincipalFacts): Denial => ({
  layer: "resource",
  reason: p.kind === "agent" ? "agent_not_member" : "not_a_member",
});

export const PRECONDITIONS: readonly Precondition[] = [
  {
    // Private channels (and, for agents, every channel) are readable by members only.
    applies: (perm) => perm === "channel.read",
    check: (p, r) => {
      if (!isChannel(r) || r.relations.has("member")) return null;
      if (p.kind === "agent") return notMember(p);
      return r.state.has("private") ? { layer: "resource", reason: "private_channel" } : null;
    },
  },
  {
    applies: (perm) => perm === "channel.post" || perm === "channel.members.add",
    check: (p, r) => {
      if (!isChannel(r)) return null;
      if (r.state.has("archived")) return { layer: "resource", reason: "archived" };
      return r.relations.has("member") ? null : notMember(p);
    },
  },
  {
    // Device layer: nothing runs on, or is changed through, a revoked device.
    applies: (perm) => perm.startsWith("device.") || DEVICE_GATED.has(perm),
    check: (_p, r) =>
      r.state.has("revoked") || r.state.has("device_revoked")
        ? { layer: "device", reason: "device_revoked" }
        : null,
  },
  {
    // Personal bots (D-01): nobody but the owner (admins included) sees, uses or configures one. Agent
    // principals are judged as themselves; the human they act for is judged by the on-behalf-of pass.
    applies: (perm) => PERSONAL_BOT_GATED.has(perm),
    check: (p, r) => {
      if (r.type !== "agent" || p.kind !== "user") return null;
      return r.state.has("personal") && !r.relations.has("owner")
        ? { layer: "resource", reason: "personal_bot" }
        : null;
    },
  },
  {
    // Direct conversations (D-03): two fixed members; nobody adds, removes or archives.
    applies: (perm) => DM_FIXED.has(perm),
    check: (_p, r) =>
      isChannel(r) && r.state.has("dm") ? { layer: "resource", reason: "direct_conversation" } : null,
  },
  {
    // D-01: moderation never reaches a direct conversation (DMs and group DMs): no admin delete path there.
    applies: (perm) => perm === "message.delete_any",
    check: (_p, r) =>
      isChannel(r) && r.state.has("dm") ? { layer: "resource", reason: "direct_conversation" } : null,
  },
  {
    // Role ceiling: an inviter never grants a role above what their own role may invite.
    applies: (perm) => perm === "invitation.create",
    check: (p, r) => {
      if (r.invitedRole === undefined) return null;
      const allowed = p.orgRole ? INVITABLE_ROLES[p.orgRole] : [];
      return allowed.includes(r.invitedRole) ? null : { layer: "resource", reason: "role_ceiling" };
    },
  },
];

/** The first precondition that denies `permission`, or null. */
export function precondition(permission: Permission, p: PrincipalFacts, r: ResourceFacts): Denial | null {
  for (const pre of PRECONDITIONS) {
    if (!pre.applies(permission)) continue;
    const d = pre.check(p, r, permission);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------- builders (pure, from row data)

function facts(
  type: ResourceType,
  relations: Iterable<Relation> = [],
  state: Iterable<ResourceState> = [],
  unitPath: readonly string[] = [],
): ResourceFacts {
  return { type, unitPath, relations: new Set(relations), state: new Set(state) };
}

const when = <T>(cond: boolean, value: T): T[] => (cond ? [value] : []);

export function orgResource(): ResourceFacts {
  return facts("organization");
}

export function unitResource(u: { id: string; path: readonly string[] }): ResourceFacts {
  return facts("unit", [], [], u.path);
}

export function userResource(targetUserId: string, principalUserId: string | null): ResourceFacts {
  return facts("user", when(targetUserId === principalUserId, "self" as const));
}

export function memberResource(targetUserId: string, principalUserId: string | null): ResourceFacts {
  return facts("member", when(targetUserId === principalUserId, "self" as const));
}

export interface ChannelFacts {
  visibility: "public" | "private";
  archived: boolean;
  viewerRole: "owner" | "member" | null;
  /**
   * `dm` = a 1:1 direct conversation, `group` = a group DM (D-06); both carry state `dm` (fixed membership, no
   * moderation). Omitted = a channel.
   */
  kind?: "channel" | "dm" | "group";
  /**
   * The unit the channel belongs to, root → self (CHAT-02): unit-scoped allow and deny rules apply to the channels of
   * that unit (principle 6). Omitted or [] = the organization (and every direct conversation).
   */
  unitPath?: readonly string[];
}

function channelRelations(c: ChannelFacts): Relation[] {
  return [
    ...when(c.viewerRole !== null, "member" as const),
    ...when(c.viewerRole === "owner", "owner" as const),
  ];
}

function channelState(c: ChannelFacts): ResourceState[] {
  return [
    ...when(c.visibility === "private", "private" as const),
    ...when(c.archived, "archived" as const),
    ...when(c.kind === "dm" || c.kind === "group", "dm" as const),
  ];
}

export function channelResource(c: ChannelFacts): ResourceFacts {
  return facts("channel", channelRelations(c), channelState(c), c.unitPath ?? []);
}

export function channelMemberResource(c: ChannelFacts, targetIsViewer: boolean): ResourceFacts {
  return facts(
    "channel_member",
    [...channelRelations(c), ...when(targetIsViewer, "self" as const)],
    channelState(c),
    c.unitPath ?? [],
  );
}

/**
 * A device as a resource. `cap` is the principal's highest mode on the device (device/access.ts, P-06): given, a
 * non-owner is a `grantee` when it is not null and a `full_access_grantee` when it is Full access; omitted, the
 * legacy rule applies (every member is a grantee of a shared device).
 */
export function deviceResource(
  d: { ownerUserId: string; shared: boolean; revoked: boolean; cap?: PermissionMode | null },
  principalUserId: string | null,
): ResourceFacts {
  const owner = principalUserId !== null && d.ownerUserId === principalUserId;
  const grantee = d.cap === undefined ? d.shared : !owner && d.cap !== null;
  return facts(
    "device",
    [
      ...when(owner, "owner" as const),
      ...when(grantee, "grantee" as const),
      ...when(!owner && d.cap === "fullAccess", "full_access_grantee" as const),
    ],
    when(d.revoked, "revoked" as const),
  );
}

export function workSessionResource(
  s: { createdBy: string; deviceOwnerUserId: string | null; deviceRevoked: boolean; tool?: string | null },
  principalUserId: string | null,
): ResourceFacts {
  const r = facts(
    "work_session",
    [
      ...when(principalUserId !== null && s.createdBy === principalUserId, "creator" as const),
      ...when(
        principalUserId !== null && s.deviceOwnerUserId !== null && s.deviceOwnerUserId === principalUserId,
        "device_owner" as const,
      ),
    ],
    when(s.deviceRevoked, "device_revoked" as const),
  );
  return s.tool ? { ...r, tool: s.tool } : r;
}

export function invitationResource(
  i: { inviterId: string | null; role: OrgRole },
  principalUserId: string | null,
): ResourceFacts {
  return {
    ...facts(
      "invitation",
      when(
        principalUserId !== null && i.inviterId !== null && i.inviterId === principalUserId,
        "inviter" as const,
      ),
    ),
    invitedRole: i.role,
  };
}

/** D-01: what the resolver needs about a bot. */
export interface AgentFacts {
  scope: "team" | "personal";
  ownerUserId: string | null;
  disabled: boolean;
}

/** A bot as a resource: `owner` relation for its owner; states `personal` and `disabled`. */
export function agentResource(a: AgentFacts, principalUserId: string | null): ResourceFacts {
  return facts(
    "agent",
    when(
      principalUserId !== null && a.ownerUserId !== null && a.ownerUserId === principalUserId,
      "owner" as const,
    ),
    [...when(a.scope === "personal", "personal" as const), ...when(a.disabled, "disabled" as const)],
  );
}
